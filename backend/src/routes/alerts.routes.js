/**
 * src/routes/alerts.routes.js — AtlasQuant AI
 */
const express  = require('express');
const router   = express.Router();
const { protect }    = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const {
  getAlerts, getHistory, createAlert, updateAlert,
  deleteAlert, togglePause, snoozeAlert, resetAlert,
  clearAllTriggered, markAsRead, markAllRead,
} = require('../controllers/alerts.controller');

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/',            protect, rateLimiter(30), getAlerts);
router.get('/history',     protect, rateLimiter(30), getHistory);
router.post('/',           protect, rateLimiter(20), createAlert);

router.delete('/triggered/all', protect, rateLimiter(10), clearAllTriggered);

router.patch('/read-all',  protect, rateLimiter(10), markAllRead);
router.patch('/:id/read',  protect, rateLimiter(30), markAsRead);

router.patch('/:id',       protect, rateLimiter(20), updateAlert);

router.delete('/:id',      protect, rateLimiter(30), deleteAlert);
router.patch('/:id/pause', protect, rateLimiter(30), togglePause);

// ✅ Fix: route manquante — snoozeAlert existait déjà dans le controller
// (exporté) mais aucune route ne pointait dessus. Le bouton "Snooze 1h/4h/24h"
// côté Alerts.jsx appelait PATCH /alerts/:id/snooze et recevait un 404 muet.
router.patch('/:id/snooze', protect, rateLimiter(20), snoozeAlert);

router.patch('/:id/reset', protect, rateLimiter(30), resetAlert);

module.exports = router;