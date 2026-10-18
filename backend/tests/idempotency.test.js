/**
 * Audit 4 — order idempotency + atomic exposure reservation (logic tests, no PostgreSQL needed).
 * The fake database models Postgres semantics: ON CONFLICT DO NOTHING, and a per-user advisory lock that is
 * held until COMMIT/ROLLBACK. The REAL proof on PostgreSQL is tests/pg-integration.test.js (TEST_DATABASE_URL).
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');

const state = { idem: new Map(), open: [], deletes: 0, failIdem: false, locks: new Map() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handler(sql, params = []) {
  if (/idempotency_keys/.test(sql) && state.failIdem && !/DELETE/.test(sql)) throw new Error('idempotency store down');
  if (/INSERT INTO idempotency_keys/.test(sql)) {
    const k = `${params[0]}|${params[1]}|${params[2]}`;
    if (state.idem.has(k)) return { rows: [] };                       // ON CONFLICT DO NOTHING
    state.idem.set(k, { request_hash: params[3], status: 'in_progress', response_status: null, response_body: null });
    return { rows: [{ key: params[2] }] };
  }
  if (/FROM idempotency_keys/.test(sql)) {
    const r = state.idem.get(`${params[0]}|${params[1]}|${params[2]}`);
    return { rows: r ? [r] : [] };
  }
  if (/UPDATE idempotency_keys/.test(sql)) {
    const r = state.idem.get(`${params[0]}|${params[1]}|${params[2]}`);
    Object.assign(r, { status: 'completed', response_status: params[3], response_body: JSON.parse(params[4]) });
    return { rows: [] };
  }
  if (/DELETE FROM idempotency_keys/.test(sql)) { state.deletes++; return { rows: [] }; }
  if (/FROM user_settings/.test(sql)) return { rows: [{ risk_max_position_pct: 20, risk_max_daily_loss_pct: 50, risk_default_stoploss_pct: 2, risk_max_total_exposure_pct: 100 }] };
  if (/quantity \* price/.test(sql)) { await sleep(1); return { rows: [{ notional: state.open.reduce((a, t) => a + t.quantity * t.price, 0) }] }; }
  if (/closed_at >=/.test(sql)) return { rows: [{ pnl: 0 }] };
  if (/SUM\(pnl\)/.test(sql)) return { rows: [{ realised: 0 }] };
  if (/INSERT INTO paper_trades/.test(sql)) { await sleep(2); const t = { id: state.open.length + 1, quantity: params[5], price: params[6] }; state.open.push(t); return { rows: [t] }; }
  return { rows: [] };
}

function getClient() {
  const held = [];
  return Promise.resolve({
    released: false,
    async query(sql, params) {
      if (/^\s*BEGIN/.test(sql) || /^\s*SET LOCAL/.test(sql)) return { rows: [] };
      if (/pg_advisory_xact_lock/.test(sql)) {
        const key = String(params[1]);
        while (state.locks.get(key)) await state.locks.get(key);       // wait for the holder's COMMIT/ROLLBACK
        let release; state.locks.set(key, new Promise((r) => { release = () => { state.locks.delete(key); r(); }; }));
        held.push(release);
        return { rows: [] };
      }
      if (/^\s*(COMMIT|ROLLBACK)/.test(sql)) { held.splice(0).forEach((f) => f()); return { rows: [] }; }
      return handler(sql, params);
    },
    release() { this.released = true; },
  });
}

const dbPath = require.resolve('../src/config/db');
let lastClient = null;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  query: (sql, params) => handler(sql, params),
  getClient: async () => (lastClient = await getClient()),
  ready: Promise.resolve(),
} };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fresh = (...m) => m.forEach((x) => { delete require.cache[require.resolve(x)]; });
const reset = () => { state.idem.clear(); state.open.length = 0; state.deletes = 0; state.failIdem = false; state.locks.clear(); };

const mkRes = () => {
  const r = { statusCode: 200, body: undefined, headers: {}, done: null };
  r.promise = new Promise((resolve) => { r.done = resolve; });
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.json = (b) => { r.body = b; r.done(r); return r; };
  return r;
};

const svc = require('../src/services/idempotency.service');

test('idempotency: key format and request hash (order of keys does not matter, content does)', () => {
  assert.equal(svc.validKey('order-1234'), true);
  for (const bad of ['short', 'has space 12345', 'x'.repeat(129), '', null, 12345678, 'semi;colon-123'])
    assert.equal(svc.validKey(bad), false, String(bad));
  const a = svc.hashRequest('order', { params: {}, body: { a: 1, b: { c: 2, d: 3 } } });
  const b = svc.hashRequest('order', { params: {}, body: { b: { d: 3, c: 2 }, a: 1 } });
  assert.equal(a, b);
  assert.notEqual(a, svc.hashRequest('order', { params: {}, body: { a: 2, b: { c: 2, d: 3 } } }));
  assert.notEqual(a, svc.hashRequest('other', { params: {}, body: { a: 1, b: { c: 2, d: 3 } } }));
});

function runThrough(mw, { key, body = { qty: 1 }, userId = 1 }) {
  const req = { user: { id: userId }, params: {}, body, get: (h) => (h.toLowerCase() === 'idempotency-key' ? key : undefined) };
  const res = mkRes();
  let nextCalled = false;
  const p = mw(req, res, () => { nextCalled = true; });
  return { req, res, p, get nextCalled() { return nextCalled; } };
}

test('idempotency middleware: same key twice => one execution, the 2nd gets the recorded response (replayed)', async () => {
  reset(); fresh('../src/middleware/idempotency.middleware');
  const mw = require('../src/middleware/idempotency.middleware').idempotent('order');
  let executions = 0;
  const handlerFn = (req, res) => { executions++; res.status(200).json({ success: true, order: { id: 7 } }); };

  const first = runThrough(mw, { key: 'order-key-0001' });
  await first.p; assert.equal(first.nextCalled, true);
  handlerFn(first.req, first.res);
  await first.res.promise;

  const second = runThrough(mw, { key: 'order-key-0001' });
  await second.p; await second.res.promise;
  assert.equal(second.nextCalled, false, 'handler must NOT run twice');
  assert.equal(executions, 1);
  assert.equal(second.res.statusCode, 200);
  assert.deepEqual(second.res.body, { success: true, order: { id: 7 } });
  assert.equal(second.res.headers['Idempotent-Replayed'], 'true');
});

test('idempotency middleware: a refusal (403) is recorded and replayed with the same status', async () => {
  reset(); fresh('../src/middleware/idempotency.middleware');
  const mw = require('../src/middleware/idempotency.middleware').idempotent('order');
  const a = runThrough(mw, { key: 'order-key-0002' }); await a.p;
  a.res.status(403).json({ success: false, code: 'RISK_MAX_EXPOSURE' }); await a.res.promise;
  const b = runThrough(mw, { key: 'order-key-0002' }); await b.p; await b.res.promise;
  assert.equal(b.res.statusCode, 403); assert.equal(b.res.body.code, 'RISK_MAX_EXPOSURE');
});

test('idempotency middleware: 10 simultaneous requests with the same key => exactly one proceeds, 9 get 409', async () => {
  reset(); fresh('../src/middleware/idempotency.middleware');
  const mw = require('../src/middleware/idempotency.middleware').idempotent('order');
  const runs = Array.from({ length: 10 }, () => runThrough(mw, { key: 'order-key-0003' }));
  await Promise.all(runs.map((r) => r.p));
  const proceeded = runs.filter((r) => r.nextCalled);
  const blocked   = runs.filter((r) => !r.nextCalled);
  assert.equal(proceeded.length, 1);
  assert.equal(blocked.length, 9);
  for (const r of blocked) { assert.equal(r.res.statusCode, 409); assert.equal(r.res.body.code, 'IDEMPOTENCY_IN_PROGRESS'); }
});

test('idempotency middleware: same key, different order => 422 and the first order is untouched', async () => {
  reset(); fresh('../src/middleware/idempotency.middleware');
  const mw = require('../src/middleware/idempotency.middleware').idempotent('order');
  const a = runThrough(mw, { key: 'order-key-0004', body: { qty: 1 } }); await a.p;
  a.res.json({ success: true }); await a.res.promise;
  const b = runThrough(mw, { key: 'order-key-0004', body: { qty: 999 } }); await b.p; await b.res.promise;
  assert.equal(b.res.statusCode, 422); assert.equal(b.res.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(b.nextCalled, false);
});

test('idempotency middleware: keys are per user; invalid key => 400; no key => passes through; store down => 503 (fail closed)', async () => {
  reset(); fresh('../src/middleware/idempotency.middleware');
  const mw = require('../src/middleware/idempotency.middleware').idempotent('order');
  const u1 = runThrough(mw, { key: 'order-key-0005', userId: 1 }); await u1.p;
  const u2 = runThrough(mw, { key: 'order-key-0005', userId: 2 }); await u2.p;
  assert.equal(u1.nextCalled && u2.nextCalled, true, 'another user may reuse the same key string');

  const bad = runThrough(mw, { key: 'x' }); await bad.p;
  assert.equal(bad.res.statusCode, 400); assert.equal(bad.res.body.code, 'IDEMPOTENCY_KEY_INVALID'); assert.equal(bad.nextCalled, false);

  const none = runThrough(mw, { key: undefined }); await none.p;
  assert.equal(none.nextCalled, true); assert.equal(none.req.idempotency, undefined);

  state.failIdem = true;
  const down = runThrough(mw, { key: 'order-key-0006' }); await down.p;
  assert.equal(down.res.statusCode, 503); assert.equal(down.res.body.code, 'IDEMPOTENCY_UNAVAILABLE'); assert.equal(down.nextCalled, false);
});

test('orderLock: BEGIN -> lock -> fn -> COMMIT, client released; error => ROLLBACK + released; 55P03 => 503 ORDER_BUSY', async () => {
  reset(); fresh('../src/utils/orderLock');
  const { withUserOrderLock } = require('../src/utils/orderLock');
  const seen = [];
  const realGet = require(dbPath).getClient;
  require(dbPath).getClient = async () => {
    const c = await getClient(); const q = c.query.bind(c);
    c.query = (sql, p) => { seen.push(String(sql).trim().split(/\s+/).slice(0, 2).join(' ')); return q(sql, p); };
    lastClient = c; return c;
  };
  try {
    const r = await withUserOrderLock(5, async (q) => { await q('SELECT 1'); return 'ok'; });
    assert.equal(r, 'ok');
    assert.equal(seen[0], 'BEGIN'); assert.equal(seen[seen.length - 1], 'COMMIT');
    assert.equal(seen[1], 'SET LOCAL');
    assert.ok(seen[2].includes('pg_advisory_xact_lock'), 'the lock is taken right after BEGIN / SET LOCAL');
    assert.equal(seen[3], 'SELECT 1');
    assert.equal(lastClient.released, true);

    seen.length = 0;
    await assert.rejects(() => withUserOrderLock(5, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(seen[seen.length - 1], 'ROLLBACK'); assert.equal(lastClient.released, true);
    assert.ok(!state.locks.has('5'), 'lock released after rollback');

    require(dbPath).getClient = async () => {
      const c = await getClient(); const q = c.query.bind(c);
      c.query = (sql, p) => { if (/pg_advisory_xact_lock/.test(sql)) { const e = new Error('lock timeout'); e.code = '55P03'; throw e; } return q(sql, p); };
      lastClient = c; return c;
    };
    await assert.rejects(() => withUserOrderLock(5, async () => 'never'), (e) => e.status === 503 && e.code === 'ORDER_BUSY' && e.expose === true);
    assert.equal(lastClient.released, true);
  } finally { require(dbPath).getClient = realGet; }
});

const CAP_ORDER = { exchangeId: 'binance', symbol: 'BTC', side: 'buy', orderType: 'limit', price: 100, quantity: 18 };   // 1 800 = 18 % of 10 000

function loadController({ mode = 'paper' } = {}) {
  const calls = { live: 0 };
  stub('../src/services/exchanges.service', {
    PAPER_START_CAPITAL: 10000,
    getDecryptedCredentials: async () => ({ mode }),
    openPaperTrade: async (userId, ex, t, q) => (await (q || require(dbPath).query)(
      `INSERT INTO paper_trades (a) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [userId, ex, t.symbol, t.side, t.orderType, t.quantity, t.price, null, null, null, null])).rows[0],
    placeLiveOrder: async () => { calls.live++; return { exchangeOrderId: 'x', status: 'submitted', raw: {} }; },
  });
  stub('../src/utils/emailVerified', { requireVerifiedEmailForLive: async () => ({ ok: true }) });
  fresh('../src/services/riskGuard.service', '../src/utils/orderLock', '../src/controllers/trading.controller');
  return { ctrl: require('../src/controllers/trading.controller'), calls };
}

test('atomic reservation: 10 simultaneous 18% paper orders => exactly 5 accepted, 5 refused (RISK_MAX_EXPOSURE), exposure <= 100%', async () => {
  reset();
  const { ctrl } = loadController();
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const res = mkRes();
    await ctrl.placeOrder({ user: { id: 1 }, body: { ...CAP_ORDER } }, res);
    return res.body ? res : res.promise;
  }));
  const ok = results.filter((r) => r.body.success === true);
  const refused = results.filter((r) => r.body.code === 'RISK_MAX_EXPOSURE');
  assert.equal(ok.length, 5);
  assert.equal(refused.length, 5);
  const exposure = state.open.reduce((a, t) => a + t.quantity * t.price, 0);
  assert.ok(exposure <= 10000, `exposure ${exposure}`);
});

test('control: the same 10 orders WITHOUT the lock overshoot the cap (shows the race is real in this model)', async () => {
  reset();
  stub('../src/services/exchanges.service', { PAPER_START_CAPITAL: 10000 });
  fresh('../src/services/riskGuard.service');
  const guard = require('../src/services/riskGuard.service');
  const db = require(dbPath);
  const outcomes = await Promise.all(Array.from({ length: 10 }, async () => {
    const r = await guard.checkOrder({ userId: 1, exchangeId: 'binance', mode: 'paper', side: 'buy', quantity: 18, refPrice: 100 });
    if (r.ok) await db.query('INSERT INTO paper_trades (a) VALUES ($1,$2,$3,$4,$5,$6,$7)', [1, 'binance', 'BTC', 'buy', 'limit', 18, 100]);
    return r.ok;
  }));
  assert.ok(outcomes.filter(Boolean).length > 5, 'without a lock more than 5 pass: that is the bug the lock removes');
});

test('live order without Idempotency-Key => 400 IDEMPOTENCY_KEY_REQUIRED, nothing sent to the exchange', async () => {
  reset();
  const { ctrl, calls } = loadController({ mode: 'live' });
  const res = mkRes();
  await ctrl.placeOrder({ user: { id: 1 }, body: { ...CAP_ORDER } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(calls.live, 0);
});
