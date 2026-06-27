/**
 * src/services/cron.service.js — AtlasQuant AI
 * Background cron jobs
 */

const cron                      = require('node-cron');
const { scanAll }               = require('./signalGenerator.service');
const { checkAlerts }           = require('./alertChecker.service');
const { checkSignalAlerts }     = require('./signalAlert.service');
const logger                    = require('../utils/logger');

const initCronJobs = () => {

  // ── Market scan every 4 hours → then check AI signal alerts ──
  cron.schedule('0 */4 * * *', async () => {
    logger.info('[cron] Starting scheduled market scan...');
    try {
      const results = await scanAll('4h');
      logger.info(`[cron] Scan finished. ${results.signals.length} signals generated.`);

      // After scan — check for high-confidence signals to notify
      await checkSignalAlerts();
    } catch (err) {
      logger.error(`[cron] Fatal error in scheduled scan: ${err.message}`);
    }
  });

  // ── Alert price checker every minute ───────────────────
  cron.schedule('* * * * *', async () => {
    await checkAlerts();
  });

  logger.info('[cron] AtlasQuant Background Engine initialized.');
};

module.exports = { initCronJobs };