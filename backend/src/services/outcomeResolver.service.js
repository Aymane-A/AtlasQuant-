/**
 * services/outcomeResolver.service.js — AtlasQuant AI
 *
 * Résout les signaux BUY/SELL ouverts en regardant les vraies bougies 1h
 * après created_at :
 *   - le prix touche le SL  -> outcome 'SL'  (pnl négatif)
 *   - le prix touche le TP  -> outcome 'TP'  (pnl positif)
 *   - aucun des deux en 7j  -> outcome 'EXPIRED' (sortie au dernier close)
 *   - SL/TP manquants       -> outcome 'INVALID' (exclu des stats)
 *
 * Si SL et TP sont touchés dans la même bougie 1h, on compte SL
 * (hypothèse conservatrice).
 *
 * Crypto  -> API publique Binance (klines, sans clé)
 * Autres  -> yahoo-finance2 chart 1h
 */

const YahooFinance = require('yahoo-finance2').default;
const yf     = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const db     = require('../config/db');
const logger = require('../utils/logger');
const { YF_SYMBOLS } = require('./yahooFinance.service');

const HOUR        = 3600_000;
const MAX_HOLD_MS = 7 * 24 * HOUR;

// display ('XAU/USD', 'SPX500'...) -> ticker Yahoo ('GC=F', '^GSPC'...)
const DISPLAY_TO_YF = Object.fromEntries(
  Object.entries(YF_SYMBOLS).map(([ticker, m]) => [m.display, ticker])
);
// anciens noms possibles dans la DB
const LEGACY_TO_YF = { GSPC: '^GSPC', NDX: '^NDX', DJI: '^DJI', VIX: '^VIX' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Source de données pour un symbole ────────────────────
function pickSource(symbol, assetClass) {
  const isCrypto = assetClass === 'Crypto' || (!assetClass && symbol.endsWith('/USDT'));
  if (isCrypto) return { type: 'binance', id: symbol.replace('/', '') };

  if (assetClass === 'Equity') return { type: 'yahoo', id: symbol };

  const ticker = DISPLAY_TO_YF[symbol] || LEGACY_TO_YF[symbol];
  return ticker ? { type: 'yahoo', id: ticker } : null;
}

// ── Bougies 1h ───────────────────────────────────────────
async function binanceCandles(pair, fromMs, toMs) {
  const out = [];
  let start = fromMs;
  while (start < toMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&startTime=${start}&endTime=${toMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${pair} HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const k of rows) out.push({ time: k[0], high: +k[2], low: +k[3], close: +k[4] });
    start = rows[rows.length - 1][0] + HOUR;
    if (rows.length < 1000) break;
  }
  return out;
}

async function yahooCandles(ticker, fromMs, toMs) {
  const maxBack = Date.now() - 729 * 24 * HOUR;          // limite Yahoo pour le 1h
  const res = await yf.chart(ticker, {
    period1:  new Date(Math.max(fromMs, maxBack)),
    period2:  new Date(toMs),
    interval: '1h',
  });
  return (res?.quotes || [])
    .filter(q => q.high && q.low && q.close)
    .map(q => ({ time: new Date(q.date).getTime(), high: q.high, low: q.low, close: q.close }));
}

// ── Logique pure: un signal + ses bougies -> résultat ou null ──
function resolveOutcome(sig, candles, now = Date.now()) {
  const created = new Date(sig.created_at).getTime();
  const from    = Math.floor(created / HOUR) * HOUR;
  const expiry  = created + MAX_HOLD_MS;

  const entry = parseFloat(sig.entry);
  const sl    = parseFloat(sig.stop_loss);
  const tp    = parseFloat(sig.take_profit);

  if (!(entry > 0 && sl > 0 && tp > 0)) {
    return { outcome: 'INVALID', exit_price: null, closed_at: new Date(now), pnl_pct: null };
  }

  const isBuy = sig.signal === 'BUY';
  const fin = (outcome, exit, closedMs) => ({
    outcome,
    exit_price: exit,
    closed_at:  new Date(Math.min(closedMs, now)),
    pnl_pct:    +(((isBuy ? exit - entry : entry - exit) / entry) * 100).toFixed(3),
  });

  let last = null;
  for (const c of candles) {
    if (c.time < from) continue;
    if (c.time >= expiry) break;
    last = c;

    const hitSL = isBuy ? c.low  <= sl : c.high >= sl;
    const hitTP = isBuy ? c.high >= tp : c.low  <= tp;
    if (hitSL) return fin('SL', sl, c.time + HOUR);   // SL d'abord (conservateur)
    if (hitTP) return fin('TP', tp, c.time + HOUR);
  }

  if (now >= expiry + HOUR) {
    return last ? fin('EXPIRED', last.close, last.time + HOUR)
                : fin('EXPIRED', entry, expiry);
  }
  return null; // toujours ouvert
}

// ── Job principal ────────────────────────────────────────
let running = false;

async function resolveOpenSignals() {
  if (running) return { skipped: true, resolved: 0 };
  running = true;
  const summary = { open: 0, resolved: 0, skippedSymbols: [], errors: 0 };

  try {
    const { rows } = await db.query(`
      SELECT id, symbol, signal, entry, stop_loss, take_profit, created_at, asset_class
      FROM signals
      WHERE signal IN ('BUY','SELL') AND outcome IS NULL
      ORDER BY created_at ASC
      LIMIT 3000
    `);
    summary.open = rows.length;
    if (!rows.length) return summary;

    // groupe par symbole -> 1 fetch de bougies par symbole
    const bySymbol = new Map();
    for (const r of rows) {
      const k = `${r.symbol}|${r.asset_class || ''}`;
      if (!bySymbol.has(k)) bySymbol.set(k, []);
      bySymbol.get(k).push(r);
    }

    const now = Date.now();

    for (const [key, sigs] of bySymbol) {
      const [symbol, assetClass] = key.split('|');
      const source = pickSource(symbol, assetClass || null);

      if (!source) {
        summary.skippedSymbols.push(symbol);
        continue;
      }

      try {
        const fromMs = Math.floor(new Date(sigs[0].created_at).getTime() / HOUR) * HOUR;
        const candles = source.type === 'binance'
          ? await binanceCandles(source.id, fromMs, now)
          : await yahooCandles(source.id, fromMs, now);

        for (const sig of sigs) {
          const res = resolveOutcome(sig, candles, now);
          if (!res) continue;
          await db.query(
            `UPDATE signals
                SET outcome = $2, closed_at = $3, exit_price = $4, pnl_pct = $5
              WHERE id = $1 AND outcome IS NULL`,
            [sig.id, res.outcome, res.closed_at, res.exit_price, res.pnl_pct]
          );
          summary.resolved++;
        }
      } catch (err) {
        summary.errors++;
        logger.error(`[outcomeResolver] ${symbol}: ${err.message}`);
      }

      await sleep(250); // politesse envers Binance / Yahoo
    }

    if (summary.skippedSymbols.length) {
      logger.warn(`[outcomeResolver] symboles sans source: ${summary.skippedSymbols.join(', ')}`);
    }
    return summary;
  } finally {
    running = false;
  }
}

module.exports = { resolveOpenSignals, resolveOutcome };