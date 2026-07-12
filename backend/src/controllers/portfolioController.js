/**
 * portfolioController.js — AtlasQuant AI v2
 * Merges DB positions + live exchange balances from connected exchanges
 * Price cache: 5min TTL to avoid Yahoo Finance 429s
 */
const db           = require('../config/db');
const axios        = require('axios');
const logger       = require('../utils/logger');
const exchangesSvc = require('../services/exchanges.service');
const { getBenchmarkHistory } = require('../services/marketData.service'); // ✅ new — Benchmark Comparison

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
// ✅ Feature: compare la performance du portefeuille à un benchmark (BTC, SPY,
// forex, commodités — tout ce que getBenchmarkHistory supporte).
//
// Aligné par DATE (pas par index) : Yahoo ne renvoie aucune candle le week-end
// pour SPY/forex/commodités (marché fermé), alors que portfolio_snapshots peut
// en avoir un tous les jours. On fait un lookup par date (YYYY-MM-DD) avec
// forward-fill du dernier close connu pour les jours de marché fermé.
//
// toDateKey utilise les getters UTC plutôt que toISOString() sur un Date déjà
// construit — évite tout décalage d'un jour si le serveur tourne dans un
// timezone non-UTC (ex: Maroc, UTC+1) quand Postgres renvoie une colonne DATE.
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

    // 6.5. Realized P&L (lifetime) — somme des trades fermés via removePosition
    // (voir plus bas). Isolé du système de paper trading partagé
    // (side IN ('long','short')), même filtre que getTradeHistory.
    const { rows: realizedRows } = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) AS total
       FROM trades WHERE user_id=$1 AND status='closed' AND side IN ('long','short')`,
      [userId]
    );
    const realizedPnLRaw = parseFloat(realizedRows[0]?.total) || 0;

    // 7. Equity curve
    // ✅ Fix: node-postgres parse les colonnes DATE via le timezone LOCAL du
    // serveur — un simple new Date(r.snapshot_date).toISOString() décale la
    // date d'un jour dès que le serveur n'est pas en UTC+0. On récupère la
    // date exacte via TO_CHAR directement en SQL pour le matching benchmark.
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
      date: r.date_key, // ✅ exact SQL string — used for benchmark date alignment
    }));

    // 7.5. Benchmark comparison (Portfolio vs BTC/SPY/...)
    // ✅ Feature: try/catch isole un ?benchmark=XYZ invalide (getBenchmarkHistory
    // throw sur symbole inconnu) du reste de la route — toute la page ne doit
    // pas planter juste parce que la carte benchmark ne peut pas se rendre.
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
      // benchmarkCurve reste [] — le frontend retombe sur l'equity curve $ normale
    }

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
      // realizedPnL = trades fermés (lifetime), lifetimePnL = les deux
      // combinés. totalPnL ci-dessus reste "unrealized only", inchangé.
      realizedPnL:   fmtUSD(realizedPnLRaw),
      lifetimePnL:   fmtUSD(totalPnLRaw + realizedPnLRaw),
      openPositions: positions.length,
      availableCash: fmtUSD(cash),
      exchangeCount: [...new Set(exchangeBalances.map(b => b.exchange))].length,
    };

    // 10. Allocations
    // ✅ Fix: positions et Cash utilisaient deux denominateurs différents
    // (investedValue pour les positions, totalValue pour Cash), ce qui faisait
    // que la somme des parts du donut ne totalisait jamais 100%. Tout le monde
    // utilise maintenant `totalValue` (positions + cash) comme référence commune.
    const allocations = processedPositions.map(p => ({
      name:  p.sym,
      pct:   totalValue > 0 ? (p.curVal / totalValue) * 100 : 0,
      color: p.color,
    }));
    if (cash > 0 && totalValue > 0) {
      allocations.push({ name:'Cash', pct:(cash / totalValue) * 100, color:'#64748b' });
    }

    // 11. Holdings strip (top 5 by value)
    // Note: "% of portfolio" ici reste volontairement basé sur investedValue
    // (composition des positions entre elles, cash exclu) — différent du donut
    // ci-dessus qui montre la répartition du portefeuille total.
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
    // ✅ Fix: maxPct était calculé sur `allocations`, qui inclut la part "Cash".
    // Une grosse réserve de cash se retrouvait donc comptée comme "la plus
    // grosse position", faisant afficher Concentration = Cash Ratio (même
    // valeur exacte) au lieu de refléter la vraie position la plus concentrée.
    const positionAllocations = allocations.filter(a => a.name !== 'Cash');
    const maxPct = positionAllocations.length > 0
      ? Math.max(...positionAllocations.map(a => a.pct))
      : 0;
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
      benchmarkCurve, benchmarkSymbol, alpha, // ✅ new — Benchmark Comparison
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
// ✅ Feature: avant, cette route supprimait la position sans laisser aucune
// trace — impossible de savoir combien avait été gagné/perdu, ni quand la
// position avait été ouverte/fermée. La table `trades` existe déjà dans le
// schéma DB (voir config/db.js) mais n'était jamais utilisée. On l'utilise
// maintenant pour enregistrer chaque clôture comme un trade réalisé.
async function removePosition(req, res) {
  try {
    const userId = req.user.id;
    const symbol = req.params.symbol.toUpperCase();
    const side   = req.params.side || 'long';

    const { rows } = await db.query(
      `SELECT * FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3`,
      [userId, symbol, side]
    );
    if (!rows.length) {
      return res.status(404).json({ success:false, error:'Position not found' });
    }
    const pos = rows[0];

    // Exit price — essaie le prix live, retombe sur le dernier prix connu en DB
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

    await db.query(
      `INSERT INTO trades
         (user_id, symbol, side, entry_price, exit_price, quantity, pnl, pnl_pct, status, paper, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',TRUE,$9,NOW())`,
      [userId, symbol, side, entry, exitPrice, amount, pnl.toFixed(8), pnlPct.toFixed(4), pos.opened_at]
    );

    await db.query(
      `DELETE FROM portfolio WHERE user_id=$1 AND symbol=$2 AND side=$3`,
      [userId, symbol, side]
    );

    res.status(200).json({
      success: true,
      realized: { symbol, side, exitPrice, pnl: fmtUSD(pnl), pnlPct: fmtPct(pnlPct) },
    });
  } catch (err) {
    logger.error(`[portfolio.removePosition] ${err.message}`);
    res.status(500).json({ success:false, error:err.message });
  }
}

// ── GET /api/portfolio/history ─────────────────────────────────────────────────
// ✅ Feature: historique des trades réalisés (fermés via removePosition
// ci-dessus). Renvoie la liste + un résumé (P&L total réalisé, win rate réel).
//
// ⚠️ La table `trades` est PARTAGÉE avec services/trade.service.js (paper
// trading automatique déclenché par les signaux IA). Ce service utilise
// side='BUY'/'SELL' (convention signal), alors qu'ici on utilise side='long'/
// 'short' (convention position). Le filtre `side IN ('long','short')` isole
// nos données de celles de trade.service.js — sans ce filtre, une fois que
// TradeService.checkAndCloseTrades() sera implémenté (actuellement un stub
// vide), ses trades fermés apparaîtraient mélangés ici avec un side non
// reconnu par le frontend (toujours affiché en rouge, peu importe le résultat).
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