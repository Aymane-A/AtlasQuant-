/**
 * src/services/backtestMarketRouter.service.js
 *
 * RÔLE DE CE FICHIER :
 * Le Backtester doit pouvoir tester n'importe quel symbole — crypto
 * (BTC/USDT), forex (EUR/USD), commodity (XAU/USD, WTI...) ou action/ETF
 * (AAPL, SPY) — sans que le moteur de simulation ait à se soucier de la
 * source des données.
 *
 * Ce fichier fait UNIQUEMENT du routage :
 *   - crypto              → services/marketData.service.js (Binance/ccxt)
 *   - forex/commodity/eq. → services/yahooFinance.service.js (Yahoo Finance)
 *
 * Il normalise la sortie vers un format unique :
 *   [{ date, open, high, low, close, volume }, ...]
 * et renvoie en plus l'asset class détectée + la devise de cotation +
 * fallbackApplied (true si le timeframe demandé a été rétrogradé vers
 * Daily faute de couverture intraday Yahoo). Le controller agrège ces
 * flags en UN SEUL message de warning au lieu d'un message par symbole.
 *
 * FIX (audit multi-asset) :
 *   - `insertSlash()` normalise les symboles écrits SANS séparateur
 *     (BTCUSD, EURUSD, USDJPY, XAUUSD...) AVANT toute classification.
 *     Avant ce fix, ces formats tombaient tous silencieusement dans la
 *     classe 'equity' par défaut → routés vers Yahoo avec un ticker
 *     invalide → échec silencieux ou mauvaises données.
 *   - "BTC/USD" (slash + quote fiat) était classé à tort comme non-crypto
 *     (car 'USD' ∈ FOREX_CURRENCIES) et finissait aussi en 'equity'.
 *     Désormais toute base crypto connue (BTC, ETH, SOL...) force la
 *     classification 'crypto', quelle que soit la devise de cotation.
 *   - Le filtre de dates crypto (Binance) lève maintenant une erreur
 *     explicite si la période demandée ne contient aucune bougie, au
 *     lieu de retomber silencieusement sur la série NON filtrée (ce qui
 *     faisait tourner le backtest sur une période différente de celle
 *     demandée sans avertir l'utilisateur).
 *   - `getQuoteCurrency('equity')` retournait TOUJOURS 'USD', même pour
 *     des tickers cotés sur d'autres places (Londres, Paris, Tokyo...).
 *     `EXCHANGE_SUFFIX_CURRENCY` détecte la devise via le suffixe Yahoo
 *     du ticker (".L", ".PA", ".T"...) quand il est présent.
 *   - `convertAmount()` : le capital et le "Fixed $ per trade" sont
 *     saisis par l'utilisateur dans SA devise de settings (ex: MAD), pas
 *     dans la devise de cotation du symbole tradé (ex: USD pour AAPL,
 *     JPY pour USD/JPY). Avant ce fix, ce montant était utilisé tel
 *     quel comme s'il était déjà dans la bonne devise — un capital de
 *     "100 000" en MAD tournait comme 100 000 USD, 10x trop gros.
 *     `convertAmount()` récupère le taux de change le plus récent via
 *     Yahoo Finance et convertit ; en cas d'échec (devise inconnue,
 *     service indisponible), il retombe sur le montant NON converti
 *     plutôt que de faire échouer tout le backtest.
 */

const logger = require('../utils/logger');
const { getCandlesRange } = require('./marketData.service');
const { getStockCandles } = require('./yahooFinance.service');

// Devises fiat connues — utilisées pour distinguer forex ("EUR/USD") de
// crypto avec slash ("BTC/USDT" — USDT n'est pas dans cette liste).
const FOREX_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'CNH', 'MXN', 'SEK', 'NOK'];

// Codes de métaux précieux traités comme des commodities (XAUUSD, XAGUSD
// écrits sans slash) — distincts de FOREX_CURRENCIES.
const COMMODITY_METAL_BASES = ['XAU', 'XAG'];

// Bases crypto connues — sert à désambiguïser "BTC/USD" (crypto, PAS forex)
// et à reconstituer le slash pour "BTCUSD", "ETHUSDT" écrits collés.
const KNOWN_CRYPTO_BASES = [
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'BNB', 'MATIC', 'DOT', 'AVAX',
  'LINK', 'LTC', 'ATOM', 'UNI', 'TRX', 'SHIB', 'NEAR', 'APT', 'ARB', 'OP',
  'FIL', 'ICP', 'ETC', 'XLM', 'BCH', 'VET', 'ALGO', 'AAVE', 'SAND', 'MANA',
  'FTM', 'SUI', 'INJ',
];

// Commodities : nom(s) affiché(s) → ticker Yahoo Finance. Plusieurs alias
// pointent vers le même ticker pour tolérer différentes façons d'écrire.
const COMMODITY_TICKERS = {
  'XAU/USD': 'GC=F',  GOLD: 'GC=F',
  'XAG/USD': 'SI=F',  SILVER: 'SI=F',
  WTI: 'CL=F', OIL: 'CL=F', 'CRUDE OIL': 'CL=F', 'CRUDE': 'CL=F',
  BRENT: 'BZ=F', 'BRENT CRUDE': 'BZ=F',
  NG: 'NG=F', NATGAS: 'NG=F', 'NATURAL GAS': 'NG=F',
  HG: 'HG=F', COPPER: 'HG=F',
  PLATINUM: 'PL=F', PALLADIUM: 'PA=F',
  CORN: 'ZC=F', WHEAT: 'ZW=F', SOYBEAN: 'ZS=F', SOYBEANS: 'ZS=F',
  COFFEE: 'KC=F', SUGAR: 'SB=F', COTTON: 'CT=F',
};
const KNOWN_COMMODITY_KEYS = new Set(Object.keys(COMMODITY_TICKERS));

// Suffixes/format qui indiquent un symbole crypto
const CRYPTO_QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'];

// Yahoo Finance ne fournit l'intraday (15m/1h, donc aussi notre "4H" agrégé)
// que sur les ~60 derniers jours. Au-delà, il faut retomber sur le Daily.
const YAHOO_INTRADAY_LOOKBACK_DAYS = 60;

// Suffixe de ticker Yahoo → devise de cotation, pour les actions/ETF
// listés hors des États-Unis. Liste non-exhaustive mais couvre les
// places les plus courantes. Sans suffixe reconnu → défaut USD.
const EXCHANGE_SUFFIX_CURRENCY = {
  L: 'GBP',   // London Stock Exchange
  PA: 'EUR',  // Paris (Euronext)
  DE: 'EUR',  // Xetra / Frankfurt
  MI: 'EUR',  // Milan (Borsa Italiana)
  AS: 'EUR',  // Amsterdam (Euronext)
  BR: 'EUR',  // Bruxelles (Euronext)
  MC: 'EUR',  // Madrid
  LS: 'EUR',  // Lisbonne
  TO: 'CAD',  // Toronto (TSX)
  V: 'CAD',   // TSX Venture
  HK: 'HKD',  // Hong Kong
  T: 'JPY',   // Tokyo
  SW: 'CHF',  // Suisse (SIX)
  ST: 'SEK',  // Stockholm
  OL: 'NOK',  // Oslo
  CO: 'DKK',  // Copenhague
  SI: 'SGD',  // Singapour
  AX: 'AUD',  // Australie (ASX)
};

// Fenêtre de recherche pour le taux de change le plus récent — on ne
// veut qu'une seule bougie récente, pas tout l'historique.
const FX_RATE_LOOKBACK_DAYS = 7;

/**
 * Insère un "/" dans un symbole écrit sans séparateur, en se basant sur
 * les bases/quotes connues. Idempotent : ne touche pas à un symbole qui
 * a déjà un slash, et ne touche pas non plus à un ticker action/ETF
 * classique (AAPL, SPY...) qui ne matche aucun pattern ci-dessous.
 *
 * Exemples : "BTCUSD" → "BTC/USD" | "BTCUSDT" → "BTC/USDT"
 *            "EURUSD" → "EUR/USD" | "USDJPY" → "USD/JPY"
 *            "XAUUSD" → "XAU/USD" | "AAPL"   → "AAPL" (inchangé)
 */
function insertSlash(rawSymbol) {
  const clean = rawSymbol.trim().toUpperCase();
  if (clean.includes('/')) return clean;

  // 1) Suffixe de cotation crypto (USDT, USDC, BUSD, BTC, ETH) — on prend
  //    le suffixe le plus long en premier pour éviter un split ambigu.
  const sortedSuffixes = [...CRYPTO_QUOTE_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suffix of sortedSuffixes) {
    if (clean.endsWith(suffix) && clean.length > suffix.length) {
      const base = clean.slice(0, -suffix.length);
      if (base.length >= 2) return `${base}/${suffix}`;
    }
  }

  // 2) Base crypto connue + devise fiat collée (BTCUSD, ETHEUR...)
  for (const base of KNOWN_CRYPTO_BASES) {
    if (clean.startsWith(base)) {
      const rest = clean.slice(base.length);
      if (FOREX_CURRENCIES.includes(rest)) return `${base}/${rest}`;
    }
  }

  // 3) Paire forex ou métal précieux collée sur 6 caractères (EURUSD,
  //    USDJPY, XAUUSD...)
  if (clean.length === 6) {
    const base = clean.slice(0, 3);
    const quote = clean.slice(3);
    if (COMMODITY_METAL_BASES.includes(base) && quote === 'USD') return `${base}/${quote}`;
    if (FOREX_CURRENCIES.includes(base) && FOREX_CURRENCIES.includes(quote)) return `${base}/${quote}`;
  }

  // Rien ne matche → probablement une action/ETF, on laisse tel quel.
  return clean;
}

/**
 * Détermine si un symbole est une paire crypto.
 * Exemples crypto : "BTC/USDT", "BTCUSDT", "BTC/USD", "ETH/USDT", "SOLUSDT"
 * Exemples stock   : "AAPL", "SPY", "NVDA", "QQQ"
 * Exemples forex   : "EUR/USD", "GBP/USD" — ont un slash, MAIS ne sont pas crypto
 */
function isCryptoSymbol(symbol) {
  const clean = insertSlash(symbol);

  if (clean.includes('/')) {
    const [base, quotePart] = clean.split('/');
    // Une base crypto connue reste crypto même cotée en devise fiat
    // (ex: "BTC/USD") — avant ce fix, ce cas tombait dans le "false"
    // ci-dessous à cause du check FOREX_CURRENCIES sur la quote seule.
    if (KNOWN_CRYPTO_BASES.includes(base)) return true;
    if (FOREX_CURRENCIES.includes(quotePart)) return false;
    return true;
  }

  return CRYPTO_QUOTE_SUFFIXES.some(suffix => clean.endsWith(suffix) && clean.length > suffix.length);
}

/**
 * Classifie le symbole : 'crypto' | 'forex' | 'commodity' | 'equity'.
 * Utilisé pour choisir la source de données et pour l'affichage (devise).
 */
function detectAssetClass(symbol) {
  const clean = insertSlash(symbol);
  if (isCryptoSymbol(clean)) return 'crypto';
  if (KNOWN_COMMODITY_KEYS.has(clean)) return 'commodity';
  if (clean.includes('/')) {
    const [base, quote] = clean.split('/');
    if (COMMODITY_METAL_BASES.includes(base) && quote === 'USD') return 'commodity';
    if (FOREX_CURRENCIES.includes(base) && FOREX_CURRENCIES.includes(quote)) return 'forex';
  }
  return 'equity';
}

/**
 * Convertit un symbole d'affichage → ticker Yahoo Finance.
 * - Commodity connue → ticker futures (ex: GOLD → "GC=F", XAUUSD → "GC=F")
 * - Forex générique  → convention Yahoo "BASEQUOTE=X", avec USD-base qui
 *   se contracte en "QUOTE=X" (ex: USD/JPY → "JPY=X", EUR/GBP → "EURGBP=X")
 * - Sinon (action/ETF) → symbole inchangé
 */
function toYahooTicker(symbol) {
  const clean = insertSlash(symbol);

  if (COMMODITY_TICKERS[clean]) return COMMODITY_TICKERS[clean];

  if (clean.includes('/')) {
    const [base, quote] = clean.split('/');
    if (FOREX_CURRENCIES.includes(base) && FOREX_CURRENCIES.includes(quote)) {
      return base === 'USD' ? `${quote}=X` : `${base}${quote}=X`;
    }
  }

  return symbol;
}

/**
 * Convertit un symbole d'affichage → symbole Binance (pour l'API crypto).
 * Binance spot n'a pas de paires fiat directes comme "BTCUSD" ; les
 * devises fiat demandées (USD, EUR...) sont mappées vers le stablecoin
 * USDT, qui suit ces devises de très près (peg 1:1 pour USD).
 */
function toBinanceSymbol(symbol) {
  const clean = insertSlash(symbol);
  if (!clean.includes('/')) return clean.replace('/', '');

  const [base, quote] = clean.split('/');
  const binanceQuote = FOREX_CURRENCIES.includes(quote) ? 'USDT' : quote;
  return `${base}${binanceQuote}`;
}

/**
 * Devise de cotation d'un symbole — utilisée par le moteur de backtest
 * pour formater correctement les montants (éviter tout hardcoder en $).
 */
function getQuoteCurrency(symbol, assetClass) {
  const clean = insertSlash(symbol);

  if (assetClass === 'forex') return clean.split('/')[1]?.trim().toUpperCase() || 'USD';
  if (assetClass === 'commodity') return 'USD';

  if (assetClass === 'equity') {
    // FIX : détecte la devise via le suffixe de place boursière du
    // ticker (ex: "VOD.L" → GBP, "MC.PA" → EUR) au lieu de forcer USD
    // pour toute action, même listée hors des États-Unis.
    const raw = symbol.trim().toUpperCase();
    const dotIdx = raw.lastIndexOf('.');
    if (dotIdx > -1) {
      const suffix = raw.slice(dotIdx + 1);
      if (EXCHANGE_SUFFIX_CURRENCY[suffix]) return EXCHANGE_SUFFIX_CURRENCY[suffix];
    }
    return 'USD';
  }

  if (assetClass === 'crypto') {
    if (clean.includes('/')) {
      const quote = clean.split('/')[1];
      // "BTC/USD" reste affiché en USD même si on fetch via USDT côté Binance.
      return quote || 'USDT';
    }
    const flat = clean.replace('/', '');
    const q = CRYPTO_QUOTE_SUFFIXES.find(s => flat.endsWith(s));
    return q || 'USDT';
  }
  return 'USD';
}

function toBinanceInterval(timeframe) {
  const map = { Daily: '1d', '4H': '4h', '1H': '1h', '15M': '15m' };
  return map[timeframe] || '1h';
}

function normalizeCryptoCandle(c) {
  return { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

function needsDailyFallback(timeframe, startDate) {
  if (timeframe === 'Daily') return false;
  const maxLookback = new Date();
  maxLookback.setDate(maxLookback.getDate() - YAHOO_INTRADAY_LOOKBACK_DAYS);
  return new Date(startDate) < maxLookback;
}

function estimateCandleCount(timeframe, startDate, endDate) {
  const msPerCandle = {
    Daily: 24 * 60 * 60 * 1000, '4H': 4 * 60 * 60 * 1000,
    '1H': 60 * 60 * 1000, '15M': 15 * 60 * 1000,
  }[timeframe] || 60 * 60 * 1000;

  const rangeMs = new Date(endDate).getTime() - new Date(startDate).getTime();
  const estimated = Math.ceil((rangeMs / msPerCandle) * 1.3);
  return Math.min(Math.max(estimated, 100), 1000);
}

/**
 * Point d'entrée unique utilisé par le Backtester (appelé une fois par
 * symbole — le contrôleur boucle sur l'univers demandé).
 *
 * @returns {Promise<{ candles, effectiveTimeframe, fallbackApplied, assetClass, quoteCurrency }>}
 */
async function fetchCandlesForBacktest(symbol, timeframe, startDate, endDate) {
  const assetClass = detectAssetClass(symbol);
  const quoteCurrency = getQuoteCurrency(symbol, assetClass);

  if (assetClass === 'crypto') {
    const binanceSymbol = toBinanceSymbol(symbol);
    logger.info(`[backtestMarketRouter] ${symbol} détecté comme crypto → Binance (${binanceSymbol})`);

        const interval = toBinanceInterval(timeframe);
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const candles = await getCandlesRange(binanceSymbol, interval, start, end);

    if (!candles || candles.length === 0) {
      throw new Error(
        `Aucune donnée Binance pour ${symbol} sur la période demandée (${startDate} → ${endDate}).`
      );
    }

    return {
      candles: candles.map(normalizeCryptoCandle),
      effectiveTimeframe: timeframe,
      fallbackApplied: false,
      assetClass,
      quoteCurrency,
    };
  }

  // Forex / commodity / equity → toutes via Yahoo Finance
  let effectiveTimeframe = timeframe;
  let fallbackApplied = false;

  if (needsDailyFallback(timeframe, startDate)) {
    logger.info(
      `[backtestMarketRouter] ${symbol} — période trop ancienne pour ${timeframe} (limite Yahoo: ${YAHOO_INTRADAY_LOOKBACK_DAYS}j), fallback vers Daily`
    );
    effectiveTimeframe = 'Daily';
    fallbackApplied = true;
  }

  const yahooTicker = toYahooTicker(symbol);
  logger.info(`[backtestMarketRouter] ${symbol} (${assetClass}) → ${yahooTicker} (Yahoo Finance, ${effectiveTimeframe})`);
  const candles = await getStockCandles(yahooTicker, effectiveTimeframe, startDate, endDate);

  if (!candles || candles.length === 0) {
    throw new Error(`Aucune donnée Yahoo Finance pour ${symbol} (ticker: ${yahooTicker})`);
  }

  return { candles, effectiveTimeframe, fallbackApplied, assetClass, quoteCurrency };
}

/**
 * Récupère le taux de change le plus récent FROM → TO via Yahoo Finance
 * (même convention de ticker que toYahooTicker : base USD se contracte
 * en "QUOTE=X", sinon "BASEQUOTE=X"). Retourne le nombre d'unités de
 * `toCurrency` pour 1 unité de `fromCurrency`.
 */
async function fetchFxRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1;

  const ticker = fromCurrency === 'USD' ? `${toCurrency}=X` : `${fromCurrency}${toCurrency}=X`;

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - FX_RATE_LOOKBACK_DAYS);

  const candles = await getStockCandles(
    ticker, 'Daily', start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)
  );

  if (!candles || candles.length === 0) {
    throw new Error(`Taux de change introuvable pour ${fromCurrency}/${toCurrency} (ticker: ${ticker})`);
  }

  return candles[candles.length - 1].close;
}

/**
 * Convertit un montant de `fromCurrency` vers `toCurrency` au taux de
 * change le plus récent disponible.
 *
 * Utilisé pour : le capital initial et le "Fixed $ per trade", tous deux
 * saisis par l'utilisateur dans SA devise de settings (ex: MAD) mais qui
 * doivent être exprimés dans la devise de cotation du symbole tradé
 * avant d'entrer dans runSimulation (ex: USD pour AAPL, JPY pour
 * USD/JPY) — sinon le moteur traite "100 000" comme 100 000 dans la
 * mauvaise devise.
 *
 * En cas d'échec de récupération du taux (devise inconnue de Yahoo,
 * service indisponible...), retourne le montant NON converti et loggue
 * un avertissement plutôt que de faire échouer tout le backtest — un
 * résultat approximatif reste plus utile qu'un symbole skippé en plus.
 */
// FIX: cache les taux FX par paire (TTL 15 min) — sans ça, chaque appel de
// convertAmount() (potentiellement plusieurs par symbole, par backtest)
// déclenchait un fetch réseau, même pour la même paire de devises.
const FX_CACHE = new Map(); // "FROM_TO" -> { rate, expiresAt }
const FX_CACHE_TTL_MS = 15 * 60 * 1000;

async function getCachedFxRate(fromCurrency, toCurrency) {
  const key = `${fromCurrency}_${toCurrency}`;
  const cached = FX_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rate;

  const rate = await fetchFxRate(fromCurrency, toCurrency);
  FX_CACHE.set(key, { rate, expiresAt: Date.now() + FX_CACHE_TTL_MS });
  return rate;
}

/**
 * `warningsSink` (optionnel) : tableau fourni par l'appelant, dans lequel
 * on pousse la paire de devises en cas d'échec — pour que le controller
 * puisse remonter un vrai warning utilisateur au lieu d'un fallback 1:1
 * silencieux. Paramètre optionnel : les appels existants qui ne le
 * passent pas continuent de fonctionner à l'identique.
 */
// Stablecoins pégués au USD (rate réel ~1:1) — Yahoo Finance n'a aucun
// ticker forex pour ces paires ("USDT=X" n'existe pas), donc tenter de
// les résoudre via getCachedFxRate échoue systématiquement et déclenche
// un warning "Conversion FX indisponible" trompeur alors que le
// fallback 1:1 utilisé est en réalité correct (pas approximatif).
const STABLE_USD_EQUIVALENTS = new Set(['USDT', 'USDC', 'BUSD']);

async function convertAmount(amount, fromCurrency, toCurrency, warningsSink) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return amount;

  // FIX (stablecoin false warning) : USD<->USDT/USDC/BUSD est traité en
  // 1:1 directement, sans passer par Yahoo ni déclencher de warning —
  // le taux réel est déjà ~1:1, ce n'est pas un fallback dégradé.
  if (
    (STABLE_USD_EQUIVALENTS.has(fromCurrency) && toCurrency === 'USD') ||
    (fromCurrency === 'USD' && STABLE_USD_EQUIVALENTS.has(toCurrency))
  ) {
    return amount;
  }

  try {
    const rate = await getCachedFxRate(fromCurrency, toCurrency);
    return amount * rate;
  } catch (err) {
    logger.info(
      `[backtestMarketRouter] Conversion FX ${fromCurrency}→${toCurrency} indisponible (${err.message}), capital utilisé sans conversion.`
    );
    if (Array.isArray(warningsSink)) {
      warningsSink.push(`${fromCurrency}→${toCurrency}`);
    }
    return amount;
  }
}

module.exports = {
  fetchCandlesForBacktest,
  isCryptoSymbol,
  detectAssetClass,
  getQuoteCurrency,
  convertAmount,
};