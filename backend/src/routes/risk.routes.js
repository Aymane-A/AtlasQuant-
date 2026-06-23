// backend/routes/risk.routes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getRiskData, runCustomStressTest } = require('../controllers/risk.controller');

// URL: /api/risk/matrix
router.get('/matrix', protect, getRiskData);

// URL: /api/risk/stress-test
router.post('/stress-test', protect, runCustomStressTest);

module.exports = router;