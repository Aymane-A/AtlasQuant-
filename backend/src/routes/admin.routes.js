/**
 * routes/admin.routes.js — AtlasQuant AI
 * Operator-only endpoints, protected by a shared secret (ADMIN_KEY, 24+ chars) sent in the
 * X-Admin-Key header. If ADMIN_KEY is not configured the endpoints answer 404 (feature off).
 *
 * GET  /api/admin/kill-switch                      -> { engaged, reason, since }
 * POST /api/admin/kill-switch  { enabled, reason } -> new state
 */
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const killSwitch = require('../utils/killSwitch');
const logger  = require('../utils/logger');
const { rateLimiter } = require('../middleware/rateLimit.middleware');

function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_KEY || '';
  if (expected.length < 24) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const given = String(req.get('x-admin-key') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    logger.warn(`[admin] Rejected admin request from ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Invalid admin key' });
  }
  next();
}

router.use(rateLimiter(20), requireAdminKey);

router.get('/kill-switch', (req, res) => res.json({ success: true, ...killSwitch.status() }));

router.post('/kill-switch', (req, res) => {
  const { enabled, reason } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: '"enabled" must be true or false' });
  }
  const state = killSwitch.set(enabled, reason);
  logger.warn(`[admin] Kill-switch ${state.engaged ? 'ENGAGED' : 'released'}${state.reason ? ` (${state.reason})` : ''}`);
  res.json({ success: true, ...state });
});

module.exports = router;
