/**
 * src/controllers/alerts.controller.js
 */
const db = require('../config/db');
const logger = require('../utils/logger');


async function getAlerts(req, res) {
    try {
        const userId = req.user.id;

        const alertsQuery = `
            SELECT id, symbol, type, target, triggered, triggered_at, created_at 
            FROM alerts 
            WHERE user_id = $1 
            ORDER BY created_at DESC
        `;
        const { rows: alerts } = await db.query(alertsQuery, [userId]);

        // ── Stats réels, calculés mn alerts table ──
        const statsQuery = `
            SELECT 
                COUNT(*) FILTER (WHERE triggered = false) as active,
                COUNT(*) FILTER (WHERE triggered = true)  as triggered
            FROM alerts 
            WHERE user_id = $1
        `;
        const { rows: statsRows } = await db.query(statsQuery, [userId]);
        const statsRow = statsRows[0] || { active: 0, triggered: 0 };

        const stats = {
            active:    parseInt(statsRow.active, 10) || 0,
            triggered: parseInt(statsRow.triggered, 10) || 0,
            // TODO: 'near' khassha live price comparison (target vs current market price)
            near:      0,
            // TODO: 'paused' khassha schema change (zid column 'paused' boolean l alerts table)
            paused:    0,
        };

        // ── Notifications mn triggered alerts (récentes) ──
        const notificationsQuery = `
            SELECT id, symbol, type, target, triggered_at 
            FROM alerts 
            WHERE user_id = $1 AND triggered = true 
            ORDER BY triggered_at DESC 
            LIMIT 10
        `;
        const { rows: triggeredRows } = await db.query(notificationsQuery, [userId]);
        const notifications = triggeredRows.map(r => ({
            title: `${r.symbol} ${r.type} alert triggered`,
            desc: `Target ${r.target} reached`,
            time: r.triggered_at,
            unread: true,
            icon: '🔔',
            bg: 'rgba(251,191,36,0.12)',
            color: 'var(--amber)',
        }));

        res.status(200).json({ 
            success: true, 
            stats,
            notifications,
            alerts,
        });
    } catch (err) {
        logger.error(`[alerts.controller] Get Error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
    }
}


async function createAlert(req, res) {
    try {
        const userId = req.user.id;
        const { symbol, type, target } = req.body;

        if (!symbol || !type || !target) {
            return res.status(400).json({ success: false, error: 'Missing required alert fields' });
        }

        const query = `
            INSERT INTO alerts (user_id, symbol, type, target) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, symbol, type, target, triggered, created_at
        `;
        
        const { rows } = await db.query(query, [userId, symbol, type, target]);
        
        res.status(201).json({ 
            success: true, 
            message: 'Alert created successfully',
            alert: rows[0]
        });
    } catch (err) {
        logger.error(`[alerts.controller] Create Error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to create alert' });
    }
}

module.exports = { getAlerts, createAlert };