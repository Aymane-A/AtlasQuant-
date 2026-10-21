/**
 * Audit 4: single-use WS tickets, kill-switch, /api/health, admin endpoint.
 * Run: cd backend && npm test      (no PostgreSQL / network needed)
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';
process.env.ADMIN_KEY  = 'k'.repeat(40);
delete process.env.TRADING_KILL_SWITCH;

const test   = require('node:test');
const assert = require('node:assert');

// the kill switch now lives in system_flags: a tiny in-memory stand-in for that one table
const flags = new Map();
const fake = { handler: async (sql, params) => {
  if (/system_flags/.test(sql)) {
    if (/^\s*SELECT/i.test(sql)) return { rows: flags.has(params[0]) ? [{ value: flags.get(params[0]) }] : [] };
    flags.set(params[0], JSON.parse(params[1])); return { rows: [] };
  }
  return { rows: [{ '?column?': 1 }] };
} };
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (sql, params) => fake.handler(sql, params), ready: Promise.resolve() },
};
const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  return r;
};

// ═════════════════════════════════════════════════════════════
// 1. WebSocket tickets
// ═════════════════════════════════════════════════════════════
test('ws ticket: random, single use, bound to the user', () => {
  const { issueTicket, consumeTicket } = require('../src/utils/wsTicket');
  const a = issueTicket(7), b = issueTicket(7);
  assert.notEqual(a.ticket, b.ticket);
  assert.ok(a.ticket.length >= 40);
  assert.deepEqual(consumeTicket(a.ticket), { userId: 7 });
  assert.equal(consumeTicket(a.ticket), null, 'replay must be rejected');
  assert.deepEqual(consumeTicket(b.ticket), { userId: 7 });
});

test('ws ticket: expires after 30 s, and an expired ticket is burned', () => {
  const { issueTicket, consumeTicket, TTL_MS } = require('../src/utils/wsTicket');
  const t0 = 1_000_000;
  const { ticket } = issueTicket(9, t0);
  assert.equal(TTL_MS, 30_000);
  assert.equal(consumeTicket(ticket, t0 + TTL_MS + 1), null);
  assert.equal(consumeTicket(ticket, t0 + 1), null, 'already burned');
});

test('ws ticket: garbage input is rejected (not a string, too short, unknown, a JWT)', () => {
  const jwt = require('jsonwebtoken');
  const { consumeTicket } = require('../src/utils/wsTicket');
  for (const bad of [undefined, null, 42, {}, '', 'abc', 'x'.repeat(500), 'a'.repeat(43)]) {
    assert.equal(consumeTicket(bad), null);
  }
  const jwtToken = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
  assert.equal(consumeTicket(jwtToken), null, 'a JWT is not a valid ticket');
});

test('POST /auth/ws-ticket handler returns a ticket for req.user and nothing else', () => {
  const { issueWsTicket } = require('../src/controllers/auth.controller');
  const { consumeTicket } = require('../src/utils/wsTicket');
  const res = mkRes();
  issueWsTicket({ user: { id: 42 } }, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.expiresInMs, 30000);
  assert.deepEqual(Object.keys(res.body).sort(), ['expiresInMs', 'success', 'ticket']);
  assert.deepEqual(consumeTicket(res.body.ticket), { userId: 42 });
});

test('dashboard socket: no ?token= path any more; a bad ticket closes with 4001', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/ws/dashboardSocket.server.js'), 'utf8');
  assert.ok(!/searchParams\.get\(['"]token['"]\)/.test(src), 'JWT must not be accepted from the URL');
  assert.ok(/searchParams\.get\(['"]ticket['"]\)/.test(src));

  const { startDashboardSocket, stopDashboardSocket } = require('../src/ws/dashboardSocket.server');
  const upgrade = startDashboardSocket();
  assert.equal(typeof upgrade, 'function');
  const wssMod = require('ws');
  const http = require('node:http');
  const server = http.createServer();
  server.on('upgrade', upgrade);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  for (const q of ['', '?ticket=nope', '?token=' + require('jsonwebtoken').sign({ id: 1 }, process.env.JWT_SECRET)]) {
    const code = await new Promise((resolve) => {
      const c = new wssMod.WebSocket(`ws://127.0.0.1:${port}/ws/dashboard${q}`);
      c.on('close', (cd) => resolve(cd));
      c.on('error', () => resolve('error'));
    });
    assert.equal(code, 4001, `query "${q.slice(0, 20)}" must be refused`);
  }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  stopDashboardSocket();   // clear the broadcast interval so node:test can exit
});

// ═════════════════════════════════════════════════════════════
// 2. Kill-switch
// ═════════════════════════════════════════════════════════════
test('kill-switch: off by default, engage/release, reason recorded', async () => {
  const ks = require('../src/utils/killSwitch');
  assert.equal(ks.isEngaged(), false);
  const s = await ks.set(true, 'exchange incident');
  assert.equal(s.engaged, true); assert.equal(s.reason, 'exchange incident'); assert.ok(s.since); assert.equal(s.persisted, true);
  assert.equal(ks.isEngaged(), true);
  const r = await ks.set(false);
  assert.equal(r.engaged, false); assert.equal(r.reason, null);
});

test('kill-switch: placeOrder refuses with 503 TRADING_DISABLED and never touches the exchange or DB', async () => {
  const svcPath = require.resolve('../src/services/exchanges.service');
  let touched = false;
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true,
    exports: new Proxy({}, { get: () => async () => { touched = true; return null; } }) };
  let dbTouched = false;
  // the only query allowed is the kill-switch read itself: no order/trade table is touched
  const prev = fake.handler; fake.handler = async (sql, params) => { if (!/system_flags/.test(sql)) dbTouched = true; return prev(sql, params); };
  const ks = require('../src/utils/killSwitch');
  delete require.cache[require.resolve('../src/controllers/trading.controller')];
  const { placeOrder } = require('../src/controllers/trading.controller');

  await ks.set(true, 'test');
  const res = mkRes();
  await placeOrder({ user: { id: 7 }, body: { exchangeId: 'binance', symbol: 'BTC', side: 'buy', quantity: 1 } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'TRADING_DISABLED');
  assert.equal(touched, false); assert.equal(dbTouched, false);

  await ks.set(false);
  const res2 = mkRes();
  await placeOrder({ user: { id: 7 }, body: { exchangeId: 'binance', symbol: 'BTC', side: 'buy', quantity: -1 } }, res2);
  assert.equal(res2.statusCode, 400, 'with the switch off the normal validation runs again');
  fake.handler = prev;
});

test('kill-switch: TRADING_KILL_SWITCH=true at boot starts engaged', async () => {
  process.env.TRADING_KILL_SWITCH = 'true';
  delete require.cache[require.resolve('../src/utils/killSwitch')];
  const ks = require('../src/utils/killSwitch');
  assert.equal(ks.isEngaged(), true);
  delete process.env.TRADING_KILL_SWITCH;
  delete require.cache[require.resolve('../src/utils/killSwitch')];
  await require('../src/utils/killSwitch').set(false);
});

// ═════════════════════════════════════════════════════════════
// 3. Admin endpoint
// ═════════════════════════════════════════════════════════════
async function adminCall(method, path, { key, body } = {}) {
  const http = require('node:http');
  const express = require('express');
  delete require.cache[require.resolve('../src/routes/admin.routes')];
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/admin.routes'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, {
      method, headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('admin: no/wrong key => 401, nothing changes; right key toggles the switch', async () => {
  const ks = require('../src/utils/killSwitch'); await ks.set(false);
  assert.equal((await adminCall('POST', '/kill-switch', { body: { enabled: true } })).status, 401);
  assert.equal((await adminCall('POST', '/kill-switch', { key: 'x'.repeat(40), body: { enabled: true } })).status, 401);
  assert.equal(ks.isEngaged(), false);

  const on = await adminCall('POST', '/kill-switch', { key: process.env.ADMIN_KEY, body: { enabled: true, reason: 'drill' } });
  assert.equal(on.status, 200); assert.equal(on.json.engaged, true); assert.equal(ks.isEngaged(), true);
  const get = await adminCall('GET', '/kill-switch', { key: process.env.ADMIN_KEY });
  assert.equal(get.json.engaged, true); assert.equal(get.json.reason, 'drill');
  const off = await adminCall('POST', '/kill-switch', { key: process.env.ADMIN_KEY, body: { enabled: false } });
  assert.equal(off.json.engaged, false);
  assert.equal((await adminCall('POST', '/kill-switch', { key: process.env.ADMIN_KEY, body: { enabled: 'yes' } })).status, 400);
});

test('admin: endpoint is disabled (404) when ADMIN_KEY is unset or too short', async () => {
  const saved = process.env.ADMIN_KEY;
  try {
    process.env.ADMIN_KEY = '';
    assert.equal((await adminCall('GET', '/kill-switch', { key: 'anything' })).status, 404);
    process.env.ADMIN_KEY = 'short';
    assert.equal((await adminCall('GET', '/kill-switch', { key: 'short' })).status, 404);
  } finally { process.env.ADMIN_KEY = saved; }
});

// ═════════════════════════════════════════════════════════════
// 4. /api/health
// ═════════════════════════════════════════════════════════════
test('health: db up + cron running + switch off => ok / 200, and nothing sensitive in the body', async () => {
  const cronPath = require.resolve('../src/services/cron.service');
  require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { isCronRunning: () => true } };
  delete require.cache[require.resolve('../src/utils/health')];
  await require('../src/utils/killSwitch').set(false);
  const { healthHandler } = require('../src/utils/health');
  const res = mkRes(); await healthHandler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok'); assert.equal(res.body.db, 'up'); assert.equal(res.body.cron, 'running'); assert.equal(res.body.killSwitch, false);
  assert.deepEqual(Object.keys(res.body).sort(), ['cron', 'db', 'killSwitch', 'paperTrading', 'status', 'timestamp']);
});

test('health: db down => 503 / down; kill-switch engaged or cron stopped => degraded / 200', async () => {
  const cronPath = require.resolve('../src/services/cron.service');
  const ks = require('../src/utils/killSwitch');
  delete require.cache[require.resolve('../src/utils/health')];
  const { healthHandler } = require('../src/utils/health');

  const prev = fake.handler;
  fake.handler = async () => { throw new Error('ECONNREFUSED secret-internal-detail'); };
  let res = mkRes(); await healthHandler({}, res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.status, 'down'); assert.equal(res.body.db, 'down');
  assert.ok(!JSON.stringify(res.body).includes('secret-internal-detail'), 'no error text leaks');
  fake.handler = prev;

  await ks.set(true, 'drill');
  res = mkRes(); await healthHandler({}, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.status, 'degraded'); assert.equal(res.body.killSwitch, true);
  await ks.set(false);

  require.cache[cronPath].exports.isCronRunning = () => false;
  res = mkRes(); await healthHandler({}, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.status, 'degraded'); assert.equal(res.body.cron, 'stopped');
});

test('health: a hung DB is cut off after ~2 s instead of hanging the probe', async () => {
  delete require.cache[require.resolve('../src/utils/health')];
  const { healthHandler } = require('../src/utils/health');
  const prev = fake.handler; fake.handler = () => new Promise(() => {});
  const t0 = Date.now(); const res = mkRes(); await healthHandler({}, res);
  assert.equal(res.statusCode, 503);
  assert.ok(Date.now() - t0 < 4000);
  fake.handler = prev;
});
