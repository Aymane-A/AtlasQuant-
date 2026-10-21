/**
 * Kill switch — persistent and shared (in-memory stand-in for the system_flags table, no PostgreSQL needed).
 * A second "backend instance" is simulated by loading utils/killSwitch.js a second time against the same fake table.
 * Run: cd backend && node --test tests/kill-switch-persist.test.js
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';
process.env.ADMIN_KEY  = 'k'.repeat(40);
delete process.env.TRADING_KILL_SWITCH;

const test   = require('node:test');
const assert = require('node:assert');

const flags = new Map();
const fake = { failReads: false, failWrites: false, calls: [] };
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    ready: Promise.resolve(),
    query: async (sql, params) => {
      fake.calls.push({ sql, params });
      if (/system_flags/.test(sql)) {
        if (/^\s*SELECT/i.test(sql)) {
          if (fake.failReads) throw new Error('db down (read)');
          return { rows: flags.has(params[0]) ? [{ value: flags.get(params[0]) }] : [] };
        }
        if (fake.failWrites) throw new Error('db down (write)');
        const incoming = JSON.parse(params[1]);
        const current = flags.get(params[0]);
        // init(): keep an engaged row as is; set(): overwrite
        if (/CASE WHEN/.test(sql) && current && current.engaged) return { rows: [] };
        flags.set(params[0], incoming);
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
};

const ksPath = require.resolve('../src/utils/killSwitch');
/** a brand-new backend process: fresh module state, same database */
function newInstance(env) {
  if (env === undefined) delete process.env.TRADING_KILL_SWITCH; else process.env.TRADING_KILL_SWITCH = env;
  delete require.cache[ksPath];
  return require(ksPath);
}

test.beforeEach(() => { flags.clear(); fake.failReads = false; fake.failWrites = false; fake.calls = []; });
test.after(() => { delete process.env.TRADING_KILL_SWITCH; });

test('engage on instance A => instance B refuses orders immediately (shared state)', async () => {
  const A = newInstance(); const B = newInstance();
  assert.equal(await B.isEngagedFresh(), false);
  const r = await A.set(true, 'exchange incident', { by: 'admin-key', ip: '9.9.9.9' });
  assert.equal(r.engaged, true); assert.equal(r.persisted, true);
  assert.equal(await B.isEngagedFresh(), true, 'B sees it without any restart');
  assert.equal(B.status().reason, 'exchange incident');
  const row = flags.get('kill_switch');
  assert.equal(row.by, 'admin-key'); assert.equal(row.ip, '9.9.9.9');
});

test('a restart does NOT re-enable trading: engaged stays engaged (env off)', async () => {
  const A = newInstance();
  const t0 = (await A.set(true, 'incident')).since;
  const restarted = newInstance();                   // new process, env flag off
  assert.equal(restarted.isEngaged(), false, 'cold cache before init()');
  assert.equal(await restarted.isEngagedFresh(), true, 'but the order path reads the database');
  const st = await restarted.init();
  assert.equal(st.engaged, true); assert.equal(st.reason, 'incident'); assert.equal(st.since, t0);
});

test('release is shared and persistent too', async () => {
  const A = newInstance(); const B = newInstance();
  await A.set(true, 'drill');
  assert.equal(await B.isEngagedFresh(), true);
  await A.set(false);
  assert.equal(await B.isEngagedFresh(), false);
  assert.equal(newInstance().status().engaged, false);
  assert.equal(await newInstance().isEngagedFresh(), false);
});

test('TRADING_KILL_SWITCH=true: init engages and persists; keeps reason/since of an engaged row', async () => {
  const A = newInstance('true');
  assert.equal(A.isEngaged(), true, 'engaged from the very first line (env)');
  await A.init();
  assert.equal(flags.get('kill_switch').engaged, true);

  flags.set('kill_switch', { engaged: true, reason: 'operator: exchange outage', since: '2026-10-20T10:00:00.000Z', by: 'admin-key' });
  const B = newInstance('true');
  const st = await B.init();
  assert.equal(st.reason, 'operator: exchange outage');
  assert.equal(st.since, '2026-10-20T10:00:00.000Z');
});

test('TRADING_KILL_SWITCH=true: a runtime release lasts until the next restart, which engages again', async () => {
  const A = newInstance('true'); await A.init();
  await A.set(false);
  assert.equal(await A.isEngagedFresh(), false);
  const restarted = newInstance('true'); await restarted.init();
  assert.equal(await restarted.isEngagedFresh(), true);
});

test('no row yet and env off => not engaged; a deleted row falls back to the env default', async () => {
  const A = newInstance();
  assert.equal(await A.isEngagedFresh(), false);
  await A.set(true, 'x'); flags.clear();
  assert.equal(await A.isEngagedFresh(), false);
});

test('FAIL CLOSED: database unreadable => isEngagedFresh() is true', async () => {
  const A = newInstance();
  fake.failReads = true;
  assert.equal(await A.isEngagedFresh(), true);
  assert.equal(A.isEngaged(), false, 'the local cache is not what protects orders');
});

test('placeOrder refuses with 503 TRADING_DISABLED when the switch state cannot be read', async () => {
  const svcPath = require.resolve('../src/services/exchanges.service');
  let touched = false;
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: new Proxy({}, { get: () => async () => { touched = true; return null; } }) };
  newInstance();
  delete require.cache[require.resolve('../src/controllers/trading.controller')];
  const { placeOrder } = require('../src/controllers/trading.controller');
  const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

  fake.failReads = true;
  const res = mkRes();
  await placeOrder({ user: { id: 7 }, body: { exchangeId: 'binance', symbol: 'BTC', side: 'buy', quantity: 1 } }, res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'TRADING_DISABLED'); assert.equal(touched, false);

  fake.failReads = false;                            // readable again and off => normal validation runs
  const res2 = mkRes();
  await placeOrder({ user: { id: 7 }, body: { exchangeId: 'binance', symbol: 'BTC', side: 'buy', quantity: -1 } }, res2);
  assert.equal(res2.statusCode, 400);
});

test('engage with a failing write: engaged on this instance anyway, persisted:false', async () => {
  const A = newInstance();
  fake.failWrites = true;
  const r = await A.set(true, 'db trouble');
  assert.equal(r.engaged, true); assert.equal(r.persisted, false);
  assert.equal(A.isEngaged(), true);
});

test('release with a failing write: it throws and the switch STAYS engaged', async () => {
  const A = newInstance();
  await A.set(true, 'incident');
  fake.failWrites = true;
  await assert.rejects(() => A.set(false), /db down/);
  assert.equal(A.isEngaged(), true);
  assert.equal(flags.get('kill_switch').engaged, true);
});

test('startSync(): the local cache follows the other instances; the timer never keeps the process alive', async () => {
  const A = newInstance(); const B = newInstance();
  const timer = B.startSync(10);
  assert.equal(timer.hasRef(), false, 'unref()');
  assert.equal(B.isEngaged(), false);
  await A.set(true, 'incident');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(B.isEngaged(), true, 'health sees it within one poll');
  B.stopSync();
});

// ── admin endpoint ──────────────────────────────────────────
async function adminCall(method, body) {
  const http = require('node:http'); const express = require('express');
  delete require.cache[require.resolve('../src/routes/admin.routes')];
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/admin.routes'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/kill-switch`, {
      method, headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const auditTypes = () => fake.calls.filter(c => /INSERT INTO audit_log/.test(c.sql)).map(c => c.params[1]);

test('admin: engage persists, is audited, and another instance sees it; GET reads the shared state', async () => {
  newInstance();
  const on = await adminCall('POST', { enabled: true, reason: 'drill' });
  assert.equal(on.status, 200); assert.equal(on.json.engaged, true); assert.equal(on.json.persisted, true);
  assert.deepEqual(auditTypes(), ['kill_switch_engaged']);
  assert.equal(flags.get('kill_switch').by, 'admin-key');

  flags.set('kill_switch', { engaged: false });                     // someone released it from another instance
  const get = await adminCall('GET');
  assert.equal(get.json.engaged, false); assert.equal(get.json.persisted, true);
});

test('admin: a release that cannot be persisted answers 503 and the switch stays engaged', async () => {
  const A = newInstance();
  await A.set(true, 'incident');
  fake.failWrites = true;
  const r = await adminCall('POST', { enabled: false });
  assert.equal(r.status, 503); assert.equal(r.json.engaged, true);
  assert.equal(flags.get('kill_switch').engaged, true);
});

test('admin: GET with the database unreadable reports persisted:false / stale:true instead of failing', async () => {
  const A = newInstance(); await A.set(true, 'incident');
  fake.failReads = true;
  const g = await adminCall('GET');
  assert.equal(g.status, 200); assert.equal(g.json.persisted, false); assert.equal(g.json.stale, true);
});
