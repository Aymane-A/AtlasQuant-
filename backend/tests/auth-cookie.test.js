/**
 * HttpOnly-cookie auth: cookie parsing, CSRF binding, legacy-Bearer migration, logout/refresh rotation.
 * Run: cd backend && node --test tests/auth-cookie.test.js   (in-memory fake DB, no PostgreSQL needed)
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const jwt    = require('jsonwebtoken');

const dbPath = require.resolve('../src/config/db');
const fake = { handler: async () => ({ rows: [] }), calls: [] };
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (sql, params) => { fake.calls.push({ sql, params }); return fake.handler(sql, params); }, ready: Promise.resolve() },
};

const { protect, optionalAuth } = require('../src/middleware/auth.middleware');
const authCtrl = require('../src/controllers/auth.controller');
const cookies  = require('../src/utils/authCookie');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const mkRes = () => {
  const r = { statusCode: 200, body: null, cookies: {}, cleared: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  r.cookie = (n, v, o) => { r.cookies[n] = { value: v, options: o }; return r; };
  r.clearCookie = (n, o) => { r.cleared = { name: n, options: o }; return r; };
  return r;
};
const tokenFor = (extra = {}, opts = { expiresIn: '1h' }) =>
  jwt.sign({ id: 7, email: 'a@b.co', plan: 'free', ...extra }, process.env.JWT_SECRET, opts);
const cookieHeader = (token) => `theme=dark; aq_session=${encodeURIComponent(token)}; other=1`;
const mkReq = (over = {}) => ({ method: 'GET', headers: {}, body: {}, ip: '1.2.3.4', originalUrl: '/api/x', ...over });
const run = async (req) => { const res = mkRes(); let nexted = false; await protect(req, res, () => { nexted = true; }); return { res, nexted }; };

test.beforeEach(() => { fake.calls = []; fake.handler = async () => ({ rows: [] }); });

// ── cookie parsing ──────────────────────────────────────────
test('parseCookies: several cookies, quotes, encoding, first occurrence wins, garbage tolerated', () => {
  const p = cookies.parseCookies('a=1; b="two"; c=x%20y; a=2; junk; =nokey');
  assert.deepEqual(p, { a: '1', b: 'two', c: 'x y' });
  assert.deepEqual(cookies.parseCookies(undefined), {});
  assert.deepEqual(cookies.parseCookies('c=%E0%A4%A'), { c: '%E0%A4%A' });  // bad escape: kept raw, no throw
});

// ── protect(): cookie + CSRF ────────────────────────────────
test('protect: cookie-authenticated GET passes without a CSRF token', async () => {
  const token = tokenFor();
  const { nexted } = await run(mkReq({ headers: { cookie: cookieHeader(token) } }));
  assert.equal(nexted, true);
});

test('protect: cookie + POST without X-CSRF-Token => 403 CSRF_INVALID', async () => {
  const token = tokenFor();
  const { res, nexted } = await run(mkReq({ method: 'POST', headers: { cookie: cookieHeader(token) } }));
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'CSRF_INVALID'); assert.equal(nexted, false);
});

test('protect: cookie + POST with the right CSRF token passes and exposes the token/via', async () => {
  const token = tokenFor();
  const req = mkReq({ method: 'POST', headers: { cookie: cookieHeader(token), 'x-csrf-token': cookies.csrfFor(token) } });
  const { nexted } = await run(req);
  assert.equal(nexted, true); assert.equal(req.authVia, 'cookie'); assert.equal(req.authToken, token);
  assert.equal(req.currentSessionHash, sha(token));
});

test('protect: a CSRF token minted for ANOTHER session is rejected', async () => {
  const mine = tokenFor(); const other = tokenFor({ id: 8, email: 'x@y.co' });
  const { res } = await run(mkReq({ method: 'DELETE', headers: { cookie: cookieHeader(mine), 'x-csrf-token': cookies.csrfFor(other) } }));
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'CSRF_INVALID');
});

test('protect: wrong-length / non-string CSRF header never throws, just 403', async () => {
  const token = tokenFor();
  for (const bad of ['', 'x', 'a'.repeat(500), ['a', 'b']]) {
    const { res } = await run(mkReq({ method: 'PUT', headers: { cookie: cookieHeader(token), 'x-csrf-token': bad } }));
    assert.equal(res.statusCode, 403);
  }
});

test('protect: cookie request from a foreign Origin is refused even with a valid CSRF token', async () => {
  const token = tokenFor();
  const { res } = await run(mkReq({ method: 'POST', headers: { cookie: cookieHeader(token), 'x-csrf-token': cookies.csrfFor(token), origin: 'https://evil.example' } }));
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'CSRF_ORIGIN');
});

test('protect: the configured frontend origin is accepted', async () => {
  const token = tokenFor();
  const env = require('../src/config/env');
  const { nexted } = await run(mkReq({ method: 'POST', headers: { cookie: cookieHeader(token), 'x-csrf-token': cookies.csrfFor(token), origin: env.FRONTEND_URL } }));
  assert.equal(nexted, true);
});

test('protect: Bearer JWT (legacy sessions) still works on POST without CSRF — header auth is not ambient', async () => {
  const token = tokenFor();
  const { nexted } = await run(mkReq({ method: 'POST', headers: { authorization: `Bearer ${token}` } }));
  assert.equal(nexted, true);
});

test('protect: Bearer wins over the cookie', async () => {
  const bearer = tokenFor(); const cookie = tokenFor({ id: 99, email: 'c@d.co' });
  const req = mkReq({ headers: { authorization: `Bearer ${bearer}`, cookie: cookieHeader(cookie) } });
  await run(req);
  assert.equal(req.user.id, 7); assert.equal(req.authVia, 'bearer');
});

test('protect: an aq_live_ API key smuggled through the cookie is NOT treated as an API key', async () => {
  const { res, nexted } = await run(mkReq({ headers: { cookie: 'aq_session=aq_live_abcdef' } }));
  assert.equal(res.statusCode, 401); assert.equal(nexted, false);
  assert.ok(!fake.calls.some(c => /api_keys/.test(c.sql)));
});

test('protect: revoked session in the cookie => 401', async () => {
  const token = tokenFor();
  fake.handler = async (sql) => (/FROM user_sessions/.test(sql) ? { rows: [{ revoked_at: new Date() }] } : { rows: [] });
  const { res } = await run(mkReq({ headers: { cookie: cookieHeader(token) } }));
  assert.equal(res.statusCode, 401);
});

test('optionalAuth: cookie POST without CSRF stays anonymous; with CSRF it is authenticated', async () => {
  const token = tokenFor();
  let req = mkReq({ method: 'POST', headers: { cookie: cookieHeader(token) } });
  await optionalAuth(req, mkRes(), () => {});
  assert.equal(req.user, undefined);
  req = mkReq({ method: 'POST', headers: { cookie: cookieHeader(token), 'x-csrf-token': cookies.csrfFor(token) } });
  await optionalAuth(req, mkRes(), () => {});
  assert.equal(req.user.id, 7);
});

// ── cookie attributes ───────────────────────────────────────
test('setAuthCookie: HttpOnly, path /api, lifetime = JWT lifetime + refresh grace', () => {
  const env = require('../src/config/env');
  const token = tokenFor({}, { expiresIn: '1h' });
  const res = mkRes(); cookies.setAuthCookie(res, token);
  const c = res.cookies.aq_session;
  assert.equal(c.value, token);
  assert.equal(c.options.httpOnly, true);
  assert.equal(c.options.path, '/api');
  assert.equal(c.options.sameSite, env.COOKIE_SAMESITE);
  const expected = (3600 + env.REFRESH_GRACE_SECONDS) * 1000;
  assert.ok(Math.abs(c.options.maxAge - expected) < 5000, `maxAge ${c.options.maxAge} vs ${expected}`);
});

// ── /me, refresh, logout ────────────────────────────────────
test('getMe: returns the CSRF token bound to the session token', async () => {
  fake.handler = async () => ({ rows: [{ id: 7, name: 'A', email: 'a@b.co', plan: 'free', created_at: new Date() }] });
  const token = tokenFor(); const res = mkRes();
  await authCtrl.getMe({ user: { id: 7 }, authToken: token }, res);
  assert.equal(res.body.csrfToken, cookies.csrfFor(token));
});

test('refresh: legacy Bearer token is exchanged for a cookie session and the old token is revoked', async () => {
  const old = tokenFor();
  fake.handler = async (sql) => (/FROM users WHERE id/.test(sql) ? { rows: [{ id: 7, email: 'a@b.co', plan: 'free' }] } : { rows: [] });
  const res = mkRes();
  await authCtrl.refreshToken(mkReq({ method: 'POST', headers: { authorization: `Bearer ${old}` } }), res);
  assert.equal(res.statusCode, 200);
  const fresh = res.cookies.aq_session.value;
  assert.ok(fresh && fresh !== old);
  assert.equal(res.body.csrfToken, cookies.csrfFor(fresh));
  assert.equal(res.body.token, undefined);
  const revoke = fake.calls.filter(c => /revoked_at/.test(c.sql) && c.params?.includes(sha(old)));
  assert.ok(revoke.length > 0, 'old token must be revoked (UPDATE or INSERT of a revoked row)');
});

test('refresh: cookie-authenticated refresh needs the CSRF token', async () => {
  const old = tokenFor();
  fake.handler = async (sql) => (/FROM users WHERE id/.test(sql) ? { rows: [{ id: 7, email: 'a@b.co', plan: 'free' }] } : { rows: [] });
  let res = mkRes();
  await authCtrl.refreshToken(mkReq({ method: 'POST', headers: { cookie: cookieHeader(old) } }), res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'CSRF_INVALID'); assert.equal(res.cookies.aq_session, undefined);

  res = mkRes();
  await authCtrl.refreshToken(mkReq({ method: 'POST', headers: { cookie: cookieHeader(old), 'x-csrf-token': cookies.csrfFor(old) } }), res);
  assert.equal(res.statusCode, 200); assert.ok(res.cookies.aq_session.value);
});

test('refresh: no credential at all => 401', async () => {
  const res = mkRes();
  await authCtrl.refreshToken(mkReq({ method: 'POST' }), res);
  assert.equal(res.statusCode, 401);
});

test('logout: revokes the current session and clears the cookie', async () => {
  const token = tokenFor(); const res = mkRes();
  await authCtrl.logout({ user: { id: 7, email: 'a@b.co' }, authToken: token, headers: {}, ip: '1.2.3.4' }, res);
  assert.equal(res.body.success, true);
  assert.equal(res.cleared.name, 'aq_session');
  assert.equal(res.cleared.options.httpOnly, true);
  assert.ok(fake.calls.some(c => /revoked_at/.test(c.sql) && c.params?.includes(sha(token))));
});

test('logout: a DB failure still clears the cookie', async () => {
  fake.handler = async () => { throw new Error('db down'); };
  const res = mkRes();
  await authCtrl.logout({ user: { id: 7, email: 'a@b.co' }, authToken: tokenFor(), headers: {}, ip: '1.2.3.4' }, res);
  assert.equal(res.cleared.name, 'aq_session'); assert.equal(res.body.success, true);
});

// ── env guard ───────────────────────────────────────────────
test('env: COOKIE_SAMESITE=none without Secure is refused; invalid value is refused', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const envJs = path.join(__dirname, '..', 'src', 'config', 'env.js');
  const exit = (env) => {
    try {
      execFileSync('node', ['-e', `require(${JSON.stringify(envJs)})`], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, JWT_SECRET: 'x'.repeat(40), ...env },
        cwd: require('node:os').tmpdir(), stdio: 'pipe',
      });
      return 0;
    } catch { return 1; }
  };
  assert.equal(exit({ NODE_ENV: 'development', COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' }), 1);
  assert.equal(exit({ NODE_ENV: 'development', COOKIE_SAMESITE: 'bogus' }), 1);
  assert.equal(exit({ NODE_ENV: 'development', COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' }), 0);
  assert.equal(exit({ NODE_ENV: 'development' }), 0);
});
