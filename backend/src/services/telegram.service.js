/**
 * src/services/telegram.service.js — AtlasQuant AI
 * Telegram Bot notifications.
 *
 * ✅ Audit 3: les messages partent TOUJOURS vers le chat_id de l'utilisateur
 * concerné (user_settings.telegram_chat_id, avec telegram_enabled = true).
 * Avant, TELEGRAM_CHAT_ID (env) était utilisé pour tout le monde : les alertes
 * (symbole, cible, prix) de chaque user arrivaient chez le propriétaire du bot.
 * TELEGRAM_CHAT_ID n'est plus lu nulle part ; seul TELEGRAM_BOT_TOKEN reste.
 */

const logger = require('../utils/logger');
const db     = require('../config/db');

const APP_URL = require('../config/env').FRONTEND_URL;

/** Chat Telegram d'un user, ou null s'il n'a pas lié/activé Telegram. */
async function getUserTelegramChat(userId) {
  const { rows } = await db.query(
    `SELECT telegram_chat_id
       FROM user_settings
      WHERE user_id = $1 AND COALESCE(telegram_enabled, false) = true`,
    [userId]
  );
  const id = rows[0] && rows[0].telegram_chat_id;
  return id ? String(id) : null;
}

/** Envoi bas niveau vers un chat précis. Ne jette jamais. Retourne true/false. */
async function sendTelegramMessage(chatId, text) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN)  { logger.warn('[telegram] TELEGRAM_BOT_TOKEN missing — skipping'); return false; }
  if (!chatId) return false;                       // user sans Telegram lié : rien à envoyer
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    if (!data.ok) { logger.error(`[telegram] API error: ${JSON.stringify(data)}`); return false; }
    return true;
  } catch (err) {
    logger.error(`[telegram] Fetch error: ${err.message}`);
    return false;
  }
}

async function sendTelegramAlert({ chatId, symbol, type, condition, target, currentPrice }) {
  if (!chatId) return false;

  const condLabel = condition === 'above' ? '📈 crossed above'
                  : condition === 'below' ? '📉 dropped below'
                  : '🎯 reached';

  const text = [
    `🔔 *AtlasQuant Alert Triggered*`,
    ``,
    `*Symbol:* \`${symbol}\``,
    `*Type:* ${type}`,
    `*Condition:* ${condLabel} \`${target}\``,
    `*Current Price:* \`$${parseFloat(currentPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\``,
    `*Time:* ${new Date().toUTCString()}`,
    ``,
    `[Open AtlasQuant](${APP_URL}/alerts)`,
  ].join('\n');

  const ok = await sendTelegramMessage(chatId, text);
  if (ok) logger.info(`[telegram] ✅ Alert sent → ${symbol} ${condLabel} ${target}`);
  return ok;
}

module.exports = { sendTelegramAlert, sendTelegramMessage, getUserTelegramChat };
