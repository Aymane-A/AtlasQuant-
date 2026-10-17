/**
 * utils/killSwitch.js — AtlasQuant AI
 *
 * Global emergency stop for NEW orders (manual /api/trading/order and the auto-trader).
 * Cancelling existing orders stays possible.
 *
 *  - Boot state comes from TRADING_KILL_SWITCH=true (so a restart cannot silently re-enable trading
 *    while the env says it must stay off).
 *  - Runtime toggle: POST /api/admin/kill-switch with the X-Admin-Key header (see routes/admin.routes.js).
 *    The runtime state is in-memory: a restart goes back to the env value.
 */
let engaged = String(process.env.TRADING_KILL_SWITCH || '').toLowerCase() === 'true';
let reason  = engaged ? 'TRADING_KILL_SWITCH=true at startup' : null;
let since   = engaged ? new Date().toISOString() : null;

function isEngaged() { return engaged; }

function set(enabled, why) {
  engaged = !!enabled;
  reason  = engaged ? (String(why || 'manual').slice(0, 200)) : null;
  since   = engaged ? new Date().toISOString() : null;
  return status();
}

function status() { return { engaged, reason, since }; }

/** Express-style guard result for order entry points. */
function blockedResponse() {
  return {
    status: 503,
    body: { success: false, code: 'TRADING_DISABLED', error: 'New orders are temporarily disabled by the operator (kill-switch).' },
  };
}

module.exports = { isEngaged, set, status, blockedResponse };
