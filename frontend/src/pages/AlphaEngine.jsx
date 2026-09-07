import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import SignalModal from '../components/SignalModal';
import { useTranslation } from 'react-i18next';

// ── Design tokens ─────────────────────────────────────────
const mono  = { fontFamily:"'JetBrains Mono','Fira Code',monospace" };
const T     = {
  cyan:'#00f5d4', purple:'#a78bfa', amber:'#f59e0b',
  red:'#f43f5e',  green:'#34d399',  slate:'#64748b',
};

const PIPELINE = ['Ingest','Features','XGBoost','LSTM','Transformer','Ensemble','Filter','Signal'];

const ASSET_TABS = [
  { key:'all',       label:'All'         },
  { key:'Crypto',    label:'🪙 Crypto'   },
  { key:'Forex',     label:'💱 Forex'    },
  { key:'Commodity', label:'🥇 Commo'   },
  { key:'Indices',   label:'📈 Indices'  },
];

// ── Style injection ───────────────────────────────────────
function injectStyles() {
  if (document.getElementById('aq-alpha-v2')) return;
  const s = document.createElement('style');
  s.id = 'aq-alpha-v2';
  s.textContent = `
    @keyframes aq-fadein  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    @keyframes aq-pulse   { 0%,100%{opacity:.35} 50%{opacity:.75} }
    @keyframes aq-flow    { 0%{background-position:0% 50%} 100%{background-position:200% 50%} }
    .aq-pipe-node { transition: box-shadow .2s, border-color .2s; }
    .aq-pipe-node:hover { box-shadow: 0 0 14px rgba(0,245,212,0.3) !important; }
    .aq-score-card:hover { border-color: rgba(0,245,212,0.25) !important; background: rgba(255,255,255,0.025) !important; }
    .aq-feed-row:hover { background: rgba(255,255,255,0.025) !important; }
    .aq-model-btn:hover { opacity:.85; }
  `;
  document.head.appendChild(s);
}

// ── Shared micro components ───────────────────────────────
const panel = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:22 };

function Label({ children, style={} }) {
  return <div style={{ ...mono, fontSize:9, letterSpacing:'.18em', textTransform:'uppercase', color:T.slate, ...style }}>{children}</div>;
}
function Sk({ w='100%', h=14, style={} }) {
  return <div style={{ width:w, height:h, borderRadius:4, background:'rgba(255,255,255,0.06)', animation:'aq-pulse 1.6s ease-in-out infinite', ...style }}/>;
}
function Dot({ color, pulse=false }) {
  return <div style={{ width:7, height:7, borderRadius:'50%', background:color, flexShrink:0, ...(pulse ? { animation:'aq-pulse 1.6s infinite' } : {}) }}/>;
}

// ── KPI Card ──────────────────────────────────────────────
function KpiCard({ label, value, sub, color, loading }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'16px 18px' }}>
      <Label style={{ marginBottom:8 }}>{label}</Label>
      {loading
        ? <Sk h={32} style={{ marginBottom:6 }}/>
        : <div style={{ fontSize:26, fontWeight:700, color, ...mono }}>{value}</div>
      }
      <div style={{ ...mono, fontSize:10, color:T.slate, marginTop:4 }}>{sub}</div>
    </div>
  );
}

// ── Signal Pipeline ───────────────────────────────────────
function Pipeline({ running, lastSignalAt }) {
  const minsAgo = lastSignalAt
    ? Math.floor((Date.now() - new Date(lastSignalAt).getTime()) / 60000)
    : Infinity;
  const isActive = running && minsAgo < 5;

  return (
    <div style={{ ...panel }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
        <Label>Signal Generation Pipeline</Label>
        <span style={{ ...mono, fontSize:9, color: isActive ? T.cyan : T.slate }}>
          {isActive ? `last signal ${minsAgo}m ago` : running ? 'idle — waiting for next scan' : 'paused'}
        </span>
      </div>
      <div style={{ display:'flex', alignItems:'center', overflowX:'auto', gap:0, padding:'4px 0' }}>
        {PIPELINE.map((step, i) => (
          <div key={step} style={{ display:'flex', alignItems:'center', flexShrink:0 }}>
            <div className="aq-pipe-node" style={{
              width:108, padding:'11px 12px', textAlign:'center', borderRadius:10,
              border:`1px solid ${isActive ? 'rgba(0,245,212,0.35)' : 'rgba(100,116,139,0.3)'}`,
              background: isActive ? 'rgba(0,245,212,0.06)' : 'rgba(255,255,255,0.02)',
            }}>
              <div style={{ ...mono, fontSize:11, fontWeight:700, color: isActive ? 'var(--text)' : T.slate }}>{step}</div>
              <div style={{ ...mono, fontSize:9, color: isActive ? T.cyan : T.slate, marginTop:4 }}>
                {isActive ? 'active' : running ? 'idle' : 'paused'}
              </div>
            </div>
            {i < PIPELINE.length - 1 && (
              <div style={{
                width:24, height:2, flexShrink:0,
                background: isActive
                  ? 'linear-gradient(90deg, rgba(0,245,212,0.2), rgba(0,245,212,0.7))'
                  : 'rgba(100,116,139,0.2)',
              }}/>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Asset Class Breakdown ────────────────────────────────
function AssetBreakdown({ assetClasses, loading }) {
  if (loading) return <div style={{ display:'flex', gap:8 }}>{[1,2,3,4].map(i => <Sk key={i} h={60} style={{ flex:1 }}/>)}</div>;
  if (!assetClasses?.length) return null;
  return (
    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
      {assetClasses.map(ac => {
        const total = parseInt(ac.total, 10);
        const buys  = parseInt(ac.buys,  10);
        const sells = parseInt(ac.sells, 10);
        const buyPct = total ? Math.round((buys / total) * 100) : 0;
        return (
          <div key={ac.asset_class} style={{ flex:1, minWidth:110, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:'10px 14px' }}>
            <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:6 }}>{ac.asset_class?.toUpperCase()}</div>
            <div style={{ ...mono, fontSize:16, fontWeight:800, color:'var(--text)', marginBottom:4 }}>{total}</div>
            <div style={{ display:'flex', gap:6, ...mono, fontSize:9 }}>
              <span style={{ color:T.green }}>↑{buys}</span>
              <span style={{ color:T.red }}>↓{sells}</span>
              <span style={{ color:T.slate, marginLeft:'auto' }}>{ac.avg_conf}% avg</span>
            </div>
            <div style={{ marginTop:6, height:3, borderRadius:2, background:'rgba(255,255,255,0.06)' }}>
              <div style={{ height:'100%', width:`${buyPct}%`, borderRadius:2, background:T.green }}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model Config ──────────────────────────────────────────
function ModelConfig({ models, selectedMdl, setSelectedMdl, confThresh, setConfThresh, onConfApply, loading }) {
  const [localConf, setLocalConf] = useState(confThresh);

  useEffect(() => { setLocalConf(confThresh); }, [confThresh]);

  return (
    <div style={panel}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16 }}>
        <Dot color={T.purple}/>
        <Label>Model Configuration</Label>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {loading
          ? [1,2,3,4].map(i => <Sk key={i} h={62}/>)
          : models.map((m, i) => (
            <button type="button" key={m.label} className="aq-model-btn" onClick={() => setSelectedMdl(i)} style={{
              width:'100%', textAlign:'left',
              background: selectedMdl===i ? 'rgba(0,245,212,0.06)' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${selectedMdl===i ? 'rgba(0,245,212,0.4)' : 'var(--border)'}`,
              borderRadius:10, padding:'13px 16px',
              display:'flex', alignItems:'center', gap:12, cursor:'pointer', color:'var(--text)',
              transition:'all .15s',
            }}>
              <div style={{ width:14, height:14, borderRadius:'50%', flexShrink:0,
                border:`2px solid ${selectedMdl===i ? T.cyan : T.slate}`,
                background: selectedMdl===i ? T.cyan : 'transparent' }}/>
              <div style={{ flex:1 }}>
                <div style={{ ...mono, fontSize:12, fontWeight:700 }}>{m.label}</div>
                <div style={{ ...mono, fontSize:10, color:T.slate, marginTop:2 }}>{m.sub}</div>
              </div>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:3 }}>
                {selectedMdl === i && (
                  <span style={{ ...mono, fontSize:9, padding:'2px 7px', borderRadius:4, background:'rgba(52,211,153,0.12)', color:T.green }}>
                    ACTIVE
                  </span>
                )}
                <span style={{ ...mono, fontSize:9, color:T.slate }}>{m.signals} signals</span>
              </div>
            </button>
          ))
        }
      </div>

      {/* Confidence threshold — connected to API */}
      <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <Label>Confidence Threshold</Label>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ ...mono, fontSize:14, fontWeight:700, color:T.cyan }}>{localConf}%</span>
            {localConf !== confThresh && (
              <button onClick={() => { setConfThresh(localConf); onConfApply(localConf); }} style={{
                ...mono, fontSize:9, padding:'3px 10px', borderRadius:5, cursor:'pointer',
                border:'1px solid rgba(0,245,212,0.35)', background:'rgba(0,245,212,0.1)', color:T.cyan,
              }}>Apply</button>
            )}
          </div>
        </div>
        <input type="range" min={50} max={95} value={localConf}
          onChange={e => setLocalConf(Number(e.target.value))}
          style={{ width:'100%', accentColor:T.cyan, cursor:'pointer' }} />
        <div style={{ display:'flex', justifyContent:'space-between', ...mono, fontSize:8, color:T.slate, marginTop:4 }}>
          <span>50% permissive</span><span>95% strict</span>
        </div>
      </div>
    </div>
  );
}

// ── Factor Weights ────────────────────────────────────────
function FactorWeights({ factors, loading }) {
  return (
    <div style={panel}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16 }}>
        <Dot color={T.amber}/>
        <Label>Factor Weights</Label>
        <span style={{ ...mono, fontSize:9, color:T.slate, marginLeft:'auto' }}>computed from signals</span>
      </div>
      {loading
        ? [1,2,3,4,5,6].map(i => <Sk key={i} h={40} style={{ marginBottom:12 }}/>)
        : factors.map(f => {
          const color = f.value >= 70 ? T.green : f.value >= 50 ? T.cyan : T.amber;
          return (
            <div key={f.label} style={{ paddingBottom:14, marginBottom:14, borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:7 }}>
                <span style={{ ...mono, fontSize:11, color:'var(--text)' }}>{f.label}</span>
                <span style={{ ...mono, fontSize:12, fontWeight:800, color }}>{f.value}%</span>
              </div>
              <div style={{ height:5, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                <div style={{
                  height:'100%', width:`${f.value}%`, borderRadius:3,
                  background: f.value >= 70
                    ? `linear-gradient(90deg, rgba(52,211,153,0.5), ${T.green})`
                    : f.value >= 50
                    ? `linear-gradient(90deg, rgba(0,245,212,0.5), ${T.cyan})`
                    : `linear-gradient(90deg, rgba(245,158,11,0.5), ${T.amber})`,
                  transition:'width .4s ease',
                }}/>
              </div>
              <div style={{ ...mono, fontSize:8, color:T.slate, marginTop:4 }}>
                {f.value >= 70 ? 'Strong signal alignment' : f.value >= 50 ? 'Moderate alignment' : 'Weak — low sample size'}
              </div>
            </div>
          );
        })
      }
    </div>
  );
}

// ── Alpha Scores ──────────────────────────────────────────
function AlphaScores({ scores, loading, onSelect }) {
  const sideColor = s => s === 'BUY' ? T.green : s === 'SELL' ? T.red : T.amber;

  return (
    <div style={panel}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16 }}>
        <Dot color={T.green}/>
        <Label>Top Alpha Scores</Label>
        <span style={{ ...mono, fontSize:9, color:T.slate, marginLeft:'auto' }}>filtered by threshold</span>
      </div>
      {loading ? (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          {[1,2,3,4].map(i => <Sk key={i} h={110}/>)}
        </div>
      ) : scores.length === 0 ? (
        <div style={{ textAlign:'center', padding:'32px 0', ...mono, fontSize:11, color:T.slate }}>
          No signals above confidence threshold
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          {scores.map((s, i) => {
            const color = sideColor(s.side);
            return (
              <div key={i} className="aq-score-card" onClick={() => onSelect && onSelect(s)} style={{
                background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)',
                borderRadius:12, padding:16, transition:'all .15s', cursor:'pointer',
              }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                  <div>
                    <div style={{ ...mono, fontSize:13, fontWeight:800 }}>{s.sym}</div>
                    <div style={{ ...mono, fontSize:9, color:T.slate, marginTop:2 }}>{s.assetClass}</div>
                  </div>
                  <span style={{ ...mono, fontSize:9, fontWeight:800, padding:'3px 8px', borderRadius:5,
                    background:`${color}18`, color, border:`1px solid ${color}30` }}>
                    {s.side}
                  </span>
                </div>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8 }}>
                  <div style={{ fontSize:28, fontWeight:800, color, ...mono }}>{s.score}</div>
                  <div style={{ ...mono, fontSize:10, color:T.slate }}>conf</div>
                </div>
                <div style={{ height:3, background:'rgba(255,255,255,0.06)', borderRadius:2, marginBottom:8 }}>
                  <div style={{ height:'100%', width:`${s.score}%`, borderRadius:2, background:color }}/>
                </div>
                <div style={{ ...mono, fontSize:9, color:T.slate, lineHeight:1.5 }}>{s.note}</div>
                {s.price > 0 && (
                  <div style={{ ...mono, fontSize:10, color:'var(--text)', marginTop:6, fontWeight:700 }}>
                    ${s.price.toLocaleString('en-US', { maximumFractionDigits:4 })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Accuracy Chart ────────────────────────────────────────
function AccuracyChart({ accuracy, confThresh, loading }) {
  if (loading) return <Sk h={200}/>;
  const max = Math.max(...accuracy, 1);
  return (
    <div style={panel}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Dot color={T.cyan}/>
          <Label>High-Confidence Rate</Label>
        </div>
        <span style={{ ...mono, fontSize:9, color:T.slate }}>signals ≥ {confThresh}% · last 90</span>
      </div>
      <div style={{ height:180, display:'flex', alignItems:'flex-end', gap:3, borderBottom:'1px solid rgba(255,255,255,0.05)', paddingTop:10 }}>
        {accuracy.map((v, i) => {
          const color = v >= 70 ? T.green : v >= 50 ? T.cyan : T.amber;
          return (
            <div key={i} title={`${v}%`} style={{
              flex:1, height:`${(v / max) * 100}%`, borderRadius:'3px 3px 0 0',
              background:`linear-gradient(180deg, ${color}bb, ${color}22)`,
              border:`1px solid ${color}20`, cursor:'default',
              transition:'height .3s ease',
            }}/>
          );
        })}
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', ...mono, fontSize:8, color:T.slate, marginTop:6 }}>
        <span>90 signals ago</span><span>latest</span>
      </div>
    </div>
  );
}

// ── Live Signal Feed ──────────────────────────────────────
function SignalFeed({ feed, loading, onSelect }) {
  const sideColor = s => s === 'BUY' ? T.green : s === 'SELL' ? T.red : T.amber;
  const assetIcon = a => ({ Crypto:'🪙', Forex:'💱', Commodity:'🥇', Indices:'📈' }[a] || '◈');

  return (
    <div style={panel}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Dot color={T.cyan} pulse/>
          <Label>Live Signal Feed</Label>
        </div>
        <span style={{ ...mono, fontSize:9, color:T.slate }}>real-time · all asset classes</span>
      </div>
      {loading
        ? [1,2,3,4,5].map(i => <Sk key={i} h={42} style={{ marginBottom:6 }}/>)
        : feed.length === 0
        ? <div style={{ textAlign:'center', padding:'24px 0', ...mono, fontSize:11, color:T.slate }}>No signals yet</div>
        : feed.map((item, i) => {
          const color = sideColor(item.type);
          return (
            <div key={i} className="aq-feed-row" onClick={() => onSelect && onSelect(item)} style={{
              display:'grid', gridTemplateColumns:'28px 90px 56px 1fr 56px 48px',
              alignItems:'center', gap:10, padding:'9px 12px',
              borderBottom:'1px solid rgba(255,255,255,0.03)',
              borderRadius:6, transition:'background .15s', cursor:'pointer',
            }}>
              <span style={{ fontSize:12 }}>{assetIcon(item.assetClass)}</span>
              <span style={{ ...mono, fontSize:11, fontWeight:800, color:'var(--text)' }}>{item.sym}</span>
              <span style={{ ...mono, fontSize:10, fontWeight:800, color,
                background:`${color}14`, padding:'2px 6px', borderRadius:4, textAlign:'center' }}>
                {item.type}
              </span>
              <span style={{ ...mono, fontSize:10, color:T.slate, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {item.msg}
              </span>
              <span style={{ ...mono, fontSize:10, fontWeight:700, color, textAlign:'right' }}>
                {item.conf}%
              </span>
              <span style={{ ...mono, fontSize:9, color:T.slate, textAlign:'right' }}>{item.time}</span>
            </div>
          );
        })
      }
    </div>
  );
}

// ── Main AlphaEngine Page ─────────────────────────────────
export default function AlphaEngine() {
  const { t } = useTranslation();

  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [running,     setRunning]     = useState(true);
  const [selectedMdl, setSelectedMdl] = useState(0);
  const [confThresh,  setConfThresh]  = useState(65);
  const [assetClass,  setAssetClass]  = useState('all');
  const [selectedSignal, setSelectedSignal] = useState(null);

  useEffect(() => { injectStyles(); }, []);

  const fetchData = useCallback(async (conf = confThresh, ac = assetClass) => {
    setLoading(true);
    try {
      const res = await api.get(`/signals/alpha/engine-data?confThresh=${conf}&assetClass=${ac}&limit=50`);
      if (res.data.success) setData(res.data);
    } catch (err) {
      console.error('AlphaEngine fetch error:', err);
    } finally { setLoading(false); }
  }, [confThresh, assetClass]);

  useEffect(() => { fetchData(confThresh, assetClass); }, [assetClass]);

  // Auto-refresh feed every 30s
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => fetchData(confThresh, assetClass), 30000);
    return () => clearInterval(iv);
  }, [running, confThresh, assetClass, fetchData]);

  const stats    = data?.stats    || {};
  const models   = data?.models   || [];
  const factors  = data?.factors  || [];
  const scores   = data?.scores   || [];
  const feed     = data?.feed     || [];
  const accuracy = data?.accuracy || Array(30).fill(0);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, animation:'aq-fadein .35s ease' }}>

      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ ...mono, fontSize:10, letterSpacing:'.2em', textTransform:'uppercase', color:T.slate, marginBottom:4 }}>
            // Alpha Engine · AI Signal Generator
          </div>
          <div style={{ ...mono, fontSize:11, color:'var(--text)' }}>
            Ensemble ML — XGBoost + LSTM + Transformer · Retrained every 4h
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'6px 14px', borderRadius:20,
            border:`1px solid ${running ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`,
            background: running ? 'rgba(52,211,153,0.08)' : 'rgba(245,158,11,0.08)',
            ...mono, fontSize:11, color: running ? T.green : T.amber }}>
            <Dot color={running ? T.green : T.amber} pulse={running}/>
            {running ? 'Engine Running' : 'Paused'} — v3.4.1
          </div>
          <button type="button" onClick={() => setRunning(v => !v)} style={{
            padding:'8px 18px', borderRadius:9, border:'1px solid var(--border)',
            background:'transparent', color:T.slate, ...mono, fontSize:11, cursor:'pointer',
          }}>
            {running ? 'Pause' : 'Resume'}
          </button>
          <button type="button" onClick={() => fetchData(confThresh, assetClass)} style={{
            padding:'8px 20px', borderRadius:9, border:'1px solid rgba(0,245,212,0.3)',
            background:'rgba(0,245,212,0.08)', color:T.cyan, ...mono, fontSize:12, fontWeight:700, cursor:'pointer',
          }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Asset class tabs ── */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        {ASSET_TABS.map(tab => (
          <button key={tab.key} onClick={() => setAssetClass(tab.key)} style={{
            ...mono, fontSize:10, padding:'6px 14px', borderRadius:8, cursor:'pointer',
            border:`1px solid ${assetClass===tab.key ? 'rgba(0,245,212,0.4)' : 'var(--border)'}`,
            background: assetClass===tab.key ? 'rgba(0,245,212,0.1)' : 'transparent',
            color: assetClass===tab.key ? T.cyan : T.slate, transition:'all .15s',
          }}>
            {tab.label}
          </button>
        ))}
        {!loading && data?.meta && (
          <span style={{ ...mono, fontSize:9, color:T.slate, marginLeft:'auto', display:'flex', alignItems:'center' }}>
            {data.meta.totalSignalsUsed} signals analysed · conf ≥ {confThresh}%
          </span>
        )}
      </div>

      {/* ── KPIs ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12 }}>
        <KpiCard label="Signals Today"   loading={loading}
          value={stats.signalsFiredToday ?? '—'}
          sub={`${stats.highConfToday ?? 0} high-conf`}
          color={T.cyan} />
        <KpiCard label="Avg Confidence"  loading={loading}
          value={stats.avgConfToday ? `${stats.avgConfToday}%` : '—'}
          sub="last 24h"
          color={T.green} />
        <KpiCard label="High-Conf Rate"  loading={loading}
          value={stats.winRateProxy != null ? `${stats.winRateProxy}%` : '—'}
          sub="conf ≥ 75% / 30d"
          color={stats.winRateProxy >= 60 ? T.green : T.amber} />
        <KpiCard label="Symbols Scanned" loading={loading}
          value={stats.symbolsScanned ?? '—'}
          sub="last 30 days"
          color={T.purple} />
        <KpiCard label="Next Scan"       loading={loading}
          value={stats.nextRetrain ?? '—'}
          sub="every 4h"
          color={T.amber} />
      </div>

      {/* ── Pipeline ── */}
      <Pipeline running={running} lastSignalAt={stats.lastSignalAt} />

      {/* ── Asset class breakdown ── */}
      {stats.assetClasses?.length > 0 && (
        <AssetBreakdown assetClasses={stats.assetClasses} loading={loading} />
      )}

      {/* ── Model Config + Factor Weights ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.4fr', gap:16 }}>
        <ModelConfig
          models={models} selectedMdl={selectedMdl} setSelectedMdl={setSelectedMdl}
          confThresh={confThresh} setConfThresh={setConfThresh}
          onConfApply={(v) => fetchData(v, assetClass)}
          loading={loading}
        />
        <FactorWeights factors={factors} loading={loading} />
      </div>

      {/* ── Alpha Scores + Accuracy Chart ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1.2fr 1fr', gap:16 }}>
        <AlphaScores scores={scores} loading={loading} onSelect={setSelectedSignal} />
        <AccuracyChart accuracy={accuracy} confThresh={confThresh} loading={loading} />
      </div>

      {/* ── Live Signal Feed ── */}
      <SignalFeed feed={feed} loading={loading} onSelect={setSelectedSignal} />

      {selectedSignal && <SignalModal signal={selectedSignal} onClose={() => setSelectedSignal(null)} />}
    </div>
  );
}