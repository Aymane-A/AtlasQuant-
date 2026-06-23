/**
 * src/routes/backtest.routes.js
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const backtestController = require('../controllers/backtest.controller');

router.post('/', protect, rateLimiter(20), backtestController.runBacktest);
router.get('/:id', protect, backtestController.getBacktestById);

module.exports = router;