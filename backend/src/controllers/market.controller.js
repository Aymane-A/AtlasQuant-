/**
 * controllers/market.controller.js — AtlasQuant AI
 */

const { getCandles, get24hrStats, getMultiplePrices } = require('../services/marketData.service');
const logger = require('../utils/logger');

// Cache بسيط في الذاكرة
const cache = {
    data: null,
    timestamp: 0
};

const MARKET_SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','MATICUSDT','LINKUSDT',
];

/** GET /api/market/prices */
async function getPrices(req, res) {
  try {
    // التحقق من الـ Cache (مدة 5 ثواني)
    if (cache.data && (Date.now() - cache.timestamp < 5000)) {
        return res.json({ success: true, prices: cache.data, cached: true, timestamp: new Date(cache.timestamp).toISOString() });
    }

    const prices = await getMultiplePrices(MARKET_SYMBOLS);
    
    // تحديث الـ Cache
    cache.data = prices;
    cache.timestamp = Date.now();

    res.json({ success: true, prices, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error(`[market.controller] getPrices: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /api/market/:symbol/stats */
async function getStats(req, res) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const stats = await get24hrStats(symbol);
    res.json({ success: true, stats });
  } catch (err) {
    logger.error(`[market.controller] getStats: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** GET /api/market/:symbol/candles */
async function getCandle(req, res) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '4h';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const candles = await getCandles(symbol, interval, limit);
    res.json({ success: true, symbol, interval, candles });
  } catch (err) {
    logger.error(`[market.controller] getCandle: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getPrices, getStats, getCandle };