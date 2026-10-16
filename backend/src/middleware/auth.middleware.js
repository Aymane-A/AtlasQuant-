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

// ── API keys (aq_live_…) ─────────────────────────────────────
// ✅ Audit 3: les clés créées dans Settings → API Keys étaient stockées mais
// jamais acceptées. Elles sont maintenant honorées en LECTURE SEULE :
//   - GET/HEAD uniquement (aucune écriture, aucun ordre, même avec scope "trade")
//   - jamais sur les routes de compte/sécurité (clés, 2FA, sessions, réglages,
//     exchanges, auth) : une clé volée ne doit pas pouvoir en créer d'autres
//     ni exporter les données du compte.
const API_KEY_PREFIX = 'aq_live_';
const API_KEY_BLOCKED_PREFIXES = ['/api/security', '/api/settings', '/api/exchanges', '/api/auth'];

function isApiKeyToken(token) { return typeof token === 'string' && token.startsWith(API_KEY_PREFIX); }

function apiKeyPathBlocked(req) {
  const url = String(req.originalUrl || (req.baseUrl || '') + (req.path || '')).split('?')[0].toLowerCase();
  return API_KEY_BLOCKED_PREFIXES.some((p) => url === p || url.startsWith(p + '/'));
}

async function authenticateApiKey(req, res, next, token) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({ success: false, error: 'API keys are read-only (GET requests only)', code: 'API_KEY_READ_ONLY' });
  }
  if (apiKeyPathBlocked(req)) {
    return res.status(403).json({ success: false, error: 'API keys cannot access this endpoint', code: 'API_KEY_FORBIDDEN' });
  }
  let row;
  try {
    const { rows } = await db.query(
      `SELECT k.id AS key_id, k.user_id, u.email, u.plan
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hashToken(token)]
    );
    row = rows[0];
  } catch (err) {
    logger.error(`[auth.middleware] API key lookup failed: ${err.message}`);
    return res.status(503).json({ success: false, error: 'Auth service temporarily unavailable' });
  }
  if (!row) return res.status(401).json({ success: false, error: 'Invalid or expired token' });

  db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.key_id])
    .catch((e) => logger.warn(`[auth.middleware] last_used_at update failed: ${e.message}`));

  req.user = { id: row.user_id, email: row.email, plan: row.plan, via: 'api_key', scopes: ['read'] };
  req.currentSessionHash = null;
  return next();
}

/**
 * protect — require valid, non-revoked JWT (or a read-only API key)
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
  if (isApiKeyToken(token)) return authenticateApiKey(req, res, next, token);

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

module.exports = { protect, optionalAuth, isSessionRevoked, hashToken, isApiKeyToken };
