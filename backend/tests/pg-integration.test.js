/**
 * Audit 4 — REAL PostgreSQL proof of idempotency + atomic exposure reservation.
 * Skipped unless TEST_DATABASE_URL is set. Use a THROWAWAY database (it creates/deletes its own users):
 *
 *   docker run -d --name aq-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
 *   (PowerShell)  $env:TEST_DATABASE_URL="postgres://postgres:pw@localhost:55432/postgres"; npm run test:pg
 *
 * CI runs it against a postgres service container (see .github/workflows/ci.yml).
 */
const test   = require('node:test');
const assert = require('node:assert');

const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'set TEST_DATABASE_URL to run the PostgreSQL integration tests';

if (URL_) {
  process.env.DATABASE_URL = URL_;
  process.env.DB_SSL = 'false';
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-123';
}

let db, riskGuard, exchangesSvc, orderLock, idem;
const users = [];

async function mkUser(label) {
  const email = `pgit-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const { rows } = await db.query(`INSERT INTO users (email, password, name) VALUES ($1, 'x', 'pgit') RETURNING id`, [email]);
  users.push(rows[0].id);
  await db.query(`INSERT INTO user_settings (user_id, risk_max_position_pct, risk_max_daily_loss_pct, risk_default_stoploss_pct, risk_max_total_exposure_pct)
                  VALUES ($1, 20, 50, 2, 100) ON CONFLICT (user_id) DO UPDATE SET risk_max_total_exposure_pct = 100`, [rows[0].id]);
  return rows[0].id;
}

test.before(async () => {
  if (!URL_) return;
  db = require('../src/config/db');
  await db.ready;                                   // migrations run once, from an empty or existing database
  riskGuard    = require('../src/services/riskGuard.service');
  exchangesSvc = require('../src/services/exchanges.service');
  orderLock    = require('../src/utils/orderLock');
  idem         = require('../src/services/idempotency.service');
});

test.after(async () => {
  if (!URL_) return;
  if (users.length) await db.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);   // cascades paper_trades / idempotency_keys
  await db.pool.end();
});

const order = (userId, qty = 18, price = 100) => ({ userId, exchangeId: 'binance', mode: 'paper', side: 'buy', quantity: qty, refPrice: price, noStopLoss: true });

// Deliberately widen the window between "check the limits" and "write the position" (50 ms of pg_sleep).
// On a fast local database the unlocked orders otherwise run almost one after the other and the race may not
// show up; with the gap, every unlocked order reads the same exposure before any of them writes.
const GAP = 'SELECT pg_sleep(0.05)';

async function placeLocked(userId) {
  return orderLock.withUserOrderLock(userId, async (q) => {
    const risk = await riskGuard.checkOrder({ ...order(userId), q });
    if (!risk.ok) return { ok: false, code: risk.code };
    await q(GAP);
    await exchangesSvc.openPaperTrade(userId, 'binance', { symbol: 'BTC', side: 'buy', orderType: 'limit', quantity: 18, price: 100 }, q);
    return { ok: true };
  });
}

async function openNotional(userId) {
  const { rows } = await db.query(`SELECT COALESCE(SUM(quantity * price),0)::float AS n FROM paper_trades WHERE user_id = $1 AND status = 'open'`, [userId]);
  return rows[0].n;
}

test('migration is idempotent and creates idempotency_keys', { skip }, async () => {
  const { rows } = await db.query(`SELECT to_regclass('public.idempotency_keys') AS t`);
  assert.ok(rows[0].t);
});

test('RACE (control): without the lock, concurrent 18% orders overshoot the 100% cap', { skip }, async () => {
  const uid = await mkUser('nolock');
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const risk = await riskGuard.checkOrder(order(uid));
    if (!risk.ok) return false;
    await db.query(GAP);                                    // same gap as the locked path
    await exchangesSvc.openPaperTrade(uid, 'binance', { symbol: 'BTC', side: 'buy', orderType: 'limit', quantity: 18, price: 100 });
    return true;
  }));
  const accepted = results.filter(Boolean).length;
  console.log(`[pg-integration] without lock: ${accepted}/10 accepted (cap allows 5)`);
  assert.ok(accepted > 5, `the race should let more than 5 through without the lock, got ${accepted}`);
  assert.ok((await openNotional(uid)) > 10000, 'exposure is above 100% of equity: the bug the lock prevents');
});

test('ATOMIC: 10 concurrent 18% orders WITH the lock => exactly 5 accepted, exposure <= 100%', { skip }, async () => {
  const uid = await mkUser('lock');
  const results = await Promise.all(Array.from({ length: 10 }, () => placeLocked(uid)));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(results.filter((r) => !r.ok && r.code === 'RISK_MAX_EXPOSURE').length, 5);
  assert.ok((await openNotional(uid)) <= 10000);
});

test('ATOMIC: locks are per user (two users do not block or affect each other)', { skip }, async () => {
  const a = await mkUser('a'), b = await mkUser('b');
  const results = await Promise.all([...Array.from({ length: 10 }, () => placeLocked(a)), ...Array.from({ length: 10 }, () => placeLocked(b))]);
  assert.equal(results.filter((r) => r.ok).length, 10);          // 5 per user
  assert.ok((await openNotional(a)) <= 10000 && (await openNotional(b)) <= 10000);
});

test('ATOMIC: a failing order rolls back and releases the lock (the next order is not blocked)', { skip }, async () => {
  const uid = await mkUser('rollback');
  await assert.rejects(() => orderLock.withUserOrderLock(uid, async (q) => {
    await exchangesSvc.openPaperTrade(uid, 'binance', { symbol: 'BTC', side: 'buy', orderType: 'limit', quantity: 18, price: 100 }, q);
    throw new Error('boom after insert');
  }), /boom after insert/);
  assert.equal(await openNotional(uid), 0, 'the insert was rolled back');
  assert.equal((await placeLocked(uid)).ok, true);
});

test('IDEMPOTENCY: 10 concurrent claims of one key => exactly one wins; replay returns the stored response', { skip }, async () => {
  const uid = await mkUser('idem');
  const hash = idem.hashRequest('order', { body: { q: 1 } });
  const claims = await Promise.all(Array.from({ length: 10 }, () => idem.claim(uid, 'order', 'pg-key-000001', hash)));
  assert.equal(claims.filter((c) => c.state === 'new').length, 1);
  assert.equal(claims.filter((c) => c.state === 'in_progress').length, 9);

  await idem.complete(uid, 'order', 'pg-key-000001', 200, { success: true, order: { id: 42 } });
  const again = await idem.claim(uid, 'order', 'pg-key-000001', hash);
  assert.equal(again.state, 'replay'); assert.equal(again.status, 200); assert.deepEqual(again.body, { success: true, order: { id: 42 } });

  const other = await idem.claim(uid, 'order', 'pg-key-000001', idem.hashRequest('order', { body: { q: 2 } }));
  assert.equal(other.state, 'conflict');
});

test('IDEMPOTENCY: same key string for two users are independent', { skip }, async () => {
  const a = await mkUser('ia'), b = await mkUser('ib');
  const h = idem.hashRequest('order', { body: {} });
  assert.equal((await idem.claim(a, 'order', 'shared-key-0001', h)).state, 'new');
  assert.equal((await idem.claim(b, 'order', 'shared-key-0001', h)).state, 'new');
});
