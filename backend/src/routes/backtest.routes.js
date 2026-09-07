/**
 * src/routes/backtest.routes.js
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const backtestController = require('../controllers/backtest.controller');

router.post('/', protect, rateLimiter(20), backtestController.runBacktest);

// NOTE: '/configs' doit être déclarée AVANT '/:id' — sinon Express
// route GET /backtest/configs vers getBacktestById avec id="configs".
router.post('/configs', protect, backtestController.saveBacktestConfig);
router.get('/configs', protect, backtestController.listBacktestConfigs);
router.delete('/configs/:id', protect, backtestController.deleteBacktestConfig);

router.get('/:id', protect, backtestController.getBacktestById);

module.exports = router;