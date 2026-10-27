/**
 * utils/secondFactor.js — AtlasQuant AI
 *
 * One place that checks a second factor (TOTP code or backup code) for sensitive actions of an
 * ALREADY logged-in user: disable 2FA, delete the account. Same rules as the login step.
 */
const crypto    = require('crypto');
const speakeasy = require('speakeasy');
const { decryptTotpSecret } = require('./secretBox');

/**
 * @param user  { twofa_secret, twofa_backup_codes } (row of users)
 * @param code  what the person typed: 6-digit TOTP code or a backup code
 * @returns boolean (never throws on bad input)
 */
function verifySecondFactor(user, code) {
  if (typeof code !== 'string' || !code.trim() || !user) return false;
  const clean = code.replace(/\s/g, '');

  let secret = null;
  try { secret = user.twofa_secret ? decryptTotpSecret(user.twofa_secret) : null; } catch { secret = null; }
  if (secret && /^\d{6}$/.test(clean) && speakeasy.totp.verify({ secret, encoding: 'base32', token: clean, window: 1 })) return true;

  const hash  = crypto.createHash('sha256').update(clean.toLowerCase()).digest('hex');
  const codes = Array.isArray(user.twofa_backup_codes) ? user.twofa_backup_codes : [];
  return codes.includes(hash);
}

module.exports = { verifySecondFactor };
