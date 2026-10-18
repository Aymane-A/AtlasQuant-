/**
 * middleware/auth.middleware.js — AtlasQuant AI
 * Verifies the JWT on protected routes AND that its session was not revoked.
 *
 * The JWT is read from, in this order:
 *   1. `Authorization: Bearer …`  — API keys (aq_live_…) and legacy JWTs issued before the cookie migration.
 *   2. the HttpOnly `aq_session` cookie — what the SPA uses now. Because a cookie is sent automatically by
 *      the browser, state-changing requests authenticated this way must carry a valid X-CSRF-Token
 *      (see utils/authCookie.js).
 */
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const env    = require('../config/env');
const db     = require('../config/db');
const logger = require('../utils/logger');
const { getCookieToken, csrfProblem } = require('../utils/authCookie');

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
 * revokeToken — mark the session of this token as revoked (logout, refresh rotation).
 * If the token has no session row (issued before sessions were tracked) a revoked row is inserted,
 * so the old token cannot be replayed.
 */
async function revokeToken(userId, token, req) {
  const h = hashToken(token);
  const upd = await db.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE user_id = $1 AND refresh_hash = $2 AND revoked_at IS NULL`,
    [userId, h]
  );
  if (upd && upd.rowCount > 0) return;
  const { rows } = await db.query(
    'SELECT 1 FROM user_sessions WHERE user_id = $1 AND refresh_hash = $2 LIMIT 1',
    [userId, h]
  );
  if (rows && rows.length > 0) return; // already revoked
  await db.query(
    `INSERT INTO user_sessions (user_id, refresh_hash, ip_address, user_agent, revoked_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [userId, h, (req && req.ip) || null, (req && req.headers && req.headers['user-agent']) || null]
  );
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
  req.authVia = 'api_key';
  return next();
}

/**
 * extractCredential — where did the client put its token?
 * Bearer wins over the cookie. API keys are only honoured through the Authorization header.
 */
function extractCredential(req) {
  const authHeader = req.headers && req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return { token: authHeader.split(' ')[1], via: 'bearer' };
  const cookieToken = getCookieToken(req);
  if (cookieToken) return { token: cookieToken, via: 'cookie' };
  return null;
}

/**
 * protect — require valid, non-revoked JWT (cookie or Bearer) or a read-only API key
 * Add to any route: router.get('/protected', protect, handler)
 *
 * req.currentSessionHash = sha256(token): same algorithm as recordSession()
 * in security.controller.js, so listSessions() can flag "This device".
 * req.authVia = 'cookie' | 'bearer' | 'api_key'; req.authToken = the JWT (not set for API keys).
 */
async function protect(req, res, next) {
  const cred = extractCredential(req);
  if (!cred) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const { token, via } = cred;
  if (via === 'bearer' && isApiKeyToken(token)) return authenticateApiKey(req, res, next, token);

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    logger.warn(`[auth.middleware] Invalid token: ${err.message}`);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  if (via === 'cookie') {
    const problem = csrfProblem(req, token);
    if (problem) {
      logger.warn(`[auth.middleware] ${problem.code} on ${req.method} ${req.originalUrl || req.url}`);
      return res.status(problem.status).json({ success: false, error: problem.error, code: problem.code });
    }
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
  req.authVia = via;
  req.authToken = token;
  next();
}

/**
 * optionalAuth — attach user if a valid token is present, continue either way
 * (a cookie request that fails the CSRF check is simply treated as anonymous)
 */
async function optionalAuth(req, res, next) {
  const cred = extractCredential(req);
  if (cred && !(cred.via === 'bearer' && isApiKeyToken(cred.token))) {
    try {
      const { token, via } = cred;
      const decoded = jwt.verify(token, env.JWT_SECRET);
      if (via === 'cookie' && csrfProblem(req, token)) return next();
      if (!(await isSessionRevoked(decoded.id, token))) {
        req.user = decoded;
        req.currentSessionHash = hashToken(token);
        req.authVia = via;
        req.authToken = token;
      }
    } catch { /* no-op: treated as anonymous */ }
  }
  next();
}

module.exports = { protect, optionalAuth, isSessionRevoked, revokeToken, extractCredential, hashToken, isApiKeyToken };
