/**
 * utils/health.js — AtlasQuant AI
 * GET /api/health. Public (Docker/load-balancer probes): states only, no secrets or counts.
 * HTTP 503 only when the DB is unreachable (the API cannot serve). A stopped cron or an engaged
 * kill-switch is "degraded" but stays HTTP 200 so the container isn't restarted for it.
 */
const db         = require('../config/db');
const env        = require('../config/env');
const logger     = require('./logger');
const killSwitch = require('./killSwitch');

const DB_TIMEOUT_MS = 2000;

async function healthHandler(req, res) {
  let dbOk = false;
  let timer;
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('db timeout')), DB_TIMEOUT_MS); }),
    ]);
    dbOk = true;
  } catch (err) {
    logger.warn(`[health] DB check failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const cronOk = require('../services/cron.service').isCronRunning();
  const ks     = killSwitch.status();
  const status = !dbOk ? 'down' : (cronOk && !ks.engaged ? 'ok' : 'degraded');

  res.status(dbOk ? 200 : 503).json({
    status,
    timestamp:    new Date().toISOString(),
    db:           dbOk ? 'up' : 'down',
    cron:         cronOk ? 'running' : 'stopped',
    killSwitch:   ks.engaged,
    paperTrading: env.PAPER_TRADING,
  });
}

module.exports = { healthHandler };
