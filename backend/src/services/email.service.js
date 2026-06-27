/**
 * src/services/email.service.js — AtlasQuant AI
 * Nodemailer + Gmail SMTP — 2 email templates
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

transporter.verify((err) => {
  if (err) logger.error(`[email] SMTP error: ${err.message}`);
  else     logger.info('[email] ✅ Gmail SMTP ready');
});

// ── Shared CSS variables ──────────────────────────────────
const BASE_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#06060f; font-family:'Space Grotesk',sans-serif; color:#e2e8f0; -webkit-font-smoothing:antialiased; }
  .outer { background:#06060f; padding:40px 20px; }
  .wrap  { max-width:560px; margin:0 auto; }

  /* Header bar */
  .topbar { display:flex; align-items:center; justify-content:space-between; padding:0 0 28px; border-bottom:1px solid #ffffff0f; margin-bottom:32px; }
  .logo   { font-family:'Space Grotesk',sans-serif; font-size:18px; font-weight:700; color:#fff; letter-spacing:-.02em; }
  .logo span { color:#00f5d4; }
  .logo-tag { font-size:10px; font-family:'JetBrains Mono',monospace; color:#64748b; letter-spacing:.12em; text-transform:uppercase; }

  /* Card */
  .card { background:#0d0d1a; border:1px solid #ffffff0f; border-radius:16px; overflow:hidden; }
  .card-hero { padding:36px 36px 28px; }
  .card-body { padding:0 36px 36px; }
  .card-footer-inner { padding:24px 36px; border-top:1px solid #ffffff08; background:#0a0a15; }

  /* Type */
  .eyebrow { font-size:10px; font-family:'JetBrains Mono',monospace; letter-spacing:.18em; text-transform:uppercase; color:#64748b; margin-bottom:12px; }
  .h1 { font-size:28px; font-weight:700; line-height:1.15; letter-spacing:-.02em; color:#fff; }
  .h1 span { display:block; }
  .subtitle { font-size:14px; color:#64748b; margin-top:8px; line-height:1.5; }

  /* Divider */
  .divider { height:1px; background:linear-gradient(90deg,transparent,#ffffff12,transparent); margin:24px 0; }

  /* Data rows */
  .data-grid { display:table; width:100%; border-collapse:collapse; }
  .data-row  { display:table-row; }
  .data-label,.data-val { display:table-cell; padding:10px 0; border-bottom:1px solid #ffffff06; font-size:13px; vertical-align:middle; }
  .data-label { color:#475569; width:45%; }
  .data-val   { color:#e2e8f0; font-family:'JetBrains Mono',monospace; font-weight:600; text-align:right; }
  .data-row:last-child .data-label,
  .data-row:last-child .data-val { border-bottom:none; }

  /* CTA */
  .cta-wrap { margin-top:28px; text-align:center; }
  .cta-btn  { display:inline-block; padding:14px 36px; border-radius:10px; font-family:'Space Grotesk',sans-serif; font-size:14px; font-weight:700; letter-spacing:.02em; text-decoration:none; }

  /* Footer */
  .footer { margin-top:28px; text-align:center; font-size:11px; font-family:'JetBrains Mono',monospace; color:#334155; line-height:1.8; }
  .footer a { color:#475569; text-decoration:none; }
`;

// ── TEMPLATE 1 — Alert Triggered ─────────────────────────
async function sendAlertEmail({ to, symbol, type, condition, target, currentPrice }) {
  const condLabel  = condition === 'above' ? 'crossed above' : condition === 'below' ? 'dropped below' : 'reached';
  const isPositive = condition === 'above';
  const accentColor = isPositive ? '#00f5d4' : '#f87171';
  const accentGlow  = isPositive ? 'rgba(0,245,212,0.12)' : 'rgba(248,113,113,0.12)';
  const icon        = isPositive ? '↑' : '↓';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Alert Triggered — ${symbol}</title>
<style>
${BASE_STYLES}
.hero-badge {
  display:inline-flex; align-items:center; gap:8px;
  background:${accentGlow}; border:1px solid ${accentColor}22;
  border-radius:8px; padding:8px 14px; margin-bottom:20px;
}
.hero-badge-dot { width:8px; height:8px; border-radius:50%; background:${accentColor}; animation:pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.hero-badge-text { font-size:11px; font-family:'JetBrains Mono',monospace; color:${accentColor}; letter-spacing:.1em; text-transform:uppercase; font-weight:700; }
.price-block { background:${accentGlow}; border:1px solid ${accentColor}22; border-radius:12px; padding:20px 24px; margin:24px 0; display:flex; align-items:center; justify-content:space-between; }
.price-main  { font-size:32px; font-weight:700; font-family:'JetBrains Mono',monospace; color:${accentColor}; }
.price-icon  { font-size:28px; color:${accentColor}; opacity:.6; }
.target-line { font-size:12px; font-family:'JetBrains Mono',monospace; color:#475569; margin-top:4px; }
</style>
</head>
<body>
<div class="outer">
  <div class="wrap">

    <!-- Top bar -->
    <div class="topbar">
      <div>
        <div class="logo">Atlas<span>Quant</span> <span style="color:#475569;font-size:13px;font-weight:400">AI</span></div>
        <div class="logo-tag">Alert Engine</div>
      </div>
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#334155">${new Date().toUTCString().slice(0,16)}</div>
    </div>

    <!-- Card -->
    <div class="card">
      <div class="card-hero">
        <div class="hero-badge">
          <div class="hero-badge-dot"></div>
          <div class="hero-badge-text">Alert Triggered</div>
        </div>
        <div class="eyebrow">Price Alert · ${type}</div>
        <div class="h1">
          <span style="color:${accentColor}">${symbol}</span>
          <span style="font-size:20px;font-weight:500;color:#94a3b8">${condLabel} your target</span>
        </div>
        <div class="subtitle">Your alert condition has been met. Review the details below.</div>

        <!-- Price block -->
        <div class="price-block">
          <div>
            <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#64748b;letter-spacing:.1em;margin-bottom:6px">CURRENT PRICE</div>
            <div class="price-main">$${parseFloat(currentPrice).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div class="target-line">Target: ${condLabel} $${parseFloat(target).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
          <div class="price-icon">${icon}</div>
        </div>
      </div>

      <div class="card-body">
        <div class="divider"></div>

        <!-- Data rows -->
        <div class="data-grid">
          <div class="data-row">
            <div class="data-label">Symbol</div>
            <div class="data-val" style="color:${accentColor}">${symbol}</div>
          </div>
          <div class="data-row">
            <div class="data-label">Alert Type</div>
            <div class="data-val">${type}</div>
          </div>
          <div class="data-row">
            <div class="data-label">Condition</div>
            <div class="data-val">${condLabel}</div>
          </div>
          <div class="data-row">
            <div class="data-label">Target Price</div>
            <div class="data-val">$${parseFloat(target).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
          <div class="data-row">
            <div class="data-label">Triggered At</div>
            <div class="data-val">${new Date().toUTCString()}</div>
          </div>
        </div>

        <!-- CTA -->
        <div class="cta-wrap">
          <a href="http://localhost:3000/alerts" class="cta-btn" style="background:${accentColor};color:#06060f">
            View Alerts Dashboard →
          </a>
        </div>
      </div>

      <div class="card-footer-inner">
        <div style="font-size:12px;color:#475569;font-family:'JetBrains Mono',monospace;text-align:center">
          This is an automated alert from AtlasQuant AI · Not financial advice
        </div>
      </div>
    </div>

    <div class="footer">
      AtlasQuant AI &nbsp;·&nbsp; <a href="#">Manage Alerts</a> &nbsp;·&nbsp; <a href="#">Unsubscribe</a>
    </div>

  </div>
</div>
</body>
</html>`;

  await transporter.sendMail({
    from:    `"AtlasQuant AI" <${process.env.EMAIL_USER}>`,
    to,
    subject: `🔔 Alert: ${symbol} ${condLabel} $${parseFloat(target).toLocaleString()}`,
    html,
  });

  logger.info(`[email] ✅ Alert email → ${to} (${symbol})`);
}

// ── TEMPLATE 2 — AI Signal ───────────────────────────────
async function sendSignalEmail({ to, symbol, signal, confidence, entry, stop_loss, take_profit, risk_reward, reasoning }) {
  const isBuy      = signal === 'BUY';
  const accentColor = isBuy ? '#00f5d4' : '#f87171';
  const accentGlow  = isBuy ? 'rgba(0,245,212,0.1)' : 'rgba(248,113,113,0.1)';
  const action      = isBuy ? 'BUY · LONG' : signal === 'SELL' ? 'SELL · SHORT' : 'HOLD';
  const signalEmoji = isBuy ? '▲' : signal === 'SELL' ? '▼' : '—';
  const confW       = Math.min(confidence, 100);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AI Signal — ${symbol}</title>
<style>
${BASE_STYLES}
.signal-hero {
  background:linear-gradient(135deg,${accentGlow} 0%,transparent 60%);
  border-bottom:1px solid ${accentColor}18;
  padding:36px 36px 28px;
}
.signal-badge {
  display:inline-flex; align-items:center; gap:6px;
  background:#ffffff06; border:1px solid #ffffff0f;
  border-radius:6px; padding:5px 12px; margin-bottom:18px;
}
.signal-badge-text { font-size:10px; font-family:'JetBrains Mono',monospace; color:#64748b; letter-spacing:.14em; text-transform:uppercase; }
.action-pill {
  display:inline-block; padding:8px 20px; border-radius:8px;
  background:${accentColor}; color:#06060f;
  font-size:13px; font-weight:800; letter-spacing:.08em;
  font-family:'JetBrains Mono',monospace; margin:16px 0 0;
}
.conf-section { padding:0 36px; margin:24px 0; }
.conf-label-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
.conf-label { font-size:11px; font-family:'JetBrains Mono',monospace; color:#64748b; letter-spacing:.1em; text-transform:uppercase; }
.conf-value { font-size:14px; font-family:'JetBrains Mono',monospace; font-weight:700; color:${accentColor}; }
.conf-track { height:6px; background:#ffffff08; border-radius:3px; overflow:hidden; }
.conf-fill  { height:6px; border-radius:3px; background:linear-gradient(90deg,${accentColor}88,${accentColor}); width:${confW}%; }
.levels-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; padding:0 36px; margin:20px 0; }
.level-box { background:#ffffff04; border:1px solid #ffffff0a; border-radius:10px; padding:14px 16px; }
.level-box-label { font-size:10px; font-family:'JetBrains Mono',monospace; color:#475569; letter-spacing:.1em; text-transform:uppercase; margin-bottom:6px; }
.level-box-val { font-size:14px; font-family:'JetBrains Mono',monospace; font-weight:700; }
.reasoning-box { margin:0 36px 28px; padding:16px 18px; background:#ffffff03; border-left:3px solid ${accentColor}44; border-radius:0 8px 8px 0; }
.reasoning-box p { font-size:12px; color:#64748b; line-height:1.7; }
</style>
</head>
<body>
<div class="outer">
  <div class="wrap">

    <!-- Top bar -->
    <div class="topbar">
      <div>
        <div class="logo">Atlas<span>Quant</span> <span style="color:#475569;font-size:13px;font-weight:400">AI</span></div>
        <div class="logo-tag">Alpha Engine · Signal</div>
      </div>
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#334155">${new Date().toUTCString().slice(0,16)}</div>
    </div>

    <!-- Card -->
    <div class="card">

      <!-- Hero -->
      <div class="signal-hero">
        <div class="signal-badge">
          <div class="signal-badge-text">🤖 AI-Generated Signal</div>
        </div>
        <div class="eyebrow">Alpha Engine Detection</div>
        <div class="h1">
          <span style="color:${accentColor}">${symbol}</span>
          <span style="font-size:20px;font-weight:500;color:#94a3b8"> opportunity detected</span>
        </div>
        <div class="subtitle">The AI engine has identified a high-confidence trading opportunity.</div>
        <div class="action-pill">${signalEmoji} ${action}</div>
      </div>

      <!-- Confidence bar -->
      <div class="conf-section">
        <div class="divider"></div>
        <div class="conf-label-row">
          <div class="conf-label">AI Confidence Score</div>
          <div class="conf-value">${confidence}%</div>
        </div>
        <div class="conf-track">
          <div class="conf-fill"></div>
        </div>
      </div>

      <!-- Entry / SL / TP -->
      <div class="levels-grid">
        <div class="level-box">
          <div class="level-box-label">Entry</div>
          <div class="level-box-val" style="color:#e2e8f0">$${parseFloat(entry).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
        <div class="level-box" style="border-color:#f8717118">
          <div class="level-box-label">Stop Loss</div>
          <div class="level-box-val" style="color:#f87171">${stop_loss ? '$'+parseFloat(stop_loss).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</div>
        </div>
        <div class="level-box" style="border-color:#00f5d418">
          <div class="level-box-label">Take Profit</div>
          <div class="level-box-val" style="color:#00f5d4">${take_profit ? '$'+parseFloat(take_profit).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</div>
        </div>
      </div>

      <div class="card-body" style="padding-top:0">
        <!-- R:R -->
        ${risk_reward ? `
        <div class="divider"></div>
        <div class="data-grid">
          <div class="data-row">
            <div class="data-label">Risk / Reward</div>
            <div class="data-val" style="color:${accentColor}">${risk_reward}</div>
          </div>
          <div class="data-row">
            <div class="data-label">Signal Strength</div>
            <div class="data-val">${confidence >= 85 ? '🔥 Very Strong' : confidence >= 75 ? '⚡ Strong' : '✓ Moderate'}</div>
          </div>
        </div>
        ` : ''}

        <!-- Reasoning -->
        ${reasoning ? `
        <div style="margin-top:20px"></div>
        <div class="reasoning-box">
          <div style="font-size:10px;font-family:'JetBrains Mono',monospace;color:#64748b;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px">AI Reasoning</div>
          <p>${reasoning}</p>
        </div>
        ` : ''}

        <!-- CTA -->
        <div class="cta-wrap">
          <a href="http://localhost:3000/signals" class="cta-btn" style="background:${accentColor};color:#06060f">
            View Full Signal →
          </a>
        </div>
      </div>

      <div class="card-footer-inner">
        <div style="font-size:12px;color:#475569;font-family:'JetBrains Mono',monospace;text-align:center">
          AI-generated signal · Not financial advice · AtlasQuant AI
        </div>
      </div>
    </div>

    <div class="footer">
      AtlasQuant AI &nbsp;·&nbsp; <a href="#">Signals Dashboard</a> &nbsp;·&nbsp; <a href="#">Unsubscribe</a>
    </div>

  </div>
</div>
</body>
</html>`;

  await transporter.sendMail({
    from:    `"AtlasQuant AI" <${process.env.EMAIL_USER}>`,
    to,
    subject: `${isBuy ? '▲' : '▼'} AI Signal: ${action} ${symbol} — ${confidence}% confidence`,
    html,
  });

  logger.info(`[email] ✅ Signal email → ${to} (${symbol} ${signal} ${confidence}%)`);
}

module.exports = { sendAlertEmail, sendSignalEmail };