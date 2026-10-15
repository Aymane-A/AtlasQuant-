/**
 * utils/emailVerified.js — gate sensitive actions (live trading) behind a verified email.
 * Controlled by REQUIRE_VERIFIED_EMAIL_FOR_LIVE (default: on).
 */
const db  = require('../config/db');
const env = require('../config/env');

const MESSAGE = 'Verify your email before using LIVE trading (Settings → Profile → Resend verification email).';

/** Resolves { ok:true } or { ok:false, status, code, error }. */
async function requireVerifiedEmailForLive(userId) {
  if (!env.REQUIRE_VERIFIED_EMAIL_FOR_LIVE) return { ok: true };
  const { rows } = await db.query('SELECT email_verified FROM users WHERE id = $1', [userId]);
  if (!rows.length || !rows[0].email_verified) {
    return { ok: false, status: 403, code: 'EMAIL_NOT_VERIFIED', error: MESSAGE };
  }
  return { ok: true };
}

module.exports = { requireVerifiedEmailForLive };
