/**
 * PAPER_TRADING kill-switch: with PAPER_TRADING=true, placeLiveOrder() must refuse
 * BEFORE any exchange call. Run: cd backend && npm test
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');
const axios  = require('axios');

const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async () => ({ rows: [] }), ready: Promise.resolve() },
};

function loadService(paperTrading) {
  if (paperTrading === undefined) delete process.env.PAPER_TRADING;
  else process.env.PAPER_TRADING = paperTrading;
  for (const m of ['../src/config/env', '../src/services/exchanges.service']) delete require.cache[require.resolve(m)];
  return require('../src/services/exchanges.service');
}

const order = { symbol: 'EURUSD', side: 'buy', type: 'market', quantity: 1 };
const creds = { apiKey: 'k', apiSecret: 's', mode: 'live' };

test('PAPER_TRADING=true (and the default) blocks live orders before any exchange call', async () => {
  let calls = 0;
  const realPost = axios.post, realGet = axios.get, realRequest = axios.request;
  axios.post = axios.get = axios.request = async () => { calls++; return { data: {} }; };
  try {
    for (const flag of ['true', undefined]) {           // explicit true AND unset (default = true)
      const svc = loadService(flag);
      for (const ex of ['oanda', 'alpaca', 'binance']) {
        await assert.rejects(
          () => svc.placeLiveOrder(ex, creds, order),
          (e) => e.code === 'PAPER_TRADING_ENABLED' && e.status === 403,
          `${ex} must be blocked (PAPER_TRADING=${flag})`
        );
      }
    }
    assert.equal(calls, 0, 'no HTTP call may reach an exchange');
  } finally { axios.post = realPost; axios.get = realGet; axios.request = realRequest; }
});

test('PAPER_TRADING=false lets the order through to the exchange layer', async () => {
  const realPost = axios.post;
  let posted = false;
  axios.post = async () => { posted = true; return { data: { orderCreateTransaction: { id: 'x1' } } }; };
  try {
    const svc = loadService('false');
    const r = await svc.placeLiveOrder('oanda', creds, order);
    assert.equal(posted, true);
    assert.equal(r.exchangeOrderId, 'x1');
  } finally { axios.post = realPost; }
});
