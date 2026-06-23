const express = require('express');
const router  = express.Router();
const { getAllSignals, getSignalBySymbol, getSupportedSymbols, getAnalyticsData } = require('../controllers/signals.controller');
const { getAlphaEngineData } = require('../controllers/alphaEngine.controller');
const { rateLimiter } = require('../middleware/rateLimit.middleware');

router.get('/',                  rateLimiter(10), getAllSignals);
router.get('/meta/supported',    getSupportedSymbols);
router.get('/alpha/engine-data', rateLimiter(10), getAlphaEngineData);
router.get('/analytics',         rateLimiter(10), getAnalyticsData);
router.get('/:symbol',           rateLimiter(20), getSignalBySymbol);

module.exports = router;