import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '../services/api';

// ── Design tokens ─────────────────────────────────────────
const PERM_CFG = {
  READ:  { color:'#00f5d4', bg:'rgba(0,245,212,0.08)',   border:'rgba(0,245,212,0.2)'   },
  WRITE: { color:'#fbbf24', bg:'rgba(251,191,36,0.08)',  border:'rgba(251,191,36,0.2)'  },
  TRADE: { color:'#f87171', bg:'rgba(248,113,113,0.08)', border:'rgba(248,113,113,0.2)' },
  ADMIN: { color:'#a78bfa', bg:'rgba(167,139,250,0.08)', border:'rgba(167,139,250,0.2)' },
};

const METHOD_CFG = {
  GET:    { color:'#00f5d4', bg:'rgba(0,245,212,0.08)'   },
  POST:   { color:'#a78bfa', bg:'rgba(167,139,250,0.08)' },
  DELETE: { color:'#f87171', bg:'rgba(248,113,113,0.08)' },
  PUT:    { color:'#fbbf24', bg:'rgba(251,191,36,0.08)'  },
};

const ENDPOINTS = [
  { method:'GET',    path:'/v2/signals',        desc:'Active signals'      },
  { method:'GET',    path:'/v2/portfolio',      desc:'Portfolio snapshot'  },
  { method:'GET',    path:'/v2/market/quotes',  desc:'Real-time quotes'    },
  { method:'POST',   path:'/v2/orders',         desc:'Place an order'      },
  { method:'GET',    path:'/v2/screener',       desc:'Run screener'        },
  { method:'GET',    path:'/v2/analytics',      desc:'Performance metrics' },
  { method:'POST',   path:'/v2/watchlist',      desc:'Add to watchlist'    },
  { method:'GET',    path:'/v2/news',           desc:'Market news feed'    },
  { method:'DELETE', path:'/v2/alerts/:id',     desc:'Delete alert'        },
];

const mono = { fontFamily:'JetBrains Mono,monospace' };
const tt   = { contentStyle:{ background:'rgba(3,7,18,0.97)', border:'1px solid rgba(0,245,212,0.2)', borderRadius:8, ...mono, fontSize:11 } };

// ── Perm Badge ────────────────────────────────────────────
function PermBadge({ p }) {
  const c = PERM_CFG[p] || PERM_CFG.READ;
  return (
    <span style={{ ...mono, fontSize:9, fontWeight:700, letterSpacing:'.08em', padding:'2px 7px', borderRadius:4, color:c.color, background:c.bg, border:`1px solid ${c.border}` }}>
      {p}
    </span>
  );
}

// ── Stat Card ─────────────────────────────────────────────
function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:'20px 22px', position:'relative', overflow:'hidden' }}>
      <div style={{ position:'absolute', top:0, left:0, width:3, height:'100%', background:accent, borderRadius:'14px 0 0 14px' }} />
      <div style={{ ...mono, fontSize:9, letterSpacing:'.18em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:10 }}>{label}</div>
      <div style={{ fontSize:28, fontWeight:800, color:accent, letterSpacing:'-.02em', marginBottom:4 }}>{value}</div>
      <div style={{ ...mono, fontSize:10, color:'var(--text-secondary)' }}>{sub}</div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────
export default function ApiKeys() {
  const [keys,      setKeys]      = useState([]);
  const [stats,     setStats]     = useState({});
  const [rates,     setRates]     = useState([]);
  const [webhooks,  setWebhooks]  = useState([]);
  const [reqVolume, setReqVolume] = useState([]);
  const [loading,   setLoading]   = useState(true);

  const [revealed,  setRevealed]  = useState({});
  const [copied,    setCopied]    = useState({});
  const [showModal, setShowModal] = useState(false);
  const [newName,   setNewName]   = useState('');
  const [perms,     setPerms]     = useState({ READ:true, WRITE:false, TRADE:false, ADMIN:false });
  const [creating,  setCreating]  = useState(false);
  const [newKeyVal, setNewKeyVal] = useState('');

  const load = () => {
    api.get('/apikeys/dashboard-data')
      .then(res => {
        setKeys(res.data.keys      || []);
        setStats(res.data.stats    || {});
        setRates(res.data.rates    || []);
        setWebhooks(res.data.webhooks  || []);
        setReqVolume(res.data.reqVolume || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const createKey = async () => {
    const name = newName.trim() || 'My API Key';
    const selectedPerms = Object.entries(perms).filter(([,v])=>v).map(([k])=>k);
    setCreating(true);
    try {
      const res = await api.post('/apikeys/create', { name, permissions: selectedPerms });
      setNewKeyVal(res.data.key || '');
      load();
    } catch (err) { console.error(err); }
    finally { setCreating(false); }
  };

  const copyKey = (val, idx) => {
    navigator.clipboard?.writeText(val).catch(()=>{});
    setCopied(c => ({ ...c, [idx]: true }));
    setTimeout(() => setCopied(c => ({ ...c, [idx]: false })), 2000);
  };

  if (loading) return (
    <div style={{ ...mono, color:'var(--text-muted)', padding:20, fontSize:12 }}>
      // Loading API environment...
    </div>
  );

  return (
    <>
      {/* ── Modal ── */}
      {showModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', backdropFilter:'blur(12px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={e => e.target === e.currentTarget && !newKeyVal && setShowModal(false)}
        >
          <div style={{ background:'#0a1020', border:'1px solid rgba(0,245,212,0.15)', borderRadius:18, padding:32, width:500, boxShadow:'0 32px 64px rgba(0,0,0,0.6)' }}>
            {newKeyVal ? (
              /* ── Key Created ── */
              <>
                <div style={{ textAlign:'center', marginBottom:24 }}>
                  <div style={{ fontSize:32, marginBottom:12 }}>🔑</div>
                  <div style={{ fontSize:16, fontWeight:700, color:'var(--text-primary)', marginBottom:8 }}>Key Generated</div>
                  <div style={{ ...mono, fontSize:11, color:'var(--text-muted)' }}>Copy it now — it won't be shown again</div>
                </div>
                <div style={{ background:'rgba(0,245,212,0.04)', border:'1px solid rgba(0,245,212,0.15)', borderRadius:10, padding:'14px 16px', marginBottom:20, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                  <span style={{ ...mono, fontSize:11, color:'var(--cyan)', wordBreak:'break-all' }}>{newKeyVal}</span>
                  <button onClick={() => copyKey(newKeyVal, 'new')} style={{ ...mono, flexShrink:0, padding:'5px 12px', borderRadius:6, border:'1px solid rgba(0,245,212,0.2)', background:'rgba(0,245,212,0.08)', color: copied['new'] ? 'var(--green)' : 'var(--cyan)', fontSize:10, cursor:'pointer' }}>
                    {copied['new'] ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <button onClick={() => { setShowModal(false); setNewKeyVal(''); setNewName(''); setPerms({ READ:true, WRITE:false, TRADE:false, ADMIN:false }); }} style={{ width:'100%', padding:12, borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
                  Done
                </button>
              </>
            ) : (
              /* ── Create Form ── */
              <>
                <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)', marginBottom:22, display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
                  New API Key
                </div>

                <div style={{ marginBottom:18 }}>
                  <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:8 }}>Key Name</div>
                  <input
                    value={newName} onChange={e => setNewName(e.target.value)}
                    placeholder="e.g. Trading Bot, Dashboard..."
                    style={{ width:'100%', background:'rgba(255,255,255,0.04)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', color:'var(--text-primary)', ...mono, fontSize:12, outline:'none', boxSizing:'border-box' }}
                    onFocus={e => e.target.style.borderColor='rgba(0,245,212,0.4)'}
                    onBlur={e  => e.target.style.borderColor='var(--border)'}
                  />
                </div>

                <div style={{ marginBottom:22 }}>
                  <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:10 }}>Permissions</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {Object.entries(PERM_CFG).map(([p, c]) => (
                      <label key={p} onClick={() => setPerms(prev => ({ ...prev, [p]: !prev[p] }))} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', borderRadius:9, border:`1px solid ${perms[p] ? c.border : 'var(--border)'}`, background: perms[p] ? c.bg : 'rgba(255,255,255,0.02)', cursor:'pointer', transition:'all .15s' }}>
                        <div style={{ width:16, height:16, borderRadius:4, border:`2px solid ${perms[p] ? c.color : 'var(--border)'}`, background: perms[p] ? c.color : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all .15s' }}>
                          {perms[p] && <span style={{ color:'#000', fontSize:10, fontWeight:900 }}>✓</span>}
                        </div>
                        <span style={{ ...mono, fontSize:10, fontWeight:700, color:c.color }}>{p}</span>
                        <span style={{ fontSize:11, color:'var(--text-secondary)' }}>
                          {p==='READ'?'Read signals & analytics':p==='WRITE'?'Manage watchlist & alerts':p==='TRADE'?'Execute paper trades':'Full administrative access'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div style={{ display:'flex', gap:10 }}>
                  <button onClick={createKey} disabled={creating} style={{ flex:1, padding:12, borderRadius:9, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.7 : 1 }}>
                    {creating ? 'Generating...' : '⬡ Generate Key'}
                  </button>
                  <button onClick={() => setShowModal(false)} style={{ padding:'12px 20px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between' }}>
        <div>
          <div style={{ ...mono, fontSize:10, letterSpacing:'.2em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:6 }}>// API Access</div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', ...mono }}>
            Base URL: <span style={{ color:'var(--cyan)' }}>https://api.atlasquant.ai/v2</span>
          </div>
        </div>
        <button onClick={() => setShowModal(true)} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 22px', borderRadius:9, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}>
          <span style={{ fontSize:16 }}>+</span> New API Key
        </button>
      </div>

      {/* ── Stats ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
        <StatCard label="Active Keys"   value={stats.activeKeys  || '0'} sub="Currently enabled"      accent="var(--cyan)"          />
        <StatCard label="Requests Today" value={stats.reqToday   || '0'} sub="Across all keys"         accent="var(--green)"         />
        <StatCard label="Error Rate"    value={stats.errorRate   || '0%'} sub="Last 24 hours"          accent="var(--green)"         />
        <StatCard label="Avg Latency"   value={stats.avgLatency  || '—'} sub="p50 response time"       accent="var(--amber)"         />
      </div>

      {/* ── Keys List ── */}
      <div>
        <div style={{ ...mono, fontSize:9, letterSpacing:'.2em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:14 }}>Your Keys</div>

        {keys.length === 0 ? (
          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:'48px 24px', textAlign:'center' }}>
            <div style={{ fontSize:32, opacity:.15, marginBottom:12 }}>◎</div>
            <div style={{ ...mono, fontSize:12, color:'var(--text-muted)', marginBottom:16 }}>No API keys yet</div>
            <button onClick={() => setShowModal(true)} style={{ padding:'9px 22px', borderRadius:9, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}>
              Create your first key
            </button>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {keys.map((k, i) => (
              <div key={i} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:'20px 22px', display:'grid', gap:14 }}>
                {/* Top row */}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', background:'var(--green)', boxShadow:'0 0 8px var(--green)', flexShrink:0 }} />
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--text-primary)' }}>{k.name}</span>
                    <span style={{ ...mono, fontSize:9, padding:'2px 8px', borderRadius:4, background:'rgba(52,211,153,0.1)', color:'var(--green)', border:'1px solid rgba(52,211,153,0.2)', fontWeight:700 }}>ACTIVE</span>
                    {(k.perms || []).map(p => <PermBadge key={p} p={p} />)}
                  </div>
                  <div style={{ display:'flex', gap:8, flexShrink:0 }}>
                    <button onClick={() => copyKey(k.full, i)} style={{ ...mono, padding:'5px 12px', borderRadius:6, border:'1px solid var(--border)', background:'transparent', color: copied[i] ? 'var(--green)' : 'var(--text-muted)', fontSize:10, cursor:'pointer', transition:'color .2s' }}>
                      {copied[i] ? '✓ Copied' : 'Copy'}
                    </button>
                    <button style={{ ...mono, padding:'5px 12px', borderRadius:6, border:'1px solid rgba(248,113,113,0.2)', background:'rgba(248,113,113,0.06)', color:'var(--red)', fontSize:10, cursor:'pointer' }}>
                      Revoke
                    </button>
                  </div>
                </div>

                {/* Key value */}
                <div style={{ display:'flex', alignItems:'center', gap:10, background:'rgba(0,0,0,0.2)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px' }}>
                  <span style={{ ...mono, fontSize:12, color:'var(--text-secondary)', flex:1, letterSpacing:'.04em' }}>
                    {revealed[i] ? k.full : k.val}
                  </span>
                  <button onClick={() => setRevealed(r => ({ ...r, [i]: !r[i] }))} style={{ ...mono, padding:'3px 10px', borderRadius:5, border:'1px solid var(--border)', background:'transparent', color:'var(--text-muted)', fontSize:9, cursor:'pointer', flexShrink:0 }}>
                    {revealed[i] ? 'Hide' : 'Reveal'}
                  </button>
                </div>

                {/* Meta row */}
                <div style={{ display:'flex', gap:20, ...mono, fontSize:10, color:'var(--text-muted)' }}>
                  <span>IP: <span style={{ color:'var(--text-secondary)' }}>{k.ip}</span></span>
                  <span>Created: <span style={{ color:'var(--text-secondary)' }}>{k.created}</span></span>
                  <span>Last used: <span style={{ color:'var(--text-secondary)' }}>{k.lastUsed}</span></span>
                  <span style={{ color:'var(--cyan)', marginLeft:'auto' }}>↑ {k.calls} calls today</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Chart + Rate Limits ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr', gap:16 }}>

        {/* Request Volume */}
        <div className="panel" style={{ padding:22 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
            Request Volume (24h)
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={reqVolume}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
              <XAxis dataKey="hour" tick={{ fontSize:8, fill:'#64748b', ...mono }} interval={5} />
              <YAxis hide />
              <Tooltip {...tt} formatter={v => [v + ' req', 'Requests']} />
              <Bar dataKey="requests" fill="rgba(0,245,212,0.35)" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Rate Limits */}
        <div className="panel" style={{ padding:22 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
            Rate Limits
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {rates.map(r => {
              const pct = Math.round((r.used / r.max) * 100);
              const barColor = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--amber)' : r.color || 'var(--cyan)';
              return (
                <div key={r.label}>
                  <div style={{ display:'flex', justifyContent:'space-between', ...mono, fontSize:10, marginBottom:6 }}>
                    <span style={{ color:'var(--text-secondary)' }}>{r.label}</span>
                    <span style={{ color: barColor }}>
                      {r.used} <span style={{ color:'var(--text-muted)' }}>/ {r.max} /min</span>
                    </span>
                  </div>
                  <div style={{ height:5, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${pct}%`, background: barColor, borderRadius:3, transition:'width 1s ease' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Quick Reference ── */}
      <div className="panel" style={{ padding:22 }}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} />
          API Reference
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
          {ENDPOINTS.map(e => {
            const mc = METHOD_CFG[e.method] || METHOD_CFG.GET;
            return (
              <div key={e.path} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px', transition:'border-color .2s' }}
                onMouseEnter={e2 => e2.currentTarget.style.borderColor='rgba(0,245,212,0.15)'}
                onMouseLeave={e2 => e2.currentTarget.style.borderColor='var(--border)'}
              >
                <div style={{ marginBottom:8 }}>
                  <span style={{ ...mono, fontSize:9, fontWeight:700, letterSpacing:'.06em', color:mc.color, background:mc.bg, border:`1px solid ${mc.color}30`, padding:'2px 6px', borderRadius:3 }}>
                    {e.method}
                  </span>
                </div>
                <div style={{ ...mono, fontSize:11, color:'var(--text-primary)', marginBottom:4 }}>{e.path}</div>
                <div style={{ fontSize:11, color:'var(--text-secondary)' }}>{e.desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Webhooks ── */}
      <div className="panel" style={{ padding:22 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
          <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} />
            Webhooks
          </div>
          <button style={{ ...mono, padding:'6px 14px', borderRadius:7, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontSize:10, cursor:'pointer' }}>
            + Add Webhook
          </button>
        </div>
        {webhooks.length === 0 ? (
          <div style={{ textAlign:'center', padding:'24px 0' }}>
            <div style={{ ...mono, fontSize:11, color:'var(--text-muted)' }}>No webhooks configured</div>
          </div>
        ) : (
          webhooks.map((w, i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9, marginBottom:8 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ ...mono, fontSize:11, color:'var(--text-primary)', marginBottom:6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{w.url}</div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  {(w.events || []).map(ev => (
                    <span key={ev} style={{ ...mono, padding:'2px 7px', borderRadius:4, fontSize:9, background:'rgba(0,245,212,0.08)', color:'var(--cyan)', border:'1px solid rgba(0,245,212,0.15)' }}>{ev}</span>
                  ))}
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
                <span style={{ ...mono, fontSize:10, color:'var(--text-muted)' }}>{w.calls} sent</span>
                <span style={{ ...mono, padding:'3px 9px', borderRadius:5, fontSize:9, fontWeight:700, background: w.status==='active'?'rgba(52,211,153,0.1)':'rgba(100,116,139,0.1)', color: w.status==='active'?'var(--green)':'var(--text-muted)' }}>
                  ● {w.status}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}