/**
 * Run: cd backend && npm test
 * Uses an in-memory fake for config/db — no PostgreSQL needed.
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const crypto = require('node:crypto');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

// ── fake db injected into the require cache ─────────────────
const dbPath = require.resolve('../src/config/db');
const fake = { handler: async () => ({ rows: [] }), calls: [] };
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (sql, params) => { fake.calls.push({ sql, params }); return fake.handler(sql, params); }, ready: Promise.resolve() },
};

const { protect } = require('../src/middleware/auth.middleware');
const authCtrl    = require('../src/controllers/auth.controller');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  return r;
};
const mkReq = (over = {}) => ({ headers: {}, body: {}, ip: '1.2.3.4', ...over });
const tokenFor = (extra = {}, opts = { expiresIn: '1h' }) =>
  jwt.sign({ id: 7, email: 'a@b.co', plan: 'free', ...extra }, process.env.JWT_SECRET, opts);

// ── protect() ───────────────────────────────────────────────
test('protect: rejects missing token', async () => {
  const res = mkRes(); let nexted = false;
  await protect(mkReq(), res, () => { nexted = true; });
  assert.equal(res.statusCode, 401); assert.equal(nexted, false);
});

test('protect: accepts valid token with no revoked session', async () => {
  fake.handler = async () => ({ rows: [{ revoked_at: null }] });
  const res = mkRes(); const req = mkReq({ headers: { authorization: `Bearer ${tokenFor()}` } });
  let nexted = false;
  await protect(req, res, () => { nexted = true; });
  assert.equal(nexted, true); assert.equal(req.user.id, 7);
});

test('protect: accepts valid token with no session row (legacy token)', async () => {
  fake.handler = async () => ({ rows: [] });
  const res = mkRes(); let nexted = false;
  await protect(mkReq({ headers: { authorization: `Bearer ${tokenFor()}` } }), res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('protect: REJECTS a token whose session was revoked', async () => {
  fake.handler = async () => ({ rows: [{ revoked_at: new Date() }] });
  const res = mkRes(); let nexted = false;
  await protect(mkReq({ headers: { authorization: `Bearer ${tokenFor()}` } }), res, () => { nexted = true; });
  assert.equal(res.statusCode, 401); assert.equal(nexted, false);
});

test('protect: fails closed (503) when DB is down', async () => {
  fake.handler = async () => { throw new Error('db down'); };
  const res = mkRes(); let nexted = false;
  await protect(mkReq({ headers: { authorization: `Bearer ${tokenFor()}` } }), res, () => { nexted = true; });
  assert.equal(res.statusCode, 503); assert.equal(nexted, false);
});

// ── login() with 2FA ────────────────────────────────────────
async function userRow(over = {}) {
  return { id: 7, name: 'A', email: 'a@b.co', plan: 'free', created_at: new Date(),
    password: await bcrypt.hash('hunter22', 4),
    twofa_enabled: true, twofa_secret: speakeasy.generateSecret({ length: 20 }).base32,
    twofa_backup_codes: [], ...over };
}
const loginDb = (user) => async (sql) => (/FROM users WHERE email/.test(sql) ? { rows: [user] } : { rows: [] });

test('login: 2FA on + no code => requires2FA and NO token', async () => {
  fake.handler = loginDb(await userRow());
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22' } }), res);
  assert.equal(res.body.requires2FA, true);
  assert.equal(res.body.token, undefined);
});

test('login: 2FA on + wrong code => 401', async () => {
  fake.handler = loginDb(await userRow());
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22', totp: '000000' } }), res);
  assert.equal(res.statusCode, 401); assert.equal(res.body.token, undefined);
});

test('login: 2FA on + valid TOTP => token', async () => {
  const u = await userRow();
  fake.handler = loginDb(u);
  const res = mkRes();
  const totp = speakeasy.totp({ secret: u.twofa_secret, encoding: 'base32' });
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22', totp } }), res);
  assert.ok(res.body.token);
});

test('login: backup code works once and is consumed', async () => {
  const u = await userRow({ twofa_backup_codes: [sha('abcde12345')] });
  let saved = null;
  fake.handler = async (sql, params) => {
    if (/UPDATE users SET twofa_backup_codes/.test(sql)) { saved = JSON.parse(params[0]); return { rows: [] }; }
    return loginDb(u)(sql);
  };
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22', backupCode: 'ABCDE12345' } }), res);
  assert.ok(res.body.token); assert.deepEqual(saved, []);
});

test('login: wrong password never reaches 2FA step', async () => {
  fake.handler = loginDb(await userRow());
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'nope-nope' } }), res);
  assert.equal(res.statusCode, 401);
});

test('login: account without 2FA logs in normally', async () => {
  fake.handler = loginDb(await userRow({ twofa_enabled: false }));
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22' } }), res);
  assert.ok(res.body.token);
});

// ── refresh() ───────────────────────────────────────────────
test('refresh: token expired beyond grace window is rejected', async () => {
  const old = tokenFor({}, { expiresIn: -(3 * 86400) }); // expired 3 days ago, grace = 1 day
  fake.handler = async () => ({ rows: [{ id: 7, email: 'a@b.co', plan: 'free' }] });
  const res = mkRes();
  await authCtrl.refreshToken(mkReq({ headers: { authorization: `Bearer ${old}` } }), res);
  assert.equal(res.statusCode, 401);
});

test('refresh: recently-expired token within grace is renewed', async () => {
  const old = tokenFor({}, { expiresIn: -60 });
  fake.handler = async (sql) => (/FROM users WHERE id/.test(sql) ? { rows: [{ id: 7, email: 'a@b.co', plan: 'free' }] } : { rows: [] });
  const res = mkRes();
  await authCtrl.refreshToken(mkReq({ headers: { authorization: `Bearer ${old}` } }), res);
  assert.ok(res.body.token);
});

test('refresh: revoked session cannot refresh', async () => {
  const old = tokenFor();
  fake.handler = async (sql) => (/FROM user_sessions/.test(sql) ? { rows: [{ revoked_at: new Date() }] } : { rows: [{ id: 7, email: 'a@b.co', plan: 'free' }] });
  const res = mkRes();
  await authCtrl.refreshToken(mkReq({ headers: { authorization: `Bearer ${old}` } }), res);
  assert.equal(res.statusCode, 401);
});

// ── env guard ───────────────────────────────────────────────
test('env: production refuses to start without a strong JWT_SECRET', () => {
  const { execFileSync } = require('node:child_process');
  const run = (env) => {
    try { execFileSync('node', ['-e', "require('./src/config/env')"], { env: { PATH: process.env.PATH, ...env }, cwd: path.join(__dirname, '..'), stdio: 'pipe' }); return 0; }
    catch { return 1; }
  };
  assert.equal(run({ NODE_ENV: 'production' }), 1);                              // missing
  assert.equal(run({ NODE_ENV: 'production', JWT_SECRET: 'short' }), 1);         // too short
  assert.equal(run({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }), 0);  // ok
});

// ── trading.placeOrder validation ───────────────────────────
test('placeOrder: rejects bad quantity / side / orderType and never touches the exchange', async () => {
  const svcPath = require.resolve('../src/services/exchanges.service');
  let touched = false;
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true,
    exports: new Proxy({}, { get: () => async () => { touched = true; return null; } }) };
  const { placeOrder } = require('../src/controllers/trading.controller');

  const base = { exchangeId: 'binance', symbol: 'BTC', side: 'buy', orderType: 'market', quantity: 1 };
  for (const bad of [
    { quantity: -1 }, { quantity: 0 }, { quantity: 'abc' }, { quantity: NaN },
    { side: 'hold' }, { orderType: 'stop' }, { symbol: 'BTC/../x?y=1&z' },
    { orderType: 'limit' },                       // limit without price
    { stopLoss: -5 },
  ]) {
    const res = mkRes();
    await placeOrder(mkReq({ user: { id: 7 }, body: { ...base, ...bad } }), res);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  assert.equal(touched, false);
});
