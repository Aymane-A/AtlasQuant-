/**
 * utils/killSwitch.js — AtlasQuant AI
 *
 * Global emergency stop for NEW orders (manual /api/trading/order and the auto-trader).
 * Cancelling existing orders stays possible.
 *
 * The state is PERSISTENT and SHARED: it lives in the system_flags table (key 'kill_switch'), so
 *   - a restart does not re-enable trading (engaged stays engaged),
 *   - every backend instance sees the same switch.
 *
 * How it is read:
 *   - isEngagedFresh()  (async) reads the database. Used on the order paths, so a switch engaged on
 *                       instance A stops orders on instance B immediately. FAIL-CLOSED: if the
 *                       database cannot be read, the answer is "engaged".
 *   - isEngaged()/status() (sync) return a local cache, refreshed by startSync() every few seconds.
 *                       Used for /api/health only.
 *
 * How it is written (set):
 *   - engage:  the local cache flips first, then the row is written. If the write fails the switch
 *              is still engaged on this instance (safe side) and the result says persisted:false.
 *   - release: the row is written first. If that fails, set() throws and the switch STAYS engaged.
 *
 * Boot: TRADING_KILL_SWITCH=true engages (and persists) at every start, keeping the reason/since of
 * an already-engaged row. Releasing at runtime lasts until the next restart with that env var set.
 * Runtime toggle: POST /api/admin/kill-switch (X-Admin-Key), see routes/admin.routes.js.
 */
const db     = require('../config/db');
const logger = require('./logger');

const KEY = 'kill_switch';
const SYNC_INTERVAL_MS = 3000;

const envOn = () => String(process.env.TRADING_KILL_SWITCH || '').toLowerCase() === 'true';
const ENV_REASON = 'TRADING_KILL_SWITCH=true at startup';

let state = envOn()
  ? { engaged: true,  reason: ENV_REASON, since: new Date().toISOString() }
  : { engaged: false, reason: null,       since: null };
let syncTimer = null;

function envDefault() {
  return envOn()
    ? { engaged: true,  reason: ENV_REASON, since: state.since || new Date().toISOString() }
    : { engaged: false, reason: null,       since: null };
}

function clean(v) {
  return {
    engaged: !!v.engaged,
    reason:  v.engaged ? String(v.reason || 'manual').slice(0, 200) : null,
    since:   v.engaged ? (v.since || new Date().toISOString()) : null,
  };
}

function isEngaged() { return state.engaged; }
function status()    { return { ...state }; }

/** Reads the shared state from the database into the local cache. Throws if the database is unreachable. */
async function refresh() {
  const { rows } = await db.query(`SELECT value FROM system_flags WHERE key = $1`, [KEY]);
  const v = rows && rows[0] && rows[0].value;
  state = (v && typeof v === 'object') ? clean(v) : envDefault();   // no row yet => the env default
  return status();
}

/** Strict read for the order paths. Any failure to read means "engaged" (fail closed). */
async function isEngagedFresh() {
  try {
    await refresh();
    return state.engaged;
  } catch (err) {
    logger.error(`[killSwitch] state unreadable, refusing orders (fail closed): ${err.message}`);
    return true;
  }
}

/** Call once at boot, after the schema is ready. */
async function init() {
  try {
    if (envOn()) {
      const v = { engaged: true, reason: ENV_REASON, since: new Date().toISOString(), by: 'env' };
      // keep reason/since/by of a switch that is already engaged
      await db.query(
        `INSERT INTO system_flags (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE
           SET value = CASE WHEN (system_flags.value->>'engaged') = 'true' THEN system_flags.value ELSE EXCLUDED.value END,
               updated_at = NOW()`,
        [KEY, JSON.stringify(v)]
      );
    }
    await refresh();
    if (state.engaged) logger.warn(`[killSwitch] ENGAGED at boot (${state.reason})`);
  } catch (err) {
    logger.error(`[killSwitch] init failed (order paths will fail closed while the database is unreadable): ${err.message}`);
  }
  return status();
}

/** Keeps the local cache (used by /api/health) in step with other instances. */
function startSync(ms = SYNC_INTERVAL_MS) {
  if (syncTimer) return syncTimer;
  syncTimer = setInterval(() => { refresh().catch(() => {}); }, ms);
  syncTimer.unref();                       // must never keep the process alive
  return syncTimer;
}
function stopSync() { if (syncTimer) { clearInterval(syncTimer); syncTimer = null; } }

async function persist(v, by) {
  const value = { ...v, by: by && by.by || null, ip: by && by.ip || null };
  await db.query(
    `INSERT INTO system_flags (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(value)]
  );
}

/**
 * Engage / release. `by` = { by, ip } is stored with the state for the record.
 * Returns { engaged, reason, since, persisted }.
 */
async function set(enabled, why, by) {
  const next = clean({ engaged: !!enabled, reason: why || 'manual', since: new Date().toISOString() });

  if (next.engaged) {
    state = next;                                           // safe side first
    try { await persist(next, by); return { ...status(), persisted: true }; }
    catch (err) {
      logger.error(`[killSwitch] ENGAGED on this instance but NOT persisted: ${err.message}`);
      return { ...status(), persisted: false };
    }
  }

  await persist(next, by);                                  // throws => stays engaged
  state = next;
  return { ...status(), persisted: true };
}

/** Express-style guard result for order entry points. */
function blockedResponse() {
  return {
    status: 503,
    body: { success: false, code: 'TRADING_DISABLED', error: 'New orders are temporarily disabled by the operator (kill-switch).' },
  };
}

module.exports = { isEngaged, isEngagedFresh, status, refresh, init, set, startSync, stopSync, blockedResponse };
