/**
 * src/services/tradeEmail.service.js — AtlasQuant AI
 * Email "Auto-trade opened / closed" — même identité visuelle que les
 * templates de email.service.js (carte sombre, JetBrains Mono, accent
 * cyan/rouge), mais dans son propre fichier pour ne pas toucher à
 * email.service.js. Un seul transporter réutilisé pour tous les envois
 * (avant : un nouveau transporter créé à chaque email).
 */

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

const money = (n, d = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * pnl === undefined/null  → email "trade opened"
 * pnl défini              → email "trade closed"
 */
async function sendTradeEmail(to, { symbol, side, price, reason, pnl, pnlPct }) {
  const isOpen = pnl === undefined || pnl === null;
  const isWin  = !isOpen && Number(pnl) > 0;

  const accent = isOpen ? '#60a5fa' : isWin ? '#00f5d4' : '#f87171';
  const glow   = isOpen ? 'rgba(96,165,250,0.12)' : isWin ? 'rgba(0,245,212,0.12)' : 'rgba(248,113,113,0.12)';
  const badge  = isOpen ? 'Trade Opened' : isWin ? 'Trade Closed · Profit' : 'Trade Closed · Loss';
  const sideLabel = String(side).toUpperCase();
  const reasonLabel = reason ? String(reason).replace(/_/g, ' ') : null;

  const pnlText = isOpen ? '' :
    `${pnl >= 0 ? '+' : '-'}$${money(Math.abs(pnl))}` +
    (pnlPct != null ? ` (${pnlPct >= 0 ? '+' : ''}${Number(pnlPct).toFixed(1)}%)` : '');

  const row = (label, value, color = '#e2e8f0') => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #ffffff06;font-size:13px;color:#475569">${label}</td>
      <td style="padding:10px 0;border-bottom:1px solid #ffffff06;font-size:13px;color:${color};font-family:'JetBrains Mono',monospace;font-weight:600;text-align:right">${value}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Auto-trade — ${symbol}</title>
</head>
<body style="margin:0;background:#06060f;font-family:'Space Grotesk','Segoe UI',sans-serif;color:#e2e8f0">
<div style="background:#06060f;padding:40px 20px">
  <div style="max-width:560px;margin:0 auto">

    <div style="padding-bottom:24px;border-bottom:1px solid #ffffff0f;margin-bottom:28px">
      <div style="font-size:18px;font-weight:700;color:#fff">Atlas<span style="color:#00f5d4">Quant</span> <span style="color:#475569;font-size:13px;font-weight:400">AI</span></div>
      <div style="font-size:10px;font-family:'JetBrains Mono',monospace;color:#64748b;letter-spacing:.12em;text-transform:uppercase;margin-top:2px">Auto-Trader</div>
    </div>

    <div style="background:#0d0d1a;border:1px solid #ffffff0f;border-radius:16px;overflow:hidden">
      <div style="padding:32px 32px 24px">
        <div style="display:inline-block;background:${glow};border:1px solid ${accent}33;border-radius:8px;padding:8px 14px;margin-bottom:18px">
          <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${accent};letter-spacing:.1em;text-transform:uppercase;font-weight:700">${badge}</span>
        </div>
        <div style="font-size:26px;font-weight:700;color:${accent};letter-spacing:-.02em">${symbol}</div>
        <div style="font-size:14px;color:#94a3b8;margin-top:6px">${isOpen
          ? `Auto-trader opened a <b>${sideLabel}</b> position.`
          : `Auto-trader closed your <b>${sideLabel}</b> position${reasonLabel ? ` (${reasonLabel})` : ''}.`}</div>

        ${isOpen ? '' : `
        <div style="background:${glow};border:1px solid ${accent}22;border-radius:12px;padding:18px 22px;margin-top:22px">
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#64748b;letter-spacing:.1em;margin-bottom:6px">RESULT</div>
          <div style="font-size:28px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${accent}">${pnlText}</div>
        </div>`}
      </div>

      <div style="padding:0 32px 28px">
        <table style="width:100%;border-collapse:collapse">
          ${row('Symbol', symbol, accent)}
          ${row('Side', sideLabel)}
          ${row('Entry price', '$' + money(price, 4))}
          ${reasonLabel && !isOpen ? row('Closed by', reasonLabel) : ''}
        </table>
        <div style="text-align:center;margin-top:26px">
          <a href="http://localhost:3000/paper-trading" style="display:inline-block;padding:13px 32px;border-radius:10px;background:${accent};color:#06060f;font-size:14px;font-weight:700;text-decoration:none">View Paper Trading →</a>
        </div>
      </div>

      <div style="padding:18px 32px;border-top:1px solid #ffffff08;background:#0a0a15;text-align:center;font-size:12px;color:#475569;font-family:'JetBrains Mono',monospace">
        Simulated (paper) trade — no real funds involved · AtlasQuant AI
      </div>
    </div>

  </div>
</div>
</body>
</html>`;

  const subject = isOpen
    ? `🤖 Auto-trade opened — ${sideLabel} ${symbol} @ $${money(price)}`
    : `🤖 Auto-trade closed — ${symbol} ${isWin ? '✅' : '🔻'} ${pnl >= 0 ? '+' : '-'}$${money(Math.abs(pnl))}`;

  await transporter.sendMail({
    from: `"AtlasQuant AI" <${process.env.EMAIL_USER}>`,
    to, subject, html,
  });

  logger.info(`[tradeEmail] ✅ ${isOpen ? 'opened' : 'closed'} email → ${to} (${symbol})`);
}

module.exports = { sendTradeEmail };