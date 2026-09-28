/**
 * services/tradeNotify.service.js — AtlasQuant AI
 *
 * Sends email + Telegram notifications when auto-trade actually opens or
 * closes a paper trade — distinct from signalAlert.service.js, which only
 * notifies on raw AI signals (BUY/SELL detected), never on trades
 * autoTrader itself executed. Without this, a user had no way to know
 * auto-trade did anything except by checking the Paper Trading dashboard
 * manually.
 *
 * Respects the same per-user toggles signalAlert.service.js uses
 * (user_settings.notifications->>'email_alerts', telegram_enabled) so a
 * user who turned notifications off isn't spammed by trade events either.
 * Never throws into the caller — a notification failure must never stop
 * autoTrader/paperTradeMonitor from doing their actual job.
 */

const db     = require('../config/db');
const logger = require('../utils/logger');
const { sendTradeEmail } = require('./tradeEmail.service');

async function getUserNotifyPrefs(userId) {
  const { rows } = await db.query(`
    SELECT u.email,
           COALESCE((us.notifications->>'email_alerts')::boolean, true) AS email_enabled,
           COALESCE(us.telegram_enabled, false) AS telegram_enabled,
           us.telegram_chat_id
    FROM users u
    LEFT JOIN user_settings us ON us.user_id = u.id
    WHERE u.id = $1
  `, [userId]);
  return rows[0] || null;
}

async function sendTradeTelegram(chatId, { symbol, side, price, reason, pnl, pnlPct }) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN || !chatId) return;

  const isOpen = pnl === undefined || pnl === null;
  const isWin  = !isOpen && Number(pnl) > 0;
  const emoji  = isOpen ? '🤖' : isWin ? '✅' : '🔻';

  const lines = isOpen
    ? [`${emoji} *Auto-trade opened*`, ``, `*${symbol}* — ${side.toUpperCase()} @ \`$${Number(price).toFixed(2)}\``, `_Simulated paper trade_`]
    : [
        `${emoji} *Auto-trade closed*`, ``, `*${symbol}*`,
        `Result: \`${pnl >= 0 ? '+' : ''}$${Number(pnl).toFixed(2)}${pnlPct != null ? ` (${pnlPct >= 0 ? '+' : ''}${Number(pnlPct).toFixed(1)}%)` : ''}\``,
        reason ? `Reason: ${reason}` : null,
      ].filter(Boolean);

  try {
    const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    if (!data.ok) logger.error(`[tradeNotify] Telegram error: ${JSON.stringify(data)}`);
  } catch (e) {
    logger.error(`[tradeNotify] Telegram failed: ${e.message}`);
  }
}

async function notifyTradeOpened(userId, { symbol, side, price }) {
  try {
    const prefs = await getUserNotifyPrefs(userId);
    if (!prefs) return;
    if (prefs.email_enabled) {
      sendTradeEmail(prefs.email, { symbol, side, price })
        .catch(e => logger.error(`[tradeNotify] email failed: ${e.message}`));
    }
    if (prefs.telegram_enabled && prefs.telegram_chat_id) {
      sendTradeTelegram(prefs.telegram_chat_id, { symbol, side, price })
        .catch(e => logger.error(`[tradeNotify] telegram failed: ${e.message}`));
    }
  } catch (e) {
    logger.error(`[tradeNotify] notifyTradeOpened error: ${e.message}`);
  }
}

async function notifyTradeClosed(userId, { symbol, side, price, reason, pnl, pnlPct }) {
  try {
    const prefs = await getUserNotifyPrefs(userId);
    if (!prefs) return;
    if (prefs.email_enabled) {
      sendTradeEmail(prefs.email, { symbol, side, price, reason, pnl, pnlPct })
        .catch(e => logger.error(`[tradeNotify] email failed: ${e.message}`));
    }
    if (prefs.telegram_enabled && prefs.telegram_chat_id) {
      sendTradeTelegram(prefs.telegram_chat_id, { symbol, side, price, reason, pnl, pnlPct })
        .catch(e => logger.error(`[tradeNotify] telegram failed: ${e.message}`));
    }
  } catch (e) {
    logger.error(`[tradeNotify] notifyTradeClosed error: ${e.message}`);
  }
}

module.exports = { notifyTradeOpened, notifyTradeClosed };