const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const ctrl    = require('../controllers/exchanges.controller');

router.use(protect);

// Connection management
router.get   ('/connections',                               ctrl.getConnections);
router.post  ('/connect',                                   ctrl.connect);
router.patch ('/:exchangeId/mode',                          ctrl.changeMode);
router.delete('/:exchangeId',                               ctrl.disconnect);
router.post  ('/:exchangeId/test',                          ctrl.testConnection);
router.post  ('/:exchangeId/health-check',                  ctrl.healthCheckOne);

// ⚠️ IMPORTANT : /portfolio/all DOIT être déclarée AVANT /:exchangeId/portfolio,
// sinon Express matche 'portfolio' comme valeur de :exchangeId et 'all' est
// interprété comme un 3e segment inexistant → 404 sur la route agrégée.
router.get   ('/portfolio/all',                             ctrl.getAggregatedPortfolio);

// Portfolio & orders
router.get   ('/:exchangeId/portfolio',                     ctrl.getPortfolio);
router.post  ('/:exchangeId/order',                         ctrl.placeOrder);

// Paper trades
router.get   ('/:exchangeId/paper-trades',                  ctrl.getPaperTrades);
router.post  ('/:exchangeId/paper-trades/:tradeId/close',   ctrl.closePaperTrade);

module.exports = router;