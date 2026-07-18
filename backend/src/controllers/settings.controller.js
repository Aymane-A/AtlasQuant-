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
              signal_alert_mode, signal_alert_symbols, signal_alert_min_confidence,
              language, timezone
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
      signal_alert_mode: 'all',
      signal_alert_symbols: [],
      signal_alert_min_confidence: 75,
      language: 'en',
      timezone: 'UTC',
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
    // ✅ Feature: langue + timezone. Liste fermée pour la langue (matche les
    // 10 langues déjà supportées par react-i18next côté frontend), timezone
    // validée via Intl plutôt qu'une liste statique — trop de fuseaux pour
    // les maintenir à la main, et Intl couvre déjà toute la base IANA.
    if (section === 'locale') {
      const SUPPORTED_LANGS = ['en','fr','ar','es','tr','pt','ru','de','hi','ko'];
      const language = SUPPORTED_LANGS.includes(payload.language) ? payload.language : 'en';

      let timezone = 'UTC';
      if (payload.timezone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: payload.timezone });
          timezone = payload.timezone;
        } catch {
          return res.status(400).json({ success: false, error: 'Fuseau horaire invalide' });
        }
      }

      await db.query(
        `INSERT INTO user_settings (user_id, language, timezone)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET
           language = EXCLUDED.language, timezone = EXCLUDED.timezone, updated_at = NOW()`,
        [userId, language, timezone]
      );
      return res.json({ success: true, message: 'Langue et fuseau mis à jour', language, timezone });
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
// ── GET /api/settings/export ──────────────────────────────
// ✅ Feature: export RGPD-style — l'utilisateur télécharge un JSON de ses
// données. On exclut délibérément les colonnes sensibles (password hash,
// key_hash, refresh_hash, twofa_secret) — l'export est pour l'utilisateur
// lui-même, pas un vecteur de fuite de secrets internes.
async function exportUserData(req, res) {
  try {
    const userId = req.user.id;

    const [user, settings, trades, portfolio, alerts, watchlist, screenerPresets, apiKeys, sessions] =
      await Promise.all([
        db.query('SELECT id, email, name, plan, created_at FROM users WHERE id = $1', [userId]),
        db.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]),
        db.query('SELECT * FROM trades WHERE user_id = $1 ORDER BY opened_at DESC', [userId]),
        db.query('SELECT * FROM portfolio WHERE user_id = $1', [userId]),
        db.query('SELECT id, symbol, type, condition, target, triggered, created_at FROM alerts WHERE user_id = $1', [userId]),
        db.query('SELECT symbol, added_at FROM watchlist WHERE user_id = $1', [userId]),
        db.query('SELECT name, asset_type, filters, created_at FROM screener_presets WHERE user_id = $1', [userId]),
        db.query('SELECT name, key_prefix, scopes, created_at, last_used_at FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [userId]),
        db.query('SELECT ip_address, user_agent, created_at, last_active FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]),
      ]);

    const exportPayload = {
      exported_at: new Date().toISOString(),
      account: user.rows[0] || null,
      settings: settings.rows[0] || null,
      trades: trades.rows,
      portfolio: portfolio.rows,
      alerts: alerts.rows,
      watchlist: watchlist.rows,
      screener_presets: screenerPresets.rows,
      api_keys: apiKeys.rows,
      active_sessions: sessions.rows,
    };

    res.setHeader('Content-Disposition', `attachment; filename="atlasquant-export-${userId}-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportPayload);
  } catch (err) {
    logger.error(`[settings] exportUserData: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── DELETE /api/settings/account ──────────────────────────
// ✅ Feature: suppression de compte — exige le mot de passe actuel (comme
// changePassword) pour éviter qu'une session volée/laissée ouverte suffise
// à effacer le compte. Le ON DELETE CASCADE sur toutes les FK vers users(id)
// (trades, portfolio, alerts, watchlist, user_settings, user_sessions,
// api_keys, etc.) fait le nettoyage — un seul DELETE FROM users suffit.
async function deleteAccount(req, res) {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password)
      return res.status(400).json({ success: false, error: 'Mot de passe requis pour confirmer' });

    const { rows } = await db.query('SELECT password, email FROM users WHERE id = $1', [userId]);
    if (!rows.length)
      return res.status(404).json({ success: false, error: 'Utilisateur introuvable' });

    const isMatch = await bcrypt.compare(password, rows[0].password);
    if (!isMatch)
      return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });

    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    logger.info(`[settings] Compte supprimé: ${rows[0].email} (id:${userId})`);

    res.json({ success: true, message: 'Compte supprimé définitivement' });
  } catch (err) {
    logger.error(`[settings] deleteAccount: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getSettings, updateSettings, changePassword, exportUserData, deleteAccount };