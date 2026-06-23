/**
 * controllers/dashboard.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');

async function getDashboardData(req, res) {
    try {
        const userId = req.user.id;

        // ── 1. Portfolio stats from trades ────────────────────
        const { rows: [s] } = await db.query(`
            SELECT
                COALESCE(SUM(pnl) FILTER (WHERE status='closed'), 0)                                    AS total_pnl,
                COALESCE(SUM(pnl) FILTER (WHERE status='closed' AND closed_at >= NOW()-INTERVAL '1 day'), 0) AS daily_pnl,
                COUNT(*) FILTER (WHERE status='open')                                                    AS open_positions,
                COUNT(*) FILTER (WHERE status='closed' AND closed_at >= NOW()-INTERVAL '1 day')          AS closed_today,
                COUNT(*) FILTER (WHERE status='closed' AND pnl > 0)                                     AS wins,
                COUNT(*) FILTER (WHERE status='closed')                                                  AS total_closed
            FROM trades WHERE user_id = $1
        `, [userId]);

        const totalPnl      = parseFloat(s?.total_pnl)     || 0;
        const dailyPnl      = parseFloat(s?.daily_pnl)     || 0;
        const openPositions = parseInt(s?.open_positions)   || 0;
        const closedToday   = parseInt(s?.closed_today)     || 0;
        const wins          = parseInt(s?.wins)             || 0;
        const totalClosed   = parseInt(s?.total_closed)     || 0;
        const winRate       = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : '0.0';
        const portfolioValue = 100000 + totalPnl;

        // ── 2. Equity curve from signals confidence (last 30) ──
        const { rows: sigRows } = await db.query(`
            SELECT confidence, created_at FROM signals
            ORDER BY created_at ASC LIMIT 30
        `);

        let cumulative = 100000;
        const equityCurve = sigRows.map((r, i) => {
            const delta = ((r.confidence || 60) - 55) * 10;
            cumulative += delta;
            return {
                day:   new Date(r.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'short' }),
                value: parseFloat(cumulative.toFixed(0)),
            };
        });

        // ── 3. Volume chart — signals per day (last 7 days) ───
        const { rows: volRows } = await db.query(`
            SELECT
                TO_CHAR(created_at, 'Dy') AS day,
                EXTRACT(DOW FROM created_at)::int AS dow,
                COUNT(*) AS volume
            FROM signals
            WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY day, dow
            ORDER BY dow
        `);

        const volumeChart = volRows.map((r, i) => ({
            index:  i,
            day:    r.day,
            volume: parseInt(r.volume) || 0,
        }));

        // Pad with zeros if less than 5 days
        while (volumeChart.length < 5) {
            volumeChart.unshift({ index: volumeChart.length, day: '—', volume: 0 });
        }

        // ── 4. Recent signals as "active trades" ───────────────
        const { rows: recentSignals } = await db.query(`
            SELECT symbol, signal, confidence, price, created_at
            FROM signals ORDER BY created_at DESC LIMIT 5
        `);

        // ── 5. Alerts count ────────────────────────────────────
        const { rows: alertRows } = await db.query(`
            SELECT COUNT(*) FILTER (WHERE triggered=false) AS active
            FROM alerts WHERE user_id = $1
        `, [userId]);

        res.json({
            success: true,
            stats: {
                portfolioValue: { value: portfolioValue,      delta: totalPnl >= 0 ? `+${totalPnl.toFixed(0)}` : `${totalPnl.toFixed(0)}` },
                dailyPnl:       { value: dailyPnl,            delta: dailyPnl >= 0 ? `+${dailyPnl.toFixed(0)}` : `${dailyPnl.toFixed(0)}` },
                openPositions:  { value: openPositions,       delta: closedToday  },
                winRate:        { value: `${winRate}%`,       delta: `${wins}W / ${totalClosed - wins}L` },
            },
            equityCurve,
            volumeChart,
            recentSignals: recentSignals.map(r => ({
                symbol:     r.symbol,
                signal:     r.signal,
                confidence: r.confidence,
                price:      parseFloat(r.price),
                time:       new Date(r.created_at).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }),
            })),
            alertsActive: parseInt(alertRows[0]?.active) || 0,
        });

    } catch (err) {
        logger.error(`[dashboard] Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = { getDashboardData };