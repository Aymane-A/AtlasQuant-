/**
 * IDOR audit — REAL PostgreSQL, two users. User B calls every id-addressed endpoint with user A's ids
 * and must never read, change or delete anything of A's.
 * Skipped unless TEST_DATABASE_URL is set (use a THROWAWAY database, it creates and deletes its own users):
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

let db, alerts, watchlist, screener, security, backtest, autoTrade, trading, exchanges;
const users = [];
const MARK = `ZZIDOR${Date.now().toString(36).toUpperCase()}`;   // unique marker: it must never show up in B's responses

const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  r.set = r.setHeader = () => r;
  return r;
};
const asUser = (id, over = {}) => ({ user: { id, email: `u${id}@example.test` }, params: {}, query: {}, body: {}, headers: {}, ip: '127.0.0.1', ...over });
async function call(fn, req) { const res = mkRes(); await fn(req, res); return res; }
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const leaks = (res) => JSON.stringify(res.body || {}).includes(MARK);

async function mkUser(label) {
  const email = `idor-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const { rows } = await db.query(`INSERT INTO users (email, password, name) VALUES ($1, 'x', 'idor') RETURNING id`, [email]);
  users.push(rows[0].id);
  return rows[0].id;
}

let A, B, fx;

test.before(async () => {
  if (!URL_) return;
  db = require('../src/config/db');
  await db.ready;
  alerts    = require('../src/controllers/alerts.controller');
  watchlist = require('../src/controllers/watchlist.controller');
  screener  = require('../src/controllers/screener.controller');
  security  = require('../src/controllers/security.controller');
  backtest  = require('../src/controllers/backtest.controller');
  autoTrade = require('../src/controllers/auto_trade.controller');
  trading   = require('../src/controllers/trading.controller');
  exchanges = require('../src/controllers/exchanges.controller');

  A = await mkUser('a'); B = await mkUser('b');
  fx = {};
  fx.alert    = (await one(`INSERT INTO alerts (user_id, symbol, type, condition, target) VALUES ($1, $2, 'price', 'above', 1) RETURNING id`, [A, MARK])).id;
  await db.query(`INSERT INTO watchlist (user_id, symbol) VALUES ($1, $2)`, [A, MARK]);
  fx.preset   = (await one(`INSERT INTO screener_presets (user_id, name, filters) VALUES ($1, $2, '{}') RETURNING id`, [A, MARK])).id;
  fx.bt       = (await one(`INSERT INTO backtest_history (user_id, symbol, strategy, result) VALUES ($1, $2, 's', '{"secret":"mine"}') RETURNING id`, [A, MARK])).id;
  fx.btcfg    = (await one(`INSERT INTO backtest_configs (user_id, name, config) VALUES ($1, $2, '{}') RETURNING id`, [A, MARK])).id;
  fx.atc      = (await one(`INSERT INTO auto_trade_configs (user_id, symbol, strategy_id, params_hash, exchange_id) VALUES ($1, $2, 's', 'h', 'binance') RETURNING id`, [A, MARK])).id;
  fx.apikey   = (await one(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, 'aq_live_xxxx', $3) RETURNING id`, [A, MARK, `hash-${MARK}`])).id;
  fx.session  = (await one(`INSERT INTO user_sessions (user_id, refresh_hash, user_agent) VALUES ($1, $2, $3) RETURNING id`, [A, `rh-${MARK}`, MARK])).id;
  fx.paper    = (await one(`INSERT INTO paper_trades (user_id, exchange_id, symbol, side, order_type, quantity, price) VALUES ($1, 'binance', $2, 'buy', 'limit', 1, 1) RETURNING id`, [A, MARK])).id;
  await db.query(`INSERT INTO live_orders (user_id, exchange_id, exchange_order_id, symbol, side, order_type, quantity, status) VALUES ($1, 'binance', $2, $3, 'buy', 'limit', 1, 'submitted')`, [A, `EX-${MARK}`, MARK]);
  await db.query(`INSERT INTO user_exchange_connections (user_id, exchange_id, api_key_enc, api_secret_enc, mode) VALUES ($1, 'binance', 'k', 's', 'paper')`, [A]);
});

test.after(async () => {
  if (!URL_) return;
  if (users.length) await db.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);   // cascades every fixture row
  await db.pool.end();
});

// ── B must not see A's data in any list ─────────────────────
test('IDOR lists: B never sees A\'s alerts, watchlist, presets, api keys, sessions, backtest configs, auto-trade configs', { skip }, async () => {
  const lists = [
    ['alerts',            alerts.getAlerts],
    ['alerts history',    alerts.getHistory],
    ['watchlist',         watchlist.getWatchlist],
    ['screener presets',  screener.listPresets],
    ['api keys',          security.listApiKeys],
    ['sessions',          security.listSessions],
    ['backtest configs',  backtest.listBacktestConfigs],
    ['auto-trade configs', autoTrade.listConfigs],
  ];
  for (const [name, fn] of lists) {
    const res = await call(fn, asUser(B));
    assert.ok(res.statusCode < 500, `${name}: B's call must not crash (${res.statusCode})`);
    assert.equal(leaks(res), false, `${name}: A's data leaked to B`);
  }
  // sanity: the same lists DO show the data to A (the marker is detectable, so the test above is meaningful)
  const mine = await call(alerts.getAlerts, asUser(A));
  assert.equal(leaks(mine), true, 'control: A sees their own alert');
});

// ── B cannot read A's backtest by id ────────────────────────
test('IDOR read: B cannot read A\'s backtest by id (404), A can', { skip }, async () => {
  const res = await call(backtest.getBacktestById, asUser(B, { params: { id: String(fx.bt) } }));
  assert.equal(res.statusCode, 404); assert.equal(leaks(res), false);
  const mine = await call(backtest.getBacktestById, asUser(A, { params: { id: String(fx.bt) } }));
  assert.equal(mine.statusCode, 200);
});

// ── alerts: every :id action ────────────────────────────────
test('IDOR alerts: B gets 404 on read/pause/snooze/reset/email-frequency/delete of A\'s alert, and the row is untouched', { skip }, async () => {
  const id = String(fx.alert);
  const before = await one(`SELECT paused, triggered, email_frequency, paused_until FROM alerts WHERE id = $1`, [fx.alert]);
  const attempts = [
    ['markAsRead',         alerts.markAsRead,         {}],
    ['togglePause',        alerts.togglePause,        {}],
    ['snoozeAlert',        alerts.snoozeAlert,        { hours: 1 }],
    ['resetAlert',         alerts.resetAlert,         {}],
    ['setEmailFrequency',  alerts.setEmailFrequency,  { emailFrequency: 'digest' }],
    ['deleteAlert',        alerts.deleteAlert,        {}],
  ];
  for (const [name, fn, body] of attempts) {
    const res = await call(fn, asUser(B, { params: { id }, body }));
    assert.equal(res.statusCode, 404, `${name}: expected 404, got ${res.statusCode}`);
  }
  const after = await one(`SELECT paused, triggered, email_frequency, paused_until FROM alerts WHERE id = $1`, [fx.alert]);
  assert.deepEqual(after, before, 'A\'s alert must be unchanged');
});

test('IDOR alerts: B\'s "clear all triggered" / "mark all read" never touch A\'s alerts', { skip }, async () => {
  await db.query(`UPDATE alerts SET triggered = true WHERE id = $1`, [fx.alert]);
  await call(alerts.clearAllTriggered, asUser(B));
  await call(alerts.markAllRead, asUser(B));
  const row = await one(`SELECT triggered, "read" FROM alerts WHERE id = $1`, [fx.alert]);
  assert.ok(row, 'A\'s triggered alert still exists');
  assert.equal(row.triggered, true);
  assert.equal(row.read, false, 'A\'s alert is still unread');
  await db.query(`UPDATE alerts SET triggered = false WHERE id = $1`, [fx.alert]);
});

// ── delete-by-id endpoints that answer 200 either way: the row must survive ──
test('IDOR delete: B cannot delete A\'s watchlist item, screener preset, backtest config, auto-trade config', { skip }, async () => {
  await call(watchlist.removeSymbol, asUser(B, { params: { sym: MARK } }));
  assert.ok(await one(`SELECT 1 AS x FROM watchlist WHERE user_id = $1 AND symbol = $2`, [A, MARK]), 'watchlist item survives');

  await call(screener.deletePreset, asUser(B, { params: { id: String(fx.preset) } }));
  assert.ok(await one(`SELECT 1 AS x FROM screener_presets WHERE id = $1`, [fx.preset]), 'preset survives');

  const c = await call(backtest.deleteBacktestConfig, asUser(B, { params: { id: String(fx.btcfg) } }));
  assert.equal(c.statusCode, 404);
  assert.ok(await one(`SELECT 1 AS x FROM backtest_configs WHERE id = $1`, [fx.btcfg]), 'backtest config survives');

  const d = await call(autoTrade.deleteConfig, asUser(B, { params: { id: String(fx.atc) } }));
  assert.equal(d.statusCode, 404);
  assert.ok(await one(`SELECT 1 AS x FROM auto_trade_configs WHERE id = $1`, [fx.atc]), 'auto-trade config survives');
});

test('IDOR auto-trade: B cannot update A\'s config (404) and cannot flip enabled', { skip }, async () => {
  const res = await call(autoTrade.updateConfig, asUser(B, { params: { id: String(fx.atc) }, body: { enabled: false } }));
  assert.equal(res.statusCode, 404);
  assert.equal((await one(`SELECT enabled FROM auto_trade_configs WHERE id = $1`, [fx.atc])).enabled, true);
});

// ── security: sessions + api keys ───────────────────────────
test('IDOR security: B cannot revoke A\'s session or A\'s API key (404), and "revoke all others" only hits B', { skip }, async () => {
  const s = await call(security.revokeSession, asUser(B, { params: { id: fx.session } }));
  assert.equal(s.statusCode, 404);
  const k = await call(security.revokeApiKey, asUser(B, { params: { id: fx.apikey } }));
  assert.equal(k.statusCode, 404);
  await call(security.revokeAllOtherSessions, asUser(B, { currentSessionHash: 'b-current' }));
  assert.equal((await one(`SELECT revoked_at FROM user_sessions WHERE id = $1`, [fx.session])).revoked_at, null, 'A\'s session still valid');
  assert.equal((await one(`SELECT revoked_at FROM api_keys WHERE id = $1`, [fx.apikey])).revoked_at, null, 'A\'s API key still valid');
});

// ── trading orders ──────────────────────────────────────────
test('IDOR trading: B cannot cancel A\'s paper trade or A\'s live order', { skip }, async () => {
  await call(trading.cancelOrder, asUser(B, { params: { orderId: String(fx.paper) }, query: { mode: 'paper' } }));
  assert.equal((await one(`SELECT status FROM paper_trades WHERE id = $1`, [fx.paper])).status, 'open', 'A\'s paper trade still open');

  const live = await call(trading.cancelOrder, asUser(B, { params: { orderId: `EX-${MARK}` }, query: { mode: 'live', exchangeId: 'binance', symbol: MARK } }));
  assert.ok(!(live.body && live.body.success === true), 'B must not get a success for A\'s live order');
  assert.equal((await one(`SELECT status FROM live_orders WHERE exchange_order_id = $1`, [`EX-${MARK}`])).status, 'submitted', 'A\'s live order untouched');
});

// ── exchange connections ────────────────────────────────────
test('IDOR exchanges: B cannot change the mode of, or disconnect, A\'s exchange connection', { skip }, async () => {
  await call(exchanges.changeMode, asUser(B, { params: { exchangeId: 'binance' }, body: { mode: 'readonly' } }));
  assert.equal((await one(`SELECT mode FROM user_exchange_connections WHERE user_id = $1 AND exchange_id = 'binance'`, [A])).mode, 'paper', 'mode unchanged');
  await call(exchanges.disconnect, asUser(B, { params: { exchangeId: 'binance' } }));
  assert.ok(await one(`SELECT 1 AS x FROM user_exchange_connections WHERE user_id = $1 AND exchange_id = 'binance'`, [A]), 'A\'s connection survives');
});
