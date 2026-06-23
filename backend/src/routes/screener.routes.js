const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { runScreen } = require('../controllers/screener.controller');
const { rateLimiter } = require('../middleware/rateLimit.middleware'); 

router.post('/run', protect, rateLimiter(5), runScreen); 

module.exports = router;