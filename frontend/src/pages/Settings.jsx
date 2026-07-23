import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../services/api';

const monoSm  = { fontFamily:'JetBrains Mono,monospace', fontSize:11 };
const label10 = { fontSize:10, letterSpacing:'.15em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', marginBottom:8, display:'block' };

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', MAD: 'DH', GBP: '£', JPY: '¥',
  CHF: 'CHF', CAD: 'CA$', AUD: 'A$', CNY: '¥', AED: 'AED',
};

const TABS = [
  { id:'profile',       icon:'◉', label:'Profile'        },
  { id:'notifications', icon:'◈', label:'Notifications'  },
  { id:'trading',       icon:'◫', label:'Trading'         },
  { id:'signalAlerts',  icon:'⚡', label:'Signal Alerts'   },
  { id:'webhook',       icon:'🔗', label:'Webhook'         },
  { id:'appearance',    icon:'⬡', label:'Appearance'      },
  { id:'security',      icon:'⬙', label:'Security'        },
  { id:'sessions',      icon:'◐', label:'Sessions'        },
  { id:'apiKeys',       icon:'⚿', label:'API Keys'        },
  { id:'locale',        icon:'🌐', label:'Language & Region' },
  { id:'auditLog',      icon:'📜', label:'Activity Log'   },
  { id:'danger',        icon:'⚠',  label:'Danger Zone'    },
];

// ✅ Fix: les <option> d'un <select> natif restent parfois rendus par le
// système d'exploitation (popup natif Windows/macOS) plutôt que par le
// CSS de la page, même avec un style forcé sur <option>. CustomSelect
// ci-dessous est un dropdown entièrement rendu en React (button + div
// positionnée en absolute) : il n'y a plus de popup natif, donc plus
// jamais de fond blanc, quel que soit le navigateur/OS.
function CustomSelect({ value, onChange, options, placeholder = 'Select...' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width:'100%', textAlign:'left', background:'rgba(255,255,255,0.04)',
          border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px',
          color:'var(--text-primary)', fontFamily:'JetBrains Mono,monospace', fontSize:13,
          cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center',
          boxSizing:'border-box',
        }}
      >
        <span>{selected ? selected.label : placeholder}</span>
        <span style={{ opacity:.5, fontSize:10, marginLeft:8 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 999,

            background: 'rgba(10,15,28,0.45)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',

            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 14,

            overflow: 'hidden',
            overflowY: 'auto',
            maxHeight: 280,

            boxShadow:
              '0 20px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04)',

            transition: 'all .25s ease',
          }}
        >
          {options.map(opt => (
            <div
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              style={{
                padding: '12px 16px',
                color:
                  opt.value === value
                    ? 'var(--cyan)'
                    : 'rgba(255,255,255,.88)',

                background:
                  opt.value === value
                    ? 'rgba(0,245,212,.12)'
                    : 'transparent',

                borderBottom: '1px solid rgba(255,255,255,.03)',

                cursor: 'pointer',
                transition: 'all .18s ease',
              }}
              onMouseEnter={e => {
                if (opt.value !== value)
                  e.currentTarget.style.background = 'rgba(255,255,255,.05)';
              }}
              onMouseLeave={e => {
                if (opt.value !== value)
                  e.currentTarget.style.background = 'transparent';
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:20 }}>
      <label style={label10}>{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, type='text', placeholder='', disabled=false, min, max, step }) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled}
      min={min} max={max} step={step}
      style={{
        width:'100%', background: disabled ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)',
        border:'1px solid var(--border)', borderRadius:8,
        padding:'10px 14px', color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        fontFamily:'JetBrains Mono,monospace', fontSize:13, outline:'none',
        boxSizing:'border-box', transition:'border-color .2s',
        cursor: disabled ? 'not-allowed' : 'text',
      }}
      onFocus={e => !disabled && (e.target.style.borderColor='rgba(0,245,212,0.4)')}
      onBlur={e  => (e.target.style.borderColor='var(--border)')}
    />
  );
}

function Select({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange} style={{
      width:'100%', background:'rgba(255,255,255,0.04)', border:'1px solid var(--border)',
      borderRadius:8, padding:'10px 14px', color:'var(--text-primary)',
      fontFamily:'JetBrains Mono,monospace', fontSize:13, outline:'none',
      cursor:'pointer', boxSizing:'border-box',
    }}>
      {children}
    </select>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button onClick={onChange} style={{
      width:44, height:24, borderRadius:12, border:'none', cursor:'pointer', position:'relative', flexShrink:0,
      background: checked ? 'var(--cyan)' : 'rgba(255,255,255,0.1)',
      transition:'background .2s',
    }}>
      <div style={{
        position:'absolute', top:3, width:18, height:18, borderRadius:'50%', background:'#fff',
        transition:'left .2s', left: checked ? 23 : 3,
      }} />
    </button>
  );
}

function SaveBtn({ onClick, saving, label='Save Changes' }) {
  return (
    <button onClick={onClick} disabled={saving} style={{
      padding:'10px 28px', borderRadius:9, border:'1px solid var(--cyan-dim)',
      background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:13, fontWeight:700,
      fontFamily:'Syne,sans-serif', cursor: saving ? 'not-allowed' : 'pointer',
      opacity: saving ? 0.7 : 1, marginTop:8,
    }}>
      {saving ? 'Saving...' : label}
    </button>
  );
}

function GhostBtn({ onClick, disabled, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:'10px 24px', borderRadius:9, border:'1px solid var(--border)',
      background:'rgba(255,255,255,0.02)', color:'var(--text-primary)', fontSize:13, fontWeight:700,
      fontFamily:'Syne,sans-serif', cursor: disabled ? 'not-allowed' : 'pointer', marginTop:8,
    }}>
      {children}
    </button>
  );
}

function Toast({ msg, ok }) {
  if (!msg) return null;
  return (
    <div style={{
      position:'fixed', bottom:28, right:28, zIndex:9999,
      padding:'12px 20px', borderRadius:10,
      background: ok ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
      border:`1px solid ${ok ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
      color: ok ? 'var(--green)' : 'var(--red)',
      fontFamily:'JetBrains Mono,monospace', fontSize:12,
      boxShadow:'0 4px 24px rgba(0,0,0,0.3)',
    }}>
      {ok ? '✓' : '✕'} {msg}
    </div>
  );
}

// ── Profile ───────────────────────────────────────────────
function ProfileSection({ data, onToast }) {
  const [name,   setName]   = useState(data?.profile?.name  || '');
  const [saving, setSaving] = useState(false);
  const [resending, setResending] = useState(false);
  const emailVerified = !!data?.profile?.email_verified;

  const save = async () => {
    if (!name.trim()) return onToast('Display name cannot be empty', false);
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'profile', payload:{ name: name.trim() } });
      onToast('Profile updated successfully', true);
    } catch { onToast('Error updating profile', false); }
    finally { setSaving(false); }
  };

  const resendVerification = async () => {
    setResending(true);
    try {
      await api.post('/settings/email/resend-verification');
      onToast('Verification email sent', true);
    } catch (err) { onToast(err?.error || 'Could not send verification email', false); }
    finally { setResending(false); }
  };

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Field label="Display Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
        </Field>
        <Field label="Email Address">
          <Input value={data?.profile?.email || ''} onChange={() => {}} disabled />
          <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:6, flexWrap:'wrap' }}>
            {emailVerified ? (
              <span style={{ ...monoSm, color:'var(--green)' }}>✓ Verified</span>
            ) : (
              <>
                <span style={{ ...monoSm, color:'var(--amber)' }}>⚠ Not verified</span>
                <button onClick={resendVerification} disabled={resending} style={{
                  padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
                  background:'transparent', color:'var(--cyan)', fontSize:11,
                  cursor: resending ? 'not-allowed' : 'pointer', fontFamily:'JetBrains Mono,monospace',
                }}>
                  {resending ? 'Sending...' : 'Resend verification email'}
                </button>
              </>
            )}
          </div>
        </Field>
      </div>
      <Field label="Current Plan">
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'8px 16px', borderRadius:8, background:'rgba(167,139,250,0.08)', border:'1px solid rgba(167,139,250,0.2)', color:'var(--purple-bright)', fontFamily:'JetBrains Mono,monospace', fontSize:12, fontWeight:700 }}>
            ◈ {(data?.profile?.plan || 'free').toUpperCase()}
          </div>
          {(!data?.profile?.plan || data.profile.plan === 'free') && (
            <a href="/pricing" style={{ ...monoSm, color:'var(--cyan)', textDecoration:'none' }}>
              Upgrade plan →
            </a>
          )}
        </div>
      </Field>
      <SaveBtn onClick={save} saving={saving} />
    </div>
  );
}

// ── Notifications (+ Telegram + Quiet Hours) ─────────────
function NotificationsSection({ data, onToast }) {
  const s = data?.settings || {};
  const init = s.notifications || { email_alerts:true, push_alerts:true, price_alerts:true };
  const [notifs, setNotifs] = useState(init);
  const [saving, setSaving] = useState(false);

  const [chatId, setChatId]     = useState(s.telegram_chat_id || '');
  const [tgEnabled, setTgEnabled] = useState(!!s.telegram_enabled);
  const [tgSaving, setTgSaving]   = useState(false);
  const [tgTesting, setTgTesting] = useState(false);

  const [qhEnabled, setQhEnabled] = useState(!!s.quiet_hours_enabled);
  const [qhStart, setQhStart]     = useState(s.quiet_hours_start || '23:00');
  const [qhEnd, setQhEnd]         = useState(s.quiet_hours_end || '07:00');
  const [qhSaving, setQhSaving]   = useState(false);

  const toggle = key => setNotifs(prev => ({ ...prev, [key]: !prev[key] }));

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'notifications', payload: notifs });
      onToast('Notifications updated', true);
    } catch { onToast('Error updating notifications', false); }
    finally { setSaving(false); }
  };

  const saveTelegram = async () => {
    if (tgEnabled && !/^-?\d+$/.test(chatId.trim())) {
      return onToast('Chat ID invalide (doit être numérique)', false);
    }
    setTgSaving(true);
    try {
      await api.post('/settings/update', { section:'telegram', payload:{ chatId: chatId.trim(), enabled: tgEnabled } });
      onToast('Telegram settings updated', true);
    } catch (err) { onToast(err?.error || 'Error updating Telegram', false); }
    finally { setTgSaving(false); }
  };

  const testTelegram = async () => {
    if (!chatId.trim()) return onToast('Enter your Chat ID first', false);
    if (!/^-?\d+$/.test(chatId.trim())) return onToast('Chat ID invalide (doit être numérique)', false);
    setTgTesting(true);
    try {
      await api.post('/settings/telegram/test', { chatId: chatId.trim() });
      onToast('Test message sent — check Telegram', true);
    } catch (err) { onToast(err?.error || 'Could not send test message', false); }
    finally { setTgTesting(false); }
  };

  const saveQuietHours = async () => {
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRe.test(qhStart) || !timeRe.test(qhEnd)) {
      return onToast('Use HH:MM format (e.g. 23:00)', false);
    }
    setQhSaving(true);
    try {
      await api.post('/settings/update', { section:'quietHours', payload:{ enabled: qhEnabled, start: qhStart, end: qhEnd } });
      onToast('Quiet hours updated', true);
    } catch { onToast('Error updating quiet hours', false); }
    finally { setQhSaving(false); }
  };

  const items = [
    { key:'email_alerts', label:'Email Alerts',       desc:'Receive signal alerts by email'         },
    { key:'push_alerts',  label:'Push Notifications', desc:'Browser push notifications for signals' },
    { key:'price_alerts', label:'Price Alerts',       desc:'Notify when price targets are reached'  },
  ];

  return (
    <div>
      {items.map(item => (
        <div key={item.key} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', marginBottom:4 }}>{item.label}</div>
            <div style={{ ...monoSm, color:'var(--text-secondary)' }}>{item.desc}</div>
          </div>
          <Toggle checked={notifs[item.key]} onChange={() => toggle(item.key)} />
        </div>
      ))}
      <div style={{ marginTop:20 }}>
        <SaveBtn onClick={save} saving={saving} />
      </div>

      {/* ── Telegram ── */}
      <div style={{ marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.06)' }}>
        <label style={label10}>Telegram</label>
        <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:16 }}>
          Reçois tes alertes et signaux directement sur Telegram. Trouve ton Chat ID en envoyant un message à{' '}
          <span style={{ color:'var(--cyan)' }}>@userinfobot</span> sur Telegram.
        </div>

        <Field label="Telegram Chat ID">
          <Input value={chatId} onChange={e => setChatId(e.target.value)} placeholder="e.g. 123456789" />
        </Field>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 0', borderBottom:'1px solid rgba(255,255,255,0.04)', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', marginBottom:4 }}>Enable Telegram Alerts</div>
            <div style={{ ...monoSm, color:'var(--text-secondary)' }}>Reçois les alertes déclenchées sur ce chat</div>
          </div>
          <Toggle checked={tgEnabled} onChange={() => setTgEnabled(v => !v)} />
        </div>

        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <SaveBtn onClick={saveTelegram} saving={tgSaving} />
          <GhostBtn onClick={testTelegram} disabled={tgTesting}>
            {tgTesting ? 'Sending...' : 'Send Test Message'}
          </GhostBtn>
        </div>
      </div>

      {/* ── Quiet Hours ── */}
      <div style={{ marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.06)' }}>
        <label style={label10}>Quiet Hours</label>
        <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:16 }}>
          Mets tes notifications en pause pendant une plage horaire quotidienne (ex. la nuit).
        </div>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 0', borderBottom:'1px solid rgba(255,255,255,0.04)', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', marginBottom:4 }}>Enable Quiet Hours</div>
            <div style={{ ...monoSm, color:'var(--text-secondary)' }}>Suspend les alertes durant la plage définie ci-dessous</div>
          </div>
          <Toggle checked={qhEnabled} onChange={() => setQhEnabled(v => !v)} />
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <Field label="From">
            <Input value={qhStart} onChange={e => setQhStart(e.target.value)} placeholder="23:00" />
          </Field>
          <Field label="To">
            <Input value={qhEnd} onChange={e => setQhEnd(e.target.value)} placeholder="07:00" />
          </Field>
        </div>
        <div style={{ ...monoSm, color:'var(--text-muted)', marginBottom:16 }}>
          Format 24h (HH:MM), basé sur ton fuseau horaire (Language &amp; Region)
        </div>

        <SaveBtn onClick={saveQuietHours} saving={qhSaving} />
      </div>
    </div>
  );
}

// ── Trading (+ Risk Management) ──────────────────────────
function TradingSection({ data, onToast }) {
  const s = data?.settings || {};
  const currency = CURRENCY_SYMBOLS[s.currency] || '$';
  const [capital,   setCapital]   = useState(s.default_capital   || 100000);
  const [riskPct,   setRiskPct]   = useState(s.default_risk_pct  || 1);
  const [timeframe, setTimeframe] = useState(s.default_timeframe || 'Daily');
  const [maxDailyLoss, setMaxDailyLoss] = useState(s.risk_max_daily_loss_pct ?? 5);
  const [maxPosition,  setMaxPosition]  = useState(s.risk_max_position_pct ?? 20);
  const [defaultStoploss, setDefaultStoploss] = useState(s.risk_default_stoploss_pct ?? 2);
  const [saving,    setSaving]    = useState(false);

  const save = async () => {
    if (!capital || capital <= 0) return onToast('Capital must be greater than 0', false);
    if (riskPct <= 0 || riskPct > 100) return onToast('Risk % must be between 0 and 100', false);
    if (maxDailyLoss <= 0 || maxDailyLoss > 100) return onToast('Max daily loss must be between 0 and 100', false);
    if (maxPosition <= 0 || maxPosition > 100) return onToast('Max position size must be between 0 and 100', false);

    setSaving(true);
    try {
      await api.post('/settings/update', {
        section:'trading',
        payload:{
          default_capital: capital, default_risk_pct: riskPct, default_timeframe: timeframe,
          max_daily_loss_pct: maxDailyLoss, max_position_pct: maxPosition, default_stoploss_pct: defaultStoploss,
        },
      });
      onToast('Trading preferences updated', true);
    } catch { onToast('Error updating trading settings', false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Field label={`Default Capital (${currency})`}>
          <Input value={capital} onChange={e => setCapital(Number(e.target.value))} type="number" min="1" step="100" />
        </Field>
        <Field label="Risk per Trade (%)">
          <Input value={riskPct} onChange={e => setRiskPct(Number(e.target.value))} type="number" min="0.1" max="100" step="0.1" />
        </Field>
      </div>
      <Field label="Default Timeframe">
        <Select value={timeframe} onChange={e => setTimeframe(e.target.value)}>
          {['1h','4h','Daily','Weekly'].map(tf => <option key={tf} value={tf}>{tf}</option>)}
        </Select>
      </Field>
      <div style={{ background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.15)', borderRadius:10, padding:'12px 16px', marginBottom:24 }}>
        <div style={{ ...monoSm, color:'var(--amber)' }}>
          ⚠ Risk: {currency}{((capital || 0) * (riskPct || 0) / 100).toLocaleString()} per trade ({riskPct || 0}% of {currency}{Number(capital || 0).toLocaleString()})
        </div>
      </div>

      <div style={{ paddingTop:8, borderTop:'1px solid rgba(255,255,255,0.06)', marginBottom:20 }}>
        <label style={{ ...label10, marginTop:20 }}>Risk Management</label>
        <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:16 }}>
          Ces limites servent de garde-fous — utilisées par le dashboard et les futurs contrôles de trading automatique.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <Field label="Max Daily Loss (%)">
            <Input value={maxDailyLoss} onChange={e => setMaxDailyLoss(Number(e.target.value))} type="number" min="0.1" max="100" step="0.5" />
          </Field>
          <Field label="Max Position Size (% of capital)">
            <Input value={maxPosition} onChange={e => setMaxPosition(Number(e.target.value))} type="number" min="0.1" max="100" step="1" />
          </Field>
        </div>
        <Field label="Default Stop-Loss (%)">
          <Input value={defaultStoploss} onChange={e => setDefaultStoploss(Number(e.target.value))} type="number" min="0.1" max="100" step="0.1" />
        </Field>
      </div>

      <SaveBtn onClick={save} saving={saving} />
    </div>
  );
}

// ── Signal Alerts ────────────────────────────────────────────
function SignalAlertsSection({ data, onToast }) {
  const s = data?.settings || {};
  const [mode,       setMode]       = useState(s.signal_alert_mode || 'all');
  const [symbols,    setSymbols]    = useState(s.signal_alert_symbols || []);
  const [symbolInput, setSymbolInput] = useState('');
  const [minConfidence, setMinConfidence] = useState(s.signal_alert_min_confidence ?? 75);
  const [saving,     setSaving]     = useState(false);

  const addSymbol = () => {
    const clean = symbolInput.trim().toUpperCase();
    if (!clean) return;
    if (!symbols.includes(clean)) setSymbols(prev => [...prev, clean]);
    setSymbolInput('');
  };

  const removeSymbol = sym => setSymbols(prev => prev.filter(s => s !== sym));

  const save = async () => {
    if (mode === 'custom' && symbols.length === 0) {
      return onToast('Add at least one symbol to follow', false);
    }
    setSaving(true);
    try {
      await api.post('/settings/update', {
        section: 'signalAlerts',
        payload: { mode, symbols, minConfidence },
      });
      onToast('Signal alert preferences updated', true);
    } catch { onToast('Error updating signal alerts', false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <Field label="Which signals should trigger alerts?">
        <div style={{ display:'flex', gap:12 }}>
          {[
            { val:'all',    label:'All Signals',    desc:'Get alerted on every high-confidence AI signal' },
            { val:'custom', label:'Custom Symbols',  desc:'Only alert me on symbols I choose below' },
          ].map(m => (
            <button key={m.val} onClick={() => setMode(m.val)} style={{
              flex:1, padding:'16px', borderRadius:12, cursor:'pointer', textAlign:'left',
              border: mode===m.val ? '1px solid var(--cyan)' : '1px solid var(--border)',
              background: mode===m.val ? 'var(--cyan-glow)' : 'rgba(255,255,255,0.02)',
              transition:'all .2s',
            }}>
              <div style={{ fontSize:13, fontWeight:700, color: mode===m.val ? 'var(--cyan)' : 'var(--text-primary)', marginBottom:4 }}>{m.label}</div>
              <div style={{ ...monoSm, color:'var(--text-secondary)' }}>{m.desc}</div>
            </button>
          ))}
        </div>
      </Field>

      {mode === 'custom' && (
        <Field label="Followed Symbols">
          <div style={{ display:'flex', gap:8, marginBottom:10 }}>
            <div style={{ flex:1 }}>
              <Input
                value={symbolInput}
                onChange={e => setSymbolInput(e.target.value)}
                placeholder="e.g. BTCUSDT, AAPL, EURUSD"
              />
            </div>
            <button onClick={addSymbol} style={{
              padding:'0 18px', borderRadius:8, border:'1px solid var(--cyan-dim)',
              background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:12, fontWeight:700,
              fontFamily:'Syne,sans-serif', cursor:'pointer',
            }}>
              Add
            </button>
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
            {symbols.length === 0 && (
              <div style={{ ...monoSm, color:'var(--text-muted)' }}>No symbols added yet</div>
            )}
            {symbols.map(sym => (
              <div key={sym} style={{
                display:'flex', alignItems:'center', gap:6, padding:'6px 10px', borderRadius:6,
                background:'rgba(0,245,212,0.06)', border:'1px solid rgba(0,245,212,0.15)',
                fontFamily:'JetBrains Mono,monospace', fontSize:12, color:'var(--cyan)',
              }}>
                {sym}
                <span onClick={() => removeSymbol(sym)} style={{ cursor:'pointer', opacity:0.7 }}>✕</span>
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label={`Minimum Confidence (${minConfidence}%)`}>
        <input
          type="range" min="50" max="95" step="5" value={minConfidence}
          onChange={e => setMinConfidence(Number(e.target.value))}
          style={{ width:'100%', accentColor:'var(--cyan)' }}
        />
        <div style={{ ...monoSm, color:'var(--text-muted)', marginTop:6 }}>
          Only AI signals at or above this confidence will trigger an alert
        </div>
      </Field>

      <SaveBtn onClick={save} saving={saving} />
    </div>
  );
}

// ── Webhook (Discord / Slack / générique) ────────────────
function WebhookSection({ data, onToast }) {
  const s = data?.settings || {};
  const [url,     setUrl]     = useState(s.webhook_url || '');
  const [enabled, setEnabled] = useState(!!s.webhook_enabled);
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState(false);

  const save = async () => {
    if (enabled && !url.trim()) return onToast('Add a webhook URL to enable it', false);
    if (enabled && !/^https:\/\//i.test(url.trim())) return onToast('Webhook URL must start with https://', false);

    setSaving(true);
    try {
      await api.post('/settings/update', { section:'webhook', payload:{ url: url.trim(), enabled } });
      onToast('Webhook settings updated', true);
    } catch (err) { onToast(err?.error || 'Error updating webhook', false); }
    finally { setSaving(false); }
  };

  const sendTest = async () => {
    if (!url.trim()) return onToast('Enter a webhook URL first', false);
    if (!/^https:\/\//i.test(url.trim())) return onToast('Webhook URL must start with https://', false);

    setTesting(true);
    try {
      await api.post('/settings/webhook/test', { url: url.trim() });
      onToast('Test message sent — check your channel', true);
    } catch (err) { onToast(err?.error || 'Could not reach webhook', false); }
    finally { setTesting(false); }
  };

  return (
    <div>
      <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:20 }}>
        Reçois tes signaux et alertes sur Discord, Slack, ou n'importe quel endpoint compatible webhook JSON.
      </div>

      <Field label="Webhook URL">
        <Input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
        />
      </Field>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 0', borderBottom:'1px solid rgba(255,255,255,0.04)', marginBottom:20 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', marginBottom:4 }}>Enable Webhook</div>
          <div style={{ ...monoSm, color:'var(--text-secondary)' }}>Envoie automatiquement les alertes déclenchées vers cette URL</div>
        </div>
        <Toggle checked={enabled} onChange={() => setEnabled(v => !v)} />
      </div>

      <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
        <SaveBtn onClick={save} saving={saving} />
        <GhostBtn onClick={sendTest} disabled={testing}>
          {testing ? 'Sending...' : 'Send Test Message'}
        </GhostBtn>
      </div>
    </div>
  );
}

// ── Appearance ────────────────────────────────────────────
function AppearanceSection({ data, onToast }) {
  const [theme,  setTheme]  = useState(data?.settings?.theme || 'dark');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'appearance', payload:{ theme } });
      document.body.classList.toggle('light', theme === 'light');
      onToast('Theme updated', true);
    } catch { onToast('Error updating theme', false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <Field label="Theme">
        <div style={{ display:'flex', gap:12 }}>
          {[
            { val:'dark',  icon:'🌑', label:'Dark Mode',  desc:'Easy on the eyes at night' },
            { val:'light', icon:'☀️', label:'Light Mode', desc:'Clean and bright interface' },
          ].map(t => (
            <button key={t.val} onClick={() => setTheme(t.val)} style={{
              flex:1, padding:'20px 16px', borderRadius:12, cursor:'pointer', textAlign:'left',
              border: theme===t.val ? '1px solid var(--cyan)' : '1px solid var(--border)',
              background: theme===t.val ? 'var(--cyan-glow)' : 'rgba(255,255,255,0.02)',
              transition:'all .2s',
            }}>
              <div style={{ fontSize:24, marginBottom:8 }}>{t.icon}</div>
              <div style={{ fontSize:13, fontWeight:700, color: theme===t.val ? 'var(--cyan)' : 'var(--text-primary)', marginBottom:4 }}>{t.label}</div>
              <div style={{ ...monoSm, color:'var(--text-secondary)' }}>{t.desc}</div>
            </button>
          ))}
        </div>
      </Field>
      <SaveBtn onClick={save} saving={saving} />
    </div>
  );
}

// ── Security (password + 2FA) ──────────────────────────────
function SecuritySection({ onToast }) {
  const [current, setCurrent] = useState('');
  const [next,    setNext]    = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving,  setSaving]  = useState(false);

  const [twofaEnabled, setTwofaEnabled] = useState(false);
  const [twofaLoading, setTwofaLoading] = useState(true);
  const [setupData, setSetupData] = useState(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [backupCodes, setBackupCodes] = useState(null);
  const [disablePwd, setDisablePwd] = useState('');
  const [showDisable, setShowDisable] = useState(false);

  useEffect(() => {
    api.get('/security/2fa/status')
      .then(res => setTwofaEnabled(res.data.enabled))
      .catch(() => {})
      .finally(() => setTwofaLoading(false));
  }, []);

  const strength = next.length >= 12 ? 100 : next.length >= 8 ? 60 : next.length > 0 ? 30 : 0;
  const strengthColor = strength === 100 ? 'var(--green)' : strength === 60 ? 'var(--amber)' : 'var(--red)';
  const strengthLabel = strength === 100 ? 'Strong' : strength === 60 ? 'Medium' : strength > 0 ? 'Weak' : '';

  const savePassword = async () => {
    if (!current) return onToast('Enter your current password', false);
    if (next !== confirm) return onToast('Passwords do not match', false);
    if (next.length < 8)  return onToast('Minimum 8 characters required', false);
    setSaving(true);
    try {
      await api.post('/settings/password', { currentPassword: current, newPassword: next });
      onToast('Password changed successfully', true);
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      onToast(err?.error || 'Current password incorrect', false);
    } finally { setSaving(false); }
  };

  const startSetup = async () => {
    try {
      const res = await api.post('/security/2fa/setup');
      setSetupData(res.data);
    } catch { onToast('Could not start 2FA setup', false); }
  };

  const confirmSetup = async () => {
    if (!verifyCode.trim()) return onToast('Enter the 6-digit code', false);
    setVerifying(true);
    try {
      const res = await api.post('/security/2fa/verify', { token: verifyCode.trim() });
      setTwofaEnabled(true);
      setBackupCodes(res.data.backupCodes);
      setSetupData(null);
      setVerifyCode('');
      onToast('2FA enabled', true);
    } catch (err) {
      onToast(err?.error || 'Invalid code', false);
    } finally { setVerifying(false); }
  };

  const disable2FA = async () => {
    if (!disablePwd) return onToast('Enter your password to disable 2FA', false);
    try {
      await api.post('/security/2fa/disable', { password: disablePwd });
      setTwofaEnabled(false);
      setShowDisable(false);
      setDisablePwd('');
      onToast('2FA disabled', true);
    } catch (err) {
      onToast(err?.error || 'Incorrect password', false);
    }
  };

  return (
    <div>
      <Field label="Current Password">
        <Input value={current} onChange={e => setCurrent(e.target.value)} type="password" placeholder="••••••••" />
      </Field>
      <Field label="New Password">
        <Input value={next} onChange={e => setNext(e.target.value)} type="password" placeholder="Min. 8 characters" />
        {next && (
          <div style={{ marginTop:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span style={{ ...monoSm, color:'var(--text-muted)' }}>Strength</span>
              <span style={{ ...monoSm, color: strengthColor }}>{strengthLabel}</span>
            </div>
            <div style={{ height:4, background:'rgba(255,255,255,0.06)', borderRadius:2, overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${strength}%`, borderRadius:2, background: strengthColor, transition:'width .3s, background .3s' }} />
            </div>
          </div>
        )}
      </Field>
      <Field label="Confirm New Password">
        <Input value={confirm} onChange={e => setConfirm(e.target.value)} type="password" placeholder="••••••••" />
        {confirm && next !== confirm && (
          <div style={{ ...monoSm, color:'var(--red)', marginTop:6 }}>✕ Passwords do not match</div>
        )}
        {confirm && next === confirm && confirm.length > 0 && (
          <div style={{ ...monoSm, color:'var(--green)', marginTop:6 }}>✓ Passwords match</div>
        )}
      </Field>
      <SaveBtn onClick={savePassword} saving={saving} label="Change Password" />

      <div style={{ marginTop:36, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.06)' }}>
        <label style={label10}>Two-Factor Authentication</label>

        {twofaLoading ? (
          <div style={{ ...monoSm, color:'var(--text-muted)' }}>Checking status...</div>
        ) : backupCodes ? (
          <div style={{ background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:10, padding:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--green)', marginBottom:8 }}>
              ✓ 2FA enabled — save your backup codes
            </div>
            <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:10 }}>
              Each code can be used once if you lose access to your authenticator app. Store them somewhere safe — they won't be shown again.
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, fontFamily:'JetBrains Mono,monospace', fontSize:12, color:'var(--text-primary)' }}>
              {backupCodes.map(c => <div key={c} style={{ padding:'6px 10px', background:'rgba(255,255,255,0.03)', borderRadius:6 }}>{c}</div>)}
            </div>
            <button onClick={() => setBackupCodes(null)} style={{
              marginTop:12, padding:'8px 16px', borderRadius:8, border:'1px solid var(--border)',
              background:'transparent', color:'var(--text-secondary)', fontSize:12, cursor:'pointer',
              fontFamily:'JetBrains Mono,monospace',
            }}>
              I've saved these
            </button>
          </div>

        ) : twofaEnabled ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 16px', background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:10 }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--green)' }}>✓ 2FA is enabled</div>
              <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:2 }}>Your account requires an authenticator code to sign in</div>
            </div>
            {!showDisable ? (
              <button onClick={() => setShowDisable(true)} style={{
                padding:'8px 16px', borderRadius:8, border:'1px solid rgba(248,113,113,0.3)',
                background:'rgba(248,113,113,0.08)', color:'var(--red)', fontSize:12, fontWeight:700,
                cursor:'pointer', fontFamily:'Syne,sans-serif',
              }}>
                Disable
              </button>
            ) : null}
          </div>

        ) : setupData ? (
          <div style={{ padding:16, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10 }}>
            <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:12 }}>
              Scan this QR code with Google Authenticator, Authy, or 1Password, then enter the 6-digit code below.
            </div>
            <img src={setupData.qrCode} alt="2FA QR code" style={{ width:160, height:160, borderRadius:8, marginBottom:12 }} />
            <div style={{ ...monoSm, color:'var(--text-muted)', marginBottom:12 }}>
              Can't scan? Enter manually: <span style={{ color:'var(--cyan)' }}>{setupData.secret}</span>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <div style={{ width:160 }}>
                <Input value={verifyCode} onChange={e => setVerifyCode(e.target.value)} placeholder="000000" />
              </div>
              <button onClick={confirmSetup} disabled={verifying} style={{
                padding:'0 20px', borderRadius:8, border:'1px solid var(--cyan-dim)',
                background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:12, fontWeight:700,
                cursor: verifying ? 'not-allowed' : 'pointer', fontFamily:'Syne,sans-serif',
              }}>
                {verifying ? 'Verifying...' : 'Verify & Enable'}
              </button>
            </div>
          </div>

        ) : (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 16px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10 }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>2FA is not enabled</div>
              <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:2 }}>Add an extra layer of security to your account</div>
            </div>
            <button onClick={startSetup} style={{
              padding:'8px 16px', borderRadius:8, border:'1px solid var(--cyan-dim)',
              background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:12, fontWeight:700,
              cursor:'pointer', fontFamily:'Syne,sans-serif',
            }}>
              Enable 2FA
            </button>
          </div>
        )}

        {showDisable && (
          <div style={{ marginTop:12, display:'flex', gap:8 }}>
            <div style={{ flex:1 }}>
              <Input value={disablePwd} onChange={e => setDisablePwd(e.target.value)} type="password" placeholder="Confirm your password" />
            </div>
            <button onClick={disable2FA} style={{
              padding:'0 20px', borderRadius:8, border:'1px solid rgba(248,113,113,0.3)',
              background:'rgba(248,113,113,0.08)', color:'var(--red)', fontSize:12, fontWeight:700,
              cursor:'pointer', fontFamily:'Syne,sans-serif',
            }}>
              Confirm Disable
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Active Sessions ─────────────────────────────────────────
function SessionsSection({ onToast }) {
  const [sessions, setSessions] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const load = () => {
    setLoading(true);
    api.get('/security/sessions')
      .then(res => setSessions(res.data.sessions))
      .catch(() => onToast('Could not load sessions', false))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const revoke = async id => {
    try {
      await api.delete(`/security/sessions/${id}`);
      setSessions(prev => prev.filter(s => s.id !== id));
      onToast('Session revoked', true);
    } catch { onToast('Could not revoke session', false); }
  };

  const revokeAll = async () => {
    try {
      await api.delete('/security/sessions');
      setSessions(prev => prev.filter(s => s.isCurrent));
      onToast('All other sessions signed out', true);
    } catch { onToast('Could not revoke sessions', false); }
  };

  const timeAgo = iso => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const deviceLabel = ua => {
    if (!ua) return 'Unknown device';
    if (/mobile/i.test(ua)) return 'Mobile device';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Unknown device';
  };

  if (loading) return <div style={{ ...monoSm, color:'var(--text-muted)' }}>Loading sessions...</div>;

  return (
    <div>
      {sessions.length === 0 && (
        <div style={{ ...monoSm, color:'var(--text-muted)' }}>No active sessions found</div>
      )}
      {sessions.map(s => (
        <div key={s.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', display:'flex', alignItems:'center', gap:8 }}>
              {deviceLabel(s.userAgent)}
              {s.isCurrent && (
                <span style={{ fontSize:10, padding:'2px 8px', borderRadius:6, background:'rgba(0,245,212,0.1)', color:'var(--cyan)', fontFamily:'JetBrains Mono,monospace' }}>
                  This device
                </span>
              )}
            </div>
            <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:4 }}>
              {s.ip || 'Unknown IP'} · Active {timeAgo(s.lastActive)}
            </div>
          </div>
          {!s.isCurrent && (
            <button onClick={() => revoke(s.id)} style={{
              padding:'6px 14px', borderRadius:8, border:'1px solid var(--border)',
              background:'transparent', color:'var(--text-secondary)', fontSize:11,
              cursor:'pointer', fontFamily:'JetBrains Mono,monospace',
            }}>
              Sign out
            </button>
          )}
        </div>
      ))}
      {sessions.length > 1 && (
        <button onClick={revokeAll} style={{
          marginTop:16, padding:'10px 20px', borderRadius:9, border:'1px solid rgba(248,113,113,0.3)',
          background:'rgba(248,113,113,0.08)', color:'var(--red)', fontSize:13, fontWeight:700,
          fontFamily:'Syne,sans-serif', cursor:'pointer',
        }}>
          Sign out all other devices
        </button>
      )}
    </div>
  );
}

// ── API Keys ─────────────────────────────────────────────────
function ApiKeysSection({ onToast }) {
  const [keys,    setKeys]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [name,    setName]    = useState('');
  const [scopeTrade, setScopeTrade] = useState(false);
  const [newKey,  setNewKey]  = useState(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/security/api-keys')
      .then(res => setKeys(res.data.keys))
      .catch(() => onToast('Could not load API keys', false))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const create = async () => {
    if (!name.trim()) return onToast('Give your key a name', false);
    setCreating(true);
    try {
      const scopes = scopeTrade ? ['read', 'trade'] : ['read'];
      const res = await api.post('/security/api-keys', { name: name.trim(), scopes });
      setNewKey(res.data.key);
      setName(''); setScopeTrade(false);
      load();
    } catch { onToast('Could not create API key', false); }
    finally { setCreating(false); }
  };

  const revoke = async id => {
    try {
      await api.delete(`/security/api-keys/${id}`);
      setKeys(prev => prev.filter(k => k.id !== id));
      onToast('API key revoked', true);
    } catch { onToast('Could not revoke key', false); }
  };

  return (
    <div>
      {newKey && (
        <div style={{ background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.2)', borderRadius:10, padding:16, marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--amber)', marginBottom:8 }}>
            ⚠ Copy this key now — it won't be shown again
          </div>
          <div style={{ fontFamily:'JetBrains Mono,monospace', fontSize:13, color:'var(--text-primary)', background:'rgba(0,0,0,0.3)', padding:'10px 14px', borderRadius:8, wordBreak:'break-all' }}>
            {newKey}
          </div>
          <button onClick={() => { navigator.clipboard.writeText(newKey); onToast('Copied to clipboard', true); }} style={{
            marginTop:10, padding:'8px 16px', borderRadius:8, border:'1px solid var(--border)',
            background:'transparent', color:'var(--text-secondary)', fontSize:12, cursor:'pointer',
            fontFamily:'JetBrains Mono,monospace',
          }}>
            Copy key
          </button>
          <button onClick={() => setNewKey(null)} style={{
            marginTop:10, marginLeft:8, padding:'8px 16px', borderRadius:8, border:'1px solid var(--border)',
            background:'transparent', color:'var(--text-secondary)', fontSize:12, cursor:'pointer',
            fontFamily:'JetBrains Mono,monospace',
          }}>
            Done
          </button>
        </div>
      )}

      <Field label="Create New Key">
        <div style={{ display:'flex', gap:8, marginBottom:10 }}>
          <div style={{ flex:1 }}>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My trading bot" />
          </div>
          <button onClick={create} disabled={creating} style={{
            padding:'0 20px', borderRadius:8, border:'1px solid var(--cyan-dim)',
            background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:12, fontWeight:700,
            cursor: creating ? 'not-allowed' : 'pointer', fontFamily:'Syne,sans-serif',
          }}>
            {creating ? 'Creating...' : 'Create Key'}
          </button>
        </div>
        <label style={{ display:'flex', alignItems:'center', gap:8, ...monoSm, color:'var(--text-secondary)', cursor:'pointer' }}>
          <input type="checkbox" checked={scopeTrade} onChange={e => setScopeTrade(e.target.checked)} />
          Allow trade execution (not just read access)
        </label>
      </Field>

      <label style={label10}>Active Keys</label>
      {loading ? (
        <div style={{ ...monoSm, color:'var(--text-muted)' }}>Loading...</div>
      ) : keys.length === 0 ? (
        <div style={{ ...monoSm, color:'var(--text-muted)' }}>No API keys yet</div>
      ) : keys.map(k => (
        <div key={k.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{k.name}</div>
            <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:4 }}>
              {k.key_prefix}••••••••• · {k.scopes.join(', ')} · {k.last_used_at ? `used ${new Date(k.last_used_at).toLocaleDateString()}` : 'never used'}
            </div>
          </div>
          <button onClick={() => revoke(k.id)} style={{
            padding:'6px 14px', borderRadius:8, border:'1px solid rgba(248,113,113,0.3)',
            background:'rgba(248,113,113,0.08)', color:'var(--red)', fontSize:11,
            cursor:'pointer', fontFamily:'JetBrains Mono,monospace',
          }}>
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Language, Region & Currency ──────────────────────────
const LANGUAGES = [
  { value:'en', label:'English'    }, { value:'fr', label:'Français'   },
  { value:'ar', label:'العربية'    }, { value:'es', label:'Español'    },
  { value:'tr', label:'Türkçe'     }, { value:'pt', label:'Português'  },
  { value:'ru', label:'Русский'    }, { value:'de', label:'Deutsch'    },
  { value:'hi', label:'हिन्दी'      }, { value:'ko', label:'한국어'      },
];

const CURRENCIES = [
  { value:'USD', label:'USD — US Dollar'     }, { value:'EUR', label:'EUR — Euro'          },
  { value:'MAD', label:'MAD — Dirham marocain' }, { value:'GBP', label:'GBP — British Pound' },
  { value:'JPY', label:'JPY — Japanese Yen'  }, { value:'CHF', label:'CHF — Swiss Franc'   },
  { value:'CAD', label:'CAD — Canadian Dollar' }, { value:'AUD', label:'AUD — Australian Dollar' },
  { value:'CNY', label:'CNY — Chinese Yuan'  }, { value:'AED', label:'AED — UAE Dirham'    },
];

function LocaleSection({ data, onToast }) {
  const { i18n } = useTranslation();
  const s = data?.settings || {};
  const [language, setLanguage] = useState(s.language || 'en');
  const [timezone, setTimezone] = useState(s.timezone || 'UTC');
  const [currency, setCurrency] = useState(s.currency || 'USD');
  const [saving, setSaving] = useState(false);

  const timezoneOptions = (typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['UTC','Africa/Casablanca','Europe/Paris','America/New_York','Asia/Dubai','Asia/Tokyo']
  ).map(tz => ({ value: tz, label: tz }));

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'locale', payload:{ language, timezone, currency } });
      i18n.changeLanguage(language);
      onToast('Language, timezone and currency updated', true);
    } catch { onToast('Error updating locale', false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <Field label="Language">
        <CustomSelect value={language} onChange={setLanguage} options={LANGUAGES} />
      </Field>
      <Field label="Timezone">
        <CustomSelect value={timezone} onChange={setTimezone} options={timezoneOptions} />
        <div style={{ ...monoSm, color:'var(--text-muted)', marginTop:6 }}>
          Toutes les dates (trades, alertes, signaux) s'afficheront dans ce fuseau
        </div>
      </Field>
      <Field label="Currency">
        <CustomSelect value={currency} onChange={setCurrency} options={CURRENCIES} />
        <div style={{ ...monoSm, color:'var(--text-muted)', marginTop:6 }}>
          Utilisée pour l'affichage du capital, du P&L, et des montants dans les emails d'alerte
        </div>
      </Field>
      <SaveBtn onClick={save} saving={saving} />
    </div>
  );
}

// ── Activity Log ─────────────────────────────────────────
function AuditLogSection({ onToast }) {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/settings/audit-log')
      .then(res => setEvents(res.data.events))
      .catch(() => onToast('Could not load activity log', false))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eventLabels = {
    login_success:    '✓ Signed in',
    login_failed:     '✕ Failed sign-in attempt',
    password_changed: '🔑 Password changed',
    '2fa_enabled':    '🔒 2FA enabled',
    '2fa_disabled':   '🔓 2FA disabled',
    api_key_created:  '⚿ API key created',
    api_key_revoked:  '⚿ API key revoked',
    email_changed:    '✉ Email changed',
  };

  const eventColor = type => {
    if (type === 'login_failed') return 'var(--red)';
    if (type.includes('disabled') || type === 'api_key_revoked') return 'var(--amber)';
    return 'var(--text-primary)';
  };

  if (loading) return <div style={{ ...monoSm, color:'var(--text-muted)' }}>Loading activity log...</div>;

  return (
    <div>
      <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:20 }}>
        Historique des 50 derniers événements liés à la sécurité de ton compte.
      </div>
      {events.length === 0 ? (
        <div style={{ ...monoSm, color:'var(--text-muted)' }}>No activity recorded yet</div>
      ) : events.map((e, i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color: eventColor(e.event_type) }}>
              {eventLabels[e.event_type] || e.event_type}
            </div>
            <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:2 }}>
              {e.ip_address || 'Unknown IP'} · {new Date(e.created_at).toLocaleString()}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Danger Zone ───────────────────────────────────────────
function DangerZoneSection({ onToast }) {
  const [exporting, setExporting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const exportData = async (format) => {
    setExporting(true);
    try {
      const res = await api.get(`/settings/export?format=${format}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'csv'
        ? `atlasquant-export-${Date.now()}.zip`
        : `atlasquant-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      onToast('Export downloaded', true);
    } catch { onToast('Could not export data', false); }
    finally { setExporting(false); }
  };

  const deleteAccount = async () => {
    if (confirmText !== 'DELETE') return onToast('Type DELETE to confirm', false);
    if (!password) return onToast('Enter your password to confirm', false);
    setDeleting(true);
    try {
      await api.delete('/settings/account', { data: { password } });
      localStorage.clear();
      window.location.href = '/login';
    } catch (err) {
      onToast(err?.error || 'Could not delete account', false);
      setDeleting(false);
    }
  };

  return (
    <div>
      <Field label="Export Your Data">
        <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:12 }}>
          Download your trades, portfolio, alerts, watchlist, and settings.
        </div>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <button onClick={() => exportData('json')} disabled={exporting} style={{
            padding:'10px 24px', borderRadius:9, border:'1px solid var(--border)',
            background:'rgba(255,255,255,0.02)', color:'var(--text-primary)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor: exporting ? 'not-allowed' : 'pointer',
          }}>
            {exporting ? 'Preparing...' : '⬇ Export as JSON'}
          </button>
          <button onClick={() => exportData('csv')} disabled={exporting} style={{
            padding:'10px 24px', borderRadius:9, border:'1px solid var(--border)',
            background:'rgba(255,255,255,0.02)', color:'var(--text-primary)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor: exporting ? 'not-allowed' : 'pointer',
          }}>
            {exporting ? 'Preparing...' : '⬇ Export as CSV (.zip)'}
          </button>
        </div>
      </Field>

      <div style={{ marginTop:32, paddingTop:24, borderTop:'1px solid rgba(248,113,113,0.15)' }}>
        <label style={{ ...label10, color:'var(--red)' }}>Delete Account</label>
        <div style={{ ...monoSm, color:'var(--text-secondary)', marginBottom:16 }}>
          This permanently deletes your account, trades, portfolio, alerts, and all associated data. This cannot be undone.
        </div>

        {!showDelete ? (
          <button onClick={() => setShowDelete(true)} style={{
            padding:'10px 24px', borderRadius:9, border:'1px solid rgba(248,113,113,0.3)',
            background:'rgba(248,113,113,0.08)', color:'var(--red)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor:'pointer',
          }}>
            Delete My Account
          </button>
        ) : (
          <div style={{ background:'rgba(248,113,113,0.04)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:10, padding:16 }}>
            <Field label={`Type DELETE to confirm`}>
              <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="DELETE" />
            </Field>
            <Field label="Confirm Your Password">
              <Input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="••••••••" />
            </Field>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={deleteAccount} disabled={deleting} style={{
                padding:'10px 24px', borderRadius:9, border:'1px solid rgba(248,113,113,0.4)',
                background:'rgba(248,113,113,0.15)', color:'var(--red)', fontSize:13, fontWeight:700,
                fontFamily:'Syne,sans-serif', cursor: deleting ? 'not-allowed' : 'pointer',
              }}>
                {deleting ? 'Deleting...' : 'Permanently Delete'}
              </button>
              <button onClick={() => { setShowDelete(false); setConfirmText(''); setPassword(''); }} style={{
                padding:'10px 24px', borderRadius:9, border:'1px solid var(--border)',
                background:'transparent', color:'var(--text-secondary)', fontSize:13,
                fontFamily:'Syne,sans-serif', cursor:'pointer',
              }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────
export default function Settings() {
  const [active,  setActive]  = useState('profile');
  const [loading, setLoading] = useState(true);
  const [data,    setData]    = useState(null);
  const [toast,   setToast]   = useState({ msg:'', ok:true });
  const toastTimer = useRef(null);

  useEffect(() => {
    api.get('/settings')
      .then(res => { setData(res.data); setLoading(false); })
      .catch(() => {
        setLoading(false);
        showToast('Failed to load settings. Please refresh.', false);
      });
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = (msg, ok) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast({ msg:'', ok:true }), 3000);
  };

  if (loading) return (
    <div style={{ color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', padding:20 }}>
      Loading settings...
    </div>
  );

  const sections = {
    profile:       <ProfileSection       data={data} onToast={showToast} />,
    notifications: <NotificationsSection data={data} onToast={showToast} />,
    trading:       <TradingSection       data={data} onToast={showToast} />,
    signalAlerts:  <SignalAlertsSection  data={data} onToast={showToast} />,
    webhook:       <WebhookSection       data={data} onToast={showToast} />,
    appearance:    <AppearanceSection    data={data} onToast={showToast} />,
    security:      <SecuritySection               onToast={showToast} />,
    sessions:      <SessionsSection                onToast={showToast} />,
    apiKeys:       <ApiKeysSection                 onToast={showToast} />,
    locale:        <LocaleSection data={data} onToast={showToast} />,
    auditLog:      <AuditLogSection onToast={showToast} />,
    danger:        <DangerZoneSection onToast={showToast} />,
  };

  return (
    <>
      <div style={{ marginBottom:4 }}>
        <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
          // Settings
        </div>
        <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
          {TABS.map(t => t.label).join(' · ')}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'200px 1fr', gap:16, alignItems:'start' }}>

        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:12, display:'flex', flexDirection:'column', gap:4 }}>
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActive(tab.id)} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:8,
              border: active===tab.id ? '1px solid rgba(0,245,212,0.2)' : '1px solid transparent',
              background: active===tab.id ? 'var(--cyan-glow)' : 'transparent',
              color: active===tab.id ? 'var(--cyan)' : 'var(--text-secondary)',
              fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer', textAlign:'left', width:'100%',
              transition:'all .15s',
            }}>
              <span style={{ fontSize:14 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:28 }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:24, color:'var(--text-primary)', display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
            {TABS.find(t => t.id === active)?.label}
          </div>
          {sections[active]}
        </div>

      </div>

      <Toast msg={toast.msg} ok={toast.ok} />
    </>
  );
}