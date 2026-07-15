/**
 * src/routes/alerts.routes.js — AtlasQuant AI
 */
const express  = require('express');
const router   = express.Router();
const { protect }    = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const {
  getAlerts, getHistory, createAlert,
  deleteAlert, togglePause, snoozeAlert, resetAlert,
  clearAllTriggered, markAsRead, markAllRead,
} = require('../controllers/alerts.controller');

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/',            protect, rateLimiter(30), getAlerts);
router.get('/history',     protect, rateLimiter(30), getHistory);
router.post('/',           protect, rateLimiter(20), createAlert);

router.delete('/triggered/all', protect, rateLimiter(10), clearAllTriggered);

// ✅ Fix "unread" mzawer
router.patch('/read-all',  protect, rateLimiter(10), markAllRead);
router.patch('/:id/read',  protect, rateLimiter(30), markAsRead);

router.delete('/:id',       protect, rateLimiter(30), deleteAlert);
router.patch('/:id/pause',  protect, rateLimiter(30), togglePause);
// ✅ Feature: Snooze — durée précise (1h/4h/24h), whitelist validée côté controller
router.patch('/:id/snooze', protect, rateLimiter(30), snoozeAlert);
router.patch('/:id/reset',  protect, rateLimiter(30), resetAlert);

module.exports = router;