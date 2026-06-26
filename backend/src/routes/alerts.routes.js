/**
 * src/routes/alerts.routes.js — AtlasQuant AI
 */

const express    = require('express');
const router     = express.Router();
const { protect }                                   = require('../middleware/auth.middleware');
const { rateLimiter }                               = require('../middleware/rateLimit.middleware');
const { getAlerts, createAlert, deleteAlert, togglePause } = require('../controllers/alerts.controller');

// Force no-cache
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/',              protect, rateLimiter(30), getAlerts);
router.post('/',             protect, rateLimiter(20), createAlert);
router.delete('/:id',        protect, rateLimiter(30), deleteAlert);
router.patch('/:id/pause',   protect, rateLimiter(30), togglePause);

module.exports = router;