/**
 * src/routes/portfolio.routes.js
 */
const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/auth.middleware');
const {
  getPortfolioData,
  addPosition,
  removePosition,
  reducePosition,
  updateCash,
  getTradeHistory,
} = require('../controllers/portfolioController');
const { analyzePortfolio } = require('../controllers/portfolioAnalyzer.controller');

// GET  /api/portfolio/data
router.get('/data', protect, getPortfolioData);

// POST /api/portfolio/position         — { symbol, side, amount, averageEntry?, sector }
router.post('/position', protect, addPosition);

// POST /api/portfolio/position/:symbol/:side/reduce — { amount, exitPrice? } (partial close)
router.post('/position/:symbol/:side/reduce', protect, reducePosition);

// DELETE /api/portfolio/position/:symbol/:side — full close
router.delete('/position/:symbol/:side', protect, removePosition);

// GET  /api/portfolio/history          — realized trade history (?limit=&offset=)
router.get('/history', protect, getTradeHistory);

// PATCH /api/portfolio/cash            — { cashBalance }
router.patch('/cash', protect, updateCash);

// POST /api/portfolio/analyze          — AI portfolio analysis
router.post('/analyze', protect, analyzePortfolio);

module.exports = router;