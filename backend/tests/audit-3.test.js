/**
 * Audit 3 fixes: per-user Telegram, 40-symbol portfolio quotes (direct call), read-only API keys,
 * encrypted 2FA secrets, cumulative exposure cap, unhandledRejection handler.
 * Run: cd backend && npm test      (no PostgreSQL / network needed)
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';
process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
process.env.TELEGRAM_CHAT_ID   = 'OWNER_CHAT_MUST_NEVER_BE_USED';
process.env.EXCHANGE_ENCRYPTION_KEY = 'ab'.repeat(32);

const test   = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// ── helpers ────────────────────────────────────────────────────
const fake = { handler: async () => ({ rows: [] }), calls: [] };
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (sql, params) => { fake.calls.push({ sql, params }); return fake.handler(sql, params); }, ready: Promise.resolve() },
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const fresh = (...mods) => { for (const m of mods) delete require.cache[require.resolve(m)]; };
const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  r.cookies = {};
  r.cookie      = (n, v, o) => { r.cookies[n] = { value: v, options: o }; return r; };
  r.clearCookie = (n, o) => { r.cleared = { name: n, options: o }; return r; };
  return r;
};

// ═════════════════════════════════════════════════════════════
// 1. Telegram: always the chat of THE user, never the bot owner's
// ═════════════════════════════════════════════════════════════
test('telegram: sendTelegramAlert goes to the given chat, never TELEGRAM_CHAT_ID; no chat => no request', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { json: async () => ({ ok: true }) }; };
  try {
    fresh('../src/services/telegram.service');
    const tg = require('../src/services/telegram.service');
    await tg.sendTelegramAlert({ chatId: '4242', symbol: 'BTC', type: 'price', condition: 'above', target: 1, currentPrice: 2 });
    await tg.sendTelegramAlert({ chatId: null,   symbol: 'BTC', type: 'price', condition: 'above', target: 1, currentPrice: 2 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat_id, '4242');
    assert.ok(!JSON.stringify(sent).includes('OWNER_CHAT'));
  } finally { global.fetch = realFetch; }
});

test('telegram: getUserTelegramChat only returns a chat for users with Telegram enabled', async () => {
  fresh('../src/services/telegram.service');
  const tg = require('../src/services/telegram.service');
  fake.calls.length = 0;
  fake.handler = async () => ({ rows: [{ telegram_chat_id: 777 }] });
  assert.equal(await tg.getUserTelegramChat(5), '777');
  assert.match(fake.calls[0].sql, /telegram_enabled/);
  assert.deepEqual(fake.calls[0].params, [5]);
  fake.handler = async () => ({ rows: [] });
  assert.equal(await tg.getUserTelegramChat(6), null);
});

test('signalAlert: signal Telegram messages reach only users who linked Telegram, each on their own chat', async () => {
  stub('../src/services/email.service', { sendAlertEmail: async () => {} });
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { json: async () => ({ ok: true }) }; };
  fake.handler = async (sql) => {
    if (/FROM users u/.test(sql)) return { rows: [
      { id: 1, email: 'a@x.co', alert_mode: 'all', alert_symbols: [], min_confidence: 50, telegram_chat_id: '111' },
      { id: 2, email: 'b@x.co', alert_mode: 'all', alert_symbols: [], min_confidence: 50, telegram_chat_id: null },
      { id: 3, email: 'c@x.co', alert_mode: 'all', alert_symbols: [], min_confidence: 50, telegram_chat_id: '333' },
    ] };
    if (/FROM signals/.test(sql)) return { rows: [{ id: 9, symbol: 'AAPL', signal: 'BUY', confidence: 80, price: 100, entry: 100, stop_loss: 95, take_profit: 110, risk_reward: 2, reasoning: 'x', asset_class: 'Stocks' }] };
    return { rows: [] };
  };
  try {
    fresh('../src/services/telegram.service', '../src/services/signalAlert.service');
    await require('../src/services/signalAlert.service').checkSignalAlerts();
    assert.deepEqual(sent.map(s => s.chat_id).sort(), ['111', '333']);
    assert.ok(!JSON.stringify(sent).includes('OWNER_CHAT'));
  } finally { global.fetch = realFetch; }
});

// ═════════════════════════════════════════════════════════════
// 2. Portfolio prices: all 40 tickers, direct call (no HTTP on localhost)
// ═════════════════════════════════════════════════════════════
const FORTY = ['AAPL','MSFT','GOOGL','GOOG','AMZN','TSLA','NVDA','META','AMD','PLTR',
  'SPY','QQQ','DIA','IWM','NFLX','BABA','TSM','ORCL','INTC','QCOM',
  'JPM','GS','MS','BAC','WFC','V','MA','PYPL','SQ','COIN',
  'XOM','CVX','BP','OXY','MCD','KO','PEP','PG','JNJ','UNH'];

function loadPortfolio({ demo = false, failing = [] } = {}) {
  if (demo) process.env.PRICES_DEMO_MODE = 'true'; else delete process.env.PRICES_DEMO_MODE;
  const quoted = [];
  class FakeYF { async quote(sym) {
    quoted.push(sym);
    if (failing.includes(sym)) throw new Error('rate limited');
    return { symbol: sym, regularMarketPrice: 100 + sym.length, regularMarketChangePercent: 1.5 };
  } }
  stub('yahoo-finance2', { default: FakeYF });
  const httpCalls = [];
  stub('axios', { get: async (url) => { httpCalls.push(url); throw new Error('no network in tests'); } });
  stub('../src/services/exchanges.service', {});
  stub('../src/services/marketData.service', { getBenchmarkHistory: async () => [] });
  stub('../src/services/benchmarkComparison.service', { buildBenchmarkCurve: () => ({}) });
  fresh('../src/services/stockQuotes.service', '../src/controllers/portfolioController');
  return { ctrl: require('../src/controllers/portfolioController'), quoted, httpCalls };
}

test('portfolio: all 40 stock tickers get a live price, via a direct service call (not HTTP localhost)', async () => {
  const { ctrl, quoted, httpCalls } = loadPortfolio();
  const prices = await ctrl.fetchLivePrices(FORTY, {});
  assert.equal(Object.keys(prices).length, 40, 'every ticker must be priced (was capped to 9)');
  for (const s of FORTY) { assert.ok(prices[s].price > 0, s); assert.ok(!prices[s].stale, s); }
  assert.equal(quoted.length, 40);
  assert.equal(httpCalls.filter(u => String(u).includes('localhost')).length, 0);
});

test('portfolio: demo/stale quotes are flagged, never presented as live', async () => {
  const { ctrl } = loadPortfolio({ demo: true, failing: ['AAPL'] });
  const prices = await ctrl.fetchLivePrices(['AAPL', 'MSFT'], {});
  assert.equal(prices.AAPL.stale, true);
  assert.equal(prices.AAPL.demo, true);
  assert.equal(prices.AAPL.changeRaw, 0, '24h change is not trusted on demo data');
  assert.ok(!prices.MSFT.stale && !prices.MSFT.demo);
  delete process.env.PRICES_DEMO_MODE;
});

test('portfolio: without PRICES_DEMO_MODE a failed ticker has NO price (no fake demo quote)', async () => {
  const { ctrl } = loadPortfolio({ failing: ['AAPL'] });
  const prices = await ctrl.fetchLivePrices(['AAPL'], {});
  assert.equal(prices.AAPL, undefined);
});

// ═════════════════════════════════════════════════════════════
// 3. API keys: honoured, read-only, never on account routes
// ═════════════════════════════════════════════════════════════
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const RAW_KEY = 'aq_live_' + 'c'.repeat(48);

function runProtect(req) {
  fresh('../src/middleware/auth.middleware');
  const { protect } = require('../src/middleware/auth.middleware');
  const res = mkRes(); let nexted = false;
  return protect({ headers: { authorization: `Bearer ${RAW_KEY}` }, method: 'GET', originalUrl: '/api/portfolio/data', ...req }, res, () => { nexted = true; })
    .then(() => ({ res, nexted }));
}

test('api key: valid key authenticates a GET as that user (read scope only)', async () => {
  fake.calls.length = 0;
  fake.handler = async (sql, params) => /FROM api_keys/.test(sql) && params[0] === sha(RAW_KEY)
    ? { rows: [{ key_id: 3, user_id: 42, email: 'u@x.co', plan: 'free' }] } : { rows: [] };
  const req = { headers: { authorization: `Bearer ${RAW_KEY}` }, method: 'GET', originalUrl: '/api/portfolio/data?x=1' };
  fresh('../src/middleware/auth.middleware');
  const res = mkRes(); let nexted = false;
  await require('../src/middleware/auth.middleware').protect(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.user.id, 42);
  assert.deepEqual(req.user.scopes, ['read']);
  assert.equal(req.user.via, 'api_key');
  assert.match(fake.calls[0].sql, /revoked_at IS NULL/);
});

test('api key: unknown or revoked key => 401', async () => {
  fake.handler = async () => ({ rows: [] });
  const { res, nexted } = await runProtect({});
  assert.equal(res.statusCode, 401); assert.equal(nexted, false);
});

test('api key: write methods are refused even with a valid key (no trading)', async () => {
  fake.calls.length = 0;
  fake.handler = async () => ({ rows: [{ key_id: 3, user_id: 42, email: 'u@x.co', plan: 'free' }] });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const { res, nexted } = await runProtect({ method, originalUrl: '/api/trading/order' });
    assert.equal(res.statusCode, 403, method);
    assert.equal(res.body.code, 'API_KEY_READ_ONLY');
    assert.equal(nexted, false);
  }
  assert.equal(fake.calls.length, 0, 'refused before touching the database');
});

test('api key: account/security/exchange/auth routes are off limits, even for GET', async () => {
  fake.handler = async () => ({ rows: [{ key_id: 3, user_id: 42, email: 'u@x.co', plan: 'free' }] });
  for (const url of ['/api/security/api-keys', '/api/settings/export', '/api/settings', '/api/exchanges/connections', '/api/auth/me', '/API/SECURITY/sessions']) {
    const { res, nexted } = await runProtect({ originalUrl: url });
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.body.code, 'API_KEY_FORBIDDEN');
    assert.equal(nexted, false);
  }
});

test('api key: creating a "trade" key is rejected; read keys are created read-only', async () => {
  fresh('../src/controllers/security.controller');
  const sec = require('../src/controllers/security.controller');
  fake.calls.length = 0;
  fake.handler = async () => ({ rows: [{ id: 1, name: 'bot', key_prefix: 'aq_live_xxxx', scopes: ['read'], created_at: new Date() }] });

  let res = mkRes();
  await sec.createApiKey({ user: { id: 1 }, body: { name: 'bot', scopes: ['read', 'trade'] }, headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'API_KEY_SCOPE_UNSUPPORTED');
  assert.equal(fake.calls.filter(c => /INSERT INTO api_keys/.test(c.sql)).length, 0);

  res = mkRes();
  await sec.createApiKey({ user: { id: 1 }, body: { name: 'bot' }, headers: {} }, res);
  const insert = fake.calls.find(c => /INSERT INTO api_keys/.test(c.sql));
  assert.ok(insert);
  assert.equal(insert.params[4], JSON.stringify(['read']));
  assert.match(res.body.key, /^aq_live_[0-9a-f]{48}$/);
});

test('JWT auth still works and is unaffected by the API key path', async () => {
  const jwt = require('jsonwebtoken');
  fake.handler = async () => ({ rows: [{ revoked_at: null }] });
  fresh('../src/middleware/auth.middleware');
  const { protect } = require('../src/middleware/auth.middleware');
  const token = jwt.sign({ id: 7, email: 'a@b.co', plan: 'free' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'POST', originalUrl: '/api/settings/update' };
  let nexted = false;
  await protect(req, mkRes(), () => { nexted = true; });
  assert.equal(nexted, true); assert.equal(req.user.id, 7);
});

// ═════════════════════════════════════════════════════════════
// 4. 2FA secrets encrypted at rest
// ═════════════════════════════════════════════════════════════
test('2FA secret: encrypted (never the base32 in clear), round-trips, legacy plaintext still readable', () => {
  const sb = require('../src/utils/secretBox');
  const secret = 'JBSWY3DPEHPK3PXP';
  const stored = sb.encryptTotpSecret(secret);
  assert.ok(stored.startsWith('enc:v1:'));
  assert.ok(!stored.includes(secret));
  assert.notEqual(stored, sb.encryptTotpSecret(secret), 'random IV: two encryptions differ');
  assert.equal(sb.decryptTotpSecret(stored), secret);
  assert.equal(sb.decryptTotpSecret(secret), secret, 'legacy plaintext value keeps working');
  assert.equal(sb.encryptTotpSecret(stored), stored, 'idempotent');
  assert.equal(sb.isEncryptedTotpSecret(secret), false);
});

test('2FA secret: tampered ciphertext is rejected (GCM auth tag)', () => {
  const sb = require('../src/utils/secretBox');
  const stored = sb.encryptTotpSecret('JBSWY3DPEHPK3PXP');
  const parts = stored.split(':');
  parts[parts.length - 1] = (parts[parts.length - 1][0] === 'a' ? 'b' : 'a') + parts[parts.length - 1].slice(1);
  assert.throws(() => sb.decryptTotpSecret(parts.join(':')));
});

test('2FA secret: production without an encryption key refuses to store a clear secret', () => {
  const sb = require('../src/utils/secretBox');
  const key = process.env.EXCHANGE_ENCRYPTION_KEY, env = process.env.NODE_ENV;
  delete process.env.EXCHANGE_ENCRYPTION_KEY; process.env.NODE_ENV = 'production';
  try { assert.throws(() => sb.encryptTotpSecret('JBSWY3DPEHPK3PXP'), /EXCHANGE_ENCRYPTION_KEY/); }
  finally { process.env.EXCHANGE_ENCRYPTION_KEY = key; process.env.NODE_ENV = env; }
});

// ═════════════════════════════════════════════════════════════
// 5. Cumulative exposure cap (10 orders x 18% no longer = 180%)
// ═════════════════════════════════════════════════════════════
function riskWorld({ openNotional = 0, maxPosition = 20, maxExposure = 100 } = {}) {
  const world = { open: openNotional };
  stub('../src/services/exchanges.service', { PAPER_START_CAPITAL: 10000 });
  fake.handler = async (sql) => {
    if (/FROM user_settings/.test(sql)) return { rows: [{ risk_max_position_pct: maxPosition, risk_max_daily_loss_pct: 50, risk_default_stoploss_pct: 2, risk_max_total_exposure_pct: maxExposure }] };
    if (/quantity \* price/.test(sql))  return { rows: [{ notional: world.open }] };
    if (/closed_at >=/.test(sql))       return { rows: [{ pnl: 0 }] };
    if (/SUM\(pnl\)/.test(sql))         return { rows: [{ realised: 0 }] };
    return { rows: [] };
  };
  fresh('../src/services/riskGuard.service');
  world.guard = require('../src/services/riskGuard.service');
  world.check = (notional) => world.guard.checkOrder({ userId: 1, exchangeId: 'binance', mode: 'paper', side: 'buy', quantity: notional / 100, refPrice: 100 });
  return world;
}

test('exposure: ten 18% orders are stopped once the 100% cap would be exceeded', async () => {
  const w = riskWorld();
  let accepted = 0, firstRefusal = null;
  for (let i = 0; i < 10; i++) {
    const r = await w.check(1800);                 // 18% of 10 000 equity, under the 20% per-order cap
    if (r.ok) { accepted++; w.open += 1800; } else { firstRefusal = firstRefusal || r; }
  }
  assert.equal(accepted, 5, '5 x 18% = 90% fits, the 6th would reach 108%');
  assert.equal(firstRefusal.code, 'RISK_MAX_EXPOSURE');
  assert.equal(firstRefusal.status, 403);
  assert.ok(w.open <= 10000);
});

test('exposure: refusal reports the remaining room as a max quantity', async () => {
  const w = riskWorld({ openNotional: 9500 });
  const r = await w.check(1000);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RISK_MAX_EXPOSURE');
  assert.equal(r.details.maxQuantity, 5);          // 500 of room / price 100
});

test('exposure: limit 0 disables the cap; a higher limit allows leverage; per-order cap still applies', async () => {
  assert.equal((await riskWorld({ openNotional: 50000, maxExposure: 0 }).check(1000)).ok, true);
  assert.equal((await riskWorld({ openNotional: 12000, maxExposure: 200 }).check(1000)).ok, true);
  const r = await riskWorld({ maxExposure: 0 }).check(2500);   // 25% > 20% per-order cap
  assert.equal(r.code, 'RISK_MAX_POSITION');
});

// ═════════════════════════════════════════════════════════════
// 6. unhandledRejection must not kill the backend
// ═════════════════════════════════════════════════════════════
test('processHandlers: unhandledRejection is logged and the process keeps running; uncaughtException exits(1)', async () => {
  const logged = [];
  stub('../src/utils/logger', { error: (m) => logged.push(m), warn() {}, info() {}, debug() {} });
  fresh('../src/utils/processHandlers');
  const { installProcessHandlers } = require('../src/utils/processHandlers');

  const proc = new EventEmitter();
  const exits = [];
  installProcessHandlers(proc, { exit: (c) => exits.push(c), exitDelayMs: 10 });

  proc.emit('unhandledRejection', new Error('boom from a cron'));
  proc.emit('unhandledRejection', 'plain string reason');
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(exits, [], 'a rejected promise must not terminate the process');
  assert.ok(logged.some(m => m.includes('unhandledRejection') && m.includes('boom from a cron')));

  proc.emit('uncaughtException', new Error('corrupt state'));
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(exits, [1]);
});

// ═════════════════════════════════════════════════════════════
// 4b. Login with an encrypted 2FA secret (auth.controller)
// ═════════════════════════════════════════════════════════════
async function loginWorld(storedSecret) {
  const bcrypt = require('bcryptjs');
  const user = { id: 7, name: 'A', email: 'a@b.co', plan: 'free', created_at: new Date(),
    password: await bcrypt.hash('hunter22', 4), twofa_enabled: true, twofa_secret: storedSecret, twofa_backup_codes: [] };
  const writes = [];
  fake.handler = async (sql, params) => {
    if (/FROM audit_log/.test(sql)) return { rows: [{ n: 0 }] };
    if (/FROM users WHERE email/.test(sql)) return { rows: [user] };
    if (/UPDATE users SET twofa_secret/.test(sql)) writes.push(params);
    return { rows: [] };
  };
  fresh('../src/controllers/security.controller', '../src/controllers/auth.controller', '../src/middleware/auth.middleware');
  return { auth: require('../src/controllers/auth.controller'), writes };
}
const loginReq = (totp) => ({ headers: {}, ip: '1.2.3.4', body: { email: 'a@b.co', password: 'hunter22', totp } });

test('login: 2FA secret stored encrypted => valid TOTP gives a token, wrong code gives 401', async () => {
  const speakeasy = require('speakeasy');
  const sb = require('../src/utils/secretBox');
  const base32 = speakeasy.generateSecret({ length: 20 }).base32;
  const { auth } = await loginWorld(sb.encryptTotpSecret(base32));

  let res = mkRes();
  await auth.login(loginReq(speakeasy.totp({ secret: base32, encoding: 'base32' })), res);
  assert.ok(res.cookies.aq_session?.value, 'valid code must log in (session cookie set)');
  assert.equal(res.body.token, undefined, 'JWT must not be in the JSON body');

  res = mkRes();
  await auth.login(loginReq('000000'), res);
  assert.equal(res.statusCode, 401); assert.equal(res.cookies.aq_session, undefined);
});

test('login: legacy plaintext secret still works and is re-encrypted after the first success', async () => {
  const speakeasy = require('speakeasy');
  const base32 = speakeasy.generateSecret({ length: 20 }).base32;
  const { auth, writes } = await loginWorld(base32);
  const res = mkRes();
  await auth.login(loginReq(speakeasy.totp({ secret: base32, encoding: 'base32' })), res);
  assert.ok(res.cookies.aq_session?.value);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(writes.length, 1);
  assert.ok(writes[0][0].startsWith('enc:v1:'));
  assert.ok(!writes[0][0].includes(base32));
});

test('login: an undecryptable 2FA secret (wrong key) fails closed with 401, never a token or a crash', async () => {
  const speakeasy = require('speakeasy');
  const sb = require('../src/utils/secretBox');
  const base32 = speakeasy.generateSecret({ length: 20 }).base32;
  const stored = sb.encryptTotpSecret(base32);
  const goodKey = process.env.EXCHANGE_ENCRYPTION_KEY;
  process.env.EXCHANGE_ENCRYPTION_KEY = 'cd'.repeat(32);
  try {
    const { auth } = await loginWorld(stored);
    const res = mkRes();
    await auth.login(loginReq(speakeasy.totp({ secret: base32, encoding: 'base32' })), res);
    assert.equal(res.statusCode, 401); assert.equal(res.cookies.aq_session, undefined);
  } finally { process.env.EXCHANGE_ENCRYPTION_KEY = goodKey; }
});
