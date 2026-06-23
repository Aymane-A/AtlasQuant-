const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getAlerts, createAlert } = require('../controllers/alerts.controller');
const { optionalAuth } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');


router.get('/', protect, rateLimiter(30), getAlerts);
router.post('/', protect, rateLimiter(20), createAlert);

module.exports = router;
