/**
 * controllers/dashboard.controller.js — AtlasQuant AI
 * Real equity curve from portfolio_snapshots
 */

const db     = require('../config/db');
const logger = require('../utils/logger');
const { takePortfolioSnapshot } = require('../services/portfolioSnapshot.service');

async function getDashboardData(req, res) {
  try {
    const userId = req.user.id;

    // ── Ensure today's snapshot exists ────────────────────
    await takePortfolioSnapshot();

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

    // Cash + portfolio market value
    const { rows: [acc] } = await db.query(
      `SELECT COALESCE(cash_balance, 10000) AS cash FROM accounts WHERE user_id = $1`,
      [userId]
    );
    const { rows: [port] } = await db.query(`
      SELECT COALESCE(SUM(amount * current_price), 0) AS market_value
      FROM portfolio WHERE user_id = $1
    `, [userId]);

    const cash        = parseFloat(acc?.cash || 10000);
    const marketValue = parseFloat(port?.market_value || 0);
    const portfolioValue = cash + marketValue + totalPnl;

    // ── 2. Equity curve from real snapshots (last 30 days) ─
    const { rows: snapshots } = await db.query(`
      SELECT snapshot_date, total_value
      FROM portfolio_snapshots
      WHERE user_id = $1
      ORDER BY snapshot_date ASC
      LIMIT 30
    `, [userId]);

    let equityCurve = snapshots.map(r => ({
      day:   new Date(r.snapshot_date).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }),
      value: parseFloat(r.total_value),
    }));

    // Ila mashi kayn snapshots — generate from today back 30 days
    if (equityCurve.length === 0) {
      const base = portfolioValue || 10000;
      equityCurve = Array.from({ length: 30 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (29 - i));
        return {
          day:   d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }),
          value: parseFloat((base * (1 + (i - 15) * 0.002)).toFixed(0)),
        };
      });
    }

    // ── 3. Volume chart — real trades per day (last 7) ────
    const { rows: volRows } = await db.query(`
      SELECT
        TO_CHAR(opened_at, 'Dy') AS day,
        EXTRACT(DOW FROM opened_at)::int AS dow,
        COUNT(*) AS volume
      FROM trades
      WHERE user_id = $1 AND opened_at >= NOW() - INTERVAL '7 days'
      GROUP BY day, dow
      ORDER BY dow
    `, [userId]);

    let volumeChart = volRows.map((r, i) => ({
      index:  i,
      day:    r.day,
      volume: parseInt(r.volume) || 0,
    }));

    // Fallback — signals per day ila machi kayn trades
    if (volumeChart.length === 0) {
      const { rows: sigVol } = await db.query(`
        SELECT
          TO_CHAR(created_at, 'Dy') AS day,
          EXTRACT(DOW FROM created_at)::int AS dow,
          COUNT(*) AS volume
        FROM signals
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY day, dow
        ORDER BY dow
      `);
      volumeChart = sigVol.map((r, i) => ({
        index:  i,
        day:    r.day,
        volume: parseInt(r.volume) || 0,
      }));
    }

    while (volumeChart.length < 5) {
      volumeChart.unshift({ index: volumeChart.length, day: '—', volume: 0 });
    }

    // ── 4. Alerts count ───────────────────────────────────
    const { rows: alertRows } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE triggered=false) AS active
      FROM alerts WHERE user_id = $1
    `, [userId]);

    res.json({
      success: true,
      stats: {
        portfolioValue: {
          value: Math.round(portfolioValue),
          delta: totalPnl >= 0 ? `+$${totalPnl.toFixed(0)}` : `-$${Math.abs(totalPnl).toFixed(0)}`,
        },
        dailyPnl: {
          value: Math.round(dailyPnl),
          delta: dailyPnl >= 0 ? `+$${dailyPnl.toFixed(0)}` : `-$${Math.abs(dailyPnl).toFixed(0)}`,
        },
        openPositions: { value: openPositions, delta: closedToday },
        winRate:       { value: `${winRate}%`, delta: `${wins}W / ${totalClosed - wins}L` },
      },
      equityCurve,
      volumeChart,
      alertsActive: parseInt(alertRows[0]?.active) || 0,
    });

  } catch (err) {
    logger.error(`[dashboard] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getDashboardData };