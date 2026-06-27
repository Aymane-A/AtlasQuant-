/**
 * src/services/telegram.service.js — AtlasQuant AI
 * Telegram Bot notifications
 */

const logger = require('../utils/logger');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert({ symbol, type, condition, target, currentPrice }) {
  if (!TOKEN || !CHAT_ID) {
    logger.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — skipping');
    return;
  }

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
    `[Open AtlasQuant](http://localhost:3000/alerts)`,
  ].join('\n');

  try {
    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    });

    const data = await res.json();
    if (data.ok) {
      logger.info(`[telegram] ✅ Alert sent → ${symbol} ${condLabel} ${target}`);
    } else {
      logger.error(`[telegram] API error: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    logger.error(`[telegram] Fetch error: ${err.message}`);
  }
}

module.exports = { sendTelegramAlert };