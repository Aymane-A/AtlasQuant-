const cron                          = require('node-cron');
const { scanAll, CRYPTO_SYMBOLS }   = require('./signalGenerator.service');
const { scanAllYF, scanEquities, YF_SYMBOLS } = require('./yahooFinance.service');
const { checkAlerts, runDailyDigest } = require('./alertChecker.service');
const { checkSignalAlerts }         = require('./signalAlert.service');
const { takePortfolioSnapshot }     = require('./portfolioSnapshot.service');
const paperTradeMonitor             = require('./paperTradeMonitor.service');
const autoTrader                    = require('./autoTrader.service');
const { resolveOpenSignals }        = require('./outcomeResolver.service');
const { reconcileLiveOrders, resolveUnresolvedOrders } = require('./liveOrderReconciler.service');
const db                            = require('../config/db');
const logger                        = require('../utils/logger');
const { healthCheckAllConnections } = require('./exchanges.service');

// Symboles déjà couverts par YF_SYMBOLS (forex/commo/indices, display
// names) — à exclure de l'univers equity pour éviter les doublons.
// On exclut aussi les TICKERS Yahoo (ex: '^GSPC', 'GC=F') — pas seulement les
// display names — sinon un ticker présent dans la watchlist ('^GSPC') est
// scanné une 2e fois comme "Equity" en plus de son scan "Indices".
const NON_EQUITY_DISPLAYS = new Set([
  ...Object.values(YF_SYMBOLS).map(m => m.display),
  ...Object.keys(YF_SYMBOLS),
]);

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

let cronRunning = false;
const isCronRunning = () => cronRunning;

const initCronJobs = () => {

  // ── Paper trade SL/TP monitor ─────────────────────────
  paperTradeMonitor.start(60_000);

  // ── Auto-Trader (backtest-gated auto-trading) ─────────
  autoTrader.start(60_000);

  // ── Market scan every 4 hours → Crypto + Forex/Commodity/Indices + Equities → AI signal alerts ───────
  const runMarketScan = async () => {
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
      // ✅ Fix — 2026-09-27: cryptoResult.signals manquait dans toInsert.
      // scanAll() (crypto) tournait bien et était compté dans le log
      // ("X crypto + ..."), mais ses résultats n'étaient JAMAIS persistés
      // dans `signals` — d'où les paires crypto figées depuis leur dernier
      // insert manuel (2026-09-08), alertChecker en "No price for X" en
      // continu, et autoTrader sans signal frais possible sur crypto.
      const toInsert = [...cryptoResult.signals, ...yfSignals, ...equitySignals];
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
  };

  cron.schedule('0 */4 * * *', runMarketScan);

  // ── Rattrapage au démarrage ────────────────────────────
  // node-cron ne rejoue PAS les exécutions ratées (PC éteint/en veille,
  // backend arrêté). Si le dernier signal date de plus de 4h30, on lance
  // un scan 60s après le démarrage au lieu d'attendre le prochain créneau.
  setTimeout(async () => {
    try {
      const { rows } = await db.query(`SELECT MAX(created_at) AS last FROM signals`);
      const last = rows[0]?.last ? new Date(rows[0].last).getTime() : 0;
      if (Date.now() - last > 4.5 * 3600_000) {
        logger.info('[cron] Dernier scan > 4h30 — rattrapage au démarrage...');
        await runMarketScan();
      }
    } catch (err) {
      logger.error(`[cron] Rattrapage error: ${err.message}`);
    }
  }, 60_000);

  // ── Résolution réelle des signaux BUY/SELL (TP / SL / EXPIRED) ─────────
  // Alimente signals.outcome / pnl_pct, utilisés par la page Analytics.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await resolveOpenSignals();
      if (r.resolved) {
        logger.info(`[cron] Outcome resolver: ${r.resolved} signal(s) résolu(s), ${r.open - r.resolved} encore ouvert(s)`);
      }
    } catch (err) {
      logger.error(`[cron] Outcome resolver error: ${err.message}`);
    }
  });

  // Première passe (backfill des signaux existants) 30s après le démarrage.
  setTimeout(() => {
    resolveOpenSignals()
      .then(r => logger.info(`[cron] Outcome backfill: ${r.resolved || 0}/${r.open || 0} résolus`))
      .catch(err => logger.error(`[cron] Outcome backfill error: ${err.message}`));
  }, 30_000);

  // ── Réconciliation des ordres LIVE (lecture seule) ─────
  // Récupère auprès de l'exchange la quantité exécutée / prix moyen / frais,
  // pour que "Mon P&L" puisse calculer un P&L live réel. Aucun ordre créé.
  // Orders whose answer was lost (status "unknown"): look them up by client id, every minute
  cron.schedule('* * * * *', async () => {
    try {
      const r = await resolveUnresolvedOrders();
      if (r.resolved || r.rejected || r.errors) {
        logger.info(`[cron] Unknown orders: ${r.resolved} retrouvé(s), ${r.rejected} rejeté(s), ${r.errors} erreur(s) sur ${r.checked}`);
      }
    } catch (err) {
      logger.error(`[cron] Unknown orders error: ${err.message}`);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await reconcileLiveOrders();
      if (r.updated || r.errors) {
        logger.info(`[cron] Live reconcile: ${r.updated} mis à jour, ${r.errors} erreur(s) sur ${r.checked}`);
      }
    } catch (err) {
      logger.error(`[cron] Live reconcile error: ${err.message}`);
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

  cronRunning = true;
  logger.info('[cron] AtlasQuant Background Engine initialized.');
};

module.exports = { initCronJobs, isCronRunning, getTrackedEquitySymbols };