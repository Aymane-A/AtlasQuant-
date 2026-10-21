/**
 * Kill switch on REAL PostgreSQL: the system_flags migration, persistence across a "restart", and two backend
 * instances sharing one switch. It writes the 'kill_switch' row, so use a THROWAWAY database.
 * Skipped unless TEST_DATABASE_URL is set:
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
  delete process.env.TRADING_KILL_SWITCH;
}

let db, ksPath;
function newInstance(env) {
  if (env === undefined) delete process.env.TRADING_KILL_SWITCH; else process.env.TRADING_KILL_SWITCH = env;
  delete require.cache[ksPath];
  return require(ksPath);
}
const wipe = () => db.query(`DELETE FROM system_flags WHERE key = 'kill_switch'`);

test.before(async () => {
  if (!URL_) return;
  db = require('../src/config/db');
  await db.ready;
  ksPath = require.resolve('../src/utils/killSwitch');
  await wipe();
});
test.beforeEach(async () => { if (URL_) await wipe(); });
test.after(async () => {
  if (!URL_) return;
  delete process.env.TRADING_KILL_SWITCH;
  await wipe();
  await db.pool.end();
});

test('migration: system_flags exists with key / value JSONB / updated_at', { skip }, async () => {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'system_flags' ORDER BY column_name`);
  assert.deepEqual(rows.map(r => `${r.column_name}:${r.data_type}`), ['key:text', 'updated_at:timestamp with time zone', 'value:jsonb']);
});

test('engage on instance A is seen by instance B at once, with who/when stored', { skip }, async () => {
  const A = newInstance(); const B = newInstance();
  assert.equal(await B.isEngagedFresh(), false);
  const r = await A.set(true, 'exchange incident', { by: 'admin-key', ip: '10.0.0.1' });
  assert.equal(r.persisted, true);
  assert.equal(await B.isEngagedFresh(), true);
  const { rows } = await db.query(`SELECT value FROM system_flags WHERE key = 'kill_switch'`);
  assert.equal(rows[0].value.engaged, true);
  assert.equal(rows[0].value.reason, 'exchange incident');
  assert.equal(rows[0].value.by, 'admin-key');
  assert.equal(rows[0].value.ip, '10.0.0.1');
});

test('a restart does not re-enable trading (engaged survives, reason and since are kept)', { skip }, async () => {
  const A = newInstance();
  const t0 = (await A.set(true, 'incident')).since;
  const restarted = newInstance();
  assert.equal(await restarted.isEngagedFresh(), true);
  const st = await restarted.init();
  assert.equal(st.engaged, true); assert.equal(st.reason, 'incident'); assert.equal(st.since, t0);
});

test('release is persistent and shared', { skip }, async () => {
  const A = newInstance(); const B = newInstance();
  await A.set(true, 'drill'); assert.equal(await B.isEngagedFresh(), true);
  await A.set(false);         assert.equal(await B.isEngagedFresh(), false);
  assert.equal(await newInstance().isEngagedFresh(), false);
});

test('TRADING_KILL_SWITCH=true: init() seeds the row with the real UPSERT, and keeps an engaged row untouched', { skip }, async () => {
  const A = newInstance('true'); await A.init();
  const first = (await db.query(`SELECT value FROM system_flags WHERE key = 'kill_switch'`)).rows[0].value;
  assert.equal(first.engaged, true); assert.equal(first.by, 'env');

  await db.query(`UPDATE system_flags SET value = $1 WHERE key = 'kill_switch'`,
    [JSON.stringify({ engaged: true, reason: 'operator: outage', since: '2026-10-20T10:00:00.000Z', by: 'admin-key' })]);
  const B = newInstance('true'); const st = await B.init();
  assert.equal(st.reason, 'operator: outage');
  assert.equal(st.since, '2026-10-20T10:00:00.000Z');

  await B.set(false);                                    // runtime release (row now says released)
  const C = newInstance('true'); await C.init();         // next boot with the env flag engages again
  assert.equal(await C.isEngagedFresh(), true);
});

test('concurrent engage/release from two instances always ends in a consistent row (last write wins)', { skip }, async () => {
  const A = newInstance(); const B = newInstance();
  await Promise.all([A.set(true, 'a'), B.set(true, 'b'), A.set(true, 'c'), B.set(true, 'd')]);
  const { rows } = await db.query(`SELECT value FROM system_flags WHERE key = 'kill_switch'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value.engaged, true);
  assert.ok(['a', 'b', 'c', 'd'].includes(rows[0].value.reason));
  assert.equal(await A.isEngagedFresh(), true); assert.equal(await B.isEngagedFresh(), true);
});
