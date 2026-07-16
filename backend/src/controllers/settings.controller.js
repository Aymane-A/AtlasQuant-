/**
 * controllers/settings.controller.js
 */
const bcrypt = require('bcryptjs');
const db     = require('../config/db');
const logger = require('../utils/logger');

// ── GET /api/settings ─────────────────────────────────────
async function getSettings(req, res) {
  try {
    const userId = req.user.id;

    const { rows: userRows } = await db.query(
      'SELECT name, email, plan FROM users WHERE id = $1',
      [userId]
    );

    const { rows: settingsRows } = await db.query(
      `SELECT theme, notifications, api_keys_enabled,
              default_capital, default_risk_pct, default_timeframe,
              signal_alert_mode, signal_alert_symbols, signal_alert_min_confidence
       FROM user_settings WHERE user_id = $1`,
      [userId]
    );

    const settings = settingsRows[0] || {
      theme: 'dark',
      notifications: { email_alerts: true, push_alerts: true, price_alerts: true },
      api_keys_enabled: false,
      default_capital: 100000,
      default_risk_pct: 1,
      default_timeframe: 'Daily',
      // ✅ Feature: par défaut on suit tout (comportement historique inchangé
      // pour les comptes existants sans préférence explicite).
      signal_alert_mode: 'all',
      signal_alert_symbols: [],
      signal_alert_min_confidence: 75,
    };

    res.json({ success: true, profile: userRows[0] || {}, settings });
  } catch (err) {
    logger.error(`[settings] getSettings: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/settings/update ─────────────────────────────
async function updateSettings(req, res) {
  try {
    const userId = req.user.id;
    const { section, payload } = req.body;

    if (!section || !payload)
      return res.status(400).json({ success: false, error: 'section et payload requis' });

    if (section === 'profile') {
      await db.query(
        'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2',
        [payload.name, userId]
      );
      return res.json({ success: true, message: 'Profil mis à jour' });
    }

    if (section === 'notifications') {
      await db.query(
        `INSERT INTO user_settings (user_id, notifications)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET notifications = EXCLUDED.notifications, updated_at = NOW()`,
        [userId, JSON.stringify(payload)]
      );
      return res.json({ success: true, message: 'Notifications mises à jour' });
    }

    if (section === 'trading') {
      await db.query(
        `INSERT INTO user_settings (user_id, default_capital, default_risk_pct, default_timeframe)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           default_capital    = EXCLUDED.default_capital,
           default_risk_pct   = EXCLUDED.default_risk_pct,
           default_timeframe  = EXCLUDED.default_timeframe,
           updated_at         = NOW()`,
        [userId, payload.default_capital, payload.default_risk_pct, payload.default_timeframe]
      );
      return res.json({ success: true, message: 'Trading mis à jour' });
    }

    if (section === 'appearance') {
      if (!['dark', 'light'].includes(payload.theme))
        return res.status(400).json({ success: false, error: 'theme invalide' });
      await db.query(
        `INSERT INTO user_settings (user_id, theme)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme, updated_at = NOW()`,
        [userId, payload.theme]
      );
      return res.json({ success: true, message: 'Thème mis à jour' });
    }

    // ✅ Feature: préférences d'alertes AI auto-générées (signalAlert.service.js)
    // payload: { mode: 'all' | 'custom', symbols: ['BTCUSDT','AAPL','EURUSD',...], minConfidence: 50-95 }
    // 'symbols' est une liste libre de tickers précis choisis par l'utilisateur,
    // pas des classes d'actifs — l'utilisateur tape exactement ce qu'il veut suivre.
    if (section === 'signalAlerts') {
      const mode = payload.mode === 'custom' ? 'custom' : 'all';
      const symbols = Array.isArray(payload.symbols)
        ? [...new Set(payload.symbols
            .map(s => String(s).toUpperCase().trim())
            .filter(Boolean))]
        : [];

      if (mode === 'custom' && symbols.length === 0) {
        return res.status(400).json({ success: false, error: 'Add at least one symbol to follow' });
      }

      // ✅ Feature: seuil de confiance — on clamp au lieu de rejeter, car
      // c'est un slider continu côté UI (step 5, 50→95), pas un choix parmi
      // des valeurs fixes comme SNOOZE_ALLOWED_HOURS. Tolère un léger écart
      // (ex. 73) plutôt que de renvoyer une erreur 400 pour ça.
      let minConfidence = parseInt(payload.minConfidence, 10);
      if (!Number.isFinite(minConfidence)) minConfidence = 75;
      minConfidence = Math.min(95, Math.max(50, minConfidence));

      await db.query(
        `INSERT INTO user_settings (user_id, signal_alert_mode, signal_alert_symbols, signal_alert_min_confidence)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           signal_alert_mode           = EXCLUDED.signal_alert_mode,
           signal_alert_symbols        = EXCLUDED.signal_alert_symbols,
           signal_alert_min_confidence = EXCLUDED.signal_alert_min_confidence,
           updated_at                  = NOW()`,
        [userId, mode, JSON.stringify(symbols), minConfidence]
      );
      return res.json({ success: true, message: 'Préférences d\'alertes mises à jour', mode, symbols, minConfidence });
    }

    return res.status(400).json({ success: false, error: `Section inconnue: ${section}` });

  } catch (err) {
    logger.error(`[settings] updateSettings: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/settings/password ───────────────────────────
async function changePassword(req, res) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, error: 'Mots de passe requis' });

    if (newPassword.length < 8)
      return res.status(400).json({ success: false, error: 'Min. 8 caractères' });

    const { rows } = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (!rows.length)
      return res.status(404).json({ success: false, error: 'Utilisateur introuvable' });

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch)
      return res.status(401).json({ success: false, error: 'Mot de passe actuel incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, userId]);

    res.json({ success: true, message: 'Mot de passe mis à jour' });
  } catch (err) {
    logger.error(`[settings] changePassword: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getSettings, updateSettings, changePassword };