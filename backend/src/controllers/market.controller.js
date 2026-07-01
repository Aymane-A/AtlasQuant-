/**
 * controllers/market.controller.js — AtlasQuant AI
 */

const {
  getUnifiedCandles, getUnifiedStats, getMultiplePrices,
  getForexPrices, getCommodityPrices,
} = require('../services/marketData.service');
const logger = require('../utils/logger');

// Cache بسيط (5 ثواني) لكل نوع أصول على حدة
const cache = { crypto: null, forex: null, commodity: null };
const stamp = { crypto: 0,    forex: 0,    commodity: 0 };
const TTL   = 5000;

const MARKET_SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT',
  'DOGEUSDT','MATICUSDT','LINKUSDT','DOTUSDT','LTCUSDT','BCHUSDT','UNIUSDT',
  'ATOMUSDT','ETCUSDT','XLMUSDT','NEARUSDT','APTUSDT','FILUSDT','ARBUSDT',
  'OPUSDT','SUIUSDT','INJUSDT','IMXUSDT','RNDRUSDT','TIAUSDT','SEIUSDT',
  'STXUSDT','HBARUSDT','VETUSDT','ICPUSDT','GRTUSDT','AAVEUSDT','MKRUSDT',
  'SANDUSDT','MANAUSDT','AXSUSDT','EGLDUSDT','FTMUSDT','ALGOUSDT','QNTUSDT',
  'FLOWUSDT','THETAUSDT','XTZUSDT','EOSUSDT','KAVAUSDT','RUNEUSDT','GALAUSDT',
  'CHZUSDT','ENJUSDT','ZILUSDT','COMPUSDT','SNXUSDT','CRVUSDT','DYDXUSDT',
  'LDOUSDT','PEPEUSDT','SHIBUSDT',
];

const isFresh = (type) => cache[type] && (Date.now() - stamp[type] < TTL);
const setCache = (type, data) => { cache[type] = data; stamp[type] = Date.now(); };

/** GET /api/market/prices — crypto (default, unchanged for backward compat) */
async function getPrices(req, res) {
  try {
    if (isFresh('crypto')) {
      return res.json({ success: true, prices: cache.crypto, cached: true, timestamp: new Date(stamp.crypto).toISOString() });
    }
    const prices = await getMultiplePrices(MARKET_SYMBOLS);
    setCache('crypto', prices);
    res.json({ success: true, prices, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error(`[market.controller] getPrices: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /api/market/forex/prices */
async function getForex(req, res) {
  try {
    if (isFresh('forex')) {
      return res.json({ success: true, prices: cache.forex, cached: true, timestamp: new Date(stamp.forex).toISOString() });
    }
    const prices = await getForexPrices();
    setCache('forex', prices);
    res.json({ success: true, prices, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error(`[market.controller] getForex: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /api/market/commodities/prices */
async function getCommodities(req, res) {
  try {
    if (isFresh('commodity')) {
      return res.json({ success: true, prices: cache.commodity, cached: true, timestamp: new Date(stamp.commodity).toISOString() });
    }
    const prices = await getCommodityPrices();
    setCache('commodity', prices);
    res.json({ success: true, prices, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error(`[market.controller] getCommodities: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /api/market/:symbol/stats — auto-detects crypto / forex / commodity */
async function getStats(req, res) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const stats = await getUnifiedStats(symbol);
    res.json({ success: true, stats });
  } catch (err) {
    logger.error(`[market.controller] getStats: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /api/market/:symbol/candles — auto-detects crypto / forex / commodity */
async function getCandle(req, res) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '4h';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const candles = await getUnifiedCandles(symbol, interval, limit);
    res.json({ success: true, symbol, interval, candles });
  } catch (err) {
    logger.error(`[market.controller] getCandle: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getPrices, getForex, getCommodities, getStats, getCandle };