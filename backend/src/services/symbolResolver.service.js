/**
 * src/services/symbolResolver.service.js — AtlasQuant AI
 *
 * Point d'entrée unique de correction des symboles tapés par l'utilisateur
 * (watchlist, alerts, Trading page). Voir docstring complet dans la
 * version précédente — inchangé sur le principe (pas de LLM, déterministe).
 *
 * ✅ Fix — 2026-09-26: ajout d'une table d'alias en dur (COMMON_ALIASES)
 * vérifiée AVANT le fuzzy match et AVANT le fallback Yahoo search. Sans
 * ça, des noms complets tapés en anglais courant (ex: "BITCOIN", "GOLD",
 * "SILVER", "OIL") tombaient dans le fallback equity et se faisaient
 * résoudre vers un VRAI ticker actions qui porte ce nom par coïncidence
 * (ex: "GOLD" → Barrick Gold Corp, une mining company, PAS le cours de
 * l'or — le fuzzy match contre "XAU/USD" était trop faible en similarité
 * pour l'attraper). Ce bug aurait pu faire ouvrir un trade sur le mauvais
 * actif si un user tapait "gold" en pensant suivre l'or.
 */

const logger = require('../utils/logger');
const { CRYPTO_SYMBOLS } = require('./signalGenerator.service');
const { YF_SYMBOLS, searchYahoo } = require('./yahooFinance.service');

const FUZZY_THRESHOLD = 0.72;

// Noms courants qu'un user tape naturellement, qui ne ressemblent PAS
// assez (en distance Levenshtein) au ticker/display réel pour être
// attrapés par le fuzzy match — vérifiés en priorité absolue, avant
// même le fallback Yahoo, pour éviter qu'un ticker actions homonyme
// (ex: "GOLD" = Barrick Gold Corp) ne vole la résolution.
const COMMON_ALIASES = {
  // Crypto
  BITCOIN:  'BTC/USDT',
  ETHEREUM: 'ETH/USDT',
  SOLANA:   'SOL/USDT',
  DOGECOIN: 'DOGE/USDT',
  CARDANO:  'ADA/USDT',
  RIPPLE:   'XRP/USDT',
  LITECOIN: 'LTC/USDT',
  POLKADOT: 'DOT/USDT',
  // Commodities
  GOLD:        'XAU/USD',
  SILVER:      'XAG/USD',
  OIL:         'OIL/USD',
  CRUDE:       'OIL/USD',
  CRUDEOIL:    'OIL/USD',
  NATURALGAS:  'NATGAS',
  PLATINUM:    'XPT/USD',
  // Indices
  SP500:     'SPX500',
  SPX:       'SPX500',
  NASDAQ:    'NAS100',
  DOWJONES:  'US30',
  DOW:       'US30',
};

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - dist / maxLen;
}

function buildFixedUniverse() {
  const universe = [];

  for (const raw of CRYPTO_SYMBOLS) {
    const display = raw.endsWith('USDT') ? `${raw.slice(0, -4)}/USDT` : raw;
    universe.push({ candidate: raw,     resolved: display, assetClass: 'Crypto' });
    universe.push({ candidate: display, resolved: display, assetClass: 'Crypto' });
  }

  for (const meta of Object.values(YF_SYMBOLS)) {
    universe.push({ candidate: meta.display, resolved: meta.display, assetClass: meta.asset_class });
  }

  return universe;
}

const FIXED_UNIVERSE = buildFixedUniverse();

// Résout un alias display (ex: "XAU/USD") vers son assetClass connue —
// utilisé quand COMMON_ALIASES matche, pour renvoyer le bon assetClass
// sans dupliquer la table YF_SYMBOLS/CRYPTO_SYMBOLS.
function assetClassForDisplay(display) {
  const entry = FIXED_UNIVERSE.find(e => e.resolved === display);
  return entry?.assetClass || null;
}

function findBestFixedMatch(input) {
  let best = null;
  for (const entry of FIXED_UNIVERSE) {
    const sim = similarity(input, entry.candidate.toUpperCase());
    if (!best || sim > best.similarity) {
      best = { ...entry, similarity: sim };
    }
  }
  return best;
}

async function resolveSymbol(rawInput) {
  const input = (rawInput || '').trim().toUpperCase();
  if (!input) {
    return { original: rawInput, resolved: null, assetClass: null, matchType: 'none', confidence: 0 };
  }

  // 0. Alias explicite — priorité absolue, avant même le match exact
  // contre les tickers bruts, pour intercepter les noms courants ("GOLD",
  // "BITCOIN") avant qu'ils ne puissent glisser vers Yahoo equity search.
  const aliasKey = input.replace(/[\s\-_]/g, ''); // "NATURAL GAS" → "NATURALGAS"
  if (COMMON_ALIASES[aliasKey]) {
    const resolved = COMMON_ALIASES[aliasKey];
    const assetClass = assetClassForDisplay(resolved);
    logger.info(`[symbolResolver] "${rawInput}" → "${resolved}" (alias)`);
    return { original: rawInput, resolved, assetClass, matchType: 'exact', confidence: 1 };
  }

  // 1. Match exact dans l'univers fixe
  const exact = FIXED_UNIVERSE.find(e => e.candidate.toUpperCase() === input);
  if (exact) {
    return { original: rawInput, resolved: exact.resolved, assetClass: exact.assetClass, matchType: 'exact', confidence: 1 };
  }

  // 2. Fuzzy match dans l'univers fixe
  const best = findBestFixedMatch(input);
  if (best && best.similarity >= FUZZY_THRESHOLD) {
    logger.info(`[symbolResolver] "${rawInput}" → "${best.resolved}" (fuzzy, ${(best.similarity * 100).toFixed(0)}%)`);
    return { original: rawInput, resolved: best.resolved, assetClass: best.assetClass, matchType: 'fuzzy', confidence: best.similarity };
  }

  // 3. Fallback equity — Yahoo Finance search
  const quotes = await searchYahoo(input);
  const equityMatch = quotes.find(q => q.quoteType === 'EQUITY') || quotes[0];
  if (equityMatch?.symbol) {
    const exactEquity = equityMatch.symbol.toUpperCase() === input;
    logger.info(`[symbolResolver] "${rawInput}" → "${equityMatch.symbol}" (Yahoo search${exactEquity ? ', exact' : ''})`);
    return {
      original:   rawInput,
      resolved:   equityMatch.symbol.toUpperCase(),
      assetClass: 'Equity',
      matchType:  exactEquity ? 'exact' : 'search',
      confidence: exactEquity ? 1 : 0.6,
      shortname:  equityMatch.shortname || equityMatch.longname || null,
    };
  }

  logger.warn(`[symbolResolver] "${rawInput}" — aucun match trouvé`);
  return { original: rawInput, resolved: null, assetClass: null, matchType: 'unresolved', confidence: 0 };
}

module.exports = { resolveSymbol, FUZZY_THRESHOLD };