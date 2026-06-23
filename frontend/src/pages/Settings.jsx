import { useState, useEffect } from 'react';
import api from '../services/api';

const monoSm  = { fontFamily:'JetBrains Mono,monospace', fontSize:11 };
const label10 = { fontSize:10, letterSpacing:'.15em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', marginBottom:8, display:'block' };

const TABS = [
  { id:'profile',       icon:'◉', label:'Profile'       },
  { id:'notifications', icon:'◈', label:'Notifications'  },
  { id:'trading',       icon:'◫', label:'Trading'        },
  { id:'appearance',    icon:'⬡', label:'Appearance'     },
  { id:'security',      icon:'⬙', label:'Security'       },
];

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:20 }}>
      <label style={label10}>{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, type='text', placeholder='', disabled=false }) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled}
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

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'profile', payload:{ name } });
      onToast('Profile updated successfully', true);
    } catch { onToast('Error updating profile', false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Field label="Display Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
        </Field>
        <Field label="Email Address">
          <Input value={data?.profile?.email || ''} onChange={() => {}} disabled />
          <div style={{ ...monoSm, color:'var(--text-muted)', marginTop:6 }}>
            ⓘ Contact support to change your email
          </div>
        </Field>
      </div>
      <Field label="Current Plan">
        <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'8px 16px', borderRadius:8, background:'rgba(167,139,250,0.08)', border:'1px solid rgba(167,139,250,0.2)', color:'var(--purple-bright)', fontFamily:'JetBrains Mono,monospace', fontSize:12, fontWeight:700 }}>
          ◈ {(data?.profile?.plan || 'free').toUpperCase()}
        </div>
      </Field>
      <SaveBtn onClick={save} saving={saving} />
    </div>
  );
}

// ── Notifications ─────────────────────────────────────────
function NotificationsSection({ data, onToast }) {
  const init = data?.settings?.notifications || { email_alerts:true, push_alerts:true, price_alerts:true };
  const [notifs, setNotifs] = useState(init);
  const [saving, setSaving] = useState(false);

  const toggle = key => setNotifs(prev => ({ ...prev, [key]: !prev[key] }));

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'notifications', payload: notifs });
      onToast('Notifications updated', true);
    } catch { onToast('Error', false); }
    finally { setSaving(false); }
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
          <button onClick={() => toggle(item.key)} style={{
            width:44, height:24, borderRadius:12, border:'none', cursor:'pointer', position:'relative', flexShrink:0,
            background: notifs[item.key] ? 'var(--cyan)' : 'rgba(255,255,255,0.1)',
            transition:'background .2s',
          }}>
            <div style={{
              position:'absolute', top:3, width:18, height:18, borderRadius:'50%', background:'#fff',
              transition:'left .2s', left: notifs[item.key] ? 23 : 3,
            }} />
          </button>
        </div>
      ))}
      <div style={{ marginTop:20 }}>
        <SaveBtn onClick={save} saving={saving} />
      </div>
    </div>
  );
}

// ── Trading ───────────────────────────────────────────────
function TradingSection({ data, onToast }) {
  const s = data?.settings || {};
  const [capital,   setCapital]   = useState(s.default_capital   || 100000);
  const [riskPct,   setRiskPct]   = useState(s.default_risk_pct  || 1);
  const [timeframe, setTimeframe] = useState(s.default_timeframe || 'Daily');
  const [saving,    setSaving]    = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/update', { section:'trading', payload:{ default_capital: capital, default_risk_pct: riskPct, default_timeframe: timeframe } });
      onToast('Trading preferences updated', true);
    } catch { onToast('Error', false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Field label="Default Capital ($)">
          <Input value={capital} onChange={e => setCapital(Number(e.target.value))} type="number" />
        </Field>
        <Field label="Risk per Trade (%)">
          <Input value={riskPct} onChange={e => setRiskPct(Number(e.target.value))} type="number" />
        </Field>
      </div>
      <Field label="Default Timeframe">
        <select value={timeframe} onChange={e => setTimeframe(e.target.value)} style={{
          width:'100%', background:'rgba(255,255,255,0.04)', border:'1px solid var(--border)',
          borderRadius:8, padding:'10px 14px', color:'var(--text-primary)',
          fontFamily:'JetBrains Mono,monospace', fontSize:13, outline:'none',
        }}>
          {['1h','4h','Daily','Weekly'].map(tf => <option key={tf} value={tf}>{tf}</option>)}
        </select>
      </Field>
      <div style={{ background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.15)', borderRadius:10, padding:'12px 16px', marginBottom:20 }}>
        <div style={{ ...monoSm, color:'var(--amber)' }}>
          ⚠ Risk: ${(capital * riskPct / 100).toLocaleString()} per trade ({riskPct}% of ${Number(capital).toLocaleString()})
        </div>
      </div>
      <SaveBtn onClick={save} saving={saving} />
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
      // Apply immediately
      document.body.classList.toggle('light', theme === 'light');
      onToast('Theme updated', true);
    } catch { onToast('Error', false); }
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

// ── Security ──────────────────────────────────────────────
function SecuritySection({ onToast }) {
  const [current, setCurrent] = useState('');
  const [next,    setNext]    = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving,  setSaving]  = useState(false);

  const strength = next.length >= 12 ? 100 : next.length >= 8 ? 60 : next.length > 0 ? 30 : 0;
  const strengthColor = strength === 100 ? 'var(--green)' : strength === 60 ? 'var(--amber)' : 'var(--red)';
  const strengthLabel = strength === 100 ? 'Strong' : strength === 60 ? 'Medium' : strength > 0 ? 'Weak' : '';

  const save = async () => {
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
      <SaveBtn onClick={save} saving={saving} label="Change Password" />
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────
export default function Settings() {
  const [active,  setActive]  = useState('profile');
  const [loading, setLoading] = useState(true);
  const [data,    setData]    = useState(null);
  const [toast,   setToast]   = useState({ msg:'', ok:true });

  useEffect(() => {
    api.get('/settings')
      .then(res => { setData(res.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const showToast = (msg, ok) => {
    setToast({ msg, ok });
    setTimeout(() => setToast({ msg:'', ok:true }), 3000);
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
    appearance:    <AppearanceSection    data={data} onToast={showToast} />,
    security:      <SecuritySection               onToast={showToast} />,
  };

  return (
    <>
      <div style={{ marginBottom:4 }}>
        <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
          // Settings
        </div>
        <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
          Profile · Notifications · Trading · Appearance · Security
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'200px 1fr', gap:16, alignItems:'start' }}>

        {/* Sidebar */}
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

        {/* Content */}
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