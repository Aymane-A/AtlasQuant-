/**
 * src/services/email.service.js — AtlasQuant AI
 * Nodemailer + Gmail SMTP
 */

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Verify connection on startup ──────────────────────────
transporter.verify((err) => {
  if (err) logger.error(`[email] SMTP error: ${err.message}`);
  else     logger.info('[email] ✅ Gmail SMTP ready');
});

// ── Alert triggered email ─────────────────────────────────
async function sendAlertEmail({ to, symbol, type, condition, target, currentPrice }) {
  const condLabel = condition === 'above' ? 'crossed above' : condition === 'below' ? 'dropped below' : 'reached';
  const subject   = `🔔 AtlasQuant Alert — ${symbol} ${condLabel} ${target}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <style>
        body { margin:0; padding:0; background:#0a0a0f; font-family:'Segoe UI',sans-serif; color:#e2e8f0; }
        .wrap { max-width:520px; margin:40px auto; background:#111118; border:1px solid #1e1e2e; border-radius:16px; overflow:hidden; }
        .header { background:linear-gradient(135deg,#00f5d4 0%,#0ea5e9 100%); padding:28px 32px; }
        .header h1 { margin:0; font-size:22px; color:#0a0a0f; font-weight:800; letter-spacing:.04em; }
        .header p  { margin:6px 0 0; font-size:13px; color:#0a0a0f; opacity:.75; }
        .body { padding:28px 32px; }
        .badge { display:inline-block; background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3); border-radius:6px; padding:4px 12px; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; margin-bottom:20px; }
        .row { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #1e1e2e; font-size:13px; }
        .row:last-child { border-bottom:none; }
        .label { color:#64748b; }
        .value { color:#e2e8f0; font-weight:600; font-family:monospace; }
        .value.green { color:#00f5d4; }
        .value.amber { color:#fbbf24; }
        .cta { margin-top:24px; text-align:center; }
        .btn { display:inline-block; background:linear-gradient(135deg,#00f5d4,#0ea5e9); color:#0a0a0f; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:700; font-size:14px; letter-spacing:.04em; }
        .footer { padding:16px 32px; text-align:center; font-size:11px; color:#334155; border-top:1px solid #1e1e2e; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="header">
          <h1>AtlasQuant AI</h1>
          <p>Price Alert Triggered</p>
        </div>
        <div class="body">
          <div class="badge">🔔 Alert Triggered</div>
          <div class="row">
            <span class="label">Symbol</span>
            <span class="value green">${symbol}</span>
          </div>
          <div class="row">
            <span class="label">Alert Type</span>
            <span class="value">${type}</span>
          </div>
          <div class="row">
            <span class="label">Condition</span>
            <span class="value">${condLabel}</span>
          </div>
          <div class="row">
            <span class="label">Target Price</span>
            <span class="value amber">$${parseFloat(target).toLocaleString()}</span>
          </div>
          <div class="row">
            <span class="label">Current Price</span>
            <span class="value green">$${parseFloat(currentPrice).toLocaleString()}</span>
          </div>
          <div class="row">
            <span class="label">Time</span>
            <span class="value">${new Date().toUTCString()}</span>
          </div>
          <div class="cta">
            <a href="http://localhost:3000/alerts" class="btn">View Alerts Dashboard</a>
          </div>
        </div>
        <div class="footer">
          AtlasQuant AI · Automated alert system · You can manage your alerts at any time.
        </div>
      </div>
    </body>
    </html>
  `;

  await transporter.sendMail({
    from:    `"AtlasQuant AI " <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });

  logger.info(`[email] ✅ Alert email sent → ${to} (${symbol} ${condLabel} ${target})`);
}

module.exports = { sendAlertEmail };