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

// Portfolio & orders
router.get   ('/:exchangeId/portfolio',                     ctrl.getPortfolio);
router.post  ('/:exchangeId/order',                         ctrl.placeOrder);

// Paper trades
router.get   ('/:exchangeId/paper-trades',                  ctrl.getPaperTrades);
router.post  ('/:exchangeId/paper-trades/:tradeId/close',   ctrl.closePaperTrade);

module.exports = router;