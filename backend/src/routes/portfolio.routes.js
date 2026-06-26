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
  updateCash,
} = require('../controllers/portfolioController');
const { analyzePortfolio } = require('../controllers/portfolioAnalyzer.controller');

// GET  /api/portfolio/data
router.get('/data', protect, getPortfolioData);

// POST /api/portfolio/position         — { symbol, side, amount, averageEntry, sector }
router.post('/position', protect, addPosition);

// DELETE /api/portfolio/position/:symbol/:side
router.delete('/position/:symbol/:side', protect, removePosition);

// PATCH /api/portfolio/cash            — { cashBalance }
router.patch('/cash', protect, updateCash);

// POST /api/portfolio/analyze          — AI portfolio analysis
router.post('/analyze', protect, analyzePortfolio);

module.exports = router;