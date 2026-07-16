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
 * et renvoie en plus l'asset class détectée + la devise de cotation,
 * utilisées en aval par le moteur pour l'affichage (formatage $/€/¥...).
 */

const logger = require('../utils/logger');
const { getCandles } = require('./marketData.service');
const { getStockCandles } = require('./yahooFinance.service');

// Devises fiat connues — utilisées pour distinguer forex ("EUR/USD") de
// crypto avec slash ("BTC/USDT" — USDT n'est pas dans cette liste).
const FOREX_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'CNH', 'MXN', 'SEK', 'NOK'];

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

/**
 * Détermine si un symbole est une paire crypto.
 * Exemples crypto : "BTC/USDT", "BTCUSDT", "ETH/USDT", "SOLUSDT"
 * Exemples stock   : "AAPL", "SPY", "NVDA", "QQQ"
 * Exemples forex   : "EUR/USD", "GBP/USD" — ont un slash, MAIS ne sont pas crypto
 */
function isCryptoSymbol(symbol) {
  const clean = symbol.trim().toUpperCase();

  if (clean.includes('/')) {
    const quotePart = clean.split('/')[1];
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
  const clean = symbol.trim().toUpperCase();
  if (isCryptoSymbol(clean)) return 'crypto';
  if (KNOWN_COMMODITY_KEYS.has(clean)) return 'commodity';
  if (clean.includes('/')) {
    const [base, quote] = clean.split('/');
    if (FOREX_CURRENCIES.includes(base) && FOREX_CURRENCIES.includes(quote)) return 'forex';
  }
  return 'equity';
}

/**
 * Convertit un symbole d'affichage → ticker Yahoo Finance.
 * - Commodity connue → ticker futures (ex: GOLD → "GC=F")
 * - Forex générique  → convention Yahoo "BASEQUOTE=X", avec USD-base qui
 *   se contracte en "QUOTE=X" (ex: USD/JPY → "JPY=X", EUR/GBP → "EURGBP=X")
 * - Sinon (action/ETF) → symbole inchangé
 */
function toYahooTicker(symbol) {
  const clean = symbol.trim().toUpperCase();

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
 * Devise de cotation d'un symbole — utilisée par le moteur de backtest
 * pour formater correctement les montants (éviter tout hardcoder en $).
 */
function getQuoteCurrency(symbol, assetClass) {
  if (assetClass === 'forex') return symbol.split('/')[1]?.trim().toUpperCase() || 'USD';
  if (assetClass === 'commodity' || assetClass === 'equity') return 'USD';
  if (assetClass === 'crypto') {
    const clean = symbol.toUpperCase().replace('/', '');
    const q = CRYPTO_QUOTE_SUFFIXES.find(s => clean.endsWith(s));
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
 * @returns {Promise<{ candles, warning, effectiveTimeframe, assetClass, quoteCurrency }>}
 */
async function fetchCandlesForBacktest(symbol, timeframe, startDate, endDate) {
  const assetClass = detectAssetClass(symbol);
  const quoteCurrency = getQuoteCurrency(symbol, assetClass);

  if (assetClass === 'crypto') {
    logger.info(`[backtestMarketRouter] ${symbol} détecté comme crypto → Binance`);

    const interval = toBinanceInterval(timeframe);
    const candleCount = estimateCandleCount(timeframe, startDate, endDate);
    const candles = await getCandles(symbol.replace('/', ''), interval, candleCount);

    if (!candles || candles.length === 0) {
      throw new Error(`Aucune donnée Binance pour ${symbol}`);
    }

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
      assetClass,
      quoteCurrency,
    };
  }

  // Forex / commodity / equity → toutes via Yahoo Finance
  let effectiveTimeframe = timeframe;
  let warning = null;

  if (needsDailyFallback(timeframe, startDate)) {
    logger.info(
      `[backtestMarketRouter] ${symbol} — période trop ancienne pour ${timeframe} (limite Yahoo: ${YAHOO_INTRADAY_LOOKBACK_DAYS}j), fallback vers Daily`
    );
    effectiveTimeframe = 'Daily';
    warning = `Le timeframe ${timeframe} n'est disponible que sur les ${YAHOO_INTRADAY_LOOKBACK_DAYS} derniers jours pour ${symbol}. Le backtest a été exécuté en Daily à la place.`;
  }

  const yahooTicker = toYahooTicker(symbol);
  logger.info(`[backtestMarketRouter] ${symbol} (${assetClass}) → ${yahooTicker} (Yahoo Finance, ${effectiveTimeframe})`);
  const candles = await getStockCandles(yahooTicker, effectiveTimeframe, startDate, endDate);

  if (!candles || candles.length === 0) {
    throw new Error(`Aucune donnée Yahoo Finance pour ${symbol} (ticker: ${yahooTicker})`);
  }

  return { candles, warning, effectiveTimeframe, assetClass, quoteCurrency };
}

module.exports = {
  fetchCandlesForBacktest,
  isCryptoSymbol,
  detectAssetClass,
  getQuoteCurrency,
};