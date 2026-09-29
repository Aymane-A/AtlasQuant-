/**
 * services/dashboardData.service.js — AtlasQuant AI
 * Extracted from dashboard.controller.js so the REST endpoint and the
 * new dashboardSocket.server.js push exactly the same payload shape from
 * one place, instead of two copies of the same SQL that can drift apart.
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const { takePortfolioSnapshot } = require('./portfolioSnapshot.service');
const { getLivePrices } = require('./livePrices.service');
const { getBenchmarkHistory } = require('./marketData.service');
const { buildBenchmarkCurve } = require('./benchmarkComparison.service');

const RANGE_DAYS = { '7': 7, '30': 30, '90': 90, all: 365 };

// ✅ Fix — takePortfolioSnapshot() loops over ALL users, and it used to run
// on every buildDashboardPayload() call (each REST hit, each WS connect, and
// soon each 30s WS tick per connected user). Now: at most once per 5 min
// process-wide, and concurrent callers share the same in-flight promise
// instead of each starting their own.
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastSnapshotAt = 0;
let snapshotInFlight = null;

function ensureSnapshot() {
  if (snapshotInFlight) return snapshotInFlight;
  if (Date.now() - lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) return Promise.resolve();

  snapshotInFlight = takePortfolioSnapshot()
    .then(() => { lastSnapshotAt = Date.now(); })
    // A failed snapshot shouldn't take the whole dashboard down with a 500
    // — the KPIs are computed live and don't depend on it.
    .catch(err => logger.warn(`[dashboard] Snapshot failed: ${err.message}`))
    .finally(() => { snapshotInFlight = null; });
  return snapshotInFlight;
}

/**
 * @param {number} userId
 * @param {object} opts
 * @param {string} [opts.range] '7'|'30'|'90'|'all'
 * @param {string} [opts.benchmarkSymbol]
 * @param {number} [opts.activityLimit]
 * @param {number} [opts.activityOffset]
 * @param {boolean} [opts.includeBenchmark] — skip the external benchmark
 *   fetch entirely when false. Used by the WebSocket broadcaster: hitting
 *   an external API for every connected user on every 30s tick is
 *   expensive and the benchmark rarely needs to be that fresh — the REST
 *   endpoint (range-selector change) still fetches it live.
 * @returns {Promise<object>} same shape the REST endpoint used to return
 *   (minus the `success` wrapper — callers add that).
 */
async function buildDashboardPayload(userId, opts = {}) {
  const range     = RANGE_DAYS[opts.range] ? opts.range : '30';
  const rangeDays = RANGE_DAYS[range];
  const benchmarkSymbol   = (opts.benchmarkSymbol || 'BTC').toUpperCase();
  const includeBenchmark  = opts.includeBenchmark !== false && benchmarkSymbol !== 'NONE';
  const activityLimit  = Math.min(parseInt(opts.activityLimit, 10)  || 5, 50);
  const activityOffset = Math.max(parseInt(opts.activityOffset, 10) || 0, 0);

    await ensureSnapshot();;

  // ── 1. Trade stats ────────────────────────────────────
  const { rows: [s] } = await db.query(`
    SELECT
      COALESCE(SUM(pnl) FILTER (WHERE status='closed'), 0)                                        AS total_pnl,
      COALESCE(SUM(pnl) FILTER (WHERE status='closed' AND closed_at >= NOW()-INTERVAL '1 day'), 0) AS daily_pnl,
      COUNT(*) FILTER (WHERE status='open')                                                        AS open_positions,
      COUNT(*) FILTER (WHERE status='closed' AND closed_at >= NOW()-INTERVAL '1 day')              AS closed_today,
      COUNT(*) FILTER (WHERE status='closed' AND pnl > 0)                                         AS wins,
      COUNT(*) FILTER (WHERE status='closed')                                                      AS total_closed
    FROM trades WHERE user_id = $1
  `, [userId]);

  const totalPnl      = parseFloat(s?.total_pnl)   || 0;
  const dailyPnl      = parseFloat(s?.daily_pnl)   || 0;
  const openPositions = parseInt(s?.open_positions) || 0;
  const closedToday   = parseInt(s?.closed_today)   || 0;
  const wins          = parseInt(s?.wins)           || 0;
  const totalClosed   = parseInt(s?.total_closed)   || 0;
  const winRate       = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : '0.0';

  const { rows: [acc] } = await db.query(
    `SELECT COALESCE(cash_balance, 10000) AS cash FROM accounts WHERE user_id = $1`,
    [userId]
  );
  const cash = parseFloat(acc?.cash || 10000);

  const { rows: portfolioRows } = await db.query(
    `SELECT symbol, amount, current_price FROM portfolio WHERE user_id = $1`,
    [userId]
  );

  const symbols     = [...new Set(portfolioRows.map(p => p.symbol))];
  const livePrices  = symbols.length > 0 ? await getLivePrices(symbols) : {};

  const marketValue = portfolioRows.reduce((sum, p) => {
    const live  = livePrices[p.symbol];
    const price = live?.price ?? parseFloat(p.current_price) ?? 0;
    return sum + parseFloat(p.amount) * price;
  }, 0);

  // ✅ cash_balance now moves on every buy/sell (see portfolioController.js
  // addPosition/removePosition) — realized gains are already inside `cash`,
  // so adding totalPnl on top would double-count.
  const portfolioValue = cash + marketValue;

  // ── 2. Equity curve — range-aware, with a date key for benchmarking ─
  const { rows: snapshotsDesc } = await db.query(`
    SELECT snapshot_date, total_value,
           TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS date_key
    FROM portfolio_snapshots
    WHERE user_id = $1
    ORDER BY snapshot_date DESC
    LIMIT $2
  `, [userId, rangeDays]);

  let equityCurve = snapshotsDesc
    .slice()
    .reverse()
    .map(r => ({
      day:   new Date(r.snapshot_date).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }),
      value: parseFloat(r.total_value),
      date:  r.date_key,
    }));

  const isSimulated = equityCurve.length === 0;

  if (isSimulated) {
    const base = portfolioValue || 10000;
    const days = Math.min(rangeDays, 30);
    equityCurve = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,'0'), day = String(d.getUTCDate()).padStart(2,'0');
      return {
        day:   d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }),
        value: parseFloat((base * (1 + (i - Math.floor(days / 2)) * 0.002)).toFixed(0)),
        date:  `${y}-${m}-${day}`,
      };
    });
  }

  let benchmarkCurve = [];
  let alpha = null;
  if (includeBenchmark && !isSimulated) {
    try {
      // fetch the raw benchmark price history for the same range, then
      // align it against equityCurve to build the comparison series.
      const benchmarkCandles = await getBenchmarkHistory(benchmarkSymbol, rangeDays);
      const built = buildBenchmarkCurve(equityCurve, benchmarkCandles);
      benchmarkCurve = built.curve;
      alpha          = built.alpha;
    } catch (e) {
      logger.warn(`[dashboard] Benchmark fetch failed (${benchmarkSymbol}): ${e.message}`);
    }
  }

  const { rows: last2Snaps } = await db.query(`
    SELECT snapshot_date, total_value
    FROM portfolio_snapshots
    WHERE user_id = $1
    ORDER BY snapshot_date DESC
    LIMIT 2
  `, [userId]);

  let dayOverDayDelta = 0;
  if (last2Snaps.length === 2) {
    dayOverDayDelta = parseFloat(last2Snaps[0].total_value) - parseFloat(last2Snaps[1].total_value);
  } else if (last2Snaps.length === 1) {
    dayOverDayDelta = parseFloat(last2Snaps[0].total_value) - cash;
  }

  // ── 3. Volume chart — grouped by literal date ──────────
  const { rows: volRows } = await db.query(`
    SELECT
      opened_at::date AS bucket_date,
      COUNT(*) AS volume
    FROM trades
    WHERE user_id = $1 AND opened_at >= NOW() - INTERVAL '7 days'
    GROUP BY bucket_date
    ORDER BY bucket_date ASC
  `, [userId]);

  let volumeChart = volRows.map((r, i) => ({
    index:  i,
    date:   r.bucket_date,
    day:    new Date(r.bucket_date).toLocaleDateString('en-US', { weekday: 'short' }),
    dow:    new Date(r.bucket_date).getDay(),
    volume: parseInt(r.volume) || 0,
  }));

  if (volumeChart.length === 0) {
    const { rows: sigVol } = await db.query(`
      SELECT
        created_at::date AS bucket_date,
        COUNT(*) AS volume
      FROM signals
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY bucket_date
      ORDER BY bucket_date ASC
    `);
    volumeChart = sigVol.map((r, i) => ({
      index:  i,
      date:   r.bucket_date,
      day:    new Date(r.bucket_date).toLocaleDateString('en-US', { weekday: 'short' }),
      dow:    new Date(r.bucket_date).getDay(),
      volume: parseInt(r.volume) || 0,
    }));
  }

  while (volumeChart.length < 5) {
    volumeChart.unshift({ index: volumeChart.length, date: null, day: '—', dow: null, volume: 0 });
  }

  // ── 4. Alerts summary ───────────────────────────────────
  const { rows: [alertRow] } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE triggered = false)                                            AS active,
      COUNT(*) FILTER (WHERE triggered = true AND triggered_at >= NOW() - INTERVAL '1 day') AS triggered_today
    FROM alerts WHERE user_id = $1
  `, [userId]);

  const alertsSummary = {
    active:         parseInt(alertRow?.active)          || 0,
    triggeredToday: parseInt(alertRow?.triggered_today)  || 0,
  };

  // ── 5. Recent activity — paginated ─────────────────────
  const { rows: recentRows } = await db.query(`
    SELECT
      id, symbol, side, status, pnl,
      opened_at, closed_at,
      GREATEST(opened_at, COALESCE(closed_at, opened_at)) AS sort_ts
    FROM trades
    WHERE user_id = $1
    ORDER BY sort_ts DESC
    LIMIT $2 OFFSET $3
  `, [userId, activityLimit + 1, activityOffset]);

  const hasMoreActivity = recentRows.length > activityLimit;
  const recentActivity = recentRows.slice(0, activityLimit).map(r => ({
    id:       r.id,
    symbol:   r.symbol,
    side:     r.side,
    status:   r.status,
    pnl:      r.pnl !== null ? parseFloat(r.pnl) : null,
    timestamp: r.status === 'closed' ? r.closed_at : r.opened_at,
  }));

  return {
    stats: {
      portfolioValue: {
        value: Math.round(portfolioValue),
        delta: dayOverDayDelta >= 0
          ? `+$${dayOverDayDelta.toFixed(0)}`
          : `-$${Math.abs(dayOverDayDelta).toFixed(0)}`,
      },
      dailyPnl: {
        value: Math.round(dailyPnl),
        delta: dailyPnl >= 0 ? `+$${dailyPnl.toFixed(0)}` : `-$${Math.abs(dailyPnl).toFixed(0)}`,
      },
      openPositions: { value: openPositions, delta: closedToday },
      winRate:       { value: `${winRate}%`, delta: `${wins}W / ${totalClosed - wins}L` },
    },
    equityCurve,
    isSimulated,
    range,
    benchmarkCurve,
    benchmarkSymbol,
    alpha,
    volumeChart,
    alertsSummary,
    recentActivity,
    hasMoreActivity,
    alertsActive: alertsSummary.active,
  };
}

module.exports = { buildDashboardPayload };