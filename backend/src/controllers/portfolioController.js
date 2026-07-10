/**
 * portfolioController.js — AtlasQuant AI v2
 * Merges DB positions + live exchange balances from connected exchanges
 * All price fetching/caching now lives in services/livePrices.service.js
 */
const db           = require('../config/db');
const logger       = require('../utils/logger');
const exchangesSvc = require('../services/exchanges.service');
const { getBenchmarkHistory } = require('../services/marketData.service');
const { getLivePrices } = require('../services/livePrices.service');

const COLORS = ['#00f5d4','#a78bfa','#f59e0b','#f43f5e','#38bdf8','#34d399','#fb923c','#e879f9'];

function fmtUSD(n, decimals = 2) {
  const abs  = Math.abs(n).toFixed(decimals);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${parseFloat(abs).toLocaleString('en-US', { minimumFractionDigits: decimals })}`;
}
function fmtPct(n, decimals = 2) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
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
// ✅ Fix: la clé de fusion était `symbol` seul. Le schéma DB autorise pourtant
// UNIQUE(user_id, symbol, side) — un utilisateur peut avoir un LONG et un SHORT
// sur le même symbole. Avec l'ancienne clé, la deuxième position DB écrasait
// silencieusement la première (aucune erreur, juste une position qui disparaît
// de l'affichage). La clé inclut maintenant le side. Les balances d'exchange
// (spot, toujours "long" par nature) ne peuvent matcher qu'une position DB
// elle-même "long", pas une position "short" du même symbole.
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
    const key = keyOf(b.symbol, 'long'); // exchange spot balances are always long holdings

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

// ── Benchmark curve builder (date-aligned, forward-filled) ────────────────────
function toDateKey(d) {
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildBenchmarkCurve(equityCurve, benchmarkCandles) {
  if (!benchmarkCandles.length || !equityCurve.length) return { curve: [], alpha: null };

  const byDate = new Map(
    benchmarkCandles.map(c => [toDateKey(c.date), c.close])
  );

  let lastKnownClose = null;
  for (const c of benchmarkCandles) {
    const d = toDateKey(c.date);
    if (d <= equityCurve[0].date) lastKnownClose = c.close;
    else break;
  }

  const firstPortfolio = equityCurve[0].v;
  let firstBenchmark    = null;

  const curve = equityCurve.map(point => {
    if (byDate.has(point.date)) lastKnownClose = byDate.get(point.date);
    if (firstBenchmark === null && lastKnownClose != null) firstBenchmark = lastKnownClose;

    return {
      t:         point.t,
      portfolio: firstPortfolio > 0 ? ((point.v - firstPortfolio) / firstPortfolio) * 100 : 0,
      benchmark: (lastKnownClose != null && firstBenchmark)
        ? ((lastKnownClose - firstBenchmark) / firstBenchmark) * 100
        : null,
    };
  });

  const last  = curve.at(-1);
  const alpha = (last && last.benchmark != null) ? (last.portfolio - last.benchmark) : null;

  return { curve, alpha };
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

    // Live prices — source wa7da: livePrices.service (cache + asset detection + routing)
    const symbols    = [...new Set(positions.map(p => p.symbol))];
    const livePrices = symbols.length > 0
      ? await getLivePrices(symbols)
      : {};

    await Promise.allSettled(
      Object.entries(livePrices)
        .filter(([, d]) => d) // skip symbols that failed to fetch (null)
        .map(([sym, d]) =>
          db.query(
            `UPDATE portfolio
            SET current_price=$1,
                updated_at=NOW()
            WHERE user_id=$2
            AND symbol=$3`,
            [d.price, userId, sym]
          )
        )
    ).catch(err => {
      logger.warn(`[portfolio] price update: ${err.message}`);
    });

    const { rows: accountRows } = await db.query(
      `SELECT cash_balance FROM accounts WHERE user_id=$1 LIMIT 1`,
      [userId]
    );
    const dbCash = accountRows.length ? parseFloat(accountRows[0].cash_balance) : 0;
    const cash   = dbCash + stableCash;

    const { rows: curveRows } = await db.query(
      `SELECT
        snapshot_date,
        total_value,
        TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS date_key
      FROM portfolio_snapshots
      WHERE user_id=$1
      ORDER BY snapshot_date DESC
      LIMIT 30`,
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

    const { rows: realizedRows } = await db.query(
      `SELECT COALESCE(SUM(pnl),0) AS realized_pnl,
              COALESCE(SUM(entry_price*quantity),0) AS realized_cost
       FROM trades WHERE user_id=$1 AND status='closed' AND side IN ('long','short')`,
      [userId]
    );
    const realizedPnLRaw  = parseFloat(realizedRows[0].realized_pnl)  || 0;
    const realizedCostRaw = parseFloat(realizedRows[0].realized_cost) || 0;

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

    const lifetimeTotalRaw = totalPnLRaw + realizedPnLRaw;
    const lifetimeCostRaw  = totalCost + realizedCostRaw;
    const lifetimeRetPct   = lifetimeCostRaw > 0 ? (lifetimeTotalRaw / lifetimeCostRaw) * 100 : 0;

    const hero = {
      totalValue,
      todayPnL:       fmtUSD(todayPnLRaw),
      dayReturn:      fmtPct(dayRetPct),
      totalPnL:       fmtUSD(totalPnLRaw),
      totalReturn:    fmtPct(totalRetPct),
      realizedPnL:    fmtUSD(realizedPnLRaw),
      realizedPnLRaw,
      lifetimeTotal:  fmtUSD(lifetimeTotalRaw),
      lifetimeReturn: fmtPct(lifetimeRetPct),
      openPositions:  positions.length,
      availableCash:  fmtUSD(cash),
      exchangeCount:  [...new Set(exchangeBalances.map(b => b.exchange))].length,
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
      { label:'Unrealized P&L', value:fmtUSD(totalPnLRaw),    note:'vs cost basis',           warn:totalPnLRaw < 0 },
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
  const client = await db.connect();

  try {
    const userId = req.user.id;
    const symbol = req.params.symbol.toUpperCase();
    const side = req.params.side || 'long';

    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT *
       FROM portfolio
       WHERE user_id = $1
         AND symbol = $2
         AND side = $3`,
      [userId, symbol, side]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Position not found',
      });
    }

    const pos = rows[0];

    // Try live price first — via source wa7da (livePrices.service)
    let exitPrice = parseFloat(pos.current_price) || 0;

    try {
      const live = await getLivePrices([symbol]);
      if (live[symbol]?.price) {
        exitPrice = live[symbol].price;
      }
    } catch (_) {
      // Keep DB price
    }

    const amount = parseFloat(pos.amount);
    const entry = parseFloat(pos.average_entry) || 0;

    const pnl =
      entry > 0
        ? side === 'short'
          ? (entry - exitPrice) * amount
          : (exitPrice - entry) * amount
        : 0;

    const pnlPct =
      entry > 0 ? (pnl / (entry * amount)) * 100 : 0;

    await client.query(
      `INSERT INTO trades
      (
        user_id,
        symbol,
        side,
        entry_price,
        exit_price,
        quantity,
        pnl,
        pnl_pct,
        status,
        paper,
        opened_at,
        closed_at
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8,
        'closed',
        TRUE,
        $9,
        NOW()
      )`,
      [
        userId,
        symbol,
        side,
        entry,
        exitPrice,
        amount,
        pnl,
        pnlPct,
        pos.opened_at,
      ]
    );

    await client.query(
      `DELETE FROM portfolio
       WHERE user_id = $1
         AND symbol = $2
         AND side = $3`,
      [userId, symbol, side]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      realized: {
        symbol,
        side,
        exitPrice,
        pnl: fmtUSD(pnl),
        pnlPct: fmtPct(pnlPct),
      },
    });

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[portfolio.removePosition] ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
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