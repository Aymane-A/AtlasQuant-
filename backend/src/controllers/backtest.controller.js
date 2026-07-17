/**
 * src/controllers/backtest.controller.js
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const { fetchCandlesForBacktest } = require('../services/backtestMarketRouter.service');
const { runSimulation, aggregatePortfolio } = require('../services/backtestEngine.service');
const { listStrategies } = require('../services/backtestStrategies.service');

const MAX_SYMBOLS = 8;

function parseCapital(raw) {
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw || '100000').replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : 100000;
}

function parseUniverse(universe) {
  if (!universe) return [];
  const symbols = [...new Set(
    String(universe).split(',').map(s => s.trim()).filter(Boolean)
  )];
  return symbols.slice(0, MAX_SYMBOLS);
}

function resolvePositionSizing(body) {
  const mode = body.positionSizeMode;
  if (mode === 'fixed_dollar') {
    return { positionSizeMode: 'fixed_dollar', positionSizeDollar: parseCapital(body.positionSizeValue) };
  }
  if (mode === 'kelly') {
    return { positionSizeMode: 'kelly' };
  }
  const pct = parseFloat(body.positionSizeValue);
  return { positionSizeMode: 'fixed_pct', positionSizePct: Number.isFinite(pct) && pct > 0 ? pct : 10 };
}

function buildWarningMessage(requestedTimeframe, succeeded, skipped) {
  const messages = [];

  const fallbackSymbols = succeeded.filter(r => r.fallbackApplied).map(r => r.symbol);
  if (fallbackSymbols.length > 0) {
    messages.push(
      `Timeframe ${requestedTimeframe} disponible sur 60 jours max pour les actions/forex/commodities. ` +
      `Backtest exécuté en Daily pour : ${fallbackSymbols.join(', ')}.`
    );
  }

  if (skipped.length > 0) {
    messages.push(`Symboles ignorés (données insuffisantes) : ${skipped.map(s => s.symbol).join(', ')}.`);
  }

  return messages.length > 0 ? messages.join(' ') : undefined;
}

async function runBacktest(req, res) {
  try {
    const userId = req.user.id;
    const { name, universe, from, to, tf, capital, maxPos } = req.body;

    const symbols = parseUniverse(universe);
    const requestedTimeframe = tf || 'Daily';

    if (symbols.length === 0 || !from || !to) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants : universe (au moins un symbole), from et to sont requis',
      });
    }

    if (new Date(from) >= new Date(to)) {
      return res.status(400).json({
        success: false,
        error: 'La date de début doit précéder la date de fin',
      });
    }

    // ── Validation de la stratégie ──
    const availableStrategies = listStrategies();
    const requestedStrategyId = req.body.strategyId || 'rsi_momentum';
    const strategyMeta = availableStrategies.find(s => s.id === requestedStrategyId);

    if (!strategyMeta) {
      return res.status(400).json({
        success: false,
        error: `Stratégie inconnue : "${requestedStrategyId}". Disponibles : ${availableStrategies.map(s => s.id).join(', ')}`,
      });
    }

    const initialCapitalTotal = parseCapital(capital);
    const capitalPerSymbol = initialCapitalTotal / symbols.length;
    const positionSizing = resolvePositionSizing(req.body);

    logger.info(`[Backtest] Démarrage pour user ${userId} — [${symbols.join(', ')}] (${requestedTimeframe}) stratégie="${strategyMeta.label}" du ${from} au ${to}`);

    const settled = await Promise.allSettled(symbols.map(async symbol => {
      const { candles, effectiveTimeframe, fallbackApplied, assetClass, quoteCurrency } =
        await fetchCandlesForBacktest(symbol, requestedTimeframe, from, to);

      if (!candles || candles.length < 50) {
        throw new Error(`Données insuffisantes pour ${symbol} (${candles?.length || 0} bougies récupérées, 50 minimum).`);
      }

      const result = runSimulation(candles, capitalPerSymbol, {
        maxPositions: parseInt(maxPos) || 5,
        ...positionSizing,
        quoteCurrency,
        strategyId: requestedStrategyId,
      }, symbol);

      return { symbol, assetClass, fallbackApplied, effectiveTimeframe, ...result };
    }));

    const succeeded = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    const skipped = settled
      .map((s, idx) => (s.status === 'rejected' ? { symbol: symbols[idx], reason: s.reason.message } : null))
      .filter(Boolean);

    if (succeeded.length === 0) {
      return res.status(422).json({
        success: false,
        error: `Aucun symbole n'a pu être backtesté. ${skipped.map(s => `${s.symbol}: ${s.reason}`).join(' | ')}`,
      });
    }

    const { metrics, charts, trades } = aggregatePortfolio(succeeded, initialCapitalTotal);
    const warning = buildWarningMessage(requestedTimeframe, succeeded, skipped);

    const strategyName = name || strategyMeta.label;
    const { rows } = await db.query(
      `INSERT INTO backtest_history (user_id, symbol, strategy, result, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [userId, symbols.join(','), strategyName, JSON.stringify({ metrics, charts, trades })]
    );

    logger.info(`[Backtest] Terminé — ${trades.length} trades (last 10), return ${metrics.totalReturn}, ${skipped.length} symbole(s) skippé(s)`);

    return res.status(200).json({
      success: true,
      backtestId: rows[0].id,
      symbols,
      metrics,
      charts,
      trades,
      warning,
      skipped: skipped.length > 0 ? skipped : undefined,
    });

  } catch (err) {
    logger.error(`[backtest.controller] Error: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message || 'Le backtest a échoué pendant l\'exécution',
    });
  }
}

async function getBacktestById(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT id, symbol, strategy, result, created_at
       FROM backtest_history WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Backtest introuvable' });
    }

    const record = rows[0];
    const result = typeof record.result === 'string' ? JSON.parse(record.result) : record.result;

    return res.status(200).json({
      success: true,
      backtestId: record.id,
      symbol: record.symbol,
      strategy: record.strategy,
      createdAt: record.created_at,
      metrics: result.metrics,
      charts: result.charts,
      trades: result.trades,
    });
  } catch (err) {
    logger.error(`[backtest.controller] getBacktestById error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Impossible de récupérer ce backtest' });
  }
}

module.exports = { runBacktest, getBacktestById };