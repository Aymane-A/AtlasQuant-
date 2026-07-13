/**
 * src/services/signalAlert.service.js — AtlasQuant AI
 * Auto-generates alerts + sends notifications when AI detects high-confidence signals
 */

const db                    = require('../config/db');
const logger                = require('../utils/logger');
const { sendAlertEmail }    = require('./email.service');
const { sendTelegramAlert } = require('./telegram.service');

const MIN_CONFIDENCE = 75; // Only alert on signals >= 75% confidence

// ✅ Feature: tokens spéciaux qu'un utilisateur peut ajouter à sa liste de
// symboles suivis pour couvrir toute une classe d'actifs d'un coup, sans
// devoir taper chaque ticker un par un (ex. "ALL_CRYPTO" au lieu de BTC,
// ETH, SOL, ... un par un).
const CLASS_WILDCARDS = {
  ALL_CRYPTO:    'Crypto',
  ALL_FOREX:     'Forex',
  ALL_COMMODITY: 'Commodity',
  ALL_INDICES:   'Indices',
};

// ✅ Fix: fenêtre de cooldown par symbole. `signals` est une table insert-only
// (chaque scan crée une nouvelle ligne avec un nouvel id, même pour un signal
// quasi identique). L'ancien dedup comparait sur `id`, qui est TOUJOURS
// différent d'un scan à l'autre — résultat : une alerte + email + Telegram à
// chaque cycle de scan pour le même symbole (ex. FILUSDT alerté 5 fois dans
// la même journée avec des confidences à peine différentes). Le dedup se fait
// maintenant sur symbole + fenêtre de temps, indépendamment de l'id du signal.
const ALERT_COOLDOWN_HOURS = 12;

// ── Email template for AI signals ────────────────────────
async function sendSignalEmail({ to, symbol, signal, confidence, entry, stop_loss, take_profit, risk_reward, reasoning }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  const isCall   = signal === 'BUY';
  const emoji    = isCall ? '🟢' : signal === 'SELL' ? '🔴' : '🟡';
  const color    = isCall ? '#00f5d4' : signal === 'SELL' ? '#f87171' : '#fbbf24';
  const action   = isCall ? 'BUY / LONG' : signal === 'SELL' ? 'SELL / SHORT' : 'HOLD';

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"/>
    <style>
      body { margin:0; padding:0; background:#0a0a0f; font-family:'Segoe UI',sans-serif; color:#e2e8f0; }
      .wrap { max-width:520px; margin:40px auto; background:#111118; border:1px solid #1e1e2e; border-radius:16px; overflow:hidden; }
      .header { background:linear-gradient(135deg,${color}22 0%,#0a0a0f 100%); border-bottom:2px solid ${color}; padding:28px 32px; }
      .badge { display:inline-block; background:${color}22; color:${color}; border:1px solid ${color}44; border-radius:8px; padding:6px 16px; font-size:13px; font-weight:800; letter-spacing:.08em; margin-bottom:12px; }
      .title { font-size:24px; font-weight:800; color:#fff; margin:0; }
      .sub   { font-size:13px; color:#64748b; margin:4px 0 0; }
      .body  { padding:28px 32px; }
      .conf  { display:flex; align-items:center; gap:10px; margin-bottom:20px; }
      .conf-bar { flex:1; height:6px; background:#1e1e2e; border-radius:3px; overflow:hidden; }
      .conf-fill { height:100%; border-radius:3px; background:${color}; }
      .conf-label { font-size:12px; color:${color}; font-weight:700; font-family:monospace; }
      .row { display:flex; justify-content:space-between; padding:11px 0; border-bottom:1px solid #1e1e2e; font-size:13px; }
      .row:last-child { border-bottom:none; }
      .label { color:#64748b; }
      .value { color:#e2e8f0; font-weight:600; font-family:monospace; }
      .reasoning { margin-top:20px; padding:14px 16px; background:#0a0a0f; border-radius:10px; border-left:3px solid ${color}; font-size:12px; color:#94a3b8; line-height:1.6; }
      .cta { margin-top:24px; text-align:center; }
      .btn { display:inline-block; background:${color}; color:#0a0a0f; text-decoration:none; padding:12px 32px; border-radius:8px; font-weight:800; font-size:14px; letter-spacing:.04em; }
      .footer { padding:16px 32px; text-align:center; font-size:11px; color:#334155; border-top:1px solid #1e1e2e; }
    </style>
    </head>
    <body>
    <div class="wrap">
      <div class="header">
        <div class="badge">${emoji} AI SIGNAL · ${action}</div>
        <div class="title">${symbol}</div>
        <div class="sub">AtlasQuant Alpha Engine · Auto-detected</div>
      </div>
      <div class="body">
        <div class="conf">
          <span class="label" style="font-size:12px;color:#64748b">AI Confidence</span>
          <div class="conf-bar"><div class="conf-fill" style="width:${confidence}%"></div></div>
          <span class="conf-label">${confidence}%</span>
        </div>
        <div class="row"><span class="label">Signal</span><span class="value" style="color:${color}">${action}</span></div>
        <div class="row"><span class="label">Entry Price</span><span class="value">$${parseFloat(entry).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
        ${stop_loss   ? `<div class="row"><span class="label">Stop Loss</span><span class="value" style="color:#f87171">$${parseFloat(stop_loss).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>` : ''}
        ${take_profit ? `<div class="row"><span class="label">Take Profit</span><span class="value" style="color:#00f5d4">$${parseFloat(take_profit).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>` : ''}
        ${risk_reward ? `<div class="row"><span class="label">Risk/Reward</span><span class="value">${risk_reward}</span></div>` : ''}
        ${reasoning   ? `<div class="reasoning">💡 ${reasoning}</div>` : ''}
        <div class="cta">
          <a href="http://localhost:3000/signals" class="btn">View Full Signal →</a>
        </div>
      </div>
      <div class="footer">AtlasQuant AI · This is an automated AI signal, not financial advice.</div>
    </div>
    </body>
    </html>
  `;

  await transporter.sendMail({
    from:    `"AtlasQuant AI 🤖" <${process.env.EMAIL_USER}>`,
    to,
    subject: `${emoji} AI Signal: ${action} ${symbol} — ${confidence}% confidence`,
    html,
  });

  logger.info(`[signalAlert] ✅ Signal email → ${to} (${symbol} ${signal} ${confidence}%)`);
}

// ── Telegram message for AI signals ──────────────────────
async function sendSignalTelegram({ symbol, signal, confidence, entry, stop_loss, take_profit, risk_reward, reasoning }) {
  const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHAT_ID) return;

  const emoji  = signal === 'BUY' ? '🟢' : signal === 'SELL' ? '🔴' : '🟡';
  const action = signal === 'BUY' ? 'BUY / LONG' : signal === 'SELL' ? 'SELL / SHORT' : 'HOLD';

  const lines = [
    `${emoji} *AI Signal Detected — AtlasQuant*`,
    ``,
    `*Symbol:* \`${symbol}\``,
    `*Action:* *${action}*`,
    `*Confidence:* \`${confidence}%\``,
    `*Entry:* \`$${parseFloat(entry).toFixed(2)}\``,
    stop_loss   ? `*Stop Loss:* \`$${parseFloat(stop_loss).toFixed(2)}\`` : null,
    take_profit ? `*Take Profit:* \`$${parseFloat(take_profit).toFixed(2)}\`` : null,
    risk_reward ? `*R:R:* \`${risk_reward}\`` : null,
    reasoning   ? `\n💡 _${reasoning.slice(0, 200)}..._` : null,
    ``,
    `[Open AtlasQuant](http://localhost:3000/signals)`,
  ].filter(Boolean).join('\n');

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: lines, parse_mode: 'Markdown' }),
  });

  const data = await res.json();
  if (data.ok) logger.info(`[signalAlert] ✅ Telegram signal → ${symbol} ${signal} ${confidence}%`);
  else logger.error(`[signalAlert] Telegram error: ${JSON.stringify(data)}`);
}

// ── Main: check new high-confidence signals ───────────────
async function checkSignalAlerts() {
  try {
    // ✅ Feature: on récupère aussi les préférences d'alertes AI de chaque
    // utilisateur (signal_alert_mode: 'all'|'custom', signal_alert_symbols:
    // liste de tickers précis suivis en mode 'custom', ex. ["BTCUSDT","AAPL"]).
    // Définies via POST /api/settings/update { section:'signalAlerts', payload:{mode,symbols} }.
    const { rows: users } = await db.query(`
      SELECT u.id, u.email, u.name,
             COALESCE(us.notifications, true)         AS notifications,
             COALESCE(us.signal_alert_mode, 'all')     AS alert_mode,
             COALESCE(us.signal_alert_symbols, '[]'::jsonb) AS alert_symbols
      FROM users u
      LEFT JOIN user_settings us ON us.user_id = u.id
      WHERE COALESCE(us.notifications, true) = true
    `);

    if (users.length === 0) return;

    // ✅ Fix: DISTINCT ON (symbol) — si plusieurs scans dans les 4 dernières
    // heures ont produit plusieurs signaux pour le même symbole (cron +
    // refresh manuel par ex.), on ne garde que le plus confiant, pas un par
    // ligne. Le dedup global par symbole a été retiré d'ici et déplacé au
    // niveau utilisateur (voir recentSet plus bas) — plus correct pour un
    // système multi-utilisateurs : chaque utilisateur a son propre cooldown,
    // indépendant des alertes déjà envoyées à quelqu'un d'autre.
    const { rows: signals } = await db.query(`
      SELECT DISTINCT ON (symbol)
             id, symbol, signal, confidence, price, entry,
             stop_loss, take_profit, risk_reward, reasoning, asset_class, created_at
      FROM signals
      WHERE confidence >= $1
        AND signal IN ('BUY', 'SELL')
        AND created_at >= NOW() - INTERVAL '4 hours'
      ORDER BY symbol, confidence DESC, created_at DESC
      LIMIT 30
    `, [MIN_CONFIDENCE]);

    if (signals.length === 0) return;

    // ✅ Fix: une seule requête pour récupérer tous les cooldowns actifs
    // (user_id + symbol) plutôt qu'une requête par combinaison utilisateur ×
    // signal — évite de spammer la DB, et sert aussi de garde anti-doublon
    // pour la même exécution (on ajoute au Set dès l'insertion décidée).
    const { rows: recentAlerts } = await db.query(`
      SELECT user_id, symbol FROM alerts
      WHERE type = 'ai_signal' AND created_at >= NOW() - ($1 || ' hours')::INTERVAL
    `, [ALERT_COOLDOWN_HOURS]);
    const recentSet = new Set(recentAlerts.map(r => `${r.user_id}:${r.symbol}`));

    logger.info(`[signalAlert] ${signals.length} candidate signal(s) this run`);

    for (const sig of signals) {
      for (const user of users) {
        // ✅ Feature: si l'utilisateur a choisi "custom", on ignore les
        // signaux dont le symbole n'est pas dans sa liste — sauf si un
        // wildcard de classe (ALL_CRYPTO/ALL_FOREX/ALL_COMMODITY/ALL_INDICES)
        // couvre la classe d'actifs du signal. Comparaison insensible à la
        // casse (le symbole en DB est déjà en majuscules, mais on normalise
        // au cas où).
        if (user.alert_mode === 'custom') {
          const raw = Array.isArray(user.alert_symbols)
            ? user.alert_symbols
            : (() => { try { return JSON.parse(user.alert_symbols); } catch { return []; } })();
          const entries = raw.map(s => String(s).toUpperCase().trim());

          const followedClasses = entries
            .filter(e => CLASS_WILDCARDS[e])
            .map(e => CLASS_WILDCARDS[e]);
          const followedSymbols = new Set(entries.filter(e => !CLASS_WILDCARDS[e]));

          const matchesClass  = followedClasses.includes(sig.asset_class);
          const matchesSymbol = followedSymbols.has(sig.symbol.toUpperCase());
          if (!matchesClass && !matchesSymbol) continue;
        }

        const cooldownKey = `${user.id}:${sig.symbol}`;
        if (recentSet.has(cooldownKey)) continue;
        recentSet.add(cooldownKey);

        await db.query(`
          INSERT INTO alerts (user_id, symbol, type, condition, target, triggered, triggered_at, notify_email, notify_telegram, metadata)
          VALUES ($1, $2, 'ai_signal', 'above', $3, true, NOW(), true, true, $4)
          ON CONFLICT DO NOTHING
        `, [
          user.id,
          sig.symbol,
          sig.entry || sig.price,
          JSON.stringify({ signal_id: sig.id, signal: sig.signal, confidence: sig.confidence }),
        ]);

        const payload = {
          symbol:      sig.symbol,
          signal:      sig.signal,
          confidence:  sig.confidence,
          entry:       sig.entry || sig.price,
          stop_loss:   sig.stop_loss,
          take_profit: sig.take_profit,
          risk_reward: sig.risk_reward,
          reasoning:   sig.reasoning,
        };

        // Send email
        try {
          await sendSignalEmail({ to: user.email, ...payload });
        } catch (e) {
          logger.error(`[signalAlert] Email failed: ${e.message}`);
        }

        // Send Telegram
        try {
          await sendSignalTelegram(payload);
        } catch (e) {
          logger.error(`[signalAlert] Telegram failed: ${e.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[signalAlert] Error: ${err.message}`);
  }
}

module.exports = { checkSignalAlerts };