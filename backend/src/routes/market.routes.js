/**
 * routes/market.routes.js — AtlasQuant AI
 *
 * GET /api/market/prices              → all prices
 * GET /api/market/:symbol/stats       → 24hr stats
 * GET /api/market/:symbol/candles     → OHLCV candles
 */
const express = require('express');
const router  = express.Router();
const { getPrices, getStats, getCandle } = require('../controllers/market.controller');
const { rateLimiter } = require('../middleware/rateLimit.middleware');

router.get('/prices',            rateLimiter(30), getPrices);
router.get('/:symbol/stats',     rateLimiter(30), getStats);
router.get('/:symbol/candles',   rateLimiter(20), getCandle);

module.exports = router;