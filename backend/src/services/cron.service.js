/**
 * src/services/cron.service.js — AtlasQuant AI
 */

const cron                          = require('node-cron');
const { scanAll }                   = require('./signalGenerator.service');
const { checkAlerts }               = require('./alertChecker.service');
const { checkSignalAlerts }         = require('./signalAlert.service');
const { takePortfolioSnapshot }     = require('./portfolioSnapshot.service');
const logger                        = require('../utils/logger');

const initCronJobs = () => {

  // ── Market scan every 4 hours → AI signal alerts ───────
  cron.schedule('0 */4 * * *', async () => {
    logger.info('[cron] Starting scheduled market scan...');
    try {
      const results = await scanAll('4h');
      logger.info(`[cron] Scan finished. ${results.signals.length} signals generated.`);
      await checkSignalAlerts();
    } catch (err) {
      logger.error(`[cron] Scan error: ${err.message}`);
    }
  });

  // ── Alert price checker every minute ───────────────────
  cron.schedule('* * * * *', async () => {
    await checkAlerts();
  });

  // ── Daily portfolio snapshot at midnight ───────────────
  cron.schedule('0 0 * * *', async () => {
    logger.info('[cron] Taking daily portfolio snapshot...');
    try {
      await takePortfolioSnapshot();
      logger.info('[cron] ✅ Portfolio snapshot saved');
    } catch (err) {
      logger.error(`[cron] Snapshot error: ${err.message}`);
    }
  });

  logger.info('[cron] AtlasQuant Background Engine initialized.');
};

module.exports = { initCronJobs };