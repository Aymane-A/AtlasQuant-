// backend/routes/overviewRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getQuantumOverview } = require('../controllers/overviewController');

// GET /api/v1/overview
router.get('/overview', protect, getQuantumOverview);

module.exports = router;