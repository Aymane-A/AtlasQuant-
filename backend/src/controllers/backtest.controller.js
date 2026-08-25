/**
 * src/controllers/backtest.controller.js
 *
 * FIX (audit multi-asset) :
 *   `aggregatePortfolio` recevait toujours `initialCapitalTotal` (le
 *   capital total demandé pour TOUS les symboles de l'univers), même
 *   quand certains symboles étaient skippés (données insuffisantes,
 *   erreur de fetch...). Le total return calculé dans l'engine divise
 *   par ce chiffre — donc plus il y avait de symboles skippés, plus le
 *   return affiché était artificiellement écrasé (on divisait par un
 *   capital jamais réellement investi). On passe maintenant le capital
 *   RÉELLEMENT engagé : capitalPerSymbol × nombre de symboles ayant
 *   effectivement tourné.
 *
 *   `capital` et le "Fixed $ per trade" sont saisis par l'utilisateur
 *   dans SA devise de settings (`capitalCurrency`, ex: MAD) — pas dans
 *   la devise de cotation du symbole tradé. Ces montants sont désormais
 *   convertis via `convertAmount()` (devise settings → devise du
 *   symbole) AVANT d'entrer dans `runSimulation`, symbole par symbole
 *   (chaque symbole de l'univers peut avoir une devise différente).
 */

const db = require('../config/db');
const logger = require('../utils/logger');
const { fetchCandlesForBacktest, convertAmount } = require('../services/backtestMarketRouter.service');
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
  if (!universe) return { symbols: [], truncated: false, truncatedCount: 0 };
  const all = [...new Set(
    String(universe).split(',').map(s => s.trim()).filter(Boolean)
  )];
  const symbols = all.slice(0, MAX_SYMBOLS);
  // FIX: signale les symboles ignorés silencieusement au-delà de
  // MAX_SYMBOLS, au lieu de les tronquer sans que l'utilisateur le sache.
  return {
    symbols,
    truncated: all.length > MAX_SYMBOLS,
    truncatedCount: Math.max(0, all.length - MAX_SYMBOLS),
    droppedSymbols: all.slice(MAX_SYMBOLS),
  };
}

/**
 * Résout le mode de sizing pour UN symbole donné. Pour 'fixed_dollar',
 * le montant saisi par l'utilisateur (dans sa devise de settings) est
 * converti vers la devise de cotation de CE symbole avant d'être utilisé
 * — deux symboles de devises différentes dans le même univers auront
 * donc des `positionSizeDollar` différents en valeur absolue, mais
 * équivalents en pouvoir d'achat réel.
 */
async function resolvePositionSizingForSymbol(body, capitalCurrency, quoteCurrency, warningsSink) {
  const mode = body.positionSizeMode;
  if (mode === 'fixed_dollar') {
    const raw = parseCapital(body.positionSizeValue);
    const converted = await convertAmount(raw, capitalCurrency, quoteCurrency, warningsSink);
    return { positionSizeMode: 'fixed_dollar', positionSizeDollar: converted };
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

        const {
          symbols,
          truncated: universeTruncated,
          truncatedCount: universeTruncatedCount,
          droppedSymbols,
        } = parseUniverse(universe);
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
    // Devise dans laquelle l'utilisateur a saisi `capital` / le "Fixed $
    // per trade" (Settings → Language & Region côté frontend). Fallback
    // USD pour compatibilité si un ancien frontend n'envoie pas ce champ.
    const capitalCurrency = (req.body.capitalCurrency || 'USD').toUpperCase();
    // FIX : collecte les paires de devises dont la conversion FX a
    // échoué (fallback 1:1 silencieux côté convertAmount) — partagé par
    // référence entre tous les appels (par-symbole + agrégation), pour
    // remonter un vrai warning utilisateur au lieu de rien.
    const fxWarnings = [];

    logger.info(`[Backtest] Démarrage pour user ${userId} — [${symbols.join(', ')}] (${requestedTimeframe}) stratégie="${strategyMeta.label}" du ${from} au ${to}`);

    const settled = await Promise.allSettled(symbols.map(async symbol => {
      const { candles, effectiveTimeframe, fallbackApplied, assetClass, quoteCurrency } =
        await fetchCandlesForBacktest(symbol, requestedTimeframe, from, to);

      if (!candles || candles.length < 50) {
        throw new Error(`Données insuffisantes pour ${symbol} (${candles?.length || 0} bougies récupérées, 50 minimum).`);
      }

      // FIX : capital et position sizing convertis vers la devise DE CE
      // SYMBOLE avant simulation — avant ce fix, un capital saisi en MAD
      // (ou toute devise ≠ devise du symbole) était utilisé tel quel,
      // comme s'il était déjà dans la bonne devise.
      const [convertedCapital, positionSizing] = await Promise.all([
        convertAmount(capitalPerSymbol, capitalCurrency, quoteCurrency, fxWarnings),
        resolvePositionSizingForSymbol(req.body, capitalCurrency, quoteCurrency, fxWarnings),
      ]);

      const result = runSimulation(candles, convertedCapital, {
        maxPositions: parseInt(maxPos) || 5,
        ...positionSizing,
        quoteCurrency,
        strategyId: requestedStrategyId,
      }, symbol);

      return { symbol, assetClass, fallbackApplied, effectiveTimeframe, initialCapitalUsed: convertedCapital, ...result };
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

    // FIX : on agrège sur le capital RÉELLEMENT investi (symboles qui ont
    // effectivement tourné, dans leur devise convertie), pas sur le
    // total initial demandé pour tout l'univers — sinon le total return
    // est faussé à la baisse dès qu'un ou plusieurs symboles sont
    // skippés. On somme les montants convertis réellement utilisés
    // (`initialCapitalUsed`) plutôt que de refaire `capitalPerSymbol ×
    // succeeded.length`, qui ignorerait la conversion FX par symbole.
    // NOTE : pour un univers mélangeant plusieurs devises de cotation
    // (ex: actions USD + forex JPY), sommer des equity curves exprimées
    // dans des devises différentes reste une simplification préexistante
    // du portefeuille agrégé (voir le flag 'MIXED' sur quoteCurrency) —
    // non résolue par ce fix, qui corrige seulement la conversion du
    // capital saisi vers la devise de CHAQUE symbole individuellement.
    const capitalActuallyInvested = succeeded.reduce((sum, r) => sum + (r.initialCapitalUsed || 0), 0);
        const { metrics, charts, trades } = await aggregatePortfolio(
      succeeded,
      capitalActuallyInvested,
      capitalCurrency,
      convertAmount,
      fxWarnings
    );
    const universeWarning = universeTruncated
      ? `Univers limité à ${MAX_SYMBOLS} symboles — ${universeTruncatedCount} ignoré(s): ${droppedSymbols.join(', ')}.`
      : '';
    const fxWarning = fxWarnings.length > 0
      ? `Conversion FX indisponible pour ${[...new Set(fxWarnings)].join(', ')} — montant(s) utilisé(s) sans conversion (taux 1:1).`
      : '';
    const warning = [
      buildWarningMessage(requestedTimeframe, succeeded, skipped),
      universeWarning,
      fxWarning,
    ].filter(Boolean).join(' ');

    // FIX (DB persistence) : `warning` et `skipped` sont désormais
    // inclus dans le blob stocké, sinon relire un backtest via
    // getBacktestById() perdait ces infos (fallback Daily appliqué,
    // symboles skippés...) — visibles seulement au moment du run live.
    const strategyName = name || strategyMeta.label;
    const { rows } = await db.query(
      `INSERT INTO backtest_history (user_id, symbol, strategy, result, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [userId, symbols.join(','), strategyName, JSON.stringify({ metrics, charts, trades, warning, skipped })]
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
      warning: result.warning,
      skipped: result.skipped,
    });
  } catch (err) {
    logger.error(`[backtest.controller] getBacktestById error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Impossible de récupérer ce backtest' });
  }
}

module.exports = { runBacktest, getBacktestById };