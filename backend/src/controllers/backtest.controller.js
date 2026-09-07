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
 *   RÉELLEMENT engagé : somme des `initialCapitalUsed` réels par symbole.
 *
 *   `capital` et le "Fixed $ per trade" sont saisis par l'utilisateur
 *   dans SA devise de settings (`capitalCurrency`, ex: MAD) — pas dans
 *   la devise de cotation du symbole tradé. Ces montants sont désormais
 *   convertis via `convertAmount()` (devise settings → devise du
 *   symbole) AVANT d'entrer dans `runSimulation`, symbole par symbole.
 *   `aggregatePortfolio` convertit en plus chaque equity curve vers
 *   `capitalCurrency` avant de les sommer (fini le 'MIXED' silencieux).
 *
 *   Univers tronqué au-delà de MAX_SYMBOLS : signalé à l'utilisateur via
 *   un warning au lieu d'être coupé silencieusement.
 *
 *   Sauvegarde/chargement de presets de config (universe, dates,
 *   stratégie, sizing...) — ne lance pas de backtest, stocke juste les
 *   paramètres du formulaire pour un rechargement ultérieur.
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
  if (!universe) return { symbols: [], truncated: false, truncatedCount: 0, droppedSymbols: [] };
  const all = [...new Set(
    String(universe).split(',').map(s => s.trim()).filter(Boolean)
  )];
  const symbols = all.slice(0, MAX_SYMBOLS);
  // FIX : signale les symboles ignorés silencieusement au-delà de
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
    // Collecte les paires de devises dont la conversion FX a échoué
    // (fallback 1:1 silencieux côté convertAmount) — partagé par
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

      // Capital et position sizing convertis vers la devise DE CE
      // SYMBOLE avant simulation — un capital saisi en MAD (ou toute
      // devise ≠ devise du symbole) n'est plus utilisé tel quel comme
      // s'il était déjà dans la bonne devise.
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

    // FIX (currency mismatch) : `initialCapitalUsed` dyal chaque symbole houwa
    // f `quoteCurrency` DYALO (AAPL → USD, USDJPY → JPY, VOD.L → GBP...), machi
    // f `capitalCurrency` (devise settings de l'user). Le sommer directement
    // mélangeait des devises différentes comme si c'était la même — le total
    // obtenu était sans signification, et servait ensuite de dénominateur pour
    // totalReturn/annualReturns dans aggregatePortfolio. On convertit chaque
    // montant vers `capitalCurrency` (= targetCurrency d'aggregatePortfolio)
    // AVANT de sommer.
    const capitalActuallyInvested = (
      await Promise.all(
        succeeded.map(r =>
          convertAmount(r.initialCapitalUsed || 0, r.metrics.quoteCurrency, capitalCurrency, fxWarnings)
        )
      )
    ).reduce((sum, v) => sum + v, 0);


    // aggregatePortfolio convertit maintenant chaque equity curve vers
    // `capitalCurrency` avant de sommer (voir backtestEngine.service.js)
    // — un univers mélangeant plusieurs devises de cotation (ex: actions
    // USD + forex JPY) n'aboutit plus à une simple addition brute de
    // devises différentes.
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
    const warningParts = [buildWarningMessage(requestedTimeframe, succeeded, skipped), universeWarning, fxWarning]
      .filter(Boolean);
    const warning = warningParts.length > 0 ? warningParts.join(' ') : undefined;

    // `warning` et `skipped` sont inclus dans le blob stocké, sinon
    // relire un backtest via getBacktestById() perd ces infos (fallback
    // Daily appliqué, symboles skippés, univers tronqué...) — visibles
    // seulement au moment du run live sinon.
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

/**
 * Sauvegarde un preset de config (universe, dates, stratégie, sizing...)
 * — ne lance PAS de backtest, stocke juste les paramètres tels quels
 * pour un rechargement ultérieur dans le formulaire.
 */
async function saveBacktestConfig(req, res) {
  try {
    const userId = req.user.id;
    const { name, config } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Un nom est requis pour sauvegarder la config' });
    }
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ success: false, error: 'Config manquante ou invalide' });
    }

    const { rows } = await db.query(
      `INSERT INTO backtest_configs (user_id, name, config, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, name, config, created_at, updated_at`,
      [userId, name.trim(), JSON.stringify(config)]
    );

    logger.info(`[Backtest] Config "${name.trim()}" sauvegardée pour user ${userId}`);

    return res.status(201).json({ success: true, config: rows[0] });
  } catch (err) {
    logger.error(`[backtest.controller] saveBacktestConfig error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Échec de la sauvegarde de la config' });
  }
}

/**
 * Liste les presets sauvegardés de l'utilisateur, les plus récents
 * d'abord.
 */
async function listBacktestConfigs(req, res) {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT id, name, config, created_at, updated_at
       FROM backtest_configs WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId]
    );
    return res.status(200).json({ success: true, configs: rows });
  } catch (err) {
    logger.error(`[backtest.controller] listBacktestConfigs error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Échec du chargement des configs' });
  }
}

/**
 * Supprime un preset. Scoped par user_id — un utilisateur ne peut pas
 * supprimer la config d'un autre (même logique que getBacktestById).
 */
async function deleteBacktestConfig(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { rowCount } = await db.query(
      `DELETE FROM backtest_configs WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Config introuvable' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error(`[backtest.controller] deleteBacktestConfig error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Échec de la suppression de la config' });
  }
}

module.exports = {
  runBacktest,
  getBacktestById,
  saveBacktestConfig,
  listBacktestConfigs,
  deleteBacktestConfig,
};