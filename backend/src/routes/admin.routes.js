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
const { logAuditEvent } = require('../utils/auditLog');
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

router.get('/kill-switch', async (req, res) => {
  try {
    await killSwitch.refresh();
    return res.json({ success: true, ...killSwitch.status(), persisted: true });
  } catch (err) {
    // database unreadable: report the local view, and say it may be stale (orders fail closed anyway)
    logger.error(`[admin] kill-switch state unreadable: ${err.message}`);
    return res.json({ success: true, ...killSwitch.status(), persisted: false, stale: true });
  }
});

router.post('/kill-switch', async (req, res) => {
  const { enabled, reason } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: '"enabled" must be true or false' });
  }
  try {
    const state = await killSwitch.set(enabled, reason, { by: 'admin-key', ip: req.ip });
    logger.warn(`[admin] Kill-switch ${state.engaged ? 'ENGAGED' : 'released'}${state.reason ? ` (${state.reason})` : ''}${state.persisted ? '' : ' — NOT persisted'}`);
    // audit trail (user_id is NULL: this is an operator action, not a user one); never blocks the response
    try { await logAuditEvent(null, enabled ? 'kill_switch_engaged' : 'kill_switch_released', req, { reason: state.reason }); } catch { /* best effort */ }
    return res.json({ success: true, ...state });
  } catch (err) {
    // release could not be persisted: the switch stays engaged
    logger.error(`[admin] kill-switch release failed, switch stays engaged: ${err.message}`);
    return res.status(503).json({ success: false, ...killSwitch.status(), error: 'Could not persist the release; the kill switch stays engaged.' });
  }
});

module.exports = router;
