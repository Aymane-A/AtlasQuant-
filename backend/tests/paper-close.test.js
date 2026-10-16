/**
 * closePaperTrade must be atomic + idempotent: a concurrent close (manual click vs. SL/TP monitor)
 * must not overwrite the first close's exit price / P&L. Run: cd backend && npm test
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');

const calls = [];
let updateRows = [];
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    ready: Promise.resolve(),
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return { rows: [{ id: 5, user_id: 7, side: 'buy', price: '100', quantity: '2', status: 'open' }] };
      return { rows: updateRows };                                   // the guarded UPDATE
    },
  },
};
const svc = require('../src/services/exchanges.service');

test('closePaperTrade: the UPDATE is guarded by user_id and status=open', async () => {
  calls.length = 0; updateRows = [{ id: 5, status: 'closed', exit_price: '110', pnl: '20' }];
  const t = await svc.closePaperTrade(7, 5, 110, 'manual');
  assert.equal(t.status, 'closed');
  const upd = calls.find(c => /UPDATE paper_trades/i.test(c.sql));
  assert.match(upd.sql, /status\s*=\s*'open'/i);
  assert.match(upd.sql, /user_id\s*=\s*\$6/i);
  assert.equal(upd.params[5], 7);
});

test('closePaperTrade: losing a concurrent-close race => 404 "already closed", nothing overwritten', async () => {
  updateRows = [];                                                    // someone else closed it between SELECT and UPDATE
  await assert.rejects(() => svc.closePaperTrade(7, 5, 120, 'take_profit'), (e) => e.status === 404 && /déjà fermé/.test(e.message));
});
