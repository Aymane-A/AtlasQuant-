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
  };
}

// onProgress(symbol) is called after each symbol completes (success or fail),
// so the caller can track "X/Y done" without waiting for the whole batch.
async function scanAllYF(interval = '4h', onProgress = () => {}) {
  const symbols = Object.keys(YF_SYMBOLS);
  logger.info(`[yahooFinance] Scanning ${symbols.length} forex/commodities/indices...`);
  const results = [];

  for (const symbol of symbols) {
    try {
      const sig = await generateYFSignal(symbol, interval);
      results.push(sig);
    } catch (err) {
      logger.error(`[yahooFinance] ${symbol} error: ${err.message}`);
    }
    try { onProgress(symbol); } catch { /* never let progress reporting break the scan */ }
    await new Promise(r => setTimeout(r, 300));
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