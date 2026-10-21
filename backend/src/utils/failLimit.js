/**
 * utils/failLimit.js — AtlasQuant AI
 *
 * Per-ACCOUNT lockout for sensitive, already-authenticated actions (change password, disable 2FA,
 * delete account). The IP rate limiter alone does not stop someone holding a stolen session from
 * guessing the current password or a TOTP code from many IPs, so failures are counted per user in
 * audit_log (the same mechanism the login lockout uses).
 *
 *   if (await isLocked(userId, 'password_change_failed')) -> answer 429
 *   ... on a wrong password / code: await recordFailure(userId, 'password_change_failed', req)
 */
const db = require('../config/db');
const { logAuditEvent } = require('./auditLog');

const MAX_FAILURES = 5;
const WINDOW_MIN   = 15;

async function isLocked(userId, eventType) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE user_id = $1 AND event_type = $2
        AND created_at > NOW() - make_interval(mins => $3)`,
    [userId, eventType, WINDOW_MIN]
  );
  return (rows[0]?.n || 0) >= MAX_FAILURES;
}

function recordFailure(userId, eventType, req) {
  return logAuditEvent(userId, eventType, req);
}

function lockedResponse(res) {
  return res.status(429).json({
    success: false,
    code: 'TOO_MANY_ATTEMPTS',
    error: `Trop de tentatives échouées. Réessayez dans ${WINDOW_MIN} minutes.`,
  });
}

module.exports = { isLocked, recordFailure, lockedResponse, MAX_FAILURES, WINDOW_MIN };
