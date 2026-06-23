/**
 * src/controllers/risk.controller.js
 *
 * Flux réel :
 *   1. Récupérer les positions ouvertes de l'utilisateur (trades, status='open')
 *   2. Calculer la matrice de risque complète via riskEngine.service
 *   3. Renvoyer les données formatées pour le frontend RiskMatrix
 *
 * GET  /api/risk/matrix?horizon=1D|1W|1M  → matrice de risque complète
 * POST /api/risk/stress-test              → stress test personnalisé { shockPct, sector }
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const { computeRiskMatrix, computeCustomStressTest } = require('../services/riskEngine.service');

const VALID_HORIZONS = ['1D', '1W', '1M'];

async function getOpenPositions(userId) {
  const { rows: trades } = await db.query(
    `SELECT symbol, side, quantity, entry_price
     FROM trades
     WHERE user_id = $1 AND status = $2`,
    [userId, 'open']
  );

  return trades.map(t => ({
    symbol: t.symbol,
    quantity: Number(t.quantity),
    entryPrice: Number(t.entry_price),
  }));
}

async function getRiskData(req, res) {
  try {
    const userId = req.user.id;
    const horizon = VALID_HORIZONS.includes(req.query.horizon) ? req.query.horizon : '1D';

    const positions = await getOpenPositions(userId);

    if (positions.length === 0) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'Aucune position ouverte — le portefeuille est vide',
      });
    }

    const riskMatrix = await computeRiskMatrix(positions, horizon);

    if (!riskMatrix) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'Impossible de calculer le risque pour ces positions',
      });
    }

    logger.info(`[risk.controller] Matrice de risque calculée pour user ${userId} — ${positions.length} positions, horizon ${horizon}, VaR: ${riskMatrix.kpis.dailyVaR}`);

    return res.status(200).json({
      success: true,
      data: riskMatrix,
    });

  } catch (err) {
    logger.error(`[risk.controller] Error calculating risk: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not calculate risk matrix' });
  }
}

/**
 * Stress test personnalisé : l'utilisateur fournit un % de choc de marché
 * et, optionnellement, un secteur ciblé. Renvoie l'impact estimé sur le
 * portefeuille actuel (beta-adjusted, même logique que les scénarios
 * prédéfinis de computeRiskMatrix).
 */
async function runCustomStressTest(req, res) {
  try {
    const userId = req.user.id;
    const { shockPct, sector } = req.body;

    const parsedShock = parseFloat(shockPct);
    if (!Number.isFinite(parsedShock) || parsedShock < -100 || parsedShock > 100) {
      return res.status(400).json({
        success: false,
        error: 'shockPct doit être un nombre entre -100 et 100',
      });
    }

    const positions = await getOpenPositions(userId);

    if (positions.length === 0) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'Aucune position ouverte — le portefeuille est vide',
      });
    }

    const result = await computeCustomStressTest(positions, parsedShock, sector);

    logger.info(`[risk.controller] Stress test personnalisé pour user ${userId} — choc ${parsedShock}% (${sector || 'all'}) → impact ${result.impactPct}%`);

    return res.status(200).json({ success: true, data: result });

  } catch (err) {
    logger.error(`[risk.controller] runCustomStressTest error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Impossible de calculer ce scénario de stress' });
  }
}

module.exports = { getRiskData, runCustomStressTest };