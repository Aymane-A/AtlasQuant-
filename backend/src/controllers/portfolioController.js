/**
 * portfolioController.js — AtlasQuant AI v2
 * Merges DB positions + live exchange balances from connected exchanges
 * Price cache: 5min TTL to avoid Yahoo Finance 429s
 */
const db           = require('../config/db');
const axios        = require('axios');
const logger       = require('../utils/logger');
const exchangesSvc = require('../services/exchanges.service');

const COLORS = ['#00f5d4','#a78bfa','#f59e0b','#f43f5e','#38bdf8','#34d399','#fb923c','#e879f9'];

// ── Price cache (in-memory, per process) ─────────────────────────────────────
const PRICE_CACHE = new Map(); // symbol → { price, changeRaw, cachedAt }
const PRICE_TTL   = 5 * 60 * 1000; // 5 minutes

// Known stock tickers — everything else treated as crypto
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

  // ── 1. Serve from cache where possible ──
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

  // ── 2. Crypto via Binance public API ──
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

  // ── 3. Stocks via internal prices route ──
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
      // Fallback: use stale cache rather than failing completely
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

  for (const p of dbPositions) {
    merged[p.symbol] = {
      symbol:        p.symbol,
      side:          p.side || 'long',
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

    if (merged[b.symbol]) {
      merged[b.symbol].amount = b.amount;
      merged[b.symbol].source = 'exchange';
      merged[b.symbol].exchanges.push(b.exchange);
    } else {
      merged[b.symbol] = {
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

    // 1. DB positions
    const { rows: dbPositions } = await db.query(
      `SELECT symbol, side, amount, average_entry, current_price, sector
       FROM portfolio WHERE user_id = $1
       ORDER BY (amount * current_price) DESC`,
      [userId]
    );

    // 2. Live exchange balances
    const exchangeBalances = await fetchExchangeBalances(userId);

    // 3. Merge
    const { positions, stableCash } = mergePositions(dbPositions, exchangeBalances);

    // 4. Live prices (with cache — no more 429s)
    const symbols    = [...new Set(positions.map(p => p.symbol))];
    const livePrices = symbols.length > 0 ? await fetchLivePrices(symbols) : {};

    // 5. Update DB current_price (fire & forget)
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

    // 6. Cash
    const { rows: accountRows } = await db.query(
      `SELECT cash_balance FROM accounts WHERE user_id=$1 LIMIT 1`,
      [userId]
    );
    const dbCash = accountRows.length ? parseFloat(accountRows[0].cash_balance) : 0;
    const cash   = dbCash + stableCash;

    // 7. Equity curve
    const { rows: curveRows } = await db.query(
      `SELECT snapshot_date, total_value FROM portfolio_snapshots
       WHERE user_id=$1 ORDER BY snapshot_date DESC LIMIT 30`,
      [userId]
    );
    const equityCurve = curveRows.reverse().map(r => ({
      t: new Date(r.snapshot_date).toLocaleDateString('en-US', { month:'short', day:'numeric' }),
      v: parseFloat(r.total_value),
    }));

    // 8. Process positions
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

    // 9. Summary stats
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
      openPositions: positions.length,
      availableCash: fmtUSD(cash),
      exchangeCount: [...new Set(exchangeBalances.map(b => b.exchange))].length,
    };

    // 10. Allocations
    const allocations = processedPositions.map(p => ({
      name:  p.sym,
      pct:   investedValue > 0 ? (p.curVal / investedValue) * 100 : 0,
      color: p.color,
    }));
    if (cash > 0 && totalValue > 0) {
      allocations.push({ name:'Cash', pct:(cash / totalValue) * 100, color:'#64748b' });
    }

    // 11. Holdings strip (top 5 by value)
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

    // 12. All positions for table
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

    // 13. Risk badges
    const maxPct = allocations.length > 0 ? Math.max(...allocations.map(a => a.pct)) : 0;
    const risks = [
      { label:'Concentration',  value:maxPct.toFixed(1)+'%',  note:'Largest single position', warn:maxPct > 30 },
      { label:'Unrealised P&L', value:fmtUSD(totalPnLRaw),    note:'vs cost basis',           warn:totalPnLRaw < 0 },
      { label:'Cash Ratio',     value:totalValue > 0 ? ((cash/totalValue)*100).toFixed(1)+'%' : '—', note:'Dry powder available', warn:totalValue > 0 && cash/totalValue < 0.05 },
    ];

    // 14. Sectors
    const sectorMap = {};
    processedPositions.forEach(p => { sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.curVal; });
    const sectors = Object.entries(sectorMap).map(([name, val], i) => ({
      name, pct: investedValue > 0 ? (val / investedValue) * 100 : 0, color: COLORS[i % COLORS.length],
    }));

    // 15. Connected exchanges
    const connectedExchanges = [...new Set(exchangeBalances.map(b => b.exchange))];

    res.status(200).json({
      success: true,
      hero, allocations, holdings, allPositions, risks, sectors, equityCurve,
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
async function addPosition(req, res) {
  try {
    const userId = req.user.id;
    const { symbol, side='long', amount, averageEntry, sector='Other' } = req.body;
    if (!symbol || !amount || !averageEntry)
      return res.status(400).json({ success:false, error:'symbol, amount, averageEntry required' });
    const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { rows } = await db.query(
      `INSERT INTO portfolio (user_id,symbol,side,amount,average_entry,current_price,sector)
       VALUES ($1,$2,$3,$4,$5,$5,$6)
       ON CONFLICT (user_id,symbol,side) DO UPDATE
         SET amount=EXCLUDED.amount, average_entry=EXCLUDED.average_entry,
             sector=EXCLUDED.sector, updated_at=NOW()
       RETURNING *`,
      [userId, sym, side, amount, averageEntry, sector]
    );
    res.status(201).json({ success:true, position:rows[0] });
  } catch (err) {
    logger.error(`[portfolio.addPosition] ${err.message}`);
    res.status(500).json({ success:false, error:err.message });
  }
}

// ── DELETE /api/portfolio/position/:symbol/:side ──────────────────────────────
async function removePosition(req, res) {
  try {
    await db.query(
      `DELETE FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3`,
      [req.user.id, req.params.symbol.toUpperCase(), req.params.side || 'long']
    );
    res.status(200).json({ success:true });
  } catch (err) {
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

module.exports = { getPortfolioData, addPosition, removePosition, updateCash };