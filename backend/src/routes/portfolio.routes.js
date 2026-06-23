// backend/routes/portfolio.routes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getPortfolioData } = require('../controllers/portfolioController');

// URL: /api/portfolio/data
router.get('/data', protect, getPortfolioData);

module.exports = router;