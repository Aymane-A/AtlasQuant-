/**
 * src/controllers/auto_trade.controller.js — AtlasQuant AI
 *
 * CRUD pour auto_trade_configs. La création ne fait AUCUN appel réseau
 * ni ne lance de backtest — elle enregistre juste l'intention (symbole +
 * stratégie + exchange), calcule params_hash, et laisse autoTrader.service.js
 * (cron) faire tout le travail de gating au prochain cycle.
 *
 * Le champ `symbol` est validé contre la watchlist de l'utilisateur —
 * "auto-trade ne doit tourner que sur les symboles que l'utilisateur a
 * explicitement choisis".
 *
 * FIX (strategy mismatch) : findMatchingBacktest et updateConfig comparent
 * `strategy_id` (id technique) et non le label affiché.
 *
 * FIX (upsert) : ON CONFLICT met aussi à jour backtest_id.
 *
 * ✅ Feature (2026-09-27): pauseAll / resumeAll — kill switch. Un seul
 * appel désactive (ou réactive) TOUS les configs de l'utilisateur, au lieu
 * de devoir les basculer un par un. Ne touche pas aux trades déjà ouverts :
 * paperTradeMonitor continue de gérer leur SL/TP normalement.
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const { computeParamsHash } = require('../utils/paramsHash');
const { listStrategies } = require('../services/backtestStrategies.service');

async function findMatchingBacktest(userId, symbol, strategyId, paramsHash) {
  const { rows } = await db.query(
    `SELECT id FROM backtest_history
     WHERE user_id = $1 AND symbol = $2 AND strategy_id = $3
       AND params_hash = $4 AND gate_eligible = true
     ORDER BY created_at DESC LIMIT 1`,
    [userId, symbol, strategyId, paramsHash]
  );
  return rows[0]?.id || null;
}

/**
 * POST /api/auto-trade/configs
 * body: { symbol, strategyId, exchangeId, maxPositions?, positionSizeMode?,
 *         positionSizeValue?, probationTradesRequired?, maxPositionSize?,
 *         maxDailyLossPct? }
 */
async function createConfig(req, res) {
  try {
    const userId = req.user.id;
    const {
      symbol, strategyId, exchangeId,
      maxPositions, positionSizeMode, positionSizeValue,
      probationTradesRequired, maxPositionSize, maxDailyLossPct,
    } = req.body;

    if (!symbol || !strategyId || !exchangeId) {
      return res.status(400).json({
        success: false,
        error: 'symbol, strategyId et exchangeId sont requis',
      });
    }

    const availableStrategies = listStrategies();
    if (!availableStrategies.find(s => s.id === strategyId)) {
      return res.status(400).json({
        success: false,
        error: `Stratégie inconnue : "${strategyId}". Disponibles : ${availableStrategies.map(s => s.id).join(', ')}`,
      });
    }

    const cleanSymbol = String(symbol).toUpperCase().trim();
    const { rows: wl } = await db.query(
      `SELECT 1 FROM watchlist WHERE user_id = $1 AND symbol = $2`,
      [userId, cleanSymbol]
    );
    if (!wl.length) {
      return res.status(400).json({
        success: false,
        error: `${cleanSymbol} n'est pas dans votre watchlist — ajoutez-le d'abord pour pouvoir l'auto-trader.`,
      });
    }

    const paramsHash = computeParamsHash({
      strategyId, maxPositions, positionSizeMode, positionSizeValue,
    });

    const backtestId = await findMatchingBacktest(userId, cleanSymbol, strategyId, paramsHash);

    const { rows } = await db.query(
      `INSERT INTO auto_trade_configs
         (user_id, symbol, strategy_id, params_hash, exchange_id, backtest_id,
          status, probation_trades_required, max_position_size, max_daily_loss_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, symbol, strategy_id, params_hash, exchange_id) DO UPDATE
         SET enabled = true, backtest_id = EXCLUDED.backtest_id, updated_at = NOW()
       RETURNING *`,
      [
        userId, cleanSymbol, strategyId, paramsHash, exchangeId,
        backtestId, 'backtest_required', // status réel décidé par le prochain cycle autoTrader
        parseInt(probationTradesRequired, 10) || 5,
        maxPositionSize ? parseFloat(maxPositionSize) : null,
        maxDailyLossPct ? parseFloat(maxDailyLossPct) : null,
      ]
    );

    logger.info(`[autoTrade] config créé/réactivé — user ${userId}, ${cleanSymbol}/${strategyId}${backtestId ? ` (backtest #${backtestId} lié)` : ' (aucun backtest correspondant trouvé)'}`);

    return res.status(201).json({ success: true, config: rows[0] });
  } catch (err) {
    logger.error(`[autoTrade.createConfig] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/auto-trade/configs
 */
async function listConfigs(req, res) {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT
         c.*,
         b.end_date    AS backtest_end_date,
         b.expires_at  AS backtest_expires_at,
         b.expectancy  AS backtest_expectancy,
         b.sharpe      AS backtest_sharpe,
         b.total_trades AS backtest_total_trades
       FROM auto_trade_configs c
       LEFT JOIN backtest_history b ON b.id = c.backtest_id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [userId]
    );
    return res.status(200).json({ success: true, configs: rows });
  } catch (err) {
    logger.error(`[autoTrade.listConfigs] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * PATCH /api/auto-trade/configs/:id
 * body: { enabled?, backtestId?, probationTradesRequired?, maxPositionSize?,
 *         maxDailyLossPct? }
 */
async function updateConfig(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { enabled, backtestId, probationTradesRequired, maxPositionSize, maxDailyLossPct } = req.body;

    const { rows: existing } = await db.query(
      `SELECT * FROM auto_trade_configs WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, error: 'Config introuvable' });
    }
    const config = existing[0];

    let newBacktestId = config.backtest_id;
    if (backtestId !== undefined) {
      if (backtestId === null) {
        newBacktestId = null;
      } else {
        const { rows: bt } = await db.query(
          `SELECT id FROM backtest_history
           WHERE id = $1 AND user_id = $2 AND symbol = $3 AND strategy_id = $4
             AND params_hash = $5 AND gate_eligible = true`,
          [backtestId, userId, config.symbol, config.strategy_id, config.params_hash]
        );
        if (!bt.length) {
          return res.status(400).json({
            success: false,
            error: 'Ce backtest ne correspond pas à ce config (symbole/stratégie/paramètres différents, non éligible, ou introuvable).',
          });
        }
        newBacktestId = backtestId;
      }
    }

    const { rows } = await db.query(
      `UPDATE auto_trade_configs
       SET enabled = COALESCE($3, enabled),
           backtest_id = $4,
           probation_trades_required = COALESCE($5, probation_trades_required),
           max_position_size = COALESCE($6, max_position_size),
           max_daily_loss_pct = COALESCE($7, max_daily_loss_pct),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        id, userId,
        enabled !== undefined ? !!enabled : null,
        newBacktestId,
        probationTradesRequired !== undefined ? parseInt(probationTradesRequired, 10) : null,
        maxPositionSize !== undefined ? parseFloat(maxPositionSize) : null,
        maxDailyLossPct !== undefined ? parseFloat(maxDailyLossPct) : null,
      ]
    );

    logger.info(`[autoTrade] config #${id} mis à jour — user ${userId}`);
    return res.status(200).json({ success: true, config: rows[0] });
  } catch (err) {
    logger.error(`[autoTrade.updateConfig] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * DELETE /api/auto-trade/configs/:id
 */
async function deleteConfig(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { rowCount } = await db.query(
      `DELETE FROM auto_trade_configs WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, error: 'Config introuvable' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error(`[autoTrade.deleteConfig] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/auto-trade/configs/pause-all
 * Kill switch : désactive tous les configs actifs de l'utilisateur.
 */
async function pauseAll(req, res) {
  try {
    const userId = req.user.id;
    const { rowCount } = await db.query(
      `UPDATE auto_trade_configs SET enabled = false, updated_at = NOW()
       WHERE user_id = $1 AND enabled = true`,
      [userId]
    );
    logger.info(`[autoTrade] pause-all — user ${userId}, ${rowCount} config(s) désactivé(s)`);
    return res.status(200).json({ success: true, affected: rowCount });
  } catch (err) {
    logger.error(`[autoTrade.pauseAll] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/auto-trade/configs/resume-all
 * Réactive tous les configs désactivés de l'utilisateur. Le statut
 * (probation/live/blocked...) n'est pas touché : autoTrader réévalue le
 * gate normalement au prochain cycle.
 */
async function resumeAll(req, res) {
  try {
    const userId = req.user.id;
    const { rowCount } = await db.query(
      `UPDATE auto_trade_configs SET enabled = true, updated_at = NOW()
       WHERE user_id = $1 AND enabled = false`,
      [userId]
    );
    logger.info(`[autoTrade] resume-all — user ${userId}, ${rowCount} config(s) réactivé(s)`);
    return res.status(200).json({ success: true, affected: rowCount });
  } catch (err) {
    logger.error(`[autoTrade.resumeAll] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { createConfig, listConfigs, updateConfig, deleteConfig, pauseAll, resumeAll };