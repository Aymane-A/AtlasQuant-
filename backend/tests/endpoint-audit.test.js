/**
 * Endpoint audit — fixes for the sensitive account actions (in-memory fake DB, no PostgreSQL needed).
 *   1. changePassword revokes every OTHER session (the current one stays), and is locked per account
 *   2. disable2FA needs password AND a second factor (TOTP or backup code), and is locked per account
 *   3. deleteAccount is locked per account after repeated wrong passwords
 *   4. scan-status: a job can only be read by the user who started it; ids are unguessable
 * Run: cd backend && node --test tests/endpoint-audit.test.js
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.NODE_ENV   = 'test';

const test   = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

const dbPath = require.resolve('../src/config/db');
const fake = { handler: async () => ({ rows: [] }), calls: [] };
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (sql, params) => { fake.calls.push({ sql, params }); return fake.handler(sql, params); }, ready: Promise.resolve() },
};

const settings = require('../src/controllers/settings.controller');
const security = require('../src/controllers/security.controller');
const signals  = require('../src/controllers/signals.controller');
const scanJobs = require('../src/services/scanJob.service');

const mkRes = () => {
  const r = { statusCode: 200, body: null, cleared: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  r.clearCookie = () => { r.cleared = true; return r; };
  return r;
};
const mkReq = (over = {}) => ({ user: { id: 7, email: 'a@b.co' }, body: {}, params: {}, query: {}, headers: {}, ip: '1.2.3.4', currentSessionHash: 'CURRENT_HASH', ...over });
const sqlOf  = (needle) => fake.calls.filter(c => c.sql.includes(needle));
const failuresLogged = (type) => fake.calls.filter(c => /INSERT INTO audit_log/.test(c.sql) && c.params[1] === type);

const PW = 'correct horse battery';
const PW_HASH = bcrypt.hashSync(PW, 4);
const SECRET = speakeasy.generateSecret({ length: 20 }).base32;           // legacy plaintext secret is accepted by decryptTotpSecret
const totp = () => speakeasy.totp({ secret: SECRET, encoding: 'base32' });
const BACKUP = 'deadbeef01';
const BACKUP_HASH = crypto.createHash('sha256').update(BACKUP).digest('hex');

/** fake DB: `failures` = how many recent failures audit_log reports, `user` = the users row */
function setDb({ failures = 0, user = {} } = {}) {
  fake.handler = async (sql) => {
    if (/FROM audit_log/.test(sql)) return { rows: [{ n: failures }] };
    if (/FROM users WHERE id/.test(sql)) return { rows: [{ password: PW_HASH, email: 'a@b.co', twofa_enabled: true, twofa_secret: SECRET, twofa_backup_codes: [BACKUP_HASH], ...user }] };
    if (/UPDATE user_sessions/.test(sql)) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 1 };
  };
}
test.beforeEach(() => { fake.calls = []; setDb(); });

// ── 1. changePassword ───────────────────────────────────────
test('changePassword: success revokes every OTHER session and keeps the current one', async () => {
  const res = mkRes();
  await settings.changePassword(mkReq({ body: { currentPassword: PW, newPassword: 'a-brand-new-password' } }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  const rev = sqlOf('UPDATE user_sessions');
  assert.equal(rev.length, 1, 'sessions must be revoked');
  assert.match(rev[0].sql, /revoked_at = NOW\(\)/);
  assert.match(rev[0].sql, /refresh_hash != \$2/);                       // the session making the request is spared
  assert.deepEqual(rev[0].params, [7, 'CURRENT_HASH']);
  assert.equal(res.body.sessionsRevoked, 3);
  assert.equal(sqlOf('UPDATE users SET password').length, 1);
});

test('changePassword: wrong current password => 401, failure recorded, nothing changed, no revocation', async () => {
  const res = mkRes();
  await settings.changePassword(mkReq({ body: { currentPassword: 'nope-nope-nope', newPassword: 'a-brand-new-password' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(failuresLogged('password_change_failed').length, 1);
  assert.equal(sqlOf('UPDATE users SET password').length, 0);
  assert.equal(sqlOf('UPDATE user_sessions').length, 0);
});

test('changePassword: locked after 5 failures => 429, password is not even checked', async () => {
  setDb({ failures: 5 });
  const res = mkRes();
  await settings.changePassword(mkReq({ body: { currentPassword: PW, newPassword: 'a-brand-new-password' } }), res);   // even the RIGHT password
  assert.equal(res.statusCode, 429); assert.equal(res.body.code, 'TOO_MANY_ATTEMPTS');
  assert.equal(sqlOf('UPDATE users SET password').length, 0);
  assert.equal(sqlOf('UPDATE user_sessions').length, 0);
});

test('changePassword: 4 failures do not lock yet', async () => {
  setDb({ failures: 4 });
  const res = mkRes();
  await settings.changePassword(mkReq({ body: { currentPassword: PW, newPassword: 'a-brand-new-password' } }), res);
  assert.equal(res.statusCode, 200);
});

// ── 2. disable2FA ───────────────────────────────────────────
test('disable2FA: password alone is NOT enough any more (400 2FA_CODE_REQUIRED), 2FA stays on', async () => {
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: PW } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.code, '2FA_CODE_REQUIRED');
  assert.equal(sqlOf('twofa_enabled = false').length, 0);
});

test('disable2FA: right password + wrong code => 401, failure recorded, 2FA stays on', async () => {
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: PW, code: '000000' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(failuresLogged('2fa_disable_failed').length, 1);
  assert.equal(sqlOf('twofa_enabled = false').length, 0);
});

test('disable2FA: wrong password => 401 (even with a valid code), failure recorded, 2FA stays on', async () => {
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: 'wrong-wrong', code: totp() } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(failuresLogged('2fa_disable_failed').length, 1);
  assert.equal(sqlOf('twofa_enabled = false').length, 0);
});

test('disable2FA: password + valid TOTP => disabled and audited', async () => {
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: PW, code: totp() } }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.equal(sqlOf('twofa_enabled = false').length, 1);
  assert.equal(fake.calls.filter(c => /INSERT INTO audit_log/.test(c.sql) && c.params[1] === '2fa_disabled').length, 1);
});

test('disable2FA: password + a valid backup code works too', async () => {
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: PW, code: BACKUP } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sqlOf('twofa_enabled = false').length, 1);
});

test('disable2FA: locked after 5 failures => 429, nothing is checked or changed', async () => {
  setDb({ failures: 5 });
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: PW, code: totp() } }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(sqlOf('twofa_enabled = false').length, 0);
});

test('disable2FA: when 2FA is not enabled => 400', async () => {
  setDb({ user: { twofa_enabled: false, twofa_secret: null } });
  const res = mkRes();
  await security.disable2FA(mkReq({ body: { password: PW, code: '123456' } }), res);
  assert.equal(res.statusCode, 400);
});

// ── 3. deleteAccount ────────────────────────────────────────
test('deleteAccount: wrong password => 401 + failure recorded + account kept', async () => {
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: 'wrong-wrong' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(failuresLogged('account_delete_failed').length, 1);
  assert.equal(sqlOf('DELETE FROM users').length, 0);
});

test('deleteAccount: locked after 5 failures => 429 even with the right password', async () => {
  setDb({ failures: 5 });
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: PW } }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(sqlOf('DELETE FROM users').length, 0);
});

test('deleteAccount: 2FA on + password only => 400 2FA_CODE_REQUIRED, the account is kept', async () => {
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: PW } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.code, '2FA_CODE_REQUIRED');
  assert.equal(sqlOf('DELETE FROM users').length, 0);
  assert.equal(failuresLogged('account_delete_failed').length, 0, 'a missing code is not a failed guess');
});

test('deleteAccount: 2FA on + right password + wrong code => 401, failure recorded, account kept', async () => {
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: PW, code: '000000' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(failuresLogged('account_delete_failed').length, 1);
  assert.equal(sqlOf('DELETE FROM users').length, 0);
});

test('deleteAccount: 2FA on + password + valid TOTP => deleted', async () => {
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: PW, code: totp() } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sqlOf('DELETE FROM users').length, 1);
  assert.equal(res.cleared, true);
});

test('deleteAccount: 2FA on + password + backup code => deleted', async () => {
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: PW, code: BACKUP } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sqlOf('DELETE FROM users').length, 1);
});

test('deleteAccount: a valid code with the WRONG password never deletes', async () => {
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: 'wrong-wrong', code: totp() } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(sqlOf('DELETE FROM users').length, 0);
});

test('deleteAccount: without 2FA the password is still enough', async () => {
  setDb({ user: { twofa_enabled: false, twofa_secret: null, twofa_backup_codes: [] } });
  const res = mkRes();
  await settings.deleteAccount(mkReq({ body: { password: PW } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sqlOf('DELETE FROM users').length, 1);
});

// ── 4. scan-status ownership ────────────────────────────────
test('scan jobs: id is unguessable (128 random bits) and a job is readable only by its owner', async () => {
  const id = scanJobs.createJob(11);
  assert.match(id, /^scan_[0-9a-f]{32}$/);
  assert.notEqual(scanJobs.createJob(11), scanJobs.createJob(11));
  assert.ok(scanJobs.getJobForUser(id, 11));
  assert.equal(scanJobs.getJobForUser(id, 12), null);
  assert.equal(scanJobs.getJobForUser(id, undefined), null);
});

test('GET scan-status: owner gets the job, another user gets 404 (same as "not found")', async () => {
  const id = scanJobs.createJob(11);
  scanJobs.updateJob(id, { cryptoTotal: 4, cryptoCompleted: 2, status: 'running' });

  const mine = mkRes();
  await signals.getScanStatus(mkReq({ user: { id: 11 }, params: { jobId: id } }), mine);
  assert.equal(mine.statusCode, 200); assert.equal(mine.body.progress, 50);

  const other = mkRes();
  await signals.getScanStatus(mkReq({ user: { id: 12 }, params: { jobId: id } }), other);
  assert.equal(other.statusCode, 404);
  assert.equal(other.body.signals, undefined);

  const missing = mkRes();
  await signals.getScanStatus(mkReq({ user: { id: 11 }, params: { jobId: 'scan_nope' } }), missing);
  assert.equal(missing.statusCode, 404);
});

test('a job created without an owner is readable by nobody', async () => {
  const id = scanJobs.createJob();
  assert.equal(scanJobs.getJobForUser(id, 1), null);
  assert.equal(scanJobs.getJobForUser(id, null), null);
});
