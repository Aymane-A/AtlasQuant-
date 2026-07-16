/**
 * src/controllers/backtest.controller.js
 *
 * Flux réel multi-symbole :
 *   1. Parser l'univers (1 à 8 symboles, crypto/forex/commodity/equity mixés)
 *   2. Fetch parallèle des candles par symbole (backtestMarketRouter)
 *   3. Simulation par symbole, capital équipondéré (backtestEngine)
 *   4. Agrégation portefeuille (backtestEngine.aggregatePortfolio)
 *   5. Sauvegarde + réponse { success, metrics, charts, trades, warning, skipped }
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const { fetchCandlesForBacktest } = require('../services/backtestMarketRouter.service');
const { runSimulation, aggregatePortfolio } = require('../services/backtestEngine.service');

const MAX_SYMBOLS = 8;

/**
 * Parse la valeur capital envoyée par le frontend.
 * Le formulaire envoie une string formatée ("100,000") → on la nettoie.
 */
function parseCapital(raw) {
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw || '100000').replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : 100000;
}

/**
 * Le frontend envoie un univers de symboles séparés par virgule
 * (ex: "SPY, QQQ, AAPL"). On garde jusqu'à MAX_SYMBOLS symboles uniques,
 * dans l'ordre saisi par l'utilisateur.
 */
function parseUniverse(universe) {
  if (!universe) return [];
  const symbols = [...new Set(
    String(universe).split(',').map(s => s.trim()).filter(Boolean)
  )];
  return symbols.slice(0, MAX_SYMBOLS);
}

/**
 * Traduit la config "Position Size" du formulaire vers les params du moteur.
 */
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

async function runBacktest(req, res) {
  try {
    const userId = req.user.id;
    const { name, universe, from, to, tf, capital, maxPos } = req.body;

    const symbols = parseUniverse(universe);

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

    const initialCapitalTotal = parseCapital(capital);
    const capitalPerSymbol = initialCapitalTotal / symbols.length;
    const positionSizing = resolvePositionSizing(req.body);

    logger.info(`[Backtest] Démarrage pour user ${userId} — [${symbols.join(', ')}] (${tf || 'Daily'}) du ${from} au ${to}`);

    // ── 1 & 2. Fetch + simulation en parallèle, par symbole ──
    const settled = await Promise.allSettled(symbols.map(async symbol => {
      const { candles, warning, effectiveTimeframe, assetClass, quoteCurrency } =
        await fetchCandlesForBacktest(symbol, tf || 'Daily', from, to);

      if (!candles || candles.length < 50) {
        throw new Error(`Données insuffisantes pour ${symbol} (${candles?.length || 0} bougies récupérées, 50 minimum).`);
      }

      const result = runSimulation(candles, capitalPerSymbol, {
        maxPositions: parseInt(maxPos) || 5,
        ...positionSizing,
        quoteCurrency,
      }, symbol);

      return { symbol, assetClass, warning, effectiveTimeframe, ...result };
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

    // ── 3. Agrégation portefeuille ──
    const { metrics, charts, trades } = aggregatePortfolio(succeeded, initialCapitalTotal);

    const warnings = succeeded.filter(r => r.warning).map(r => r.warning);
    if (skipped.length > 0) {
      warnings.push(`Symboles ignorés (données insuffisantes) : ${skipped.map(s => s.symbol).join(', ')}.`);
    }

    // ── 4. Sauvegarde en base ──
    const strategyName = name || 'RSI Momentum Reversion';
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
      warning: warnings.length > 0 ? warnings.join(' ') : undefined,
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

/**
 * Récupère un backtest précédemment sauvegardé par son ID.
 * Utile si le frontend veut recharger/partager un résultat.
 */
async function getBacktestById(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT id, symbol, strategy, result, created_at
       FROM backtest_history
       WHERE id = $1 AND user_id = $2`,
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