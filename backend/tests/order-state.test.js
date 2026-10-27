/**
 * Live order state machine (in-memory fake DB + fake exchange layer, no PostgreSQL, no network).
 *   - the order is RECORDED (pending, with a client id) BEFORE it is sent, and the same id is sent to the exchange
 *   - a lost reply is "unknown" (never "failed", never re-sent); a definite refusal is "rejected"
 *   - what the exchange layer sends (clientOrderId) and how errors/statuses are classified
 * Run: cd backend && node --test tests/order-state.test.js
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';
process.env.PAPER_TRADING = 'false';
process.env.REQUIRE_VERIFIED_EMAIL_FOR_LIVE = 'false';

const test   = require('node:test');
const assert = require('node:assert');
const axios  = require('axios');
const ccxt   = require('ccxt');

// ── fake database ───────────────────────────────────────────
const fake = { calls: [], failInsert: false, failUpdate: false, order: [] };
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    ready: Promise.resolve(),
    query: async (sql, params) => {
      fake.calls.push({ sql, params });
      if (/INSERT INTO live_orders/.test(sql)) {
        if (fake.failInsert) throw new Error('db down (insert)');
        fake.order.push('INSERT'); return { rows: [{ id: 41 }] };
      }
      if (/UPDATE live_orders/.test(sql)) {
        if (fake.failUpdate) throw new Error('db down (update)');
        fake.order.push('UPDATE'); return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  },
};

// ── fake exchange layer (the controller's only door to an exchange) ──
const svc = {
  sent: [], behaviour: async () => ({ exchangeOrderId: 'EX-1', status: 'open', raw: { id: 'EX-1' } }),
  getDecryptedCredentials: async () => ({ apiKey: 'k', apiSecret: 's', mode: 'live' }),
  placeLiveOrder: async (exchangeId, creds, order) => { fake.order.push('SEND'); svc.sent.push(order); return svc.behaviour(order); },
};
const svcPath = require.resolve('../src/services/exchanges.service');
require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: svc };

const killPath = require.resolve('../src/utils/killSwitch');
require.cache[killPath] = { id: killPath, filename: killPath, loaded: true, exports: { isEngagedFresh: async () => false, isEngaged: () => false, blockedResponse: () => ({}) } };

const { placeOrder } = require('../src/controllers/trading.controller');
const { classifyOrderError, normalizeOrderStatus, newClientOrderId } = require('../src/utils/orderState');

const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
// a live SELL limit order: reduce-only, so the risk guard lets it through without equity data
const req = () => ({ user: { id: 7 }, idempotency: { key: 'k-12345678' }, body: { exchangeId: 'binance', symbol: 'BTC', side: 'sell', orderType: 'limit', price: 100, quantity: 1, noStopLoss: true } });
const updates = () => fake.calls.filter((c) => /UPDATE live_orders/.test(c.sql));

test.beforeEach(() => {
  fake.calls = []; fake.order = []; fake.failInsert = false; fake.failUpdate = false;
  svc.sent = []; svc.behaviour = async () => ({ exchangeOrderId: 'EX-1', status: 'open', raw: { id: 'EX-1' } });
});

// ── controller ──────────────────────────────────────────────
test('placed: the row is recorded as pending BEFORE the send, with the SAME client id, then completed', async () => {
  const res = mkRes(); await placeOrder(req(), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.deepEqual(fake.order, ['INSERT', 'SEND', 'UPDATE'], 'record first, send second, complete third');
  const ins = fake.calls.find((c) => /INSERT INTO live_orders/.test(c.sql));
  assert.match(ins.sql, /'pending'/);
  const clientId = ins.params[ins.params.length - 1];
  assert.match(clientId, /^aq[0-9a-f]{28}$/);
  assert.equal(svc.sent[0].clientOrderId, clientId, 'the exchange receives the id we stored');
  const up = updates()[0];
  assert.deepEqual([up.params[0], up.params[1]], ['EX-1', 'submitted'], 'exchange "open" is stored as our "submitted"');
});

test('lost reply (timeout): row becomes "unknown", answer is 502 ORDER_STATE_UNKNOWN, the order is sent ONCE', async () => {
  svc.behaviour = async () => { const e = new Error('timeout of 8000ms exceeded'); e.code = 'ECONNABORTED'; throw e; };
  const res = mkRes(); await placeOrder(req(), res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.code, 'ORDER_STATE_UNKNOWN');
  assert.equal(res.body.orderId, 41); assert.match(res.body.clientOrderId, /^aq/);
  assert.match(res.body.error, /Do NOT send it again/);
  assert.equal(svc.sent.length, 1, 'never re-sent');
  assert.equal(updates()[0].params[0], 'unknown');
});

test('every ambiguous failure is "unknown": 5xx, reset, ccxt timeout / network / generic exchange error, plain Error', async () => {
  const errs = [
    Object.assign(new Error('Bad gateway'), { response: { status: 502 } }),
    Object.assign(new Error('Service unavailable'), { response: { status: 503 } }),
    Object.assign(new Error('Too many requests'), { response: { status: 429 } }),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    new ccxt.RequestTimeout('t'), new ccxt.NetworkError('n'), new ccxt.ExchangeNotAvailable('x'), new ccxt.ExchangeError('generic'),
    new Error('something unexpected'),
  ];
  for (const e of errs) {
    fake.calls = []; svc.behaviour = async () => { throw e; };
    const res = mkRes(); await placeOrder(req(), res);
    assert.equal(res.body.code, 'ORDER_STATE_UNKNOWN', `${e.message} must be unknown`);
    assert.equal(updates()[0].params[0], 'unknown');
  }
});

test('a definite refusal is "rejected" (HTTP 400/401/403/404/422, ccxt InvalidOrder/InsufficientFunds/AuthenticationError/BadSymbol, orderNotSent)', async () => {
  const errs = [
    Object.assign(new Error('bad request'), { response: { status: 400 } }),
    Object.assign(new Error('forbidden'), { response: { status: 403 } }),
    Object.assign(new Error('unprocessable'), { response: { status: 422 } }),
    new ccxt.InvalidOrder('min notional'), new ccxt.InsufficientFunds('no funds'),
    new ccxt.AuthenticationError('bad key'), new ccxt.BadSymbol('no such market'),
    Object.assign(new Error('Live trading is disabled'), { orderNotSent: true, status: 403 }),
  ];
  for (const e of errs) {
    fake.calls = []; fake.order = []; svc.behaviour = async () => { throw e; };
    const res = mkRes(); await placeOrder(req(), res);
    assert.notEqual(res.body && res.body.code, 'ORDER_STATE_UNKNOWN', `${e.message} must NOT be unknown`);
    assert.equal(updates()[0].params[0], 'rejected', `${e.message} => rejected`);
  }
});

test('the row cannot be recorded => 503, and NOTHING is sent to the exchange', async () => {
  fake.failInsert = true;
  const res = mkRes(); await placeOrder(req(), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'ORDER_NOT_RECORDED');
  assert.equal(svc.sent.length, 0);
});

test('placed but the completing write fails: the user still gets success, the row stays pending for the reconciler', async () => {
  fake.failUpdate = true;
  const res = mkRes(); await placeOrder(req(), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.equal(svc.sent.length, 1);
});

test('even the state write after a lost reply may fail: still 502 unknown, never a crash', async () => {
  fake.failUpdate = true;
  svc.behaviour = async () => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; };
  const res = mkRes(); await placeOrder(req(), res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.code, 'ORDER_STATE_UNKNOWN');
});

// ── helpers ─────────────────────────────────────────────────
test('classifyOrderError: unknown is the default; only a certain refusal is rejected', () => {
  assert.equal(classifyOrderError(null), 'unknown');
  assert.equal(classifyOrderError({}), 'unknown');
  assert.equal(classifyOrderError({ response: { status: 408 } }), 'unknown');
  assert.equal(classifyOrderError({ response: { status: 500 } }), 'unknown');
  assert.equal(classifyOrderError({ response: { status: 401 } }), 'rejected');
  assert.equal(classifyOrderError({ orderNotSent: true }), 'rejected');
});

test('normalizeOrderStatus maps exchange words onto our states ("open" must not stay "open")', () => {
  const t = [['open', 0, 'submitted'], ['open', 0.4, 'partially_filled'], ['new', 0, 'submitted'], ['accepted', 0, 'submitted'],
    ['pending_new', 0, 'submitted'], ['filled', 1, 'filled'], ['closed', 1, 'filled'], ['partially_filled', 0.5, 'partially_filled'],
    ['canceled', 0, 'cancelled'], ['expired', 0, 'cancelled'], ['rejected', 0, 'rejected'], ['weird', 0, 'submitted'], [undefined, 0, 'submitted']];
  for (const [raw, filled, want] of t) assert.equal(normalizeOrderStatus(raw, filled), want, `${raw}/${filled}`);
});

test('newClientOrderId: 30 chars, unique, safe for Binance (<=36, [A-Za-z0-9-_])', () => {
  const ids = new Set(Array.from({ length: 500 }, newClientOrderId));
  assert.equal(ids.size, 500);
  for (const id of ids) { assert.equal(id.length, 30); assert.match(id, /^[A-Za-z0-9_-]{1,36}$/); }
});

// ── what the exchange layer sends (real exchanges.service, HTTP stubbed) ──
test('exchange layer: the client id is sent to OANDA, Alpaca and ccxt exchanges', async () => {
  delete require.cache[svcPath];
  delete require.cache[require.resolve('../src/config/env')];
  const real = require('../src/services/exchanges.service');
  const sent = {};
  const realPost = axios.post; const realBinance = ccxt.binance;
  axios.post = async (url, body) => { sent[url.includes('oanda') || url.includes('/v3/') ? 'oanda' : 'alpaca'] = body;
    return { data: url.includes('/v3/') ? { orderCreateTransaction: { id: '9' } } : { id: 'A1', status: 'new' } }; };
  ccxt.binance = class { constructor() {} async loadMarkets() {} async createOrder(...a) { sent.ccxt = a; return { id: 77, status: 'open' }; } };
  const creds = { apiKey: 'acct', apiSecret: 's', mode: 'paper' };
  try {
    await real.placeLiveOrder('oanda', creds, { symbol: 'EURUSD', side: 'buy', type: 'market', quantity: 1, clientOrderId: 'aqOANDA' });
    await real.placeLiveOrder('alpaca', creds, { symbol: 'AAPL', side: 'buy', type: 'market', quantity: 1, clientOrderId: 'aqALPACA' });
    await real.placeLiveOrder('binance', creds, { symbol: 'BTC', side: 'buy', type: 'limit', quantity: 1, price: 1, clientOrderId: 'aqCCXT' });
  } finally { axios.post = realPost; ccxt.binance = realBinance; }
  assert.equal(sent.oanda.order.clientExtensions.id, 'aqOANDA');
  assert.equal(sent.alpaca.client_order_id, 'aqALPACA');
  assert.deepEqual(sent.ccxt[5], { clientOrderId: 'aqCCXT' });
});

test('exchange layer: a failing market-data call is "orderNotSent" (rejected), a failing createOrder is not', async () => {
  const real = require('../src/services/exchanges.service');
  const realBinance = ccxt.binance;
  try {
    ccxt.binance = class { async loadMarkets() { throw new ccxt.NetworkError('markets down'); } async createOrder() { throw new Error('never'); } };
    await assert.rejects(() => real.placeLiveOrder('binance', { mode: 'live' }, { symbol: 'BTC', side: 'buy', type: 'market', quantity: 1 }),
      (e) => e.orderNotSent === true && classifyOrderError(e) === 'rejected');
    ccxt.binance = class { async loadMarkets() {} async createOrder() { throw new ccxt.RequestTimeout('lost'); } };
    await assert.rejects(() => real.placeLiveOrder('binance', { mode: 'live' }, { symbol: 'BTC', side: 'buy', type: 'market', quantity: 1 }),
      (e) => e.orderNotSent !== true && classifyOrderError(e) === 'unknown');
  } finally { ccxt.binance = realBinance; }
});

// ── lookup by client id (what the reconciler calls) ──
test('fetchOrderByClientId: found / not found (404, OrderNotFound) / cannot ask (throws)', async () => {
  const real = require('../src/services/exchanges.service');
  const realGet = axios.get; const realBinance = ccxt.binance;
  const creds = { apiKey: 'acct', apiSecret: 's', mode: 'paper' };
  try {
    axios.get = async (url) => url.includes('/v3/') ? { data: { order: { id: '5', state: 'FILLED', fillingTransactionID: '6' } } } : { data: { id: 'A9', status: 'partially_filled', filled_qty: '1' } };
    const o = await real.fetchOrderByClientId('oanda', creds, { clientOrderId: 'aq1' });
    assert.deepEqual([o.found, o.exchangeOrderId, o.status], [true, '6', 'filled']);
    const a = await real.fetchOrderByClientId('alpaca', creds, { clientOrderId: 'aq1' });
    assert.deepEqual([a.found, a.exchangeOrderId, a.status], [true, 'A9', 'partially_filled']);

    axios.get = async () => { throw Object.assign(new Error('nf'), { response: { status: 404 } }); };
    assert.deepEqual(await real.fetchOrderByClientId('oanda', creds, { clientOrderId: 'aq1' }), { found: false });
    assert.deepEqual(await real.fetchOrderByClientId('alpaca', creds, { clientOrderId: 'aq1' }), { found: false });

    axios.get = async () => { throw Object.assign(new Error('boom'), { response: { status: 500 } }); };   // could not ask => NOT "not found"
    await assert.rejects(() => real.fetchOrderByClientId('alpaca', creds, { clientOrderId: 'aq1' }));
    axios.get = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
    await assert.rejects(() => real.fetchOrderByClientId('oanda', creds, { clientOrderId: 'aq1' }));

    ccxt.binance = class { async loadMarkets() {} async fetchOrder(id, sym, params) { fake.lookup = [id, sym, params]; return { id: 55, status: 'open', filled: 0 }; } };
    const c = await real.fetchOrderByClientId('binance', creds, { clientOrderId: 'aqC', symbol: 'btc' });
    assert.deepEqual([c.found, c.exchangeOrderId, c.status], [true, '55', 'submitted']);
    assert.deepEqual(fake.lookup, [undefined, 'BTC/USDT', { clientOrderId: 'aqC' }]);
    ccxt.binance = class { async loadMarkets() {} async fetchOrder() { throw new ccxt.OrderNotFound('no'); } };
    assert.deepEqual(await real.fetchOrderByClientId('binance', creds, { clientOrderId: 'aqC', symbol: 'BTC' }), { found: false });
    ccxt.binance = class { async loadMarkets() {} async fetchOrder() { throw new ccxt.NotSupported('no'); } };
    await assert.rejects(() => real.fetchOrderByClientId('binance', creds, { clientOrderId: 'aqC', symbol: 'BTC' }));
    await assert.rejects(() => real.fetchOrderByClientId('binance', creds, {}), /clientOrderId required/);
  } finally { axios.get = realGet; ccxt.binance = realBinance; }
});
