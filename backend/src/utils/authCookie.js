/**
 * utils/authCookie.js — AtlasQuant AI
 *
 * Session cookie + CSRF helpers (HttpOnly-cookie auth).
 *
 *  - The JWT lives in an HttpOnly cookie (`aq_session`): JavaScript (and therefore XSS) can never read it.
 *  - Because browsers attach cookies automatically, every state-changing request authenticated by the
 *    cookie must also carry `X-CSRF-Token`. That token is HMAC(JWT_SECRET, sha256(jwt)): it is bound to
 *    ONE session (a token from another session / user is useless) and needs no extra storage. The SPA
 *    receives it in the JSON body of login/register/refresh/me and keeps it in memory only.
 *  - Defence in depth: if the browser sends an Origin header, it must be an allowed origin.
 *  - `Authorization: Bearer …` (API keys, legacy JWTs from before this change) is not ambient, so it needs no CSRF token.
 *
 * No cookie-parser dependency: we only ever read one cookie.
 */
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const env    = require('../config/env');

const COOKIE_NAME  = 'aq_session';
const COOKIE_PATH  = '/api';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;            // first occurrence wins
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function getCookieToken(req) {
  return parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME] || null;
}

/** CSRF token bound to this exact JWT. */
function csrfFor(token) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update('csrf:' + sha256(String(token))).digest('base64url');
}

function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method || 'GET').toUpperCase());
}

function allowedOrigins() {
  return [
    env.FRONTEND_URL,
    ...(env.IS_PRODUCTION ? [] : ['http://localhost:3000', 'http://localhost:4173']),
    ...env.ALLOWED_ORIGINS,
  ];
}

/**
 * Returns null when the request may proceed, or { status, code, error } when it must be refused.
 * Only call it for requests authenticated by the cookie.
 */
function csrfProblem(req, token) {
  if (isSafeMethod(req.method)) return null;

  const origin = req.headers && req.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) {
    return { status: 403, code: 'CSRF_ORIGIN', error: 'Origin not allowed' };
  }

  const sent = req.headers && req.headers['x-csrf-token'];
  const want = csrfFor(token);
  if (typeof sent !== 'string' || sent.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) {
    return { status: 403, code: 'CSRF_INVALID', error: 'Missing or invalid CSRF token' };
  }
  return null;
}

function baseCookieOptions() {
  const o = {
    httpOnly: true,
    secure:   env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path:     COOKIE_PATH,
  };
  if (env.COOKIE_DOMAIN) o.domain = env.COOKIE_DOMAIN;
  return o;
}

/** Cookie lives as long as the JWT + the refresh grace window, so an expired session can still be refreshed. */
function setAuthCookie(res, token) {
  const decoded = jwt.decode(token);
  const now = Math.floor(Date.now() / 1000);
  const ttlSec = decoded && decoded.exp ? Math.max(60, decoded.exp - now + env.REFRESH_GRACE_SECONDS) : 7 * 86400;
  res.cookie(COOKIE_NAME, token, { ...baseCookieOptions(), maxAge: ttlSec * 1000 });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, baseCookieOptions());
}

module.exports = {
  COOKIE_NAME, parseCookies, getCookieToken, csrfFor, csrfProblem, isSafeMethod,
  setAuthCookie, clearAuthCookie,
};
