/**
 * Preliminary-audit fixes: no fake balances, strict Auto-Trader/backtest validation,
 * no internal error details in production. Run: cd backend && npm test
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');

// ── fake db ──────────────────────────────────────────────────
const dbCalls = [];
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async (sql, params) => { dbCalls.push({ sql, params }); return { rows: [] }; }, ready: Promise.resolve() },
};

// ── fake exchanges service ───────────────────────────────────
const ex = {
  creds: { mode: 'paper' },
  portfolioError: null,
  getDecryptedCredentials: async () => ex.creds,
  fetchPortfolio: async () => { if (ex.portfolioError) throw ex.portfolioError; return [{ symbol: 'USD', free: 1234, locked: 0, total: 1234 }]; },
  PAPER_START_CAPITAL: 10000,
};
const svcPath = require.resolve('../src/services/exchanges.service');
require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true,
  exports: new Proxy(ex, { get: (t, k) => (k in t ? t[k] : async () => null) }) };

const mkRes = () => {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  return r;
};

// ── 1. balances: never a made-up number presented as the account's ───
const trading = require('../src/controllers/trading.controller');

test('balance: OANDA/Alpaca paper sync failure => 502 + balanceUnavailable, NO fake 10000/100000', async () => {
  for (const exchangeId of ['oanda', 'alpaca']) {
    ex.creds = { mode: 'paper' };
    ex.portfolioError = new Error('ECONNRESET secret-internal-detail');
    const res = mkRes();
    await trading.getBalance({ user: { id: 7 }, query: { exchangeId } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.equal(res.body.balanceUnavailable, true);
    assert.deepEqual(res.body.balances, []);
    assert.ok(!JSON.stringify(res.body).includes('10000') && !JSON.stringify(res.body).includes('100000'));
  }
});

test('balance: successful OANDA paper sync is labelled as coming from the exchange', async () => {
  ex.creds = { mode: 'paper' }; ex.portfolioError = null;
  const res = mkRes();
  await trading.getBalance({ user: { id: 7 }, query: { exchangeId: 'oanda' } }, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.source, 'exchange');
  assert.equal(res.body.simulated, false);
  assert.equal(res.body.balances[0].total, 1234);
});

test('balance: paper wallet on other exchanges is explicitly flagged simulated', async () => {
  ex.creds = { mode: 'paper' };
  const res = mkRes();
  await trading.getBalance({ user: { id: 7 }, query: { exchangeId: 'binance' } }, res);
  assert.equal(res.body.simulated, true);
  assert.equal(res.body.source, 'simulated');
  assert.equal(res.body.balances.find(b => b.symbol === 'USDT').total, 10000);
});

// ── 2. Auto-Trader validation ────────────────────────────────
const { validateAutoTradeParams, toId } = require('../src/utils/validate');

test('validate: rejects negative, zero, NaN, Infinity, junk strings, out-of-range, non-integers', () => {
  const bad = [
    { maxDailyLossPct: -5 }, { maxDailyLossPct: 0 }, { maxDailyLossPct: 101 }, { maxDailyLossPct: 'abc' },
    { maxDailyLossPct: NaN }, { maxDailyLossPct: Infinity }, { maxDailyLossPct: '5abc' }, { maxDailyLossPct: true },
    { maxPositionSize: -1 }, { maxPositionSize: Infinity }, { maxPositionSize: '1e999' }, { maxPositionSize: 1e15 },
    { probationTradesRequired: 0 }, { probationTradesRequired: 2.5 }, { probationTradesRequired: 100000 }, { probationTradesRequired: 'x' },
    { maxPositions: 0 }, { maxPositions: 51 },
    { positionSizeMode: 'yolo' }, { positionSizeMode: 'fixed_pct', positionSizeValue: 500 }, { positionSizeValue: -1 },
  ];
  for (const b of bad) assert.ok(validateAutoTradeParams(b).errors.length > 0, `should reject ${JSON.stringify(b)}`);
});

test('validate: accepts sane values (numbers or numeric strings) and ignores absent fields', () => {
  const r = validateAutoTradeParams({ maxDailyLossPct: '5', maxPositionSize: 1000, probationTradesRequired: '10', maxPositions: '5', positionSizeMode: 'fixed_pct', positionSizeValue: '10' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.values.maxDailyLossPct, 5);
  assert.equal(r.values.probationTradesRequired, 10);
  assert.deepEqual(validateAutoTradeParams({ maxPositionSize: '', maxDailyLossPct: null }).errors, []);
  assert.equal(toId('12'), 12); assert.equal(toId('1; DROP TABLE'), null); assert.equal(toId(-3), null);
});

const auto = require('../src/controllers/auto_trade.controller');

test('auto-trade createConfig: invalid risk params => 400 and the database is never touched', async () => {
  dbCalls.length = 0;
  for (const bad of [{ maxDailyLossPct: -5 }, { maxPositionSize: Infinity }, { probationTradesRequired: 'abc' }]) {
    const res = mkRes();
    await auto.createConfig({ user: { id: 7 }, body: { symbol: 'AAPL', strategyId: 'rsi_momentum', exchangeId: 'binance', ...bad } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(Array.isArray(res.body.errors));
  }
  assert.equal(dbCalls.length, 0);
});

test('auto-trade updateConfig/deleteConfig: bad id or non-boolean enabled => 400, no DB call', async () => {
  dbCalls.length = 0;
  let res = mkRes(); await auto.updateConfig({ user: { id: 7 }, params: { id: 'abc' }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  res = mkRes(); await auto.updateConfig({ user: { id: 7 }, params: { id: '3' }, body: { enabled: 'false' } }, res);
  assert.equal(res.statusCode, 400);                       // the string "false" used to become true
  res = mkRes(); await auto.updateConfig({ user: { id: 7 }, params: { id: '3' }, body: { maxDailyLossPct: -1 } }, res);
  assert.equal(res.statusCode, 400);
  res = mkRes(); await auto.deleteConfig({ user: { id: 7 }, params: { id: '3; DROP' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(dbCalls.length, 0);
});

// ── 3. backtest parameters ───────────────────────────────────
const { _resolveBacktestParams: resolveParams } = require('../src/controllers/backtest.controller');

test('backtest: invalid capital / maxPos / sizing are rejected, not silently replaced', () => {
  for (const bad of [
    { capital: 'abc' }, { capital: -5 }, { capital: 0 }, { capital: Infinity },
    { maxPos: 0 }, { maxPos: 'x' }, { maxPos: 2.5 },
    { positionSizeMode: 'weird' }, { positionSizeMode: 'fixed_pct', positionSizeValue: 0 },
    { positionSizeMode: 'fixed_pct', positionSizeValue: 150 }, { positionSizeMode: 'fixed_dollar' },
  ]) assert.ok(resolveParams(bad).errors.length > 0, `should reject ${JSON.stringify(bad)}`);
});

test('backtest: absent values use documented defaults AND report them; formatted numbers are accepted', () => {
  const d = resolveParams({});
  assert.deepEqual(d.errors, []);
  assert.equal(d.capital, 100000); assert.equal(d.maxPositions, 5); assert.equal(d.positionSizeValue, 10);
  assert.deepEqual(d.defaultsApplied.sort(), ['capital', 'maxPositions', 'positionSizeMode', 'positionSizeValue']);
  const u = resolveParams({ capital: '$250,000', maxPos: '3', positionSizeMode: 'fixed_dollar', positionSizeValue: '5 000' });
  assert.deepEqual(u.errors, []);
  assert.equal(u.capital, 250000); assert.equal(u.maxPositions, 3); assert.equal(u.positionSizeValue, 5000);
  assert.deepEqual(u.defaultsApplied, []);
});

// ── 4. error messages ────────────────────────────────────────
test('httpError: production hides internals (generic message + requestId); dev/4xx/expose pass through', () => {
  const { sendServerError, publicMessage } = require('../src/utils/httpError');
  const secret = new Error('relation "users" does not exist at /srv/app/db.js:42');
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    let res = mkRes(); sendServerError(res, secret);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Internal server error');
    assert.match(res.body.requestId, /^[0-9a-f]{8}$/);
    assert.ok(!JSON.stringify(res.body).includes('relation'));
    assert.equal(publicMessage(secret), 'Internal server error');

    res = mkRes(); sendServerError(res, Object.assign(new Error('Live trading is disabled'), { status: 403, code: 'PAPER_TRADING_ENABLED' }));
    assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'PAPER_TRADING_ENABLED');
    assert.match(res.body.error, /Live trading is disabled/);
    assert.equal(publicMessage(Object.assign(new Error('Données insuffisantes'), { expose: true })), 'Données insuffisantes');

    process.env.NODE_ENV = 'development';
    res = mkRes(); sendServerError(res, secret);
    assert.match(res.body.error, /relation "users"/);
  } finally { process.env.NODE_ENV = prev; }
});
