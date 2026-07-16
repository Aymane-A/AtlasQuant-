/**
 * src/services/cron.service.js — AtlasQuant AI
 */

const cron                          = require('node-cron');
const { scanAll }                   = require('./signalGenerator.service');
const { scanAllYF }                 = require('./yahooFinance.service');
const { checkAlerts, runDailyDigest } = require('./alertChecker.service');
const { checkSignalAlerts }         = require('./signalAlert.service');
const { takePortfolioSnapshot }     = require('./portfolioSnapshot.service');
const paperTradeMonitor             = require('./paperTradeMonitor.service');
const db                            = require('../config/db');
const logger                        = require('../utils/logger');

const initCronJobs = () => {

  // ── Paper trade SL/TP monitor ─────────────────────────
  // Checks every 60s — auto-closes paper trades when stop_loss or
  // take_profit price is hit. start() is idempotent (won't double-schedule
  // on hot reload). Runs inside cron.service so it shares the same process
  // and pool as the rest of the background engine.
  paperTradeMonitor.start(60_000);

  // ── Market scan every 4 hours → Crypto + Forex/Commodity/Indices → AI signal alerts ───────
  cron.schedule('0 */4 * * *', async () => {
    logger.info('[cron] Starting scheduled market scan...');
    try {
      const [cryptoResult, yfSignals] = await Promise.all([
        scanAll('4h'),
        scanAllYF('4h'),
      ]);

      const allSignals = [
        ...cryptoResult.signals,
        ...yfSignals,
      ];

      // ✅ Fix Bug 4: scanAllYF() ne persiste pas en DB elle-même (contrairement à
      // scanAll côté crypto) — sans cet insert, les signaux Forex/Commodity/Indices
      // générés par le cron étaient calculés mais jamais sauvegardés, donc jamais
      // visibles ni utilisés dans Analytics.
      for (const sig of yfSignals) {
        await db.query(`
          INSERT INTO signals (symbol, interval, signal, confidence, price, entry, stop_loss, take_profit, risk_reward, reasoning, indicators, asset_class)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT DO NOTHING
        `, [
          sig.symbol, '4h', sig.signal, sig.confidence,
          sig.price,
          sig.entry       || sig.price,
          sig.stop_loss   || null,
          sig.take_profit || null,
          sig.risk_reward || null,
          sig.reasoning,
          JSON.stringify(sig.indicators),
          sig.asset_class || 'Crypto',
        ]);
      }

      logger.info(`[cron] Scan finished. ${cryptoResult.signals.length} crypto + ${yfSignals.length} forex/commo/indices signals generated.`);
      await checkSignalAlerts();
    } catch (err) {
      logger.error(`[cron] Scan error: ${err.message}`);
    }
  });

  // ── Alert price checker every minute ───────────────────
  cron.schedule('* * * * *', async () => {
    await checkAlerts();
  });

  // ── Daily email digest at 08:00 ────────────────────────
  // ✅ Feature: flush alert_digest_queue vers un email récapitulatif par
  // utilisateur, pour les alertes en mode email_frequency='digest'
  // (voir alertChecker.service.js + alerts.controller.js/setEmailFrequency).
  // Heure serveur — adapte le cron pattern si le serveur ne tourne pas en UTC.
  cron.schedule('0 8 * * *', async () => {
    logger.info('[cron] Running daily alert digest...');
    try {
      await runDailyDigest();
      logger.info('[cron] ✅ Daily digest processed');
    } catch (err) {
      logger.error(`[cron] Digest error: ${err.message}`);
    }
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