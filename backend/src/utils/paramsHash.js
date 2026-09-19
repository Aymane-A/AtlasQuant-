/**
 * src/utils/paramsHash.js — AtlasQuant AI
 *
 * Hash canonique des paramètres de stratégie — partagé entre
 * backtest.controller.js (au moment de sauvegarder un backtest) et
 * auto_trade.controller.js (au moment de créer/valider un config
 * d'auto-trading). Les deux DOIVENT utiliser exactement la même logique
 * de hash, sinon un auto_trade_config ne matchera jamais le backtest
 * censé le débloquer même quand les paramètres sont identiques.
 *
 * Ne hash QUE ce qui détermine réellement le comportement de
 * runSimulation (strategyId, maxPositions, position sizing) — pas les
 * montants d'argent (capital, devise), qui ne changent pas les règles
 * d'entrée/sortie.
 */

const crypto = require('crypto');

function computeParamsHash({ strategyId, maxPositions, positionSizeMode, positionSizeValue }) {
  const canonical = {
    strategyId: strategyId || 'rsi_momentum',
    maxPositions: parseInt(maxPositions, 10) || 5,
    positionSizeMode: positionSizeMode || 'fixed_pct',
    positionSizeValue: positionSizeValue != null ? String(positionSizeValue) : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = { computeParamsHash };