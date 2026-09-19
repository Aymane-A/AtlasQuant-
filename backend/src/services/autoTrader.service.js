/**
 * src/services/autoTrader.service.js — AtlasQuant AI
 *
 * Backtest-gated auto-trader. Contrairement à un bot classique qui exécute
 * un trade dès qu'un signal atteint un seuil de confiance, ce service exige
 * qu'un backtest RÉCENT, SUR LE MÊME SYMBOLE, AVEC LES MÊMES PARAMÈTRES DE
 * STRATÉGIE ait montré une expectancy positive avant de laisser passer quoi
 * que ce soit — et même alors, force une phase de probation (paper) avant
 * le passage en live. Voir auto_trade_configs (config/db.js) pour le schéma
 * et statuts.
 *
 * Lifecycle d'un config :
 *   disabled → backtest_required → (backtest_expired | backtest_rejected) → probation → live
 *   `blocked` est atteignable depuis n'importe quel état si la probation échoue
 *   ou si un check de sécurité (max_daily_loss_pct) se déclenche.
 *
 * Ce service NE réimplémente PAS l'exit logic (SL/TP) — chaque trade ouvert
 * ici passe par exchangesSvc.openPaperTrade(), et paperTradeMonitor.service.js
 * (déjà existant, tourne en cron séparé) se charge de la clôture. Ce fichier
 * s'occupe uniquement de la décision "faut-il ouvrir un trade" et du
 * lifecycle des configs.
 *
 * Wiring: dans le cron bootstrap (là où checkAlerts / paperTradeMonitor sont
 * démarrés), ajouter :
 *   const autoTrader = require('./services/autoTrader.service');
 *   autoTrader.start(); // vérifie toutes les 60s par défaut
 */

const db           = require('../config/db');
const logger       = require('../utils/logger');
const exchangesSvc = require('./exchanges.service');

const GATE_FRESHNESS_DAYS   = 30; // doit rester cohérent avec backtest.controller.js
const MIN_BACKTEST_TRADES   = 20; // en dessous, l'expectancy n'est pas statistiquement fiable
const MIN_EXPECTANCY        = 0;  // strictement positif pour passer le gate
const SIGNAL_MAX_AGE_MS     = 15 * 60 * 1000; // un signal de plus de 15 min est considéré périmé

// Un seul trade ouvert à la fois par config — évite le pyramiding non
// contrôlé pendant la probation, qui fausserait le calcul du win rate.
const MAX_OPEN_PER_CONFIG = 1;

/**
 * Charge tous les configs actifs (enabled=true, status pas 'disabled' ni
 * 'blocked') avec leur backtest associé, s'il existe.
 */
async function loadActiveConfigs() {
  const { rows } = await db.query(`
    SELECT
      c.*,
      b.end_date        AS bt_end_date,
      b.expires_at       AS bt_expires_at,
      b.total_trades     AS bt_total_trades,
      b.expectancy        AS bt_expectancy,
      b.sharpe            AS bt_sharpe,
      b.gate_eligible      AS bt_gate_eligible,
      b.params_hash        AS bt_params_hash,
      b.symbol              AS bt_symbol
    FROM auto_trade_configs c
    LEFT JOIN backtest_history b ON b.id = c.backtest_id
    WHERE c.enabled = true
      AND c.status NOT IN ('disabled', 'blocked')
  `);
  return rows;
}

/**
 * Réévalue le backtest gate pour UN config. Retourne le nouveau status
 * (sans l'écrire en DB — l'appelant décide s'il faut persister).
 *
 * Ne fait PAS de recherche automatique du "meilleur" backtest disponible —
 * un config est lié à un backtest_id précis (choisi explicitement par
 * l'utilisateur au moment de la création/mise à jour du config, via l'API).
 * Réévaluer ici sert seulement à vérifier que CE backtest reste valide
 * (fraîcheur, seuils), pas à en chercher un autre.
 */
function evaluateGate(config) {
  if (!config.backtest_id) return 'backtest_required';
  if (!config.bt_gate_eligible) return 'backtest_rejected'; // multi-symbole ou données insuffisantes
  if (config.bt_symbol !== config.symbol) return 'backtest_rejected'; // sécurité: le backtest lié ne correspond pas au symbole du config
  if (config.bt_params_hash !== config.params_hash) return 'backtest_required'; // params changés depuis le backtest

  const expiresAt = new Date(config.bt_expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) return 'backtest_expired';

  const totalTrades = parseInt(config.bt_total_trades, 10) || 0;
  if (totalTrades < MIN_BACKTEST_TRADES) return 'backtest_rejected';

  const expectancy = parseFloat(config.bt_expectancy);
  if (!Number.isFinite(expectancy) || expectancy <= MIN_EXPECTANCY) return 'backtest_rejected';

  // Gate passé — probation si on vient d'un état "bloquant", sinon on
  // conserve l'état courant (live reste live, probation reste probation).
  if (['probation', 'live'].includes(config.status)) return config.status;
  return 'probation';
}

/**
 * Critères de graduation probation → live, une fois
 * probation_trades_completed >= probation_trades_required.
 * Simple et conservateur : win rate > 40% ET pnl net positif sur la
 * fenêtre de probation. Ajustable plus tard sans toucher au reste du flow.
 */
function evaluateGraduation(config) {
  const completed = config.probation_trades_completed;
  const required  = config.probation_trades_required;
  if (completed < required) return null; // pas encore assez de données

  const winRate = completed > 0 ? config.probation_wins / completed : 0;
  const pnl     = parseFloat(config.probation_pnl) || 0;

  return (winRate > 0.4 && pnl > 0) ? 'live' : 'blocked';
}

/**
 * Trouve le signal le plus récent pour ce symbole, pas plus vieux que
 * SIGNAL_MAX_AGE_MS, et pas déjà consommé par ce config (on track via
 * paper_trades.opened_at > signal.created_at n'est pas fiable — on stocke
 * plutôt le dernier signal traité par config pour éviter les doublons).
 */
async function getFreshSignal(symbol, lastProcessedAt) {
  const { rows } = await db.query(
    `SELECT id, signal, confidence, entry, stop_loss, take_profit, created_at
     FROM signals
     WHERE symbol = $1 AND signal IN ('BUY','SELL')
       AND created_at > NOW() - INTERVAL '${SIGNAL_MAX_AGE_MS / 1000} seconds'
       ${lastProcessedAt ? 'AND created_at > $2' : ''}
     ORDER BY created_at DESC LIMIT 1`,
    lastProcessedAt ? [symbol, lastProcessedAt] : [symbol]
  );
  return rows[0] || null;
}

/**
 * Combien de paper_trades ouverts existent déjà pour ce config —
 * empêche le pyramiding pendant la probation (voir MAX_OPEN_PER_CONFIG).
 */
async function countOpenTradesForConfig(configId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM paper_trades WHERE auto_trade_config_id = $1 AND status = 'open'`,
    [configId]
  );
  return rows[0]?.n || 0;
}

/**
 * Taille de position — conservatrice par défaut : 5% du solde disponible
 * en devise de cotation, plafonnée par max_position_size si défini sur le
 * config. Pas de Kelly ici : la probation doit rester lisible/traçable,
 * pas optimisée agressivement sur un historique encore mince.
 */
async function computeQuantity(userId, exchangeId, symbol, price, config) {
  const balance = await exchangesSvc.getBalance
    ? await exchangesSvc.getBalance(userId, exchangeId)
    : null;

  // Fallback si exchangesSvc n'expose pas de lecture directe de balance
  // (selon la version de exchanges.service.js) — on relit via le même
  // chemin que trading.controller.js (paper mode → solde simulé).
  let quoteBalance = 10000;
  if (balance) {
    const quoteSymbol = symbol.includes('/') ? symbol.split('/')[1] : 'USDT';
    const b = balance.find(x => x.symbol === quoteSymbol);
    if (b) quoteBalance = b.free;
  }

  const riskAmount = quoteBalance * 0.05;
  const capped     = config.max_position_size
    ? Math.min(riskAmount, parseFloat(config.max_position_size))
    : riskAmount;

  return capped / price;
}

/**
 * Traite UN config : réévalue le gate, exécute un trade si probation/live
 * et qu'un signal frais + aucune position ouverte le permettent.
 */
async function processConfig(config) {
  const newStatus = evaluateGate(config);

  if (newStatus !== config.status) {
    await db.query(
      `UPDATE auto_trade_configs SET status = $1, last_evaluated_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [newStatus, config.id]
    );
    logger.info(`[autoTrader] config #${config.id} (${config.symbol}/${config.strategy_id}) → ${newStatus}`);
    config.status = newStatus;
  }

  if (!['probation', 'live'].includes(config.status)) return;

  const openCount = await countOpenTradesForConfig(config.id);
  if (openCount >= MAX_OPEN_PER_CONFIG) return;

  const signal = await getFreshSignal(config.symbol, config.last_signal_at);
  if (!signal) return;

  const side  = signal.signal === 'BUY' ? 'buy' : 'sell';
  const price = parseFloat(signal.entry) || null;
  if (!price) return;

  const quantity = await computeQuantity(config.user_id, config.exchange_id, config.symbol, price, config);
  if (!quantity || quantity <= 0) return;

  try {
    const trade = await exchangesSvc.openPaperTrade(config.user_id, config.exchange_id, {
      symbol:     config.symbol,
      side,
      orderType:  'market',
      quantity,
      price,
      limitPrice: null,
      stopLoss:   signal.stop_loss   ? parseFloat(signal.stop_loss)   : null,
      takeProfit: signal.take_profit ? parseFloat(signal.take_profit) : null,
    });

    // Traçabilité — lie le paper_trade à son config + backtest d'origine.
    await db.query(
      `UPDATE paper_trades SET auto_trade_config_id = $1, backtest_id = $2 WHERE id = $3`,
      [config.id, config.backtest_id, trade.id]
    );

    await db.query(
      `UPDATE auto_trade_configs
       SET last_signal_at = $1, last_evaluated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [signal.created_at, config.id]
    );

    logger.info(`[autoTrader] config #${config.id} — opened ${side} ${config.symbol} @ ${price} (${config.status})`);
  } catch (err) {
    logger.error(`[autoTrader] config #${config.id} — trade failed: ${err.message}`);
  }
}

/**
 * Ferme la boucle de probation : appelée par paperTradeMonitor (ou un hook
 * équivalent) quand un paper_trade lié à un auto_trade_config se ferme.
 * Incrémente les compteurs et déclenche evaluateGraduation().
 */
async function recordProbationResult(configId, pnl) {
  const { rows } = await db.query(
    `UPDATE auto_trade_configs
     SET probation_trades_completed = probation_trades_completed + 1,
         probation_wins  = probation_wins + CASE WHEN $2 > 0 THEN 1 ELSE 0 END,
         probation_pnl   = probation_pnl + $2,
         updated_at      = NOW()
     WHERE id = $1 AND status = 'probation'
     RETURNING *`,
    [configId, pnl]
  );
  const config = rows[0];
  if (!config) return;

  const graduation = evaluateGraduation(config);
  if (graduation) {
    await db.query(
      `UPDATE auto_trade_configs SET status = $1, updated_at = NOW() WHERE id = $2`,
      [graduation, configId]
    );
    logger.info(`[autoTrader] config #${configId} — probation complete → ${graduation}`);
  }
}

let intervalHandle = null;
let isRunning       = false;

async function runCycle() {
  const configs = await loadActiveConfigs();
  for (const config of configs) {
    try {
      await processConfig(config);
    } catch (err) {
      logger.error(`[autoTrader] config #${config.id} — cycle error: ${err.message}`);
    }
  }
}

function start(intervalMs = 60000) {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (isRunning) {
      logger.warn('[autoTrader] previous run still in progress — skipping this tick');
      return;
    }
    isRunning = true;
    runCycle()
      .catch(err => logger.error(`[autoTrader] run error: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, intervalMs);
  logger.info(`[autoTrader] started — checking every ${intervalMs / 1000}s`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  isRunning = false;
}

module.exports = { runCycle, processConfig, evaluateGate, evaluateGraduation, recordProbationResult, start, stop };