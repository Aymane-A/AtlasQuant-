const express = require('express');
const router  = express.Router();
const {
  getAllSignals,
  getScanStatus,
  getSignalBySymbol,
  getSupportedSymbols,
  getAnalyticsData
} = require('../controllers/signals.controller');
const { getMyAnalytics }     = require('../controllers/myAnalytics.controller');
const { getAlphaEngineData } = require('../controllers/alphaEngine.controller');
const { protect }            = require('../middleware/auth.middleware');
const { rateLimiter }        = require('../middleware/rateLimit.middleware');

// A full scan (crypto + forex + Yahoo) is expensive: refresh=true requires a
// logged-in user. Plain reads of stored signals stay public.
const protectIfRefresh = (req, res, next) =>
  req.query.refresh === 'true' ? protect(req, res, next) : next();

router.get('/',                  rateLimiter(10), protectIfRefresh, getAllSignals);
router.get('/meta/supported',    getSupportedSymbols);
router.get('/alpha/engine-data', rateLimiter(10), getAlphaEngineData);
router.get('/analytics',         rateLimiter(10), getAnalyticsData);
// "Mon P&L": performance de l'utilisateur connecté (paper_trades). Protégée.
router.get('/analytics/mine',    protect, rateLimiter(10), getMyAnalytics);
router.get('/:symbol',           rateLimiter(20), getSignalBySymbol);
router.get('/scan-status/:jobId', protect, getScanStatus);

module.exports = router;