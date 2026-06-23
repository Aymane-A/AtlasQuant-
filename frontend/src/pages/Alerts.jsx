import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { alertsAPI } from '../services/api';


export default function Alerts() {
  const { t } = useTranslation();
  const a = key => t(`alerts.${key}`);

  const [form, setForm] = useState({ symbol:'', type:'typePrice', condition:'above', value:'', notify:'once' });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState({ stats:null, notifications:[], alerts:[] });

  const loadAlerts = async () => {
    try {
      const res = await alertsAPI.getAll();
      setData({
        stats: res.data.stats,
        notifications: res.data.notifications || [],
        alerts: res.data.alerts || [],
      });
      setError('');
    } catch (err) {
      setError(err.error || 'Alerts unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAlerts();
    const id = setInterval(loadAlerts, 30000);
    return () => clearInterval(id);
  }, []);

  const inp = {
    width:'100%', padding:'10px 13px', borderRadius:8,
    border:'1px solid var(--border)', background:'rgba(255,255,255,0.04)',
    color:'var(--text-primary)', fontFamily:'JetBrains Mono,monospace',
    fontSize:12, outline:'none',
  };

  const ALERT_TYPES = ['typePrice','typeRsi','typeMacd','typeVolume','typePct'];
  const NOTIFY_OPTS = [
    { val:'once',   labelKey:'notifyOnce'  },
    { val:'always', labelKey:'notifyAlways'},
    { val:'daily',  labelKey:'notifyDaily' },
  ];
  const CHANNELS = ['channelInApp','channelEmail','channelSms','channelWebhook'];

  const STAT_CARDS = [
    { labelKey:'statActive',    v:data.stats?.active ?? 0,    color:'var(--cyan)'          },
    { labelKey:'statTriggered', v:data.stats?.triggered ?? 0, color:'var(--amber)'         },
    { labelKey:'statNear',      v:data.stats?.near ?? 0,      color:'var(--red)'           },
    { labelKey:'statPaused',    v:data.stats?.paused ?? 0,    color:'var(--text-secondary)'},
  ];
  const notifications = data.notifications || [];
  const alertCards = data.alerts || [];
  const unreadCount = notifications.filter(n => n.unread).length;

  return (
    <>
      {loading && (
        <div style={{ padding:'10px 14px', border:'1px solid var(--border)', borderRadius:10, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
          Loading alerts...
        </div>
      )}
      {error && (
        <div style={{ padding:'10px 14px', border:'1px solid rgba(248,113,113,0.25)', background:'rgba(248,113,113,0.08)', borderRadius:10, color:'var(--red)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
          {error}
        </div>
      )}
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
            {a('pageEngine')}
          </div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {a('pageSubtitle')}
          </div>
        </div>
        <button style={{ padding:'10px 22px', borderRadius:8, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}>
          {a('newAlert')}
        </button>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
        {STAT_CARDS.map(k => (
          <div key={k.labelKey} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'18px 20px' }}>
            <div style={{ fontSize:10, letterSpacing:'.12em', color:'var(--text-secondary)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:10 }}>
              {a(k.labelKey)}
            </div>
            <div style={{ fontSize:28, fontWeight:700, color:k.color }}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Feed + Form */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {/* Notification Feed */}
        <div className="panel" style={{ padding:22 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
              {a('feedTitle')}
            </div>
            <span style={{ background:'rgba(248,113,113,0.15)', color:'var(--red)', fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'2px 8px', borderRadius:5 }}>
              {t('alerts.unread', { count: unreadCount })}
            </span>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {notifications.map((n, i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'12px 14px', borderRadius:10, background: n.unread ? 'rgba(251,191,36,0.03)' : 'rgba(255,255,255,0.02)', border:`1px solid ${n.unread ? 'rgba(251,191,36,0.25)' : 'var(--border)'}` }}>
                <div style={{ width:34, height:34, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, background:n.bg, color:n.color, flexShrink:0 }}>
                  {n.icon}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, marginBottom:3 }}>{n.titleKey ? t(`alerts.${n.titleKey}`) : n.title}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', lineHeight:1.5 }}>{n.descKey ? t(`alerts.${n.descKey}`) : n.desc}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:4 }}>
                    {t('alerts.timeAgo', { time: n.time })}
                  </div>
                </div>
                {n.unread && <div style={{ width:7, height:7, borderRadius:'50%', background:'var(--amber)', flexShrink:0 }} />}
              </div>
            ))}
          </div>
        </div>

        {/* Create Alert */}
        <div className="panel" style={{ padding:22 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} />
            {a('createTitle')}
          </div>
          {submitted ? (
            <div style={{ textAlign:'center', padding:40, color:'var(--green)', fontFamily:'JetBrains Mono,monospace' }}>
              {a('successMsg')}
              <br />
              <button onClick={() => setSubmitted(false)} style={{ marginTop:16, padding:'8px 20px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:12, cursor:'pointer' }}>
                {a('newBtn')}
              </button>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <input
                  style={inp}
                  placeholder={a('symPlaceholder')}
                  value={form.symbol}
                  onChange={set('symbol')}
                />
                <select style={{ ...inp, color:'var(--text-secondary)' }} value={form.type} onChange={set('type')}>
                  {ALERT_TYPES.map(tk => (
                    <option key={tk} value={tk}>{a(tk)}</option>
                  ))}
                </select>
              </div>

              {/* Condition Toggle */}
              <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, padding:3 }}>
                {['above','below','equal'].map(c => (
                  <button key={c} onClick={() => setForm(f => ({ ...f, condition:c }))} style={{ flex:1, padding:7, borderRadius:6, border:'none', fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer', background: form.condition === c ? 'rgba(0,245,212,0.12)' : 'transparent', color: form.condition === c ? 'var(--cyan)' : 'var(--text-secondary)' }}>
                    {c === 'above' ? a('condAbove') : c === 'below' ? a('condBelow') : a('condEqual')}
                  </button>
                ))}
              </div>

              <input
                style={inp}
                placeholder={a('valuePlaceholder')}
                value={form.value}
                onChange={set('value')}
              />

              <select style={{ ...inp, color:'var(--text-secondary)' }} value={form.notify} onChange={set('notify')}>
                {NOTIFY_OPTS.map(o => (
                  <option key={o.val} value={o.val}>{a(o.labelKey)}</option>
                ))}
              </select>

              <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                {CHANNELS.map((ch, idx) => (
                  <label key={ch} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)', cursor:'pointer' }}>
                    <input type="checkbox" defaultChecked={idx < 2} style={{ accentColor:'var(--cyan)' }} />
                    {a(ch)}
                  </label>
                ))}
              </div>

              <button onClick={async () => {
                await alertsAPI.create(form);
                setSubmitted(true);
                loadAlerts();
              }} style={{ padding:12, borderRadius:8, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer', letterSpacing:'.04em' }}>
                {a('createBtn')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Alert Cards */}
      <div>
        <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:14 }}>
          {a('activeSection')}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          {alertCards.map((card, i) => (
            <div key={i} style={{ background:'var(--surface)', border:`1px solid ${card.near ? 'rgba(251,191,36,0.3)' : 'var(--border)'}`, borderRadius:12, padding:18, borderTop:`2px solid ${card.color}` }}>
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:17, fontWeight:700 }}>{card.sym}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                    {a(card.typeKey)}
                  </div>
                </div>
                <span style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'3px 9px', borderRadius:5, background: card.near ? 'rgba(251,191,36,0.12)' : 'rgba(0,245,212,0.08)', color: card.near ? 'var(--amber)' : 'var(--cyan)', fontWeight:600 }}>
                  {card.near ? a('near') : a('active')}
                </span>
              </div>
              <div style={{ fontSize:22, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:card.color, marginBottom:8 }}>
                {card.cur}
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontFamily:'JetBrains Mono,monospace', marginBottom:6 }}>
                <span style={{ color:'var(--text-muted)' }}>{a('target')}</span>
                <span style={{ color:'var(--text-secondary)' }}>{card.target}</span>
              </div>
              <div style={{ height:4, background:'rgba(255,255,255,0.05)', borderRadius:2, overflow:'hidden', marginBottom:6 }}>
                <div style={{ height:'100%', width:`${card.pct}%`, background:card.color, borderRadius:2, transition:'width 1s ease' }} />
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
                <span style={{ color:'var(--text-secondary)' }}>
                  {t('alerts.threshold', { pct: card.pct })}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
