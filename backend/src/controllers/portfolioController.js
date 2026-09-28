/**
 * portfolioController.js — AtlasQuant AI v2
 * Merges DB positions + live exchange balances from connected exchanges
 * Price cache: 5min TTL to avoid Yahoo Finance 429s
 */
const db           = require('../config/db');
const axios        = require('axios');
const logger       = require('../utils/logger');
const exchangesSvc = require('../services/exchanges.service');
const { getBenchmarkHistory } = require('../services/marketData.service');
const { toDateKey, buildBenchmarkCurve } = require('../services/benchmarkComparison.service');

const COLORS = ['#00f5d4','#a78bfa','#f59e0b','#f43f5e','#38bdf8','#34d399','#fb923c','#e879f9'];

// ── Price cache (in-memory, per process) ─────────────────────────────────────
const PRICE_CACHE = new Map(); // symbol → { price, changeRaw, cachedAt }
const PRICE_TTL   = 5 * 60 * 1000; // 5 minutes

const STOCK_SYMBOLS = new Set([
  'AAPL','MSFT','GOOGL','GOOG','AMZN','TSLA','NVDA','META','AMD','PLTR',
  'SPY','QQQ','DIA','IWM','NFLX','BABA','TSM','ORCL','INTC','QCOM',
  'JPM','GS','MS','BAC','WFC','V','MA','PYPL','SQ','COIN',
  'XOM','CVX','BP','OXY','MCD','KO','PEP','PG','JNJ','UNH',
]);

function fmtUSD(n, decimals = 2) {
  const abs  = Math.abs(n).toFixed(decimals);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${parseFloat(abs).toLocaleString('en-US', { minimumFractionDigits: decimals })}`;
}
function fmtPct(n, decimals = 2) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

// ── Fetch live prices with cache ──────────────────────────────────────────────
async function fetchLivePrices(symbols) {
  const CRYPTO_STABLE = ['USDT','USDC','BUSD','DAI','TUSD','FDUSD','FDUSD'];
  const now = Date.now();

  const priceMap         = {};
  const cryptoToFetch    = [];
  const stocksToFetch    = [];

  for (const s of symbols) {
    const cached = PRICE_CACHE.get(s);
    if (cached && now - cached.cachedAt < PRICE_TTL) {
      priceMap[s] = { price: cached.price, changeRaw: cached.changeRaw };
      continue;
    }
    if (CRYPTO_STABLE.includes(s)) {
      priceMap[s] = { price: 1, changeRaw: 0 };
      PRICE_CACHE.set(s, { price: 1, changeRaw: 0, cachedAt: now });
    } else if (STOCK_SYMBOLS.has(s)) {
      stocksToFetch.push(s);
    } else {
      cryptoToFetch.push(s);
    }
  }

  if (cryptoToFetch.length > 0) {
    const results = await Promise.allSettled(
      cryptoToFetch.map(sym =>
        axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`, { timeout: 5000 })
          .then(r => ({ sym, price: parseFloat(r.data.lastPrice), changeRaw: parseFloat(r.data.priceChangePercent) }))
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.price > 0) {
        const { sym, price, changeRaw } = r.value;
        priceMap[sym] = { price, changeRaw };
        PRICE_CACHE.set(sym, { price, changeRaw, cachedAt: now });
      }
    }
  }

  if (stocksToFetch.length > 0) {
    try {
      const { data } = await axios.get(
        `http://localhost:${process.env.PORT || 5000}/api/prices/stocks?symbols=${stocksToFetch.join(',')}`,
        { timeout: 12000 }
      );
      if (data?.success && Array.isArray(data.data)) {
        data.data.forEach(q => {
          if (q?.symbol) {
            priceMap[q.symbol] = { price: q.price, changeRaw: q.change };
            PRICE_CACHE.set(q.symbol, { price: q.price, changeRaw: q.change, cachedAt: now });
          }
        });
      }
    } catch (e) {
      logger.warn(`[portfolio] Stock prices fetch failed: ${e.message}`);
      for (const s of stocksToFetch) {
        const stale = PRICE_CACHE.get(s);
        if (stale) {
          priceMap[s] = { price: stale.price, changeRaw: stale.changeRaw };
          logger.warn(`[portfolio] Using stale cache for ${s} (age: ${Math.round((now - stale.cachedAt) / 1000)}s)`);
        }
      }
    }
  }

  return priceMap;
}

// ── Fetch live balances from all connected exchanges ──────────────────────────
async function fetchExchangeBalances(userId) {
  try {
    const { rows } = await db.query(
      `SELECT exchange_id, mode FROM user_exchange_connections WHERE user_id = $1`,
      [userId]
    );
    if (!rows.length) return [];

    const allBalances = [];

    await Promise.allSettled(
      rows.map(async (conn) => {
        try {
          if (conn.mode === 'paper') return;

          const creds = await exchangesSvc.getDecryptedCredentials(userId, conn.exchange_id);
          if (!creds) return;

          const balances = await exchangesSvc.fetchPortfolio(conn.exchange_id, creds);

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

          await db.query(
            `UPDATE user_exchange_connections SET last_sync_at = NOW()
             WHERE user_id = $1 AND exchange_id = $2`,
            [userId, conn.exchange_id]
          );
        } catch (err) {
          logger.warn(`[portfolio] Failed to fetch ${conn.exchange_id} balances: ${err.message}`);
        }
      })
    );

    return allBalances;
  } catch (err) {
    logger.warn(`[portfolio] fetchExchangeBalances error: ${err.message}`);
    return [];
  }
}

// ── Merge DB positions + exchange balances ────────────────────────────────────
function mergePositions(dbPositions, exchangeBalances) {
  const STABLES = ['USDT','USDC','BUSD','DAI','TUSD','FDUSD'];
  const merged  = {};
  const keyOf   = (symbol, side) => `${symbol}::${side}`;

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
      exchanges:     [],
    };
  }

  for (const b of exchangeBalances) {
    if (STABLES.includes(b.symbol)) continue;
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
        exchanges:     [b.exchange],
      };
    }
  }

  const stableCash = exchangeBalances
    .filter(b => STABLES.includes(b.symbol))
    .reduce((sum, b) => sum + b.amount, 0);

  return { positions: Object.values(merged), stableCash };
}

// ── GET /api/portfolio/data ───────────────────────────────────────────────────
async function getPortfolioData(req, res) {
  try {
    const userId = req.user.id;

    const { rows: dbPositions } = await db.query(
      `SELECT symbol, side, amount, average_entry, current_price, sector
       FROM portfolio WHERE user_id = $1
       ORDER BY (amount * current_price) DESC`,
      [userId]
    );

    const exchangeBalances = await fetchExchangeBalances(userId);
    const { positions, stableCash } = mergePositions(dbPositions, exchangeBalances);

    const symbols    = [...new Set(positions.map(p => p.symbol))];
    const livePrices = symbols.length > 0 ? await fetchLivePrices(symbols) : {};

    if (Object.keys(livePrices).length > 0) {
      Promise.all(
        Object.entries(livePrices).map(([sym, d]) =>
          db.query(
            `UPDATE portfolio SET current_price=$1, updated_at=NOW()
             WHERE user_id=$2 AND symbol=$3`,
            [d.price, userId, sym]
          ).catch(() => {})
        )
      );
    }

    const { rows: accountRows } = await db.query(
      `SELECT cash_balance FROM accounts WHERE user_id=$1 LIMIT 1`,
      [userId]
    );
    const dbCash = accountRows.length ? parseFloat(accountRows[0].cash_balance) : 0;
    const cash   = dbCash + stableCash;

    const { rows: realizedRows } = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) AS total
       FROM trades WHERE user_id=$1 AND status='closed' AND side IN ('long','short')`,
      [userId]
    );
    const realizedPnLRaw = parseFloat(realizedRows[0]?.total) || 0;

    const { rows: curveRows } = await db.query(
      `SELECT snapshot_date, total_value,
              TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS date_key
       FROM portfolio_snapshots
       WHERE user_id=$1 ORDER BY snapshot_date DESC LIMIT 30`,
      [userId]
    );
    const equityCurve = curveRows.reverse().map(r => ({
      t:    new Date(r.snapshot_date).toLocaleDateString('en-US', { month:'short', day:'numeric' }),
      v:    parseFloat(r.total_value),
      date: r.date_key,
    }));

    const benchmarkSymbol = (req.query.benchmark || 'BTC').toUpperCase();
    let benchmarkCurve = [];
    let alpha = null;

    try {
      const benchmarkCandles = await getBenchmarkHistory(benchmarkSymbol, equityCurve.length + 5);
      const built = buildBenchmarkCurve(equityCurve, benchmarkCandles);
      benchmarkCurve = built.curve;
      alpha          = built.alpha;
    } catch (e) {
      logger.warn(`[portfolio] Benchmark fetch failed (${benchmarkSymbol}): ${e.message}`);
    }

    let totalCost = 0, totalValue = cash, todayPnLRaw = 0;

    const processedPositions = positions.map((p, i) => {
      const avgEntry  = parseFloat(p.average_entry) || 0;
      const amount    = parseFloat(p.amount);
      const liveData  = livePrices[p.symbol];
      const curPrice  = liveData?.price ?? parseFloat(p.current_price) ?? 0;
      const dayChgPct = liveData?.changeRaw ?? 0;

      const curVal    = curPrice * amount;
      const costBasis = avgEntry * amount;
      const pnlRaw    = avgEntry > 0
        ? (p.side === 'short'
          ? (avgEntry - curPrice) * amount
          : (curPrice - avgEntry) * amount)
        : 0;
      const retPct = costBasis > 0 ? (pnlRaw / costBasis) * 100 : 0;

      totalCost   += costBasis;
      totalValue  += curVal;
      todayPnLRaw += curVal * (dayChgPct / 100);

      return {
        sym:       p.symbol,
        side:      p.side || 'long',
        amount,
        avgEntry:  avgEntry > 0 ? `$${avgEntry.toFixed(avgEntry >= 1000 ? 2 : 4)}` : 'N/A',
        price:     curPrice >= 1000
          ? `$${curPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
          : `$${curPrice.toFixed(curPrice < 0.01 ? 6 : 2)}`,
        curVal,
        pnl:       avgEntry > 0 ? fmtUSD(pnlRaw) : 'N/A',
        pnlRaw,
        ret:       avgEntry > 0 ? fmtPct(retPct) : 'N/A',
        ch:        fmtPct(dayChgPct),
        up:        dayChgPct >= 0,
        color:     COLORS[i % COLORS.length],
        sector:    p.sector || 'Crypto',
        source:    p.source || 'manual',
        exchanges: p.exchanges || [],
      };
    });

    const investedValue = totalValue - cash;
    const totalPnLRaw   = totalValue - cash - totalCost;
    const totalRetPct   = totalCost > 0 ? (totalPnLRaw / totalCost) * 100 : 0;
    const dayRetPct     = (totalValue - todayPnLRaw) > 0
      ? (todayPnLRaw / (totalValue - todayPnLRaw)) * 100 : 0;

    const hero = {
      totalValue,
      todayPnL:      fmtUSD(todayPnLRaw),
      dayReturn:     fmtPct(dayRetPct),
      totalPnL:      fmtUSD(totalPnLRaw),
      totalReturn:   fmtPct(totalRetPct),
      realizedPnL:   fmtUSD(realizedPnLRaw),
      lifetimePnL:   fmtUSD(totalPnLRaw + realizedPnLRaw),
      openPositions: positions.length,
      availableCash: fmtUSD(cash),
      exchangeCount: [...new Set(exchangeBalances.map(b => b.exchange))].length,
    };

    const allocations = processedPositions.map(p => ({
      name:  p.sym,
      pct:   totalValue > 0 ? (p.curVal / totalValue) * 100 : 0,
      color: p.color,
    }));
    if (cash > 0 && totalValue > 0) {
      allocations.push({ name:'Cash', pct:(cash / totalValue) * 100, color:'#64748b' });
    }

    const holdings = [...processedPositions]
      .sort((a, b) => b.curVal - a.curVal)
      .slice(0, 5)
      .map(p => ({
        sym:      p.sym,
        price:    p.price,
        ch:       p.ch,
        up:       p.up,
        pct:      investedValue > 0 ? ((p.curVal / investedValue) * 100).toFixed(1) + '%' : '0%',
        source:   p.source,
        exchange: p.exchanges[0] || null,
      }));

    const allPositions = processedPositions.map(p => ({
      sym:       p.sym,
      side:      p.side,
      price:     p.price,
      ch:        p.ch,
      up:        p.up,
      pnl:       p.pnl,
      ret:       p.ret,
      amount:    p.amount,
      avgEntry:  p.avgEntry,
      source:    p.source,
      exchanges: p.exchanges,
    }));

    const positionAllocations = allocations.filter(a => a.name !== 'Cash');
    const maxPct = positionAllocations.length > 0
      ? Math.max(...positionAllocations.map(a => a.pct))
      : 0;
    const risks = [
      { label:'Concentration',  value:maxPct.toFixed(1)+'%',  note:'Largest single position', warn:maxPct > 30 },
      { label:'Unrealised P&L', value:fmtUSD(totalPnLRaw),    note:'vs cost basis',           warn:totalPnLRaw < 0 },
      { label:'Cash Ratio',     value:totalValue > 0 ? ((cash/totalValue)*100).toFixed(1)+'%' : '—', note:'Dry powder available', warn:totalValue > 0 && cash/totalValue < 0.05 },
    ];

    const sectorMap = {};
    processedPositions.forEach(p => { sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.curVal; });
    const sectors = Object.entries(sectorMap).map(([name, val], i) => ({
      name, pct: investedValue > 0 ? (val / investedValue) * 100 : 0, color: COLORS[i % COLORS.length],
    }));

    const connectedExchanges = [...new Set(exchangeBalances.map(b => b.exchange))];

    res.status(200).json({
      success: true,
      hero, allocations, holdings, allPositions, risks, sectors, equityCurve,
      benchmarkCurve, benchmarkSymbol, alpha,
      connectedExchanges,
      _meta: {
        pricesFrom:       Object.keys(livePrices),
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

// ── POST /api/portfolio/position ──────────────────────────────────────────────
// ✅ Fix — cash_balance now actually moves on buy/sell instead of drifting
// independently. long = pay cash to open (deduct cost, require sufficient
// funds). short = receive proceeds from the short sale (credit cost).
// ⚠️ Simplification: no margin/collateral requirement modeled for shorts —
// the "proceeds" just get added to spendable cash. Flag if you want real
// margin accounting later.
async function addPosition(req, res) {
  const { pool } = require('../config/db');
  const userId = req.user.id;
  const { symbol, side='long', amount, averageEntry, sector='Other' } = req.body;
  if (!symbol || !amount || !averageEntry)
    return res.status(400).json({ success:false, error:'symbol, amount, averageEntry required' });

  const sym       = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const newAmount = parseFloat(amount);
  const newPrice  = parseFloat(averageEntry);
  if (!(newAmount > 0) || !(newPrice > 0))
    return res.status(400).json({ success:false, error:'amount and averageEntry must be positive numbers' });

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
      finalAvgEntry = finalAmount > 0
        ? (exAmount * exAvg + newAmount * newPrice) / finalAmount
        : newPrice;
    } else {
      finalAmount   = newAmount;
      finalAvgEntry = newPrice;
    }

    const { rows } = await client.query(
      `INSERT INTO portfolio (user_id,symbol,side,amount,average_entry,current_price,sector)
       VALUES ($1,$2,$3,$4,$5,$5,$6)
       ON CONFLICT (user_id,symbol,side) DO UPDATE
         SET amount=$4, average_entry=$5, sector=$6, updated_at=NOW()
       RETURNING *`,
      [userId, sym, side, finalAmount, finalAvgEntry, sector]
    );

    const cashDelta = side === 'long' ? -cost : cost;
    await client.query(
      `UPDATE accounts SET cash_balance = cash_balance + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, cashDelta]
    );

    await client.query('COMMIT');
    res.status(201).json({ success:true, position:rows[0], cashDelta });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[portfolio.addPosition] ${err.message}`);
    res.status(500).json({ success:false, error:err.message });
  } finally {
    client.release();
  }
}

// ── DELETE /api/portfolio/position/:symbol/:side ──────────────────────────────
// ✅ Fix — cash_balance now moves on close, mirroring addPosition.
async function removePosition(req, res) {
  const { pool } = require('../config/db');
  const userId = req.user.id;
  const symbol = req.params.symbol.toUpperCase();
  const side   = req.params.side || 'long';

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
    const pos = rows[0];

    let exitPrice = parseFloat(pos.current_price) || 0;
    try {
      const live = await fetchLivePrices([symbol]);
      if (live[symbol]?.price) exitPrice = live[symbol].price;
    } catch { /* fallback silencieux sur current_price */ }

    const amount = parseFloat(pos.amount);
    const entry  = parseFloat(pos.average_entry) || 0;
    const pnl    = entry > 0
      ? (side === 'short' ? (entry - exitPrice) : (exitPrice - entry)) * amount
      : 0;
    const pnlPct = entry > 0 ? (pnl / (entry * amount)) * 100 : 0;

    await client.query(
      `INSERT INTO trades
         (user_id, symbol, side, entry_price, exit_price, quantity, pnl, pnl_pct, status, paper, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',TRUE,$9,NOW())`,
      [userId, symbol, side, entry, exitPrice, amount, pnl.toFixed(8), pnlPct.toFixed(4), pos.opened_at]
    );

    await client.query(
      `DELETE FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3`,
      [userId, symbol, side]
    );

    await client.query(
      `INSERT INTO accounts (user_id, cash_balance) VALUES ($1, 10000) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const proceeds = side === 'short' ? -(exitPrice * amount) : (exitPrice * amount);
    await client.query(
      `UPDATE accounts SET cash_balance = cash_balance + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, proceeds]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      realized: { symbol, side, exitPrice, pnl: fmtUSD(pnl), pnlPct: fmtPct(pnlPct) },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[portfolio.removePosition] ${err.message}`);
    res.status(500).json({ success:false, error:err.message });
  } finally {
    client.release();
  }
}

// ── GET /api/portfolio/history ─────────────────────────────────────────────────
async function getTradeHistory(req, res) {
  try {
    const userId = req.user.id;
    const status = req.query.status || 'closed';
    const limit  = parseInt(req.query.limit) || 50;

    const { rows } = await db.query(
      `SELECT id, symbol, side, entry_price, exit_price, quantity, pnl, pnl_pct, opened_at, closed_at
       FROM trades
       WHERE user_id=$1 AND status=$2 AND side IN ('long','short')
       ORDER BY closed_at DESC LIMIT $3`,
      [userId, status, limit]
    );

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

    const totalRealizedRaw = trades.reduce((sum, t) => sum + t.pnlRaw, 0);
    const wins    = trades.filter(t => t.pnlRaw > 0).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

    res.json({
      success: true,
      trades,
      summary: {
        totalRealized: fmtUSD(totalRealizedRaw),
        totalRealizedRaw,
        count:   trades.length,
        winRate: parseFloat(winRate.toFixed(1)),
      },
    });
  } catch (err) {
    logger.error(`[portfolio.getTradeHistory] ${err.message}`);
    res.status(500).json({ success:false, error:err.message });
  }
}

// ── PATCH /api/portfolio/cash ─────────────────────────────────────────────────
async function updateCash(req, res) {
  try {
    const { cashBalance } = req.body;
    if (cashBalance === undefined || isNaN(cashBalance))
      return res.status(400).json({ success:false, error:'cashBalance required' });
    await db.query(
      `INSERT INTO accounts (user_id,cash_balance) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET cash_balance=$2, updated_at=NOW()`,
      [req.user.id, cashBalance]
    );
    res.status(200).json({ success:true, cashBalance });
  } catch (err) {
    res.status(500).json({ success:false, error:err.message });
  }
}

module.exports = { getPortfolioData, addPosition, removePosition, updateCash, getTradeHistory };