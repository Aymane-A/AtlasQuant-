/**
 * portfolioController.js — AtlasQuant AI v3
 *
 * Accounting model (matches addPosition / removePosition cash moves):
 *   long  open  → cash -= cost          | equity contribution = +price*amount
 *   short open  → cash += proceeds      | equity contribution = -price*amount
 *   equity (Total Portfolio Value) = cash + Σ signedMarketValue
 *   Unrealised P&L = Σ position P&L (only positions with a known entry price)
 *
 * Percentages: everything labelled "of portfolio" (donut, holdings, concentration,
 * cash ratio) uses the same base = gross exposure + positive cash.
 * Sectors use gross exposure only (they sum to 100%).
 */
const db           = require('../config/db');
const axios        = require('axios');
const logger       = require('../utils/logger');
const exchangesSvc = require('../services/exchanges.service');
const { getStockQuotes } = require('../services/stockQuotes.service');
const { getBenchmarkHistory } = require('../services/marketData.service');
const { buildBenchmarkCurve } = require('../services/benchmarkComparison.service');
const { sendServerError } = require('../utils/httpError');

const COLORS = ['#00f5d4','#a78bfa','#f59e0b','#f43f5e','#38bdf8','#34d399','#fb923c','#e879f9'];

const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','FDUSD']);

const STOCK_SYMBOLS = new Set([
  'AAPL','MSFT','GOOGL','GOOG','AMZN','TSLA','NVDA','META','AMD','PLTR',
  'SPY','QQQ','DIA','IWM','NFLX','BABA','TSM','ORCL','INTC','QCOM',
  'JPM','GS','MS','BAC','WFC','V','MA','PYPL','SQ','COIN',
  'XOM','CVX','BP','OXY','MCD','KO','PEP','PG','JNJ','UNH',
]);
// Any symbol whose sector is one of these is treated as a stock ticker,
// even if it is not in STOCK_SYMBOLS (no more hardcoded-list dependency).
const STOCK_SECTORS = new Set(['Stocks', 'ETF']);

const ALLOWED_BENCHMARKS = new Set(['BTC', 'SPY']);

// ── Caches (in-memory, per process) ──────────────────────────────────────────
const PRICE_CACHE = new Map();            // symbol → { price, changeRaw, cachedAt }
const PRICE_TTL   = 5 * 60 * 1000;

const BENCH_CACHE = new Map();            // `${sym}:${days}` → { candles, cachedAt }
const BENCH_TTL   = 10 * 60 * 1000;

const EXCH_CACHE  = new Map();            // userId → { balances, cachedAt }
const EXCH_TTL    = 45 * 1000;
const EXCH_TIMEOUT_MS = 8000;

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtUSD(n, decimals = 2) {
  if (!Number.isFinite(n)) n = 0;
  const r    = Number(n.toFixed(decimals));
  const sign = r < 0 ? '-' : r > 0 ? '+' : '';
  return `${sign}$${Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtPct(n, decimals = 2) {
  if (!Number.isFinite(n)) n = 0;
  const r = Number(n.toFixed(decimals));
  return `${r >= 0 ? '+' : ''}${r.toFixed(decimals)}%`;
}
function fmtPriceStr(p) {
  if (!(p > 0)) return '$0.00';
  if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (p >= 0.01) return `$${p.toFixed(2)}`;
  return `$${p.toFixed(6)}`;
}
function fmtEntryStr(p) {
  return p > 0 ? `$${p.toFixed(p >= 1000 ? 2 : 4)}` : 'N/A';
}
// Stable colour per symbol → same asset has the same colour everywhere.
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ── Live prices ──────────────────────────────────────────────────────────────
function cacheGet(sym, allowStale = false) {
  const c = PRICE_CACHE.get(sym);
  if (!c) return null;
  if (allowStale || Date.now() - c.cachedAt < PRICE_TTL) return c;
  return null;
}

async function fetchCryptoQuotes(list) {
  const out = {}, failed = [];
  if (!list.length) return { out, failed };
  const results = await Promise.allSettled(
    list.map(sym =>
      axios.get('https://api.binance.com/api/v3/ticker/24hr', { params: { symbol: `${sym}USDT` }, timeout: 5000 })
        .then(r => ({ sym, price: parseFloat(r.data.lastPrice), changeRaw: parseFloat(r.data.priceChangePercent) }))
    )
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.price > 0) {
      out[r.value.sym] = { price: r.value.price, changeRaw: Number.isFinite(r.value.changeRaw) ? r.value.changeRaw : 0 };
    } else {
      failed.push(list[i]);
    }
  });
  return { out, failed };
}

// ✅ Audit 3: appel direct du service (plus de HTTP sur localhost, plus de
// plafond à 9 symboles). Les cotations isDemo / isStale ne sont JAMAIS prises
// pour des prix live : elles reviennent flaguées `stale` (changement 24h = 0) et
// ne sont pas écrites dans PRICE_CACHE comme des prix frais.
async function fetchStockQuotes(list) {
  const out = {};
  if (!list.length) return out;
  try {
    const { quotes } = await getStockQuotes(list);
    for (const q of quotes) {
      if (!q?.symbol || !(q.price > 0)) continue;
      const flagged = !!(q.isDemo || q.isStale);
      out[q.symbol] = {
        price:     q.price,
        changeRaw: flagged ? 0 : (Number.isFinite(q.change) ? q.change : 0),
        ...(flagged ? { stale: true, demo: !!q.isDemo } : {}),
      };
    }
  } catch (e) {
    logger.warn(`[portfolio] Stock prices fetch failed: ${e.message}`);
  }
  return out;
}

/**
 * symbols: string[]   hints: { SYMBOL: sector }
 * returns { SYMBOL: { price, changeRaw, stale? } }
 */
async function fetchLivePrices(symbols, hints = {}) {
  const now      = Date.now();
  const priceMap = {};
  const cryptoList = [], stockList = [];

  const put = (sym, price, changeRaw, flags) => {
    if (flags && flags.stale) { priceMap[sym] = { price, changeRaw, ...flags }; return; }   // demo/stale: jamais en cache "frais"
    priceMap[sym] = { price, changeRaw };
    PRICE_CACHE.set(sym, { price, changeRaw, cachedAt: now });
  };

  for (const s of symbols) {
    const fresh = cacheGet(s);
    if (fresh) { priceMap[s] = { price: fresh.price, changeRaw: fresh.changeRaw }; continue; }
    if (STABLES.has(s)) { put(s, 1, 0); continue; }
    if (STOCK_SYMBOLS.has(s) || STOCK_SECTORS.has(hints[s])) stockList.push(s);
    else if (/^[A-Z0-9]{1,15}$/.test(s)) cryptoList.push(s);
  }

  const [crypto, stocks] = await Promise.all([fetchCryptoQuotes(cryptoList), fetchStockQuotes(stockList)]);
  Object.entries(crypto.out).forEach(([s, q]) => put(s, q.price, q.changeRaw));
  Object.entries(stocks).forEach(([s, q]) => put(s, q.price, q.changeRaw, q));

  // Not on Binance? It may be a stock ticker that isn't in STOCK_SYMBOLS.
  if (crypto.failed.length) {
    const extra = await fetchStockQuotes(crypto.failed);
    Object.entries(extra).forEach(([s, q]) => put(s, q.price, q.changeRaw, q));
  }

  // Last resort: stale cache (any age), flagged so callers don't trust 24h change.
  for (const s of symbols) {
    if (priceMap[s]) continue;
    const stale = cacheGet(s, true);
    if (stale) {
      priceMap[s] = { price: stale.price, changeRaw: 0, stale: true };
      logger.warn(`[portfolio] Using stale cache for ${s} (age: ${Math.round((now - stale.cachedAt) / 1000)}s)`);
    }
  }
  return priceMap;
}

// ── Benchmark (cached) ───────────────────────────────────────────────────────
async function getBenchmarkCached(symbol, days = 35) {
  const key = `${symbol}:${days}`;
  const hit = BENCH_CACHE.get(key);
  if (hit && Date.now() - hit.cachedAt < BENCH_TTL) return hit.candles;
  const candles = await getBenchmarkHistory(symbol, days);
  BENCH_CACHE.set(key, { candles, cachedAt: Date.now() });
  return candles;
}

// ── Exchange balances (cached 45s, per-exchange timeout) ─────────────────────
async function fetchExchangeBalances(userId) {
  const hit = EXCH_CACHE.get(userId);
  if (hit && Date.now() - hit.cachedAt < EXCH_TTL) return hit.balances;

  try {
    const { rows } = await db.query(
      `SELECT exchange_id, mode FROM user_exchange_connections WHERE user_id = $1`,
      [userId]
    );
    if (!rows.length) { EXCH_CACHE.set(userId, { balances: [], cachedAt: Date.now() }); return []; }

    const allBalances = [];

    await Promise.allSettled(
      rows.map(async (conn) => {
        try {
          if (conn.mode === 'paper') return;

          const creds = await exchangesSvc.getDecryptedCredentials(userId, conn.exchange_id);
          if (!creds) return;

          const balances = await withTimeout(
            exchangesSvc.fetchPortfolio(conn.exchange_id, creds),
            EXCH_TIMEOUT_MS,
            `${conn.exchange_id} fetchPortfolio`
          );

          for (const b of balances) {
            if (b.total > 0.000001) {
              allBalances.push({
                symbol:   b.symbol,
                amount:   b.total,
                free:     b.free,
                locked:   b.locked,
                exchange: conn.exchange_id,
                mode:     conn.mode,
              });
            }
          }

          db.query(
            `UPDATE user_exchange_connections SET last_sync_at = NOW()
             WHERE user_id = $1 AND exchange_id = $2`,
            [userId, conn.exchange_id]
          ).catch(() => {});
        } catch (err) {
          logger.warn(`[portfolio] Failed to fetch ${conn.exchange_id} balances: ${err.message}`);
        }
      })
    );

    EXCH_CACHE.set(userId, { balances: allBalances, cachedAt: Date.now() });
    return allBalances;
  } catch (err) {
    logger.warn(`[portfolio] fetchExchangeBalances error: ${err.message}`);
    return [];
  }
}

// ── Merge DB positions + exchange balances ───────────────────────────────────
function mergePositions(dbPositions, exchangeBalances) {
  const merged = {};
  const keyOf  = (symbol, side) => `${symbol}::${side}`;

  for (const p of dbPositions) {
    const side = p.side || 'long';
    merged[keyOf(p.symbol, side)] = {
      symbol:        p.symbol,
      side,
      amount:        parseFloat(p.amount),
      average_entry: parseFloat(p.average_entry),
      current_price: parseFloat(p.current_price),
      sector:        p.sector || 'Crypto',
      source:        'manual',
      inDb:          true,
      exchanges:     [],
    };
  }

  for (const b of exchangeBalances) {
    if (STABLES.has(b.symbol)) continue;
    const key = keyOf(b.symbol, 'long');

    if (merged[key]) {
      merged[key].amount = b.amount;
      merged[key].source = 'exchange';
      merged[key].exchanges.push(b.exchange);
    } else {
      merged[key] = {
        symbol:        b.symbol,
        side:          'long',
        amount:        b.amount,
        average_entry: 0,
        current_price: 0,
        sector:        'Crypto',
        source:        'exchange',
        inDb:          false,
        exchanges:     [b.exchange],
      };
    }
  }

  const stableCash = exchangeBalances
    .filter(b => STABLES.has(b.symbol))
    .reduce((sum, b) => sum + b.amount, 0);

  return { positions: Object.values(merged), stableCash };
}

// ── GET /api/portfolio/data ──────────────────────────────────────────────────
async function getPortfolioData(req, res) {
  try {
    const userId = req.user.id;

    const reqBench        = String(req.query.benchmark || 'BTC').toUpperCase();
    const benchmarkSymbol = ALLOWED_BENCHMARKS.has(reqBench) ? reqBench : 'BTC';

    // Start the benchmark fetch immediately — it runs while everything else loads.
    const benchPromise = getBenchmarkCached(benchmarkSymbol).catch(e => {
      logger.warn(`[portfolio] Benchmark fetch failed (${benchmarkSymbol}): ${e.message}`);
      return null;
    });

    const [posRes, exchangeBalances, accountRes, realizedRes, curveRes] = await Promise.all([
      db.query(
        `SELECT symbol, side, amount, average_entry, current_price, sector
         FROM portfolio WHERE user_id = $1
         ORDER BY (amount * current_price) DESC`,
        [userId]
      ),
      fetchExchangeBalances(userId),
      db.query(`SELECT cash_balance FROM accounts WHERE user_id=$1 LIMIT 1`, [userId]),
      db.query(
        `SELECT COALESCE(SUM(pnl), 0) AS total
         FROM trades WHERE user_id=$1 AND status='closed' AND side IN ('long','short')`,
        [userId]
      ),
      db.query(
        `SELECT snapshot_date, total_value,
                TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS date_key
         FROM portfolio_snapshots
         WHERE user_id=$1 ORDER BY snapshot_date DESC LIMIT 30`,
        [userId]
      ),
    ]);

    const dbPositions = posRes.rows;
    const { positions, stableCash } = mergePositions(dbPositions, exchangeBalances);

    const symbols = [...new Set(positions.map(p => p.symbol))];
    const hints   = {};
    positions.forEach(p => { if (p.sector) hints[p.symbol] = p.sector; });
    const livePrices = symbols.length ? await fetchLivePrices(symbols, hints) : {};

    // Persist fresh prices (fire-and-forget, never blocks the response)
    const fresh = Object.entries(livePrices).filter(([, d]) => !d.stale && d.price > 0);
    if (fresh.length) {
      Promise.all(
        fresh.map(([sym, d]) =>
          db.query(
            `UPDATE portfolio SET current_price=$1, updated_at=NOW()
             WHERE user_id=$2 AND symbol=$3`,
            [d.price, userId, sym]
          ).catch(() => {})
        )
      ).catch(() => {});
    }

    const dbCash = accountRes.rows.length ? parseFloat(accountRes.rows[0].cash_balance) : 0;
    const cash   = dbCash + stableCash;
    const realizedPnLRaw = parseFloat(realizedRes.rows[0]?.total) || 0;

    const equityCurve = curveRes.rows.reverse().map(r => ({
      t:    new Date(r.snapshot_date).toLocaleDateString('en-US', { month:'short', day:'numeric' }),
      v:    parseFloat(r.total_value),
      date: r.date_key,
    }));

    // ── Per-position maths ────────────────────────────────────────────────────
    let totalCost = 0, signedValue = 0, grossValue = 0, unrealisedRaw = 0, todayPnLRaw = 0;

    const processed = positions.map((p) => {
      const sgn      = p.side === 'short' ? -1 : 1;
      const avgEntry = parseFloat(p.average_entry) || 0;
      const amount   = parseFloat(p.amount) || 0;
      const live     = livePrices[p.symbol];
      const dbPrice  = parseFloat(p.current_price) || 0;
      const curPrice = live?.price > 0 ? live.price : dbPrice;
      const dayChg   = live && !live.stale ? (live.changeRaw || 0) : 0;

      const curVal    = curPrice * amount;                       // always ≥ 0 (gross)
      const costBasis = avgEntry * amount;
      const pnlRaw    = avgEntry > 0 ? sgn * (curPrice - avgEntry) * amount : 0;
      const retPct    = costBasis > 0 ? (pnlRaw / costBasis) * 100 : 0;

      // value change over the last 24h: curVal - curVal/(1+c) = curVal*c/(1+c)
      const c      = dayChg / 100;
      const dayPnl = (1 + c) > 0 ? sgn * curVal * (c / (1 + c)) : 0;

      totalCost     += costBasis;
      signedValue   += sgn * curVal;
      grossValue    += curVal;
      unrealisedRaw += pnlRaw;
      todayPnLRaw   += dayPnl;

      return {
        sym: p.symbol, side: p.side || 'long', amount,
        avgEntryRaw: avgEntry, priceRaw: curPrice,
        avgEntry: fmtEntryStr(avgEntry),
        price:    fmtPriceStr(curPrice),
        curVal, pnlRaw, retPct,
        pnl: avgEntry > 0 ? fmtUSD(pnlRaw) : 'N/A',
        ret: avgEntry > 0 ? fmtPct(retPct) : 'N/A',
        ch:  fmtPct(dayChg),
        up:  dayChg >= 0,
        color:     colorFor(p.symbol),
        sector:    p.sector || 'Crypto',
        source:    p.source || 'manual',
        inDb:      !!p.inDb,
        exchanges: p.exchanges || [],
      };
    }).sort((a, b) => b.curVal - a.curVal);

    const totalValue  = cash + signedValue;                       // equity
    const totalRetPct = totalCost > 0 ? (unrealisedRaw / totalCost) * 100 : 0;
    const prevValue   = totalValue - todayPnLRaw;
    const dayRetPct   = prevValue > 0 ? (todayPnLRaw / prevValue) * 100 : 0;

    const allocBase = grossValue + Math.max(cash, 0);
    const pctOf     = (v) => (allocBase > 0 ? (v / allocBase) * 100 : 0);

    const hero = {
      totalValue,
      todayPnL:      fmtUSD(todayPnLRaw),
      dayReturn:     fmtPct(dayRetPct),
      totalPnL:      fmtUSD(unrealisedRaw),
      totalReturn:   fmtPct(totalRetPct),
      realizedPnL:   fmtUSD(realizedPnLRaw),
      lifetimePnL:   fmtUSD(unrealisedRaw + realizedPnLRaw),
      openPositions: processed.length,
      availableCash: fmtUSD(cash),
      exchangeCount: new Set(exchangeBalances.map(b => b.exchange)).size,
    };

    const allocations = processed.map(p => ({
      name:  p.side === 'short' ? `${p.sym} (S)` : p.sym,
      pct:   pctOf(p.curVal),
      color: p.color,
    }));
    if (cash > 0 && allocBase > 0) allocations.push({ name: 'Cash', pct: pctOf(cash), color: '#64748b' });

    const holdings = processed.slice(0, 5).map(p => ({
      sym: p.sym, side: p.side, price: p.price, ch: p.ch, up: p.up, color: p.color,
      pct:      pctOf(p.curVal).toFixed(1) + '%',
      source:   p.source,
      exchange: p.exchanges[0] || null,
    }));

    const allPositions = processed.map(p => ({
      sym: p.sym, side: p.side, color: p.color,
      price: p.price, priceRaw: p.priceRaw,
      ch: p.ch, up: p.up,
      pnl: p.pnl, ret: p.ret,
      amount: p.amount,
      avgEntry: p.avgEntry, avgEntryRaw: p.avgEntryRaw,
      source: p.source, inDb: p.inDb, exchanges: p.exchanges,
    }));

    const maxPct    = processed.length ? Math.max(...processed.map(p => pctOf(p.curVal))) : 0;
    const cashRatio = pctOf(Math.max(cash, 0));
    const risks = [
      { label:'Concentration',  value:maxPct.toFixed(1)+'%',   note:'Largest position (% of portfolio)', warn:maxPct > 30 },
      { label:'Unrealised P&L', value:fmtUSD(unrealisedRaw),   note:'vs cost basis',                      warn:unrealisedRaw < 0 },
      { label:'Cash Ratio',     value:allocBase > 0 ? cashRatio.toFixed(1)+'%' : '—', note:'Dry powder available', warn:allocBase > 0 && cashRatio < 5 },
    ];

    const sectorMap = {};
    processed.forEach(p => { sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.curVal; });
    const sectors = Object.entries(sectorMap).map(([name, val]) => ({
      name, pct: grossValue > 0 ? (val / grossValue) * 100 : 0, color: colorFor(name),
    }));

    // ── Benchmark (already running in parallel) ───────────────────────────────
    let benchmarkCurve = [], alpha = null;
    const benchmarkCandles = await benchPromise;
    if (benchmarkCandles) {
      try {
        const built = buildBenchmarkCurve(equityCurve, benchmarkCandles);
        benchmarkCurve = built.curve;
        alpha          = built.alpha;
      } catch (e) {
        logger.warn(`[portfolio] Benchmark curve failed (${benchmarkSymbol}): ${e.message}`);
      }
    }

    res.status(200).json({
      success: true,
      hero, allocations, holdings, allPositions, risks, sectors, equityCurve,
      benchmarkCurve, benchmarkSymbol, alpha,
      connectedExchanges: [...new Set(exchangeBalances.map(b => b.exchange))],
      _meta: {
        pricesFrom:       Object.keys(livePrices),
        stale:            Object.entries(livePrices).filter(([, d]) => d.stale).map(([s]) => s),
        demo:             Object.entries(livePrices).filter(([, d]) => d.demo).map(([s]) => s),
        cacheSize:        PRICE_CACHE.size,
        exchangeBalances: exchangeBalances.length,
        dbPositions:      dbPositions.length,
        fetchedAt:        new Date().toISOString(),
      },
    });

  } catch (err) {
    logger.error(`[portfolio.controller] ${err.message}`);
    res.status(500).json({ success:false, error:'Failed to fetch portfolio data' });
  }
}

// ── POST /api/portfolio/position ─────────────────────────────────────────────
// long  = pay cash (requires sufficient funds). short = proceeds credited to cash.
// averageEntry is optional: when omitted, the live market price is used.
// ⚠️ No margin/collateral modelled for shorts.
async function addPosition(req, res) {
  const { pool } = require('../config/db');
  const userId = req.user.id;
  const { symbol, side = 'long', amount, averageEntry, sector = 'Other' } = req.body || {};

  if (!symbol || !amount)
    return res.status(400).json({ success:false, error:'symbol and amount required' });
  if (!['long', 'short'].includes(side))
    return res.status(400).json({ success:false, error:"side must be 'long' or 'short'" });

  const sym       = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const newAmount = parseFloat(amount);
  if (!sym || !(newAmount > 0))
    return res.status(400).json({ success:false, error:'amount must be a positive number' });

  let newPrice = parseFloat(averageEntry);
  if (!(newPrice > 0)) {
    if (averageEntry !== undefined && averageEntry !== null && averageEntry !== '')
      return res.status(400).json({ success:false, error:'averageEntry must be a positive number' });
    // No entry given → use market price (fetched BEFORE opening the transaction)
    const live = await fetchLivePrices([sym], { [sym]: sector });
    newPrice = live[sym]?.price;
    if (!(newPrice > 0))
      return res.status(400).json({ success:false, error:`No market price found for ${sym} — enter an entry price` });
  }

  const cost = newAmount * newPrice;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO accounts (user_id, cash_balance) VALUES ($1, 10000) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const { rows: accRows } = await client.query(
      `SELECT cash_balance FROM accounts WHERE user_id=$1 FOR UPDATE`,
      [userId]
    );
    const cash = parseFloat(accRows[0].cash_balance);

    if (side === 'long' && cost > cash) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success:false, error:`Insufficient cash: need $${cost.toFixed(2)}, have $${cash.toFixed(2)}` });
    }

    const { rows: existingRows } = await client.query(
      `SELECT amount, average_entry FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3 FOR UPDATE`,
      [userId, sym, side]
    );

    let finalAmount, finalAvgEntry;
    if (existingRows.length) {
      const exAmount = parseFloat(existingRows[0].amount);
      const exAvg    = parseFloat(existingRows[0].average_entry) || 0;
      finalAmount   = exAmount + newAmount;
      finalAvgEntry = (exAmount * exAvg + newAmount * newPrice) / finalAmount;
    } else {
      finalAmount   = newAmount;
      finalAvgEntry = newPrice;
    }

    const { rows } = await client.query(
      `INSERT INTO portfolio (user_id,symbol,side,amount,average_entry,current_price,sector)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id,symbol,side) DO UPDATE
         SET amount=$4, average_entry=$5, sector=$7, updated_at=NOW()
       RETURNING *`,
      [userId, sym, side, finalAmount, finalAvgEntry, newPrice, sector]
    );

    const cashDelta = side === 'long' ? -cost : cost;
    await client.query(
      `UPDATE accounts SET cash_balance = cash_balance + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, cashDelta]
    );

    await client.query('COMMIT');
    res.status(201).json({ success:true, position:rows[0], cashDelta, entryUsed:newPrice });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[portfolio.addPosition] ${err.message}`);
    sendServerError(res, err);
  } finally {
    client.release();
  }
}

// ── Shared close / partial close ─────────────────────────────────────────────
async function resolveExitPrice(symbol, pos, override) {
  if (override > 0) return override;
  try {
    const live = await fetchLivePrices([symbol], { [symbol]: pos.sector });
    if (live[symbol]?.price > 0) return live[symbol].price;
  } catch { /* fall through to stored price */ }
  return parseFloat(pos.current_price) || 0;
}

/**
 * requestedQty === null → close everything.
 * Price is resolved BEFORE the transaction so no network call holds a row lock.
 */
async function executeClose(req, res, requestedQty) {
  const { pool } = require('../config/db');
  const userId = req.user.id;
  const symbol = String(req.params.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const side   = req.params.side || 'long';

  if (!['long', 'short'].includes(side))
    return res.status(400).json({ success:false, error:"side must be 'long' or 'short'" });

  const exitOverride = parseFloat(req.body?.exitPrice);

  const { rows: pre } = await db.query(
    `SELECT * FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3`,
    [userId, symbol, side]
  );
  if (!pre.length)
    return res.status(404).json({ success:false, error:'Position not found in your portfolio (exchange balances are read-only — close them on the exchange)' });

  const exitPrice = await resolveExitPrice(symbol, pre[0], exitOverride);
  if (!(exitPrice > 0))
    return res.status(502).json({ success:false, error:'No market price available — enter an exit price' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3 FOR UPDATE`,
      [userId, symbol, side]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success:false, error:'Position not found' });
    }
    const pos  = rows[0];
    const held = parseFloat(pos.amount);

    let qty = requestedQty == null ? held : requestedQty;
    if (!(qty > 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success:false, error:'Quantity must be a positive number' });
    }
    if (qty > held * (1 + 1e-9)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success:false, error:`Quantity exceeds position size (${held})` });
    }
    const isFull = qty >= held * (1 - 1e-9);
    if (isFull) qty = held;

    const entry  = parseFloat(pos.average_entry) || 0;
    const sgn    = side === 'short' ? -1 : 1;
    const pnl    = entry > 0 ? sgn * (exitPrice - entry) * qty : 0;
    const pnlPct = entry > 0 ? (pnl / (entry * qty)) * 100 : 0;

    await client.query(
      `INSERT INTO trades
         (user_id, symbol, side, entry_price, exit_price, quantity, pnl, pnl_pct, status, paper, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',TRUE,$9,NOW())`,
      [userId, symbol, side, entry, exitPrice, qty, pnl.toFixed(8), pnlPct.toFixed(4), pos.opened_at]
    );

    if (isFull) {
      await client.query(`DELETE FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3`, [userId, symbol, side]);
    } else {
      await client.query(
        `UPDATE portfolio SET amount = amount - $4, updated_at = NOW()
         WHERE user_id=$1 AND symbol=$2 AND side=$3`,
        [userId, symbol, side, qty]
      );
    }

    await client.query(
      `INSERT INTO accounts (user_id, cash_balance) VALUES ($1, 10000) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    // long: sell → receive cash. short: buy back → pay cash.
    const cashDelta = side === 'short' ? -(exitPrice * qty) : exitPrice * qty;
    await client.query(
      `UPDATE accounts SET cash_balance = cash_balance + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, cashDelta]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      closed:  isFull,
      remaining: isFull ? 0 : held - qty,
      realized: { symbol, side, quantity: qty, exitPrice, pnl: fmtUSD(pnl), pnlPct: fmtPct(pnlPct) },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[portfolio.executeClose] ${err.message}`);
    sendServerError(res, err);
  } finally {
    client.release();
  }
}

// ── DELETE /api/portfolio/position/:symbol/:side ─────────────────────────────
function removePosition(req, res) {
  return executeClose(req, res, null);
}

// ── POST /api/portfolio/position/:symbol/:side/reduce  { amount, exitPrice? } ─
function reducePosition(req, res) {
  const qty = parseFloat(req.body?.amount);
  if (!(qty > 0))
    return res.status(400).json({ success:false, error:'amount must be a positive number' });
  return executeClose(req, res, qty);
}

// ── GET /api/portfolio/history ───────────────────────────────────────────────
async function getTradeHistory(req, res) {
  try {
    const userId = req.user.id;
    const status = req.query.status || 'closed';
    const limit  = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const [{ rows }, { rows: [agg] }] = await Promise.all([
      db.query(
        `SELECT id, symbol, side, entry_price, exit_price, quantity, pnl, pnl_pct, opened_at, closed_at
         FROM trades
         WHERE user_id=$1 AND status=$2 AND side IN ('long','short')
         ORDER BY closed_at DESC LIMIT $3 OFFSET $4`,
        [userId, status, limit, offset]
      ),
      // Summary over ALL closed trades (not just the page) → matches hero "Realised P&L"
      db.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(pnl), 0) AS total,
                COUNT(*) FILTER (WHERE pnl > 0)::int AS wins
         FROM trades
         WHERE user_id=$1 AND status=$2 AND side IN ('long','short')`,
        [userId, status]
      ),
    ]);

    const trades = rows.map(t => {
      const pnlRaw = parseFloat(t.pnl) || 0;
      return {
        id:        t.id,
        symbol:    t.symbol,
        side:      t.side,
        entry:     parseFloat(t.entry_price),
        exit:      parseFloat(t.exit_price),
        quantity:  parseFloat(t.quantity),
        pnl:       fmtUSD(pnlRaw),
        pnlRaw,
        pnlPct:    fmtPct(parseFloat(t.pnl_pct) || 0),
        openedAt:  t.opened_at,
        closedAt:  t.closed_at,
        holdDays:  t.opened_at && t.closed_at
          ? Math.max(0, Math.round((new Date(t.closed_at) - new Date(t.opened_at)) / 86400000))
          : null,
      };
    });

    const totalRealizedRaw = parseFloat(agg.total) || 0;
    const winRate = agg.count > 0 ? (agg.wins / agg.count) * 100 : 0;

    res.json({
      success: true,
      trades,
      hasMore: offset + trades.length < agg.count,
      summary: {
        totalRealized: fmtUSD(totalRealizedRaw),
        totalRealizedRaw,
        count:   agg.count,
        winRate: parseFloat(winRate.toFixed(1)),
      },
    });
  } catch (err) {
    logger.error(`[portfolio.getTradeHistory] ${err.message}`);
    sendServerError(res, err);
  }
}

// ── PATCH /api/portfolio/cash ────────────────────────────────────────────────
async function updateCash(req, res) {
  try {
    const cashBalance = parseFloat(req.body?.cashBalance);
    if (!Number.isFinite(cashBalance))
      return res.status(400).json({ success:false, error:'cashBalance required' });
    await db.query(
      `INSERT INTO accounts (user_id,cash_balance) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET cash_balance=$2, updated_at=NOW()`,
      [req.user.id, cashBalance]
    );
    res.status(200).json({ success:true, cashBalance });
  } catch (err) {
    sendServerError(res, err);
  }
}

module.exports = {
  getPortfolioData, addPosition, removePosition, reducePosition, updateCash, getTradeHistory,
  // shared with portfolioAnalyzer.controller so the AI sees the SAME numbers as the UI
  fetchLivePrices, fetchExchangeBalances, mergePositions,
};