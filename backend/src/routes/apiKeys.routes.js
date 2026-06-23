const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getApiKeysData, createApiKey, revokeApiKey } = require('../controllers/apiKeys.controller');
const { rateLimiter } = require('../middleware/rateLimit.middleware');

router.get('/dashboard-data', protect, rateLimiter(10), getApiKeysData);
router.post('/create',        protect, rateLimiter(5),  createApiKey);
router.delete('/:id',         protect,                  revokeApiKey);

module.exports = router;