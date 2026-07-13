import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { alertsAPI } from '../services/api';
import api from '../services/api';

// ✅ Feature: petit Levenshtein maison — pas de dépendance externe pour un
// besoin aussi simple. Sert à proposer des corrections quand ce que tape
// l'utilisateur ne matche aucun symbole connu exactement (fautes de frappe).
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// ✅ Feature: wildcards de classe — couvrent toute une classe d'actifs sans
// devoir taper chaque ticker un par un.
const WILDCARDS = [
  { key:'ALL_CRYPTO',    label:'All Crypto'    },
  { key:'ALL_FOREX',     label:'All Forex'     },
  { key:'ALL_COMMODITY', label:'All Commodity' },
  { key:'ALL_INDICES',   label:'All Indices'   },
];

export default function Alerts() {
  const { t } = useTranslation();
  const a = key => t(`alerts.${key}`);

  // ✅ Fix Bug 2: 'typeAiSignal' n'existe probablement pas dans les fichiers
  // de traduction (type ajouté après coup, généré par le backend, jamais
  // choisi via le formulaire). On l'affiche directement en clair plutôt que
  // de risquer d'afficher la clé brute "alerts.typeAiSignal" non traduite.
  const typeLabel = key => key === 'typeAiSignal' ? 'AI Signal' : a(key);

  const [form, setForm]         = useState({ symbol:'', type:'typePrice', condition:'above', value:'', notify:'once' });
  const [channels, setChannels] = useState({ inapp:true, email:true, telegram:false, sms:false });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const toggleChannel = k => setChannels(c => ({ ...c, [k]: !c[k] }));

  const [submitted, setSubmitted] = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'history'
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [data, setData]           = useState({ stats:null, notifications:[], alerts:[] });
  const [history, setHistory]     = useState([]);

  // ✅ Feature: préférences AI Signal Alerts — Follow All vs Custom (liste de
  // symboles précis tapés par l'utilisateur, ex. BTC, AAPL, EURUSD)
  const [alertPrefs, setAlertPrefs]     = useState({ mode:'all', symbols:[] });
  const [symbolInput, setSymbolInput]   = useState('');
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [prefsSaving, setPrefsSaving]   = useState(false);
  const [prefsSaved, setPrefsSaved]     = useState(false);

  // ✅ Feature: liste des symboles réellement scannés par AtlasQuant (crypto +
  // forex + commodities + indices), utilisée pour l'autocomplete/fuzzy-match
  // afin que l'utilisateur ne puisse pas taper un ticker inexistant sans s'en
  // rendre compte.
  const [knownSymbols, setKnownSymbols] = useState([]);
  useEffect(() => {
    api.get('/signals/meta/supported')
      .then(res => { if (res.data?.success) setKnownSymbols(res.data.symbols || []); })
      .catch(() => { /* autocomplete juste indisponible, pas bloquant */ });
  }, []);

  // Suggestions: substring match en priorité, sinon fuzzy (distance ≤ 3) pour
  // couvrir les fautes de frappe (ex. "BYC" → "BTC").
  const symbolSuggestions = useMemo(() => {
    const q = symbolInput.toUpperCase().trim();
    if (!q || knownSymbols.length === 0) return [];
    const substringMatches = knownSymbols.filter(s => s.symbol?.toUpperCase().includes(q));
    if (substringMatches.length > 0) return substringMatches.slice(0, 6);
    return knownSymbols
      .map(s => ({ ...s, _dist: levenshtein(q, (s.symbol || '').toUpperCase()) }))
      .sort((x, y) => x._dist - y._dist)
      .filter(s => s._dist <= 3)
      .slice(0, 6);
  }, [symbolInput, knownSymbols]);

  const loadAlerts = async () => {
    try {
      const res = await alertsAPI.getAll();
      setData({
        stats:         res.data.stats,
        notifications: res.data.notifications || [],
        alerts:        res.data.alerts        || [],
      });
      setError('');
    } catch (err) {
      setError(err.error || 'Alerts unavailable');
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    try {
      const res = await alertsAPI.getHistory();
      setHistory(res.data.history || []);
    } catch {}
  };

  // ✅ Feature: charge les préférences AI Signal Alerts existantes
  const loadAlertPrefs = async () => {
    setPrefsLoading(true);
    try {
      const res = await api.get('/settings');
      const s = res.data?.settings || {};
      setAlertPrefs({
        mode:    s.signal_alert_mode === 'custom' ? 'custom' : 'all',
        symbols: Array.isArray(s.signal_alert_symbols) ? s.signal_alert_symbols : [],
      });
    } catch { /* garde les valeurs par défaut si l'appel échoue */ }
    finally { setPrefsLoading(false); }
  };

  useEffect(() => {
    loadAlerts();
    loadHistory();
    loadAlertPrefs();
    const id = setInterval(() => { loadAlerts(); loadHistory(); }, 30000);
    return () => clearInterval(id);
  }, []);

  const handleDelete = async (id) => {
    try { await alertsAPI.remove(id); loadAlerts(); loadHistory(); }
    catch { setError('Failed to delete alert'); }
  };

  const handlePause = async (id) => {
    try { await alertsAPI.togglePause(id); loadAlerts(); }
    catch { setError('Failed to pause alert'); }
  };

  const handleReset = async (id) => {
    try { await alertsAPI.reset(id); loadAlerts(); loadHistory(); }
    catch { setError('Failed to reset alert'); }
  };

  const handleCreate = async () => {
    if (!form.symbol || !form.value) return;
    try {
      const activeChannels = Object.entries(channels).filter(([,v]) => v).map(([k]) => k);
      await alertsAPI.create({
        symbol: form.symbol, type: form.type,
        condition: form.condition, value: form.value,
        notify: form.notify, channels: activeChannels,
      });
      setSubmitted(true);
      setForm({ symbol:'', type:'typePrice', condition:'above', value:'', notify:'once' });
      setChannels({ inapp:true, email:true, telegram:false, sms:false });
      loadAlerts();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create alert');
    }
  };

  // ✅ Feature: ajoute un symbole (ou un wildcard de classe) à la liste suivie
  const addSymbolValue = (raw) => {
    const sym = String(raw).toUpperCase().trim();
    if (!sym) return;
    setPrefsSaved(false);
    setAlertPrefs(p => p.symbols.includes(sym) ? p : { ...p, symbols: [...p.symbols, sym] });
    setSymbolInput('');
  };

  const addSymbol = () => addSymbolValue(symbolInput);

  const removeSymbol = (sym) => {
    setPrefsSaved(false);
    setAlertPrefs(p => ({ ...p, symbols: p.symbols.filter(s => s !== sym) }));
  };

  const handleSymbolKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      // Si une suggestion existe et que ce qui est tapé ne matche aucun
      // symbole connu exactement, on prend la meilleure suggestion — évite
      // d'ajouter un ticker mal orthographié tel quel.
      const q = symbolInput.toUpperCase().trim();
      const exact = knownSymbols.find(s => s.symbol?.toUpperCase() === q);
      if (!exact && symbolSuggestions[0]) {
        addSymbolValue(symbolSuggestions[0].symbol);
      } else {
        addSymbol();
      }
    }
  };

  const setPrefsMode = (mode) => {
    setPrefsSaved(false);
    setAlertPrefs(p => ({ ...p, mode }));
  };

  const savePrefs = async () => {
    if (alertPrefs.mode === 'custom' && alertPrefs.symbols.length === 0) {
      setError('Add at least one symbol to follow');
      return;
    }
    setPrefsSaving(true);
    try {
      await api.post('/settings/update', {
        section: 'signalAlerts',
        payload: { mode: alertPrefs.mode, symbols: alertPrefs.symbols },
      });
      setPrefsSaved(true);
      setError('');
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save alert preferences');
    } finally {
      setPrefsSaving(false);
    }
  };

  // ── Filtered alert cards by search ───────────────────────
  const filteredCards = useMemo(() =>
    (data.alerts || []).filter(c =>
      !search || c.sym.toLowerCase().includes(search.toLowerCase())
    ), [data.alerts, search]);

  const filteredHistory = useMemo(() =>
    history.filter(h =>
      !search || h.sym.toLowerCase().includes(search.toLowerCase())
    ), [history, search]);

  const inp = {
    width:'100%', padding:'10px 13px', borderRadius:8,
    border:'1px solid var(--border)', background:'rgba(255,255,255,0.04)',
    color:'var(--text-primary)', fontFamily:'JetBrains Mono,monospace',
    fontSize:12, outline:'none',
  };

  const ALERT_TYPES = ['typePrice','typeRsi','typeMacd','typeVolume','typePct'];
  const NOTIFY_OPTS = [
    { val:'once',   labelKey:'notifyOnce'   },
    { val:'always', labelKey:'notifyAlways' },
    { val:'daily',  labelKey:'notifyDaily'  },
  ];
  const CHANNEL_OPTS = [
    { key:'inapp',    label:'In-App',   icon:'🔔', always:true  },
    { key:'email',    label:'Email',    icon:'📧', always:false },
    { key:'telegram', label:'Telegram', icon:'✈️', always:false },
    { key:'sms',      label:'SMS',      icon:'💬', always:false, disabled:true },
  ];

  const STAT_CARDS = [
    { labelKey:'statActive',    v:data.stats?.active    ?? 0, color:'var(--cyan)'          },
    { labelKey:'statTriggered', v:data.stats?.triggered ?? 0, color:'var(--amber)'         },
    { labelKey:'statNear',      v:data.stats?.near      ?? 0, color:'var(--red)'           },
    { labelKey:'statPaused',    v:data.stats?.paused    ?? 0, color:'var(--text-secondary)'},
  ];

  const notifications = data.notifications || [];
  const unreadCount   = notifications.filter(n => n.unread).length;

  const iconBtn = (onClick, title, hoverColor='var(--red)') => ({
    onClick, title,
    style: {
      background:'transparent', border:'none', cursor:'pointer',
      color:'var(--text-muted)', fontSize:13, padding:'4px 6px',
      borderRadius:6, transition:'color .15s', fontFamily:'JetBrains Mono,monospace',
    },
    onMouseEnter: e => e.currentTarget.style.color = hoverColor,
    onMouseLeave: e => e.currentTarget.style.color = 'var(--text-muted)',
  });

  const tabStyle = (tab) => ({
    padding:'7px 18px', borderRadius:7, border:'none', cursor:'pointer',
    fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600,
    letterSpacing:'.06em', textTransform:'uppercase',
    background: activeTab === tab ? 'rgba(0,245,212,0.12)' : 'transparent',
    color:      activeTab === tab ? 'var(--cyan)' : 'var(--text-muted)',
    transition: 'all .15s',
  });

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
        <button
          onClick={() => { setShowForm(true); setSubmitted(false); }}
          style={{ padding:'10px 22px', borderRadius:8, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}
        >
          {a('newAlert')}
        </button>
      </div>

      {/* ══ AI SIGNAL ALERT PREFERENCES ══ */}
      {/* ✅ Feature: choix entre "suivre tout" et "suivre seulement certaines
          classes d'actifs" pour les alertes AI auto-générées (signalAlert.service.js) */}
      <div className="panel" style={{ padding:20 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:10 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright, #a78bfa)' }} />
              🤖 AI Signal Alerts
            </div>
            <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>
              Auto-alerts for high-confidence signals (≥75%) — choose what to follow
            </div>
          </div>
          {!prefsLoading && (
            <button onClick={savePrefs} disabled={prefsSaving} style={{
              padding:'8px 18px', borderRadius:8, border:'1px solid var(--cyan-dim)',
              background: prefsSaved ? 'rgba(52,211,153,0.1)' : 'var(--cyan-glow)',
              color: prefsSaved ? 'var(--green)' : 'var(--cyan)',
              fontFamily:'Syne,sans-serif', fontSize:12, fontWeight:700,
              cursor: prefsSaving ? 'not-allowed' : 'pointer', opacity: prefsSaving ? 0.7 : 1,
            }}>
              {prefsSaving ? 'Saving...' : prefsSaved ? '✓ Saved' : 'Save preferences'}
            </button>
          )}
        </div>

        {prefsLoading ? (
          <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>Loading preferences...</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {/* Mode choice */}
            <div style={{ display:'flex', gap:10 }}>
              {[
                { val:'all',    label:'Follow Everything', desc:'Get alerted on every high-confidence signal, any asset class' },
                { val:'custom', label:'Custom',             desc:'Only follow specific symbols you choose' },
              ].map(opt => (
                <button key={opt.val} onClick={() => setPrefsMode(opt.val)} style={{
                  flex:1, textAlign:'left', padding:'12px 16px', borderRadius:10, cursor:'pointer',
                  border:`1px solid ${alertPrefs.mode===opt.val ? 'var(--cyan-dim)' : 'var(--border)'}`,
                  background: alertPrefs.mode===opt.val ? 'rgba(0,245,212,0.06)' : 'transparent',
                  transition:'all .15s',
                }}>
                  <div style={{ fontSize:12, fontWeight:700, color: alertPrefs.mode===opt.val ? 'var(--cyan)' : 'var(--text-primary)', marginBottom:3 }}>
                    {alertPrefs.mode===opt.val ? '● ' : '○ '}{opt.label}
                  </div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', lineHeight:1.5 }}>
                    {opt.desc}
                  </div>
                </button>
              ))}
            </div>

            {/* Symbol watchlist — only when 'custom' */}
            {alertPrefs.mode === 'custom' && (
              <div style={{ padding:'12px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10 }}>

                {/* Wildcard quick-add */}
                <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
                  {WILDCARDS.map(w => {
                    const active = alertPrefs.symbols.includes(w.key);
                    return (
                      <button key={w.key} onClick={() => addSymbolValue(w.key)} disabled={active} style={{
                        padding:'5px 12px', borderRadius:20, cursor: active ? 'default' : 'pointer',
                        fontFamily:'JetBrains Mono,monospace', fontSize:10, fontWeight:600,
                        border:`1px solid ${active ? 'rgba(167,139,250,0.15)' : 'rgba(167,139,250,0.3)'}`,
                        background: active ? 'rgba(167,139,250,0.05)' : 'rgba(167,139,250,0.1)',
                        color: active ? 'rgba(167,139,250,0.4)' : '#a78bfa',
                        opacity: active ? 0.6 : 1,
                      }}>
                        🌐 {w.label}{active ? ' ✓' : ''}
                      </button>
                    );
                  })}
                </div>

                {/* Text input + autocomplete dropdown */}
                <div style={{ position:'relative' }}>
                  <div style={{ display:'flex', gap:8 }}>
                    <input
                      style={{ ...inp, flex:1 }}
                      placeholder="Type a symbol (BTC, AAPL, EURUSD...) — suggestions appear below"
                      value={symbolInput}
                      onChange={e => setSymbolInput(e.target.value)}
                      onKeyDown={handleSymbolKeyDown}
                    />
                    <button onClick={addSymbol} style={{
                      padding:'0 18px', borderRadius:8, border:'1px solid var(--cyan-dim)',
                      background:'rgba(0,245,212,0.08)', color:'var(--cyan)',
                      fontFamily:'JetBrains Mono,monospace', fontSize:12, fontWeight:700, cursor:'pointer',
                    }}>
                      + Add
                    </button>
                  </div>

                  {/* Live suggestions — ✅ Feature: le système propose les
                      symboles réellement suivis par AtlasQuant, tolère les
                      fautes de frappe via fuzzy match */}
                  {symbolSuggestions.length > 0 && (
                    <div style={{
                      position:'absolute', top:'calc(100% + 4px)', left:0, right:90, zIndex:20,
                      background:'#0a0f1e', border:'1px solid var(--cyan-dim)', borderRadius:8,
                      boxShadow:'0 8px 24px rgba(0,0,0,0.5)', overflow:'hidden',
                    }}>
                      {symbolSuggestions.map(s => (
                        <div key={s.symbol} onClick={() => addSymbolValue(s.symbol)} style={{
                          padding:'8px 14px', cursor:'pointer', display:'flex',
                          justifyContent:'space-between', alignItems:'center',
                          fontFamily:'JetBrains Mono,monospace', fontSize:11,
                          borderBottom:'1px solid rgba(255,255,255,0.05)',
                        }}
                          onMouseEnter={e => e.currentTarget.style.background='rgba(0,245,212,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background='transparent'}
                        >
                          <span style={{ color:'var(--text-primary)', fontWeight:700 }}>{s.symbol}</span>
                          <span style={{ color:'var(--text-muted)', fontSize:9 }}>{s.asset_class}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Chips */}
                {alertPrefs.symbols.length === 0 ? (
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:10 }}>
                    No symbols yet — add tickers above, or use "All Crypto" / "All Forex" / etc.
                  </div>
                ) : (
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:10 }}>
                    {alertPrefs.symbols.map(sym => {
                      const isWildcard = sym.startsWith('ALL_');
                      const wLabel = isWildcard ? WILDCARDS.find(w => w.key === sym)?.label || sym : sym;
                      return (
                        <span key={sym} style={{
                          display:'flex', alignItems:'center', gap:6,
                          padding:'6px 10px 6px 14px', borderRadius:20,
                          border:`1px solid ${isWildcard ? 'rgba(167,139,250,0.3)' : 'var(--cyan-dim)'}`,
                          background: isWildcard ? 'rgba(167,139,250,0.1)' : 'rgba(0,245,212,0.1)',
                          color: isWildcard ? '#a78bfa' : 'var(--cyan)',
                          fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600,
                        }}>
                          {isWildcard ? '🌐 ' : ''}{wLabel}
                          <span onClick={() => removeSymbol(sym)} style={{ cursor:'pointer', opacity:0.7, fontWeight:700, padding:'0 2px' }}>✕</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
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
      <div style={{ display:'grid', gridTemplateColumns: showForm ? '1fr 1fr' : '1fr', gap:16 }}>

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
            {notifications.length === 0 && (
              <div style={{ padding:'20px 0', textAlign:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
                No triggered alerts yet
              </div>
            )}
            {notifications.map((n, i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'12px 14px', borderRadius:10, background: n.unread ? 'rgba(251,191,36,0.03)' : 'rgba(255,255,255,0.02)', border:`1px solid ${n.unread ? 'rgba(251,191,36,0.25)' : 'var(--border)'}` }}>
                <div style={{ width:34, height:34, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, background:n.bg, color:n.color, flexShrink:0 }}>
                  {n.icon}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, marginBottom:3 }}>{n.title}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', lineHeight:1.5 }}>{n.desc}</div>
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
        {showForm && (
          <div className="panel" style={{ padding:22 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
              <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} />
                {a('createTitle')}
              </div>
              <button onClick={() => setShowForm(false)} style={{ background:'transparent', border:'none', color:'var(--text-muted)', fontSize:16, cursor:'pointer', padding:'2px 6px' }}>✕</button>
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
                  <input style={inp} placeholder={a('symPlaceholder')} value={form.symbol} onChange={set('symbol')} />
                  <select style={{ ...inp, color:'var(--text-secondary)' }} value={form.type} onChange={set('type')}>
                    {ALERT_TYPES.map(tk => <option key={tk} value={tk}>{a(tk)}</option>)}
                  </select>
                </div>
                <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, padding:3 }}>
                  {['above','below','equal'].map(c => (
                    <button key={c} onClick={() => setForm(f => ({ ...f, condition:c }))}
                      style={{ flex:1, padding:7, borderRadius:6, border:'none', fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer', background: form.condition===c ? 'rgba(0,245,212,0.12)' : 'transparent', color: form.condition===c ? 'var(--cyan)' : 'var(--text-secondary)' }}>
                      {c==='above' ? a('condAbove') : c==='below' ? a('condBelow') : a('condEqual')}
                    </button>
                  ))}
                </div>
                <input style={inp} placeholder={a('valuePlaceholder')} value={form.value} onChange={set('value')} type="number" />
                <select style={{ ...inp, color:'var(--text-secondary)' }} value={form.notify} onChange={set('notify')}>
                  {NOTIFY_OPTS.map(o => <option key={o.val} value={o.val}>{a(o.labelKey)}</option>)}
                </select>
                <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, padding:'12px 14px' }}>
                  <div style={{ fontSize:10, letterSpacing:'.1em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:10 }}>Notify via</div>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                    {CHANNEL_OPTS.map(ch => (
                      <button key={ch.key} onClick={() => !ch.always && !ch.disabled && toggleChannel(ch.key)}
                        style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', borderRadius:8, fontSize:12, fontFamily:'JetBrains Mono,monospace', cursor:ch.disabled?'not-allowed':'pointer', border:`1px solid ${channels[ch.key]?'var(--cyan-dim)':'var(--border)'}`, background:channels[ch.key]?'rgba(0,245,212,0.08)':'transparent', color:channels[ch.key]?'var(--cyan)':'var(--text-muted)', opacity:ch.disabled?0.4:1, transition:'all .15s' }}>
                        <span>{ch.icon}</span><span>{ch.label}</span>
                        {ch.disabled && <span style={{ fontSize:9, opacity:.6 }}>(soon)</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={handleCreate} style={{ padding:12, borderRadius:8, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer', letterSpacing:'.04em' }}>
                  {a('createBtn')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs + Search */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
        {/* Tabs */}
        <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9, padding:3 }}>
          <button style={tabStyle('active')} onClick={() => setActiveTab('active')}>
            Active {data.stats?.active > 0 && <span style={{ marginLeft:6, background:'rgba(0,245,212,0.15)', color:'var(--cyan)', fontSize:10, padding:'1px 6px', borderRadius:4 }}>{data.stats.active}</span>}
          </button>
          <button style={tabStyle('history')} onClick={() => setActiveTab('history')}>
            History {history.length > 0 && <span style={{ marginLeft:6, background:'rgba(251,191,36,0.15)', color:'var(--amber)', fontSize:10, padding:'1px 6px', borderRadius:4 }}>{history.length}</span>}
          </button>
        </div>

        {/* Search */}
        <div style={{ position:'relative', flex:1, maxWidth:260 }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-muted)', fontSize:12 }}>🔍</span>
          <input
            style={{ ...inp, paddingLeft:30, width:'100%' }}
            placeholder="Filter by symbol..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* ── ACTIVE TAB ── */}
      {activeTab === 'active' && (
        <div>
          {filteredCards.length === 0 && !loading && (
            <div style={{ padding:'30px 0', textAlign:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
              {search ? `No alerts matching "${search}"` : 'No active alerts — create one above'}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
            {filteredCards.map(card => (
              <div key={card.id} style={{ background:'var(--surface)', border:`1px solid ${card.near?'rgba(251,191,36,0.3)':'var(--border)'}`, borderRadius:12, padding:18, borderTop:`2px solid ${card.color}` }}>
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:17, fontWeight:700 }}>{card.sym}</div>
                    <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>{typeLabel(card.typeKey)}</div>
                  </div>
                  <span style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'3px 9px', borderRadius:5, background:card.near?'rgba(251,191,36,0.12)':'rgba(0,245,212,0.08)', color:card.near?'var(--amber)':'var(--cyan)', fontWeight:600 }}>
                    {card.near ? a('near') : a('active')}
                  </span>
                </div>
                <div style={{ fontSize:22, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:card.color, marginBottom:8 }}>{card.cur}</div>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontFamily:'JetBrains Mono,monospace', marginBottom:6 }}>
                  <span style={{ color:'var(--text-muted)' }}>{a('target')}</span>
                  <span style={{ color:'var(--text-secondary)' }}>{card.target}</span>
                </div>
                <div style={{ height:4, background:'rgba(255,255,255,0.05)', borderRadius:2, overflow:'hidden', marginBottom:8 }}>
                  <div style={{ height:'100%', width:`${card.pct}%`, background:card.color, borderRadius:2, transition:'width 1s ease' }} />
                </div>
                {/* Channel badges */}
                <div style={{ display:'flex', gap:5, marginBottom:8 }}>
                  {card.notifyEmail    && <span style={{ fontSize:9, fontFamily:'JetBrains Mono,monospace', padding:'2px 7px', borderRadius:4, background:'rgba(0,245,212,0.08)', color:'var(--cyan)', border:'1px solid var(--cyan-dim)' }}>📧 Email</span>}
                  {card.notifyTelegram && <span style={{ fontSize:9, fontFamily:'JetBrains Mono,monospace', padding:'2px 7px', borderRadius:4, background:'rgba(99,102,241,0.08)', color:'#818cf8', border:'1px solid rgba(99,102,241,0.25)' }}>✈️ Telegram</span>}
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
                  <span style={{ color:'var(--text-secondary)' }}>{t('alerts.threshold', { pct: card.pct })}</span>
                  <div style={{ display:'flex', gap:2 }}>
                    <button {...iconBtn(() => handlePause(card.id), 'Pause', 'var(--amber)')}>⏸</button>
                    <button {...iconBtn(() => handleDelete(card.id), 'Delete', 'var(--red)')}>🗑</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {activeTab === 'history' && (
        <div>
          {filteredHistory.length === 0 && (
            <div style={{ padding:'30px 0', textAlign:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
              {search ? `No history matching "${search}"` : 'No triggered alerts yet'}
            </div>
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {filteredHistory.map(h => (
              <div key={h.id} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 18px', display:'flex', alignItems:'center', gap:16 }}>
                {/* Color dot */}
                <div style={{ width:8, height:8, borderRadius:'50%', background:h.color, flexShrink:0 }} />
                {/* Symbol */}
                <div style={{ minWidth:80 }}>
                  <div style={{ fontSize:14, fontWeight:700 }}>{h.sym}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>{typeLabel(h.typeKey)}</div>
                </div>
                {/* Condition + target */}
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>
                    {h.condition} {h.target}
                  </div>
                </div>
                {/* Triggered at */}
                <div style={{ fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', textAlign:'right' }}>
                  <div style={{ color:'var(--amber)', marginBottom:2 }}>✓ Triggered</div>
                  <div>{h.triggeredAt ? new Date(h.triggeredAt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}</div>
                </div>
                {/* Channels */}
                <div style={{ display:'flex', gap:4 }}>
                  {h.notifyEmail    && <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, background:'rgba(0,245,212,0.08)', color:'var(--cyan)', border:'1px solid var(--cyan-dim)', fontFamily:'JetBrains Mono,monospace' }}>📧</span>}
                  {h.notifyTelegram && <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, background:'rgba(99,102,241,0.08)', color:'#818cf8', border:'1px solid rgba(99,102,241,0.25)', fontFamily:'JetBrains Mono,monospace' }}>✈️</span>}
                </div>
                {/* Reset button */}
                <button {...iconBtn(() => handleReset(h.id), 'Reset alert — watch again', 'var(--cyan)')}>↺</button>
                {/* Delete */}
                <button {...iconBtn(() => handleDelete(h.id), 'Delete', 'var(--red)')}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}