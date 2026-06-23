/**
 * src/services/backtestMarketRouter.service.js
 *
 * RÔLE DE CE FICHIER :
 * Le Backtester doit pouvoir tester n'importe quel symbole — crypto
 * (BTC/USDT) ou action/ETF (AAPL, SPY) — sans que le moteur de
 * simulation ait à se soucier de la source des données.
 *
 * Ce fichier fait UNIQUEMENT du routage :
 *   - symbole crypto  → délègue à services/marketData.service.js (Binance/ccxt)
 *   - symbole boursier → délègue à services/yahooFinance.service.js (Yahoo Finance)
 *
 * Il ne contient aucune logique de fetch lui-même — il réutilise les
 * services existants tels quels, et normalise juste leur sortie vers
 * un format unique : [{ date, open, high, low, close, volume }, ...]
 */

const logger = require('../utils/logger');
const { getCandles } = require('./marketData.service');
const { getStockCandles } = require('./yahooFinance.service');

// Mapping symbole d'affichage → ticker Yahoo Finance, pour le forex et
// les commodities. yahoo-finance2 ne comprend pas "EUR/USD" ou "Gold" —
// il faut le ticker brut ("EURUSD=X", "GC=F").
const YAHOO_TICKER_MAP = {
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'JPY=X',
  'AUD/USD': 'AUDUSD=X',
  'USD/CAD': 'CAD=X',
  'USD/CHF': 'CHF=X',
  'XAU/USD': 'GC=F',
  'XAG/USD': 'SI=F',
  'WTI':     'CL=F',
  'BRENT':   'BZ=F',
  'NG':      'NG=F',
  'HG':      'HG=F',
};

function toYahooTicker(symbol) {
  const clean = symbol.trim().toUpperCase();
  return YAHOO_TICKER_MAP[clean] || symbol;
}

// Suffixes/format qui indiquent un symbole crypto
const CRYPTO_QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'];

// Yahoo Finance ne fournit l'intraday (15m/1h, donc aussi notre "4H" agrégé)
// que sur les ~60 derniers jours. Au-delà, il faut retomber sur le Daily.
const YAHOO_INTRADAY_LOOKBACK_DAYS = 60;

// Devises fiat connues — si la paire contient un slash mais que le côté
// "quote" est une devise fiat (pas un crypto quote asset), c'est du forex.
const FOREX_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

/**
 * Détermine si un symbole est une paire crypto.
 * Exemples crypto : "BTC/USDT", "BTCUSDT", "ETH/USDT", "SOLUSDT"
 * Exemples stock   : "AAPL", "SPY", "NVDA", "QQQ"
 * Exemples forex   : "EUR/USD", "GBP/USD" — ont un slash, MAIS ne sont pas crypto
 */
function isCryptoSymbol(symbol) {
  const clean = symbol.trim().toUpperCase();

  // Format avec slash ("BTC/USDT" ou "EUR/USD") — le slash seul ne suffit
  // pas à conclure : il faut regarder ce qu'il y a après le slash.
  if (clean.includes('/')) {
    const quotePart = clean.split('/')[1];
    // Si le côté droit est une devise fiat connue, c'est du forex, pas crypto.
    if (FOREX_CURRENCIES.includes(quotePart)) return false;
    return true;
  }

  // Format collé ("BTCUSDT") → crypto si se termine par un quote asset connu
  return CRYPTO_QUOTE_SUFFIXES.some(suffix => clean.endsWith(suffix) && clean.length > suffix.length);
}

/**
 * Convertit le timeframe du Backtester ("Daily","4H","1H","15M")
 * vers le format attendu par marketData.service.js (Binance/ccxt),
 * qui utilise des intervalles type "1d","4h","1h","15m".
 */
function toBinanceInterval(timeframe) {
  const map = { Daily: '1d', '4H': '4h', '1H': '1h', '15M': '15m' };
  return map[timeframe] || '1h';
}

/**
 * Normalise une bougie Binance/ccxt (qui a `timestamp` + `date` ISO)
 * vers le format unique attendu par le moteur de backtest.
 */
function normalizeCryptoCandle(c) {
  return {
    date:   c.date,
    open:   c.open,
    high:   c.high,
    low:    c.low,
    close:  c.close,
    volume: c.volume,
  };
}

/**
 * Détermine si la période demandée dépasse la fenêtre intraday de Yahoo
 * (~60 jours). Si oui, et que le timeframe n'est pas déjà Daily, il faut
 * retomber sur Daily plutôt que de laisser Yahoo lever une erreur.
 */
function needsDailyFallback(timeframe, startDate) {
  if (timeframe === 'Daily') return false;

  const maxLookback = new Date();
  maxLookback.setDate(maxLookback.getDate() - YAHOO_INTRADAY_LOOKBACK_DAYS);

  return new Date(startDate) < maxLookback;
}

/**
 * Point d'entrée unique utilisé par le Backtester.
 * Détecte le type de symbole et délègue au bon service.
 *
 * @param {string} symbol     - "BTC/USDT", "AAPL", "SPY"...
 * @param {string} timeframe  - "Daily" | "4H" | "1H" | "15M"
 * @param {string} startDate  - "YYYY-MM-DD"
 * @param {string} endDate    - "YYYY-MM-DD"
 * @returns {Promise<{ candles: Array, warning: string|null, effectiveTimeframe: string }>}
 */
async function fetchCandlesForBacktest(symbol, timeframe, startDate, endDate) {
  if (isCryptoSymbol(symbol)) {
    logger.info(`[backtestMarketRouter] ${symbol} détecté comme crypto → Binance`);

    // marketData.service.js (Binance/ccxt) ne prend pas de plage de dates,
    // seulement une limite de bougies. On calcule combien de bougies
    // couvrent la période demandée, avec une marge de sécurité.
    const interval = toBinanceInterval(timeframe);
    const candleCount = estimateCandleCount(timeframe, startDate, endDate);

    const candles = await getCandles(symbol.replace('/', ''), interval, candleCount);

    if (!candles || candles.length === 0) {
      throw new Error(`Aucune donnée Binance pour ${symbol}`);
    }

    // On filtre sur la plage de dates demandée (Binance renvoie les N
    // dernières bougies, potentiellement plus large que la période voulue).
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const filtered = candles.filter(c => {
      const t = new Date(c.date).getTime();
      return t >= start && t <= end;
    });

    return {
      candles: (filtered.length > 0 ? filtered : candles).map(normalizeCryptoCandle),
      warning: null,
      effectiveTimeframe: timeframe,
    };
  }

  // Yahoo Finance limite l'intraday (15m/1h, donc notre "4H" agrégé) à
  // ~60 jours dans le passé. Si la période demandée commence avant cette
  // limite, on retombe automatiquement sur Daily plutôt que d'échouer.
  let effectiveTimeframe = timeframe;
  let warning = null;

  if (needsDailyFallback(timeframe, startDate)) {
    logger.info(
      `[backtestMarketRouter] ${symbol} — période trop ancienne pour ${timeframe} (limite Yahoo: ${YAHOO_INTRADAY_LOOKBACK_DAYS}j), fallback vers Daily`
    );
    effectiveTimeframe = 'Daily';
    warning = `Le timeframe ${timeframe} n'est disponible que sur les ${YAHOO_INTRADAY_LOOKBACK_DAYS} derniers jours sur les actions/ETF. Le backtest a été exécuté en Daily à la place.`;
  }

  logger.info(`[backtestMarketRouter] ${symbol} → ${toYahooTicker(symbol)} (Yahoo Finance, ${effectiveTimeframe})`);
  const candles = await getStockCandles(toYahooTicker(symbol), effectiveTimeframe, startDate, endDate);

  return { candles, warning, effectiveTimeframe };
}

/**
 * Estime combien de bougies sont nécessaires pour couvrir la période
 * demandée, avec marge de sécurité (×1.3) pour les jours fériés/weekends.
 */
function estimateCandleCount(timeframe, startDate, endDate) {
  const msPerCandle = {
    Daily: 24 * 60 * 60 * 1000,
    '4H':  4 * 60 * 60 * 1000,
    '1H':  60 * 60 * 1000,
    '15M': 15 * 60 * 1000,
  }[timeframe] || 60 * 60 * 1000;

  const rangeMs = new Date(endDate).getTime() - new Date(startDate).getTime();
  const estimated = Math.ceil((rangeMs / msPerCandle) * 1.3);

  // Binance limite généralement à 1000 bougies par requête
  return Math.min(Math.max(estimated, 100), 1000);
}

module.exports = { fetchCandlesForBacktest, isCryptoSymbol };