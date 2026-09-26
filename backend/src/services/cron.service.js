const cron                          = require('node-cron');
const { scanAll, CRYPTO_SYMBOLS }   = require('./signalGenerator.service');
const { scanAllYF, scanEquities, YF_SYMBOLS } = require('./yahooFinance.service');
const { checkAlerts, runDailyDigest } = require('./alertChecker.service');
const { checkSignalAlerts }         = require('./signalAlert.service');
const { takePortfolioSnapshot }     = require('./portfolioSnapshot.service');
const paperTradeMonitor             = require('./paperTradeMonitor.service');
const autoTrader                    = require('./autoTrader.service');
const db                            = require('../config/db');
const logger                        = require('../utils/logger');
const { healthCheckAllConnections } = require('./exchanges.service');

// Symboles déjà couverts par YF_SYMBOLS (forex/commo/indices, display
// names) — à exclure de l'univers equity pour éviter les doublons.
const NON_EQUITY_DISPLAYS = new Set(Object.values(YF_SYMBOLS).map(m => m.display));

// Exclut les paires crypto — via la vraie liste exportée par
// signalGenerator.service.js (CRYPTO_SYMBOLS, ex: 'BTCUSDT'), pas une
// heuristique par suffixe. Couvre aussi le format avec slash (BTC/USDT)
// au cas où un user l'aurait ajouté à sa watchlist sous cette forme.
const CRYPTO_SYMBOLS_SET = new Set(CRYPTO_SYMBOLS);

function looksLikeCrypto(symbol) {
  if (CRYPTO_SYMBOLS_SET.has(symbol)) return true;
  if (symbol.includes('/')) {
    const noSlash = symbol.replace('/', '');
    if (CRYPTO_SYMBOLS_SET.has(noSlash)) return true;
  }
  return false;
}

/**
 * Construit dynamiquement la liste des tickers equity à scanner : tout
 * symbole présent dans la watchlist d'un user OU configuré en auto-trade
 * (enabled), qui n'est ni un pair crypto (CRYPTO_SYMBOLS) ni déjà couvert
 * par YF_SYMBOLS (forex/commo/indices). C'est ce qui évite le bug —
 * n'importe quel ticker qu'un user ajoute est automatiquement inclus,
 * sans modification de code.
 */
async function getTrackedEquitySymbols() {
  const { rows } = await db.query(`
    SELECT DISTINCT symbol FROM (
      SELECT symbol FROM watchlist
      UNION
      SELECT symbol FROM auto_trade_configs WHERE enabled = true
    ) s
  `);

  return rows
    .map(r => r.symbol)
    .filter(sym => sym && !looksLikeCrypto(sym) && !NON_EQUITY_DISPLAYS.has(sym));
}

const initCronJobs = () => {

  // ── Paper trade SL/TP monitor ─────────────────────────
  paperTradeMonitor.start(60_000);

  // ── Auto-Trader (backtest-gated auto-trading) ─────────
  autoTrader.start(60_000);

  // ── Market scan every 4 hours → Crypto + Forex/Commodity/Indices + Equities → AI signal alerts ───────
  cron.schedule('0 */4 * * *', async () => {
    logger.info('[cron] Starting scheduled market scan...');
    try {
      const equitySymbols = await getTrackedEquitySymbols();

      const [cryptoResult, yfSignals, equitySignals] = await Promise.all([
        scanAll('4h'),
        scanAllYF('4h'),
        scanEquities(equitySymbols, '4h'),
      ]);

      // ✅ Fix Bug 4 (existant): scanAllYF() ne persiste pas elle-même.
      // ✅ Fix — 2026-09-26: scanEquities() non plus. Sans cet insert,
      // AUCUN equity (AAPL et tout ticker ajouté par un user) ne recevait
      // jamais de ligne dans `signals` — bloquait silencieusement tout
      // auto-trade sur action, pour n'importe quel user.
      const toInsert = [...yfSignals, ...equitySignals];
      for (const sig of toInsert) {
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

      logger.info(`[cron] Scan finished. ${cryptoResult.signals.length} crypto + ${yfSignals.length} forex/commo/indices + ${equitySignals.length} equity signals generated.`);
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

  // ── Exchange API health check every 15 minutes ─────────
  cron.schedule('*/15 * * * *', async () => {
    logger.info('[cron] Running exchange health check...');
    try {
      const results = await healthCheckAllConnections();
      const failed = results.filter(r => r.healthStatus === 'failed');
      if (failed.length > 0) {
        logger.warn(`[cron] Exchange health check: ${failed.length} failed connection(s)`);
      } else {
        logger.info('[cron] ✅ All exchange connections are healthy.');
      }
    } catch (err) {
      logger.error(`[cron] Exchange health check crashed: ${err.message}`);
    }
  });

  logger.info('[cron] AtlasQuant Background Engine initialized.');
};

module.exports = { initCronJobs, getTrackedEquitySymbols };