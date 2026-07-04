/**
 * services/yahooFinance.service.js
 * Commodities, Forex & Indices via Yahoo Finance (no API key needed)
 *
 * + getStockCandles : ajouté pour le Backtester, permet de récupérer
 *   n'importe quel symbole boursier (AAPL, SPY, NVDA...), pas seulement
 *   les paires de YF_SYMBOLS ci-dessous.
 */

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance  = new YahooFinance();
const logger        = require('../utils/logger');

// asset_class doit matcher: 'Commodity' | 'Forex' | 'Indices'
const YF_SYMBOLS = {
  // ── Commodities ──
  'GC=F':     { display: 'XAU/USD', asset_class: 'Commodity', category: 'Gold'        },
  'SI=F':     { display: 'XAG/USD', asset_class: 'Commodity', category: 'Silver'      },
  'CL=F':     { display: 'OIL/USD', asset_class: 'Commodity', category: 'Crude Oil'   },
  'NG=F':     { display: 'NATGAS',  asset_class: 'Commodity', category: 'Natural Gas' },
  'HG=F':     { display: 'COPPER',  asset_class: 'Commodity', category: 'Copper'      },
  'PL=F':     { display: 'XPT/USD', asset_class: 'Commodity', category: 'Platinum'    },

  // ── Forex ──
  'EURUSD=X': { display: 'EUR/USD', asset_class: 'Forex', category: 'Forex' },
  'GBPUSD=X': { display: 'GBP/USD', asset_class: 'Forex', category: 'Forex' },
  'USDJPY=X': { display: 'USD/JPY', asset_class: 'Forex', category: 'Forex' },
  'USDCHF=X': { display: 'USD/CHF', asset_class: 'Forex', category: 'Forex' },
  'AUDUSD=X': { display: 'AUD/USD', asset_class: 'Forex', category: 'Forex' },
  'USDCAD=X': { display: 'USD/CAD', asset_class: 'Forex', category: 'Forex' },
  'NZDUSD=X': { display: 'NZD/USD', asset_class: 'Forex', category: 'Forex' },
  'EURGBP=X': { display: 'EUR/GBP', asset_class: 'Forex', category: 'Forex' },

  // ── Indices ──
  '^GSPC':    { display: 'SPX500',  asset_class: 'Indices', category: 'US Index' },
  '^NDX':     { display: 'NAS100',  asset_class: 'Indices', category: 'US Index' },
  '^DJI':     { display: 'US30',    asset_class: 'Indices', category: 'US Index' },
  '^VIX':     { display: 'VIX',     asset_class: 'Indices', category: 'Volatility' },
};

const INTERVAL_MAP = {
  '1h': '1h',
  '4h': '1h',  // Yahoo ma 3andha-sh 4h — nakhdo 1h u ncompute
  '1d': '1d',
};

// Reward:Risk multiple appliqué au SL/TP calculé via ATR
const RR_MULTIPLE = 2;

async function getYFData(symbol, interval = '4h', limit = 100) {
  const yfInterval = INTERVAL_MAP[interval] || '1h';

  const now    = new Date();
  const period1 = new Date(now);
  if (yfInterval === '1h') {
    period1.setDate(period1.getDate() - 7);
  } else {
    period1.setFullYear(period1.getFullYear() - 1);
  }

  const result = await yahooFinance.chart(symbol, {
    period1:  period1.toISOString().split('T')[0],
    period2:  now.toISOString().split('T')[0],
    interval: yfInterval,
  });

  if (!result?.quotes?.length) {
    throw new Error(`No data for ${symbol}`);
  }

  const candles = result.quotes
    .filter(q => q.open && q.high && q.low && q.close)
    .slice(-limit)
    .map(q => ({
      open:   q.open,
      high:   q.high,
      low:    q.low,
      close:  q.close,
      volume: q.volume || 0,
    }));

  if (candles.length < 30) {
    throw new Error(`Not enough candles for ${symbol}: ${candles.length}`);
  }

  const price = candles[candles.length - 1].close;
  return { candles, price };
}

// ── ATR (Average True Range) — mesure de volatilité réelle par symbole ──
// Utilisé pour calculer stop_loss/take_profit spécifiques à chaque actif,
// au lieu de laisser ces champs vides (ce qui faisait tomber tous les
// signaux Forex/Commodity/Indices dans le même fallback basé uniquement
// sur la confidence — cause du bug des valeurs identiques en Journal).
function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close)
    );
    trueRanges.push(tr);
  }

  const recent = trueRanges.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
  return atr > 0 ? atr : null;
}

// Calcule entry/stop_loss/take_profit à partir de l'ATR. Fallback à 1% du
// prix si l'ATR ne peut pas être calculé (historique trop court).
function calcRiskLevels(price, candles, signal) {
  const atr = computeATR(candles) || price * 0.01;

  if (signal === 'BUY') {
    return {
      entry:       price,
      stop_loss:   price - atr,
      take_profit: price + atr * RR_MULTIPLE,
    };
  }
  if (signal === 'SELL') {
    return {
      entry:       price,
      stop_loss:   price + atr,
      take_profit: price - atr * RR_MULTIPLE,
    };
  }
  // HOLD — pas de position, pas de niveaux de risque
  return { entry: price, stop_loss: null, take_profit: null };
}

async function generateYFSignal(symbol, interval = '4h') {
  logger.info(`[yahooFinance] Processing ${symbol} (${interval})...`);

  const meta = YF_SYMBOLS[symbol];
  if (!meta) throw new Error(`Unknown YF symbol: ${symbol}`);

  const { computeAllIndicators } = require('./indicators.service');
  const { generateReasoning }    = require('./ai.service');

  const { candles, price } = await getYFData(symbol, interval, 100);
  const indicators = computeAllIndicators(candles);

  const { rsi, macd, ema, bollinger, volume } = indicators;
  let bull = 0, bear = 0;
  if (rsi.value <= 35)                    bull += 2;
  if (rsi.value >= 65)                    bear += 2;
  if (macd.trend === 'BUY')               bull++;
  if (macd.trend === 'SELL')              bear++;
  if (macd.crossover === 'BULLISH_CROSS') bull += 2;
  if (macd.crossover === 'BEARISH_CROSS') bear += 2;
  if (ema.signal === 'BUY')               bull++;
  if (ema.signal === 'SELL')              bear++;
  if (ema.crossover === 'GOLDEN_CROSS')   bull += 2;
  if (ema.crossover === 'DEATH_CROSS')    bear += 2;
  if (bollinger.signal === 'OVERSOLD')    bull++;
  if (bollinger.signal === 'OVERBOUGHT')  bear++;
  if (volume.ratio >= 1.5) { bull > bear ? bull++ : bear++; }

  const ai = await generateReasoning(meta.display, price, indicators);

  logger.info(`[yahooFinance] ${meta.display} → ${ai.signal} (${ai.confidence}%)`);

  const { entry, stop_loss, take_profit } = calcRiskLevels(price, candles, ai.signal);

  return {
    id:          `${symbol}_${Date.now()}`,
    symbol:      meta.display,
    rawSymbol:   symbol,
    asset_class: meta.asset_class,
    category:    meta.category,
    timestamp:   new Date().toISOString(),
    price,
    signal:      ai.signal,
    confidence:  ai.confidence,
    reasoning:   ai.reasoning,
    score:       { bullish: bull, bearish: bear },
    indicators,
    // ✅ Fix Bug 3: entry/SL/TP calculés via ATR (volatilité réelle du symbole),
    // plus jamais null pour un signal BUY/SELL — chaque actif a désormais ses
    // propres niveaux de risque au lieu de retomber sur le fallback confidence-only.
    entry,
    stop_loss,
    take_profit,
    risk_reward: ai.signal !== 'HOLD' ? `1:${RR_MULTIPLE}` : null,
  };
}

// onProgress(symbol) is called after each symbol completes (success or fail),
// so the caller can track "X/Y done" without waiting for the whole batch.
//
// ✅ Fix Bug 8: les 16 symboles étaient traités un par un (300ms d'attente +
// un appel Groq de 15s de timeout potentiel CHACUN), ce qui pouvait faire
// durer le scan complet plusieurs minutes et provoquer les "missed execution"
// du cron toutes les minutes (checkAlerts). On traite maintenant par petits
// lots parallèles (BATCH_SIZE symboles en même temps) — le total attendu
// passe de ~16×(fetch+Groq) à ~(16/BATCH_SIZE)×(fetch+Groq).
const YF_BATCH_SIZE = 4;

async function scanAllYF(interval = '4h', onProgress = () => {}) {
  const symbols = Object.keys(YF_SYMBOLS);
  logger.info(`[yahooFinance] Scanning ${symbols.length} forex/commodities/indices...`);
  const results = [];

  for (let i = 0; i < symbols.length; i += YF_BATCH_SIZE) {
    const batch = symbols.slice(i, i + YF_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(symbol => generateYFSignal(symbol, interval)));

    settled.forEach((outcome, idx) => {
      const symbol = batch[idx];
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        logger.error(`[yahooFinance] ${symbol} error: ${outcome.reason?.message}`);
      }
      try { onProgress(symbol); } catch { /* never let progress reporting break the scan */ }
    });

    if (i + YF_BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

// ── EXTENSION BACKTESTER ────────────────────────────────────
const STOCK_INTERVAL_MAP = {
  '15M':  '15m',
  '1H':   '60m',
  '4H':   '60m',
  Daily:  '1d',
};

function aggregateTo4H(candles) {
  const result = [];
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    if (chunk.length === 0) continue;
    result.push({
      date:   chunk[0].date,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(c => c.high)),
      low:    Math.min(...chunk.map(c => c.low)),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + (c.volume || 0), 0),
    });
  }
  return result;
}

async function getStockCandles(symbol, timeframe, startDate, endDate) {
  const interval = STOCK_INTERVAL_MAP[timeframe] || '1d';
  const isIntraday = interval !== '1d';

  let effectiveStart = new Date(startDate);
  let effectiveEnd = new Date(endDate);

  if (isIntraday) {
    const maxLookback = new Date();
    maxLookback.setDate(maxLookback.getDate() - 59);

    if (effectiveEnd < maxLookback) {
      throw new Error(
        `Yahoo Finance ne supporte pas ${timeframe} avant ${maxLookback.toISOString().slice(0,10)}`
      );
    }

    if (effectiveStart < maxLookback) {
      effectiveStart = maxLookback;
      logger.info(
        `[yahooFinance] Intraday limité à 60j — startDate ajusté à ${effectiveStart.toISOString().slice(0,10)}`
      );
    }
  }

  if (effectiveStart > effectiveEnd) {
    throw new Error(`Période invalide: ${effectiveStart} > ${effectiveEnd}`);
  }

  try {
    const raw = await yahooFinance.chart(symbol, {
      period1: effectiveStart,
      period2: effectiveEnd,
      interval,
    });

    if (!raw?.quotes?.length) {
      throw new Error(`Aucune donnée pour ${symbol}`);
    }

    let candles = raw.quotes
      .filter(q => q.open && q.high && q.low && q.close)
      .map(q => ({
        date: q.date,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
      }));

    if (timeframe === '4H') {
      candles = aggregateTo4H(candles);
    }

    return candles;

  } catch (error) {
    logger.error(`[yahooFinance] getStockCandles error (${symbol}): ${error.message}`);
    throw new Error(`Impossible de récupérer les données pour ${symbol}: ${error.message}`);
  }
}

module.exports = { generateYFSignal, scanAllYF, YF_SYMBOLS, getStockCandles };