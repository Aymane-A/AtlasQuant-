/**
 * middleware/auth.middleware.js — AtlasQuant AI
 * Verifies the JWT on protected routes AND that its session was not revoked.
 */
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const env    = require('../config/env');
const db     = require('../config/db');
const logger = require('../utils/logger');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * isSessionRevoked — true if the session row for this token was revoked.
 * Tokens with no session row (issued before sessions were tracked) are still
 * accepted: only an explicit revocation blocks a token.
 * Throws on DB errors so callers can fail closed.
 */
async function isSessionRevoked(userId, token) {
  const { rows } = await db.query(
    `SELECT revoked_at FROM user_sessions
     WHERE user_id = $1 AND refresh_hash = $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, hashToken(token)]
  );
  return rows.length > 0 && rows[0].revoked_at !== null;
}

/**
 * protect — require valid, non-revoked JWT
 * Add to any route: router.get('/protected', protect, handler)
 *
 * req.currentSessionHash = sha256(token): same algorithm as recordSession()
 * in security.controller.js, so listSessions() can flag "This device".
 */
async function protect(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    logger.warn(`[auth.middleware] Invalid token: ${err.message}`);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  try {
    if (await isSessionRevoked(decoded.id, token)) {
      return res.status(401).json({ success: false, error: 'Session revoked' });
    }
  } catch (err) {
    // Fail closed: if we can't prove the session is valid, don't let it through.
    logger.error(`[auth.middleware] Session check failed: ${err.message}`);
    return res.status(503).json({ success: false, error: 'Auth service temporarily unavailable' });
  }

  req.user = decoded;
  req.currentSessionHash = hashToken(token);
  next();
}

/**
 * optionalAuth — attach user if a valid token is present, continue either way
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token   = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, env.JWT_SECRET);
      if (!(await isSessionRevoked(decoded.id, token))) {
        req.user = decoded;
        req.currentSessionHash = hashToken(token);
      }
    } catch { /* no-op: treated as anonymous */ }
  }
  next();
}

module.exports = { protect, optionalAuth, isSessionRevoked, hashToken };
