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
  r.cookies = {};
  r.cookie      = (n, v, o) => { r.cookies[n] = { value: v, options: o }; return r; };
  r.clearCookie = (n, o) => { r.cleared = { name: n, options: o }; return r; };
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
const loginDb = (user, failures = 0) => async (sql) => {
  if (/FROM audit_log/.test(sql)) return { rows: [{ n: failures }] };
  return /FROM users WHERE email/.test(sql) ? { rows: [user] } : { rows: [] };
};

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
  assert.ok(res.cookies.aq_session.value);
});

test('login: backup code works once and is consumed', async () => {
  const u = await userRow({ twofa_backup_codes: [sha('abcde12345')] });
  let saved = null;
  fake.handler = async (sql, params) => {
    if (/UPDATE users SET twofa_backup_codes/.test(sql)) { saved = JSON.parse(params[0]); return { rows: [] }; }
    return loginDb(u)(sql, params);
  };
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22', backupCode: 'ABCDE12345' } }), res);
  assert.ok(res.cookies.aq_session.value); assert.deepEqual(saved, []);
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
  assert.ok(res.cookies.aq_session.value);
  assert.ok(res.body.csrfToken);
  assert.equal(res.body.token, undefined);
  assert.equal(res.cookies.aq_session.options.httpOnly, true);
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
  assert.ok(res.cookies.aq_session.value);
  assert.ok(res.body.csrfToken);
  assert.equal(res.body.token, undefined);
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
  // env.js calls dotenv, which reads ./.env from the CURRENT working directory. Run the
  // child from an empty temp dir so a developer's real backend/.env (which usually has a
  // JWT_SECRET) cannot leak into the test and make the "missing secret" case pass.
  const envJs = path.join(__dirname, '..', 'src', 'config', 'env.js');
  const run = (env) => {
    try {
      execFileSync('node', ['-e', `require(${JSON.stringify(envJs)})`], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
        cwd: require('node:os').tmpdir(), stdio: 'pipe',
      });
      return 0;
    } catch { return 1; }
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


// ── password policy + account lockout ───────────────────────
test('register: rejects passwords shorter than 8 chars and bad emails', async () => {
  fake.handler = async () => ({ rows: [] });
  for (const body of [
    { email: 'a@b.co', password: '1234567' },
    { email: 'not-an-email', password: 'longenough1' },
    { email: 'a@b', password: 'longenough1' },
  ]) {
    const res = mkRes();
    await authCtrl.register(mkReq({ body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

test('login: account is locked (429) after 5 failed attempts, even with the right password', async () => {
  fake.handler = loginDb(await userRow({ twofa_enabled: false }), 5);
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22' } }), res);
  assert.equal(res.statusCode, 429); assert.equal(res.body.token, undefined);
});

test('login: 4 failures do not lock the account yet', async () => {
  fake.handler = loginDb(await userRow({ twofa_enabled: false }), 4);
  const res = mkRes();
  await authCtrl.login(mkReq({ body: { email: 'a@b.co', password: 'hunter22' } }), res);
  assert.ok(res.cookies.aq_session.value);
  assert.ok(res.body.csrfToken);
  assert.equal(res.body.token, undefined);
  assert.equal(res.cookies.aq_session.options.httpOnly, true);
});

// ── risk guard ──────────────────────────────────────────────
const svcPath2 = require.resolve('../src/services/exchanges.service');
const fakeExchanges = { PAPER_START_CAPITAL: 10000, fetchPortfolio: async () => [] };
require.cache[svcPath2] = { id: svcPath2, filename: svcPath2, loaded: true, exports: fakeExchanges };
delete require.cache[require.resolve('../src/services/riskGuard.service')];
const riskGuard = require('../src/services/riskGuard.service');

const riskDb = ({ settings = {}, realised = 0, todayPnl = 0 } = {}) => async (sql) => {
  if (/FROM user_settings/.test(sql)) return { rows: [{ risk_max_position_pct: 20, risk_max_daily_loss_pct: 5, risk_default_stoploss_pct: 2, ...settings }] };
  if (/closed_at >= date_trunc/.test(sql)) return { rows: [{ pnl: todayPnl }] };
  if (/FROM paper_trades/.test(sql)) return { rows: [{ realised }] };
  return { rows: [] };
};
const paper = (over = {}) => ({ userId: 7, exchangeId: 'binance', mode: 'paper', side: 'buy', quantity: 1, refPrice: 1000, ...over });

test('risk: paper order within the position limit passes and gets the default stop-loss', async () => {
  fake.handler = riskDb();
  const r = await riskGuard.checkOrder(paper());            // 1000 = 10% of 10k
  assert.equal(r.ok, true); assert.equal(r.stopLoss, 980);  // buy: -2%
});

test('risk: sell gets a stop-loss ABOVE entry', async () => {
  fake.handler = riskDb();
  const r = await riskGuard.checkOrder(paper({ side: 'sell' }));
  assert.equal(r.stopLoss, 1020);
});

test('risk: order above max position % is refused with a max quantity hint', async () => {
  fake.handler = riskDb();
  const r = await riskGuard.checkOrder(paper({ quantity: 3 })); // 3000 = 30% > 20%
  assert.equal(r.ok, false); assert.equal(r.code, 'RISK_MAX_POSITION');
  assert.equal(r.details.maxQuantity, 2);
});

test('risk: equity follows realised paper P&L (losses shrink the allowed size)', async () => {
  fake.handler = riskDb({ realised: -5000 });               // equity 5000 -> limit 1000
  const r = await riskGuard.checkOrder(paper({ quantity: 1.5 })); // 1500 = 30%
  assert.equal(r.code, 'RISK_MAX_POSITION');
});

test('risk: daily loss limit blocks NEW paper positions', async () => {
  fake.handler = riskDb({ todayPnl: -600 });                // 6% of 10k >= 5%
  const r = await riskGuard.checkOrder(paper());
  assert.equal(r.ok, false); assert.equal(r.code, 'RISK_DAILY_LOSS');
});

test('risk: a gain today or a loss under the limit does not block', async () => {
  for (const todayPnl of [250, -100]) {
    fake.handler = riskDb({ todayPnl });
    assert.equal((await riskGuard.checkOrder(paper())).ok, true);
  }
});

test('risk: limits set to 0 are disabled; noStopLoss opts out; explicit SL is kept', async () => {
  // Audit 3 added a 4th limit (cumulative exposure): "all limits off" now also means exposure 0.
  fake.handler = riskDb({ settings: { risk_max_position_pct: 0, risk_max_daily_loss_pct: 0, risk_default_stoploss_pct: 0, risk_max_total_exposure_pct: 0 } });
  const big = await riskGuard.checkOrder(paper({ quantity: 50 }));
  assert.equal(big.ok, true); assert.equal(big.stopLoss, null);
  fake.handler = riskDb();
  assert.equal((await riskGuard.checkOrder(paper({ noStopLoss: true }))).stopLoss, null);
  assert.equal((await riskGuard.checkOrder(paper({ stopLoss: 900 }))).stopLoss, 900);
});

test('risk: live CEX sell is reduce-only and is never blocked', async () => {
  fake.handler = riskDb();
  const r = await riskGuard.checkOrder({ userId: 7, exchangeId: 'binance', mode: 'live', creds: {}, side: 'sell', quantity: 1000, refPrice: 1000 });
  assert.equal(r.ok, true); assert.equal(r.details.reduceOnly, true);
});

test('risk: live buy is refused when equity is unknown (strict mode), allowed with enough USDT', async () => {
  fake.handler = riskDb();
  fakeExchanges.fetchPortfolio = async () => [{ symbol: 'BTC', total: 2 }];            // no stablecoin
  const blocked = await riskGuard.checkOrder({ userId: 7, exchangeId: 'binance', mode: 'live', creds: {}, side: 'buy', quantity: 0.01, refPrice: 60000 });
  assert.equal(blocked.code, 'RISK_UNVERIFIABLE');

  fakeExchanges.fetchPortfolio = async () => [{ symbol: 'USDT', total: 10000 }];
  const tooBig = await riskGuard.checkOrder({ userId: 7, exchangeId: 'binance', mode: 'live', creds: {}, side: 'buy', quantity: 0.05, refPrice: 60000 }); // 3000 = 30%
  assert.equal(tooBig.code, 'RISK_MAX_POSITION');
  const ok = await riskGuard.checkOrder({ userId: 7, exchangeId: 'binance', mode: 'live', creds: {}, side: 'buy', quantity: 0.03, refPrice: 60000 });   // 1800 = 18%
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.some(w => /stop-loss/i.test(w)), 'CEX spot cannot carry a stop-loss -> warning');
  fakeExchanges.fetchPortfolio = async () => [];
});

// ── email verification gate for LIVE ────────────────────────
test('live gate: unverified email is refused, verified is allowed', async () => {
  const { requireVerifiedEmailForLive } = require('../src/utils/emailVerified');
  fake.handler = async () => ({ rows: [{ email_verified: false }] });
  const no = await requireVerifiedEmailForLive(7);
  assert.equal(no.ok, false); assert.equal(no.code, 'EMAIL_NOT_VERIFIED'); assert.equal(no.status, 403);
  fake.handler = async () => ({ rows: [{ email_verified: true }] });
  assert.equal((await requireVerifiedEmailForLive(7)).ok, true);
});
