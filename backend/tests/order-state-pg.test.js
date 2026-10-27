/**
 * Unknown-order reconciler on REAL PostgreSQL (the exchange layer is a stub: only the lookup is faked).
 * Skipped unless TEST_DATABASE_URL is set (use a THROWAWAY database; it creates and deletes its own users):
 *   (PowerShell)  $env:TEST_DATABASE_URL="postgres://postgres:pw@localhost:5432/aq_test"; npm run test:pg
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

// the exchange layer is the only thing replaced
const stub = { creds: { apiKey: 'k', apiSecret: 's', mode: 'live' }, lookup: async () => ({ found: false }), asked: [] };
let db, reconciler;
const users = [];
const MARK = `OS${Date.now().toString(36)}`;

async function mkUser(label) {
  const { rows } = await db.query(`INSERT INTO users (email, password, name) VALUES ($1, 'x', 'os') RETURNING id`,
    [`os-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`]);
  users.push(rows[0].id); return rows[0].id;
}
/** a live_orders row created `ageMin` minutes ago */
async function mkOrder(userId, { status, ageMin = 0, clientId, exchangeOrderId = null, unknownAgeMin = null }) {
  const { rows } = await db.query(
    `INSERT INTO live_orders (user_id, exchange_id, exchange_order_id, symbol, side, order_type, quantity, status, client_order_id, created_at, unknown_since)
     VALUES ($1,'binance',$2,$3,'buy','limit',1,$4,$5, NOW() - make_interval(mins => $6::int), CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $7::int) END)
     RETURNING id`,
    [userId, exchangeOrderId, MARK, status, clientId || `aq${Math.random().toString(16).slice(2)}${Date.now()}`, ageMin, unknownAgeMin]);
  return rows[0].id;
}
const row = async (id) => (await db.query(`SELECT * FROM live_orders WHERE id = $1`, [id])).rows[0];
let U;

test.before(async () => {
  if (!URL_) return;
  const svcPath = require.resolve('../src/services/exchanges.service');
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: {
    getDecryptedCredentials: async () => stub.creds,
    fetchOrderByClientId: async (ex, creds, args) => { stub.asked.push(args); return stub.lookup(args); },
    fetchOrderFill: async () => null,
  } };
  db = require('../src/config/db'); await db.ready;
  reconciler = require('../src/services/liveOrderReconciler.service');
  U = await mkUser('a');
});
test.beforeEach(() => { stub.creds = { apiKey: 'k', apiSecret: 's', mode: 'live' }; stub.lookup = async () => ({ found: false }); stub.asked = []; });
test.after(async () => {
  if (!URL_) return;
  if (users.length) await db.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);   // cascades live_orders
  await db.pool.end();
});

test('migration: client_order_id / status_note / unknown_since exist; (user, client id) is unique, other users may reuse it', { skip }, async () => {
  const { rows } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='live_orders' AND column_name IN ('client_order_id','status_note','unknown_since') ORDER BY 1`);
  assert.deepEqual(rows.map((r) => r.column_name), ['client_order_id', 'status_note', 'unknown_since']);
  const V = await mkUser('b');
  await mkOrder(U, { status: 'pending', clientId: `dup-${MARK}` });
  await assert.rejects(() => mkOrder(U, { status: 'pending', clientId: `dup-${MARK}` }), /unique|duplicate/i);
  await mkOrder(V, { status: 'pending', clientId: `dup-${MARK}` });       // another user: allowed
});

test('a "pending" row with no exchange id for 60 s+ becomes "unknown"; a younger one, and one with an exchange id, stay', { skip }, async () => {
  const old = await mkOrder(U, { status: 'pending', ageMin: 3 });
  const young = await mkOrder(U, { status: 'pending', ageMin: 0 });
  const live = await mkOrder(U, { status: 'pending', ageMin: 30, exchangeOrderId: `EX-${MARK}-1` });   // a real resting order
  stub.lookup = async () => { throw new Error('exchange unreachable'); };                                // so nothing else changes
  await reconciler.resolveUnresolvedOrders();
  assert.equal((await row(old)).status, 'unknown');
  assert.ok((await row(old)).unknown_since, 'unknown_since is set');
  assert.equal((await row(young)).status, 'pending');
  assert.equal((await row(live)).status, 'pending');
});

test('unknown + found on the exchange => adopts its id and state, with the note', { skip }, async () => {
  const id = await mkOrder(U, { status: 'unknown', ageMin: 2, clientId: `found-${MARK}`, unknownAgeMin: 2 });
  stub.lookup = async () => ({ found: true, exchangeOrderId: `EX-${MARK}-42`, status: 'filled', raw: { id: 42, note: 'x' } });
  const s = await reconciler.resolveUnresolvedOrders();
  const r = await row(id);
  assert.equal(r.exchange_order_id, `EX-${MARK}-42`); assert.equal(r.status, 'filled');
  assert.match(r.status_note, /found on the exchange by client id/);
  assert.deepEqual(r.raw_response, { id: 42, note: 'x' });
  assert.ok(s.resolved >= 1);
  assert.ok(stub.asked.some((a) => a.clientOrderId === `found-${MARK}`), 'it asked by the client id we stored');
});

test('unknown + NOT found: left alone before the grace period, "rejected" after it', { skip }, async () => {
  const fresh = await mkOrder(U, { status: 'unknown', ageMin: 3, unknownAgeMin: 3 });
  const aged  = await mkOrder(U, { status: 'unknown', ageMin: 15, unknownAgeMin: 15 });
  await reconciler.resolveUnresolvedOrders();
  assert.equal((await row(fresh)).status, 'unknown', 'a delayed request could still land');
  const a = await row(aged);
  assert.equal(a.status, 'rejected'); assert.match(a.status_note, /never reached/);
});

test('unknown + the lookup FAILS (network / auth / unsupported / connection gone): never concluded, stays unknown', { skip }, async () => {
  const a = await mkOrder(U, { status: 'unknown', ageMin: 120, unknownAgeMin: 120 });
  stub.lookup = async () => { throw new Error('timeout'); };
  let s = await reconciler.resolveUnresolvedOrders();
  assert.equal((await row(a)).status, 'unknown', 'could not ask != does not exist');
  assert.ok(s.errors >= 1);
  stub.lookup = async () => ({ found: false }); stub.creds = null;               // connection deleted
  s = await reconciler.resolveUnresolvedOrders();
  assert.equal((await row(a)).status, 'unknown');
  assert.ok(s.errors >= 1);
});

test('stale unknown orders (> 60 min) are counted so the operator is alerted', { skip }, async () => {
  await mkOrder(U, { status: 'unknown', ageMin: 200, unknownAgeMin: 90 });
  stub.lookup = async () => { throw new Error('still down'); };
  const s = await reconciler.resolveUnresolvedOrders();
  assert.ok(s.stale >= 1);
});

test('only unknown rows are looked up; submitted / filled / rejected / already-identified rows are never touched', { skip }, async () => {
  const ids = [
    await mkOrder(U, { status: 'submitted', ageMin: 500, exchangeOrderId: `EX-${MARK}-a` }),
    await mkOrder(U, { status: 'filled', ageMin: 500, exchangeOrderId: `EX-${MARK}-b` }),
    await mkOrder(U, { status: 'rejected', ageMin: 500 }),
    await mkOrder(U, { status: 'unknown', ageMin: 500, exchangeOrderId: `EX-${MARK}-c` }),   // has an id: the fill reconciler's job
  ];
  const before = await Promise.all(ids.map(row));
  stub.lookup = async () => ({ found: true, exchangeOrderId: 'SHOULD-NOT-HAPPEN', status: 'filled', raw: {} });
  await reconciler.resolveUnresolvedOrders();
  const after = await Promise.all(ids.map(row));
  for (let i = 0; i < ids.length; i++) { assert.equal(after[i].status, before[i].status); assert.equal(after[i].exchange_order_id, before[i].exchange_order_id); }
});

test('two sweeps at the same time: the second one backs off instead of double-processing', { skip }, async () => {
  await mkOrder(U, { status: 'unknown', ageMin: 2, unknownAgeMin: 2 });
  stub.lookup = async () => { await new Promise((r) => setTimeout(r, 200)); return { found: false }; };
  const [a, b] = await Promise.all([reconciler.resolveUnresolvedOrders(), reconciler.resolveUnresolvedOrders()]);
  assert.equal([a, b].filter((x) => x.skipped).length, 1);
});
