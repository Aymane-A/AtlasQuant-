/**
 * src/controllers/backtest.controller.js
 *
 * Remplace l'ancienne version mock. Le flux réel est :
 *   1. Valider les paramètres reçus du frontend
 *   2. Récupérer l'historique OHLCV via backtestMarketRouter (Binance ou Yahoo)
 *   3. Lancer la simulation via backtestEngine.service
 *   4. Sauvegarder le résultat en base
 *   5. Renvoyer { success, backtestId, metrics, charts, trades }
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const { fetchCandlesForBacktest } = require('../services/backtestMarketRouter.service');
const { runSimulation } = require('../services/backtestEngine.service');

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
 * (ex: "SPY, QQQ, AAPL"). Pour l'instant le moteur backtest
 * un seul symbole à la fois : on prend le premier de la liste.
 * (Le multi-symbole pourra être ajouté plus tard en bouclant ici.)
 */
function extractPrimarySymbol(universe) {
  if (!universe) return null;
  const first = String(universe).split(',')[0].trim();
  return first || null;
}

async function runBacktest(req, res) {
  try {
    const userId = req.user.id;
    const {
      name,
      universe,
      from,
      to,
      tf,
      capital,
      maxPos,
    } = req.body;

    const symbol = extractPrimarySymbol(universe);

    if (!symbol || !from || !to) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants : universe (symbole), from et to sont requis',
      });
    }

    if (new Date(from) >= new Date(to)) {
      return res.status(400).json({
        success: false,
        error: 'La date de début doit précéder la date de fin',
      });
    }

    logger.info(`[Backtest] Démarrage pour user ${userId} — ${symbol} (${tf || 'Daily'}) du ${from} au ${to}`);

    // ── 1. Récupération des données historiques (crypto → Binance, stock → Yahoo) ──
    const { candles, warning, effectiveTimeframe } = await fetchCandlesForBacktest(
      symbol, tf || 'Daily', from, to
    );

    if (!candles || candles.length < 50) {
      return res.status(422).json({
        success: false,
        error: `Données insuffisantes pour ${symbol} sur cette période (${candles?.length || 0} bougies récupérées, 50 minimum).`,
      });
    }

    // ── 2. Simulation ──
    const initialCapital = parseCapital(capital);
    const result = runSimulation(candles, initialCapital, {
      maxPositions: parseInt(maxPos) || 5,
    }, symbol);

    // ── 3. Sauvegarde en base ──
    const query = `
      INSERT INTO backtest_history (user_id, symbol, strategy, result, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id
    `;
    const strategyName = name || 'RSI Momentum Reversion';
    const { rows } = await db.query(query, [
      userId,
      symbol,
      strategyName,
      JSON.stringify(result),
    ]);

    logger.info(`[Backtest] Terminé — ${result.trades.length} trades, return ${result.metrics.totalReturn}`);

    return res.status(200).json({
      success: true,
      backtestId: rows[0].id,
      metrics: result.metrics,
      charts: result.charts,
      trades: result.trades,
      warning: warning || undefined,
      effectiveTimeframe,
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