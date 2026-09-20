/**
 * src/routes/auto_trade.routes.js
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const autoTradeController = require('../controllers/auto_trade.controller');

// Création/màj de config = action peu fréquente mais sensible (peut
// déclencher du trading automatique) — même limiter que runBacktest.
router.post('/configs', protect, rateLimiter(20), autoTradeController.createConfig);
router.get('/configs', protect, autoTradeController.listConfigs);
router.patch('/configs/:id', protect, rateLimiter(20), autoTradeController.updateConfig);
router.delete('/configs/:id', protect, autoTradeController.deleteConfig);

module.exports = router;