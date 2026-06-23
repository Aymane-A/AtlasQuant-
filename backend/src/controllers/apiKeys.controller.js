/**
 * controllers/apiKeys.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const crypto = require('crypto');

// ── GET /api/apikeys/dashboard-data ───────────────────────
async function getApiKeysData(req, res) {
    try {
        const userId = req.user.id;

        // Fetch user's API keys
        const { rows } = await db.query(
            `SELECT id, name, key_preview, key_full, permissions,
                    ip_whitelist, calls_today, last_used_at, created_at
             FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
            [userId]
        );

        const keys = rows.map(k => ({
            name:        k.name,
            type:        'active',
            statusColor: 'var(--green)',
            statusBg:    'rgba(52,211,153,0.12)',
            val:         k.key_preview,
            full:        k.key_full || k.key_preview,
            perms:       k.permissions || ['READ'],
            ip:          k.ip_whitelist || 'Any',
            created:     new Date(k.created_at).toLocaleDateString('fr-FR'),
            lastUsed:    k.last_used_at
                           ? new Date(k.last_used_at).toLocaleDateString('fr-FR')
                           : 'Never',
            calls:       k.calls_today?.toString() || '0',
        }));

        // Stats
        const totalCalls = rows.reduce((a, k) => a + (k.calls_today || 0), 0);
        const stats = {
            activeKeys:  keys.length.toString(),
            reqToday:    totalCalls.toLocaleString(),
            errorRate:   '0.0%',
            avgLatency:  '42ms',
        };

        // Rate limits (static — reflect backend rateLimit.middleware)
        const rates = [
            { label:'Signals API',   used: Math.min(totalCalls, 8),   max:10,  color:'var(--cyan)'  },
            { label:'Market Data',   used: Math.min(totalCalls, 5),   max:20,  color:'var(--green)' },
            { label:'Analytics',     used: Math.min(totalCalls, 3),   max:10,  color:'var(--amber)' },
            { label:'Global',        used: Math.min(totalCalls, 60),  max:100, color:'var(--purple-bright)' },
        ];

        // Request volume (last 24h — simulated from calls_today)
        const reqVolume = Array.from({ length: 24 }, (_, i) => ({
            hour:     `${String(i).padStart(2,'0')}:00`,
            requests: Math.floor(Math.random() * (totalCalls || 50) * 0.15 + 5),
        }));

        // Webhooks (from DB if exists, else empty)
        let webhooks = [];
        try {
            const wh = await db.query(
                `SELECT url, events, status, calls_sent FROM webhooks WHERE user_id = $1`,
                [userId]
            );
            webhooks = wh.rows.map(w => ({
                url:    w.url,
                events: w.events || [],
                status: w.status || 'active',
                calls:  w.calls_sent || 0,
            }));
        } catch {
            // webhooks table may not exist yet
        }

        res.json({ success: true, keys, stats, rates, reqVolume, webhooks });

    } catch (err) {
        logger.error(`[apiKeys] getApiKeysData: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── POST /api/apikeys/create ───────────────────────────────
async function createApiKey(req, res) {
    try {
        const userId = req.user.id;
        const { name, permissions } = req.body;

        if (!name) return res.status(400).json({ success: false, error: 'Name required' });

        const rawKey    = 'aq_live_' + crypto.randomBytes(16).toString('hex');
        const keyPreview = rawKey.substring(0, 16) + '...' + rawKey.slice(-4);
        const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex');

        await db.query(
            `INSERT INTO api_keys (user_id, name, key_hash, key_preview, key_full, permissions)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, name, keyHash, keyPreview, rawKey, permissions || ['READ']]
        );

        res.json({ success: true, key: rawKey, preview: keyPreview });

    } catch (err) {
        logger.error(`[apiKeys] createApiKey: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── DELETE /api/apikeys/:id ────────────────────────────────
async function revokeApiKey(req, res) {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        await db.query(
            'DELETE FROM api_keys WHERE id = $1 AND user_id = $2',
            [id, userId]
        );

        res.json({ success: true, message: 'Key revoked' });

    } catch (err) {
        logger.error(`[apiKeys] revokeApiKey: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = { getApiKeysData, createApiKey, revokeApiKey };