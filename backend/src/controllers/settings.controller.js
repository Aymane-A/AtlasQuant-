/**
 * controllers/settings.controller.js
 */
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const archiver = require('archiver');
const db       = require('../config/db');
const logger   = require('../utils/logger');
const { logAuditEvent } = require('../utils/auditLog');

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'MAD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'AED'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── GET /api/settings ─────────────────────────────────────
async function getSettings(req, res) {
  try {
    const userId = req.user.id;

    const { rows: userRows } = await db.query(
      'SELECT name, email, plan, email_verified FROM users WHERE id = $1',
      [userId]
    );

    const { rows: settingsRows } = await db.query(
      `SELECT theme, notifications, api_keys_enabled,
              default_capital, default_risk_pct, default_timeframe,
              signal_alert_mode, signal_alert_symbols, signal_alert_min_confidence,
              language, timezone, currency,
              webhook_url, webhook_enabled,
              risk_max_daily_loss_pct, risk_max_position_pct, risk_default_stoploss_pct,
              telegram_chat_id, telegram_enabled,
              quiet_hours_enabled, quiet_hours_start, quiet_hours_end
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
      currency: 'USD',
      webhook_url: null,
      webhook_enabled: false,
      risk_max_daily_loss_pct: 5,
      risk_max_position_pct: 20,
      risk_default_stoploss_pct: 2,
      telegram_chat_id: null,
      telegram_enabled: false,
      quiet_hours_enabled: false,
      quiet_hours_start: '23:00',
      quiet_hours_end: '07:00',
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

    // ✅ Feature: trading defaults + gestion du risque avancée
    if (section === 'trading') {
      const clampPct = (val, fallback) => {
        const n = parseFloat(val);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(100, Math.max(0, n));
      };

      const maxDailyLossPct    = clampPct(payload.max_daily_loss_pct, 5);
      const maxPositionPct     = clampPct(payload.max_position_pct, 20);
      const defaultStoplossPct = payload.default_stoploss_pct !== undefined
        ? clampPct(payload.default_stoploss_pct, 2)
        : 2;

      await db.query(
        `INSERT INTO user_settings (
           user_id, default_capital, default_risk_pct, default_timeframe,
           risk_max_daily_loss_pct, risk_max_position_pct, risk_default_stoploss_pct
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           default_capital            = EXCLUDED.default_capital,
           default_risk_pct           = EXCLUDED.default_risk_pct,
           default_timeframe          = EXCLUDED.default_timeframe,
           risk_max_daily_loss_pct    = EXCLUDED.risk_max_daily_loss_pct,
           risk_max_position_pct      = EXCLUDED.risk_max_position_pct,
           risk_default_stoploss_pct  = EXCLUDED.risk_default_stoploss_pct,
           updated_at                 = NOW()`,
        [userId, payload.default_capital, payload.default_risk_pct, payload.default_timeframe,
         maxDailyLossPct, maxPositionPct, defaultStoplossPct]
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

    // ✅ Feature: langue + timezone + devise
    if (section === 'locale') {
      const SUPPORTED_LANGS = ['en','fr','ar','es','tr','pt','ru','de','hi','ko'];
      const language = SUPPORTED_LANGS.includes(payload.language) ? payload.language : 'en';
      const currency = SUPPORTED_CURRENCIES.includes(payload.currency) ? payload.currency : 'USD';

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
        `INSERT INTO user_settings (user_id, language, timezone, currency)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           language = EXCLUDED.language, timezone = EXCLUDED.timezone,
           currency = EXCLUDED.currency, updated_at = NOW()`,
        [userId, language, timezone, currency]
      );
      return res.json({ success: true, message: 'Langue et fuseau mis à jour', language, timezone, currency });
    }

    // ✅ Feature: webhook custom (Discord/Slack/générique)
    if (section === 'webhook') {
      const enabled = !!payload.enabled;
      let url = (payload.url || '').trim();

      if (enabled) {
        if (!url) return res.status(400).json({ success: false, error: 'URL requise pour activer le webhook' });
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:')
            return res.status(400).json({ success: false, error: 'Le webhook doit utiliser HTTPS' });
        } catch {
          return res.status(400).json({ success: false, error: 'URL invalide' });
        }
      }

      await db.query(
        `INSERT INTO user_settings (user_id, webhook_url, webhook_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET
           webhook_url = EXCLUDED.webhook_url, webhook_enabled = EXCLUDED.webhook_enabled, updated_at = NOW()`,
        [userId, url || null, enabled]
      );
      return res.json({ success: true, message: 'Webhook mis à jour', url, enabled });
    }

    // ✅ Feature: linking Telegram — chat_id saisi manuellement (via @userinfobot)
    if (section === 'telegram') {
      const enabled = !!payload.enabled;
      const chatId = String(payload.chatId || '').trim();

      if (enabled) {
        if (!chatId) return res.status(400).json({ success: false, error: 'Chat ID requis pour activer Telegram' });
        if (!/^-?\d+$/.test(chatId)) return res.status(400).json({ success: false, error: 'Chat ID invalide (doit être numérique)' });
      }

      await db.query(
        `INSERT INTO user_settings (user_id, telegram_chat_id, telegram_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET
           telegram_chat_id = EXCLUDED.telegram_chat_id, telegram_enabled = EXCLUDED.telegram_enabled, updated_at = NOW()`,
        [userId, chatId || null, enabled]
      );
      return res.json({ success: true, message: 'Telegram mis à jour', chatId, enabled });
    }

    // ✅ Feature: quiet hours — désactive temporairement les notifications
    // (email/push/telegram/webhook) pendant une plage horaire quotidienne.
    // ⚠️ Le stockage est ici; l'enforcement réel (ne pas envoyer d'alerte
    // durant ces heures) doit être ajouté dans alertChecker.service.js en
    // comparant l'heure locale de l'user (via son timezone) à ce range.
    if (section === 'quietHours') {
      const enabled = !!payload.enabled;
      const start = TIME_RE.test(payload.start) ? payload.start : '23:00';
      const end   = TIME_RE.test(payload.end)   ? payload.end   : '07:00';

      await db.query(
        `INSERT INTO user_settings (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
           quiet_hours_start   = EXCLUDED.quiet_hours_start,
           quiet_hours_end     = EXCLUDED.quiet_hours_end,
           updated_at          = NOW()`,
        [userId, enabled, start, end]
      );
      return res.json({ success: true, message: 'Quiet hours mis à jour', enabled, start, end });
    }

    return res.status(400).json({ success: false, error: `Section inconnue: ${section}` });

  } catch (err) {
    logger.error(`[settings] updateSettings: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/settings/webhook/test ───────────────────────
async function testWebhook(req, res) {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL requise' });

    let parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('not https');
    } catch {
      return res.status(400).json({ success: false, error: 'URL invalide (HTTPS requis)' });
    }

    const testPayload = {
      content: '🔔 AtlasQuant AI — test webhook. Si tu vois ce message, ton webhook est bien configuré.',
      text: '🔔 AtlasQuant AI — test webhook. Si tu vois ce message, ton webhook est bien configuré.',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testPayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return res.status(502).json({ success: false, error: `Le service distant a répondu ${resp.status}` });
      }
      res.json({ success: true, message: 'Webhook testé avec succès' });
    } catch (fetchErr) {
      clearTimeout(timeout);
      logger.error(`[settings] testWebhook fetch: ${fetchErr.message}`);
      res.status(502).json({ success: false, error: 'Impossible de contacter le webhook (timeout ou URL injoignable)' });
    }
  } catch (err) {
    logger.error(`[settings] testWebhook: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/settings/telegram/test ──────────────────────
// ✅ Utilise le même bot que alertChecker.service.js / signalAlert.service.js
// (process.env.TELEGRAM_BOT_TOKEN) — pas de nouveau bot à créer.
async function testTelegram(req, res) {
  try {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ success: false, error: 'Chat ID requis' });
    if (!/^-?\d+$/.test(String(chatId).trim())) {
      return res.status(400).json({ success: false, error: 'Chat ID invalide (doit être numérique)' });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.error('[settings] testTelegram: TELEGRAM_BOT_TOKEN manquant dans .env');
      return res.status(500).json({ success: false, error: 'Bot Telegram non configuré côté serveur' });
    }

    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🔔 AtlasQuant AI — test message. Ton compte Telegram est bien lié.',
      }),
    });

    const data = await resp.json();
    if (!data.ok) {
      return res.status(502).json({ success: false, error: data.description || 'Telegram a refusé le message' });
    }
    res.json({ success: true, message: 'Message de test envoyé' });
  } catch (err) {
    logger.error(`[settings] testTelegram: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/settings/email/resend-verification ──────────
// ⚠️ Adapte l'import de sendMail ci-dessous à ton service mailer existant
// (celui déjà utilisé par alertChecker.service.js pour les emails Nodemailer).
async function resendVerification(req, res) {
  try {
    const userId = req.user.id;
    const { rows } = await db.query('SELECT email, email_verified FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Utilisateur introuvable' });
    if (rows[0].email_verified) return res.json({ success: true, message: 'Email déjà vérifié' });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await db.query(
      `UPDATE users SET email_verification_token = $1, email_verification_sent_at = NOW() WHERE id = $2`,
      [tokenHash, userId]
    );

    const { sendMail } = require('../services/emailService'); // ⚠️ adapte le chemin/nom si différent
    const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${token}`;
    await sendMail({
      to: rows[0].email,
      subject: 'Vérifie ton adresse email — AtlasQuant AI',
      html: `<p>Clique sur le lien ci-dessous pour vérifier ton adresse email :</p>
             <p><a href="${verifyUrl}">${verifyUrl}</a></p>
             <p>Ce lien expire dans 24h.</p>`,
    });

    res.json({ success: true, message: 'Email de vérification envoyé' });
  } catch (err) {
    logger.error(`[settings] resendVerification: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/settings/email/verify (public, sans auth) ───
async function verifyEmail(req, res) {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token requis' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await db.query(
      `SELECT id, email_verification_sent_at FROM users WHERE email_verification_token = $1`,
      [tokenHash]
    );
    if (!rows.length) return res.status(400).json({ success: false, error: 'Lien de vérification invalide' });

    const sentAt = new Date(rows[0].email_verification_sent_at);
    const hoursSince = (Date.now() - sentAt.getTime()) / 3600000;
    if (hoursSince > 24) {
      return res.status(400).json({ success: false, error: 'Lien expiré — redemande un email de vérification' });
    }

    await db.query(
      `UPDATE users SET email_verified = true, email_verification_token = NULL WHERE id = $1`,
      [rows[0].id]
    );
    res.json({ success: true, message: 'Email vérifié avec succès' });
  } catch (err) {
    logger.error(`[settings] verifyEmail: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── GET /api/settings/audit-log ────────────────────────────
async function getAuditLog(req, res) {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT event_type, ip_address, user_agent, created_at
       FROM audit_log WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ success: true, events: rows });
  } catch (err) {
    logger.error(`[settings] getAuditLog: ${err.message}`);
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

    await logAuditEvent(userId, 'password_changed', req);

    res.json({ success: true, message: 'Mot de passe mis à jour' });
  } catch (err) {
    logger.error(`[settings] changePassword: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── CSV helper ─────────────────────────────────────────────
function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

// ── GET /api/settings/export ──────────────────────────────
// ✅ Feature: export au format CSV (zip multi-fichiers) en plus du JSON
// existant. ?format=csv|json (défaut: json).
async function exportUserData(req, res) {
  try {
    const userId = req.user.id;
    const format = req.query.format === 'csv' ? 'csv' : 'json';

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

    if (format === 'json') {
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
      return res.json(exportPayload);
    }

    // format === 'csv' → zip multi-fichiers
    res.setHeader('Content-Disposition', `attachment; filename="atlasquant-export-${userId}-${Date.now()}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    archive.append(rowsToCsv(user.rows),            { name: 'account.csv' });
    archive.append(rowsToCsv(settings.rows),         { name: 'settings.csv' });
    archive.append(rowsToCsv(trades.rows),           { name: 'trades.csv' });
    archive.append(rowsToCsv(portfolio.rows),        { name: 'portfolio.csv' });
    archive.append(rowsToCsv(alerts.rows),           { name: 'alerts.csv' });
    archive.append(rowsToCsv(watchlist.rows),        { name: 'watchlist.csv' });
    archive.append(rowsToCsv(screenerPresets.rows),  { name: 'screener_presets.csv' });
    archive.append(rowsToCsv(apiKeys.rows),          { name: 'api_keys.csv' });
    archive.append(rowsToCsv(sessions.rows),         { name: 'active_sessions.csv' });

    await archive.finalize();
  } catch (err) {
    logger.error(`[settings] exportUserData: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
}

// ── DELETE /api/settings/account ──────────────────────────
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

module.exports = {
  getSettings, updateSettings, changePassword, exportUserData, deleteAccount,
  testWebhook, testTelegram, resendVerification, verifyEmail, getAuditLog,
};