/**
 * routes/market.routes.js — AtlasQuant AI
 *
 * GET /api/market/prices              → crypto prices
 * GET /api/market/forex/prices        → forex prices
 * GET /api/market/commodities/prices  → commodities prices
 * GET /api/market/:symbol/stats       → 24hr stats (auto-detect crypto/forex/commodity)
 * GET /api/market/:symbol/candles     → OHLCV candles (auto-detect crypto/forex/commodity)
 */
const express = require('express');
const router  = express.Router();
const { getPrices, getForex, getCommodities, getStats, getCandle } = require('../controllers/market.controller');
const { getCalendar } = require('../controllers/economicCalendar.controller');
const { getNews } = require('../controllers/news.controller');
const { rateLimiter } = require('../middleware/rateLimit.middleware');

// ⚠️ NOTE: had jouj khassom yji9bel `/:symbol/stats` w `/:symbol/candles`,
// wla Express ghadi yetfaser "forex"/"commodities" b7al qima dyal :symbol
router.get('/forex/prices',       rateLimiter(30), getForex);
router.get('/commodities/prices', rateLimiter(30), getCommodities);

router.get('/prices',             rateLimiter(30), getPrices);
router.get('/:symbol/stats',      rateLimiter(30), getStats);
router.get('/:symbol/candles',    rateLimiter(20), getCandle);
router.get('/economic-calendar', getCalendar);
router.get('/news', getNews);


module.exports = router;