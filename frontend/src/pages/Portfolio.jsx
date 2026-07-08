import { useState, useEffect, useRef } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import api from '../services/api';
import { useLivePrices } from '../hooks/useLivePrices';
import PortfolioAnalyzer from './PortfolioAnalyzer';

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  cyan:    '#00f5d4',
  purple:  '#a78bfa',
  amber:   '#f59e0b',
  red:     '#f43f5e',
  green:   '#34d399',
  sky:     '#38bdf8',
  orange:  '#fb923c',
  pink:    '#e879f9',
  slate:   '#64748b',
  surface: 'var(--surface)',
  border:  'var(--border)',
};
const PALETTE  = [T.cyan, T.purple, T.amber, T.red, T.sky, T.green, T.orange, T.pink];
const mono     = { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" };
const ttStyle  = {
  contentStyle: { background:'rgba(3,7,18,0.98)', border:'1px solid rgba(0,245,212,0.2)', borderRadius:8, ...mono, fontSize:11, boxShadow:'0 8px 32px rgba(0,0,0,0.6)' },
  labelStyle:   { color: T.slate },
  itemStyle:    { color: T.cyan },
  cursor:       { stroke: 'rgba(0,245,212,0.2)', strokeWidth:1 },
};

const SECTORS = ['Crypto','Stocks','DeFi','NFT','Commodities','Forex','ETF','Other'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPrice(sym, price) {
  if (typeof price === 'string') return price;
  if ((sym === 'BTC' || sym === 'ETH') && price >= 1000)
    return `$${price.toLocaleString('en-US', { maximumFractionDigits:2 })}`;
  return `$${price.toFixed(2)}`;
}
function colorPnl(str) {
  if (!str || str === 'N/A') return T.slate;
  return str.startsWith('-') ? T.red : T.green;
}
function sign(n) { return n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`; }
function isNeg(str) { return typeof str === 'string' && str.startsWith('-'); }

function injectStyles() {
  if (document.getElementById('aq-pf-v3')) return;
  const s = document.createElement('style');
  s.id = 'aq-pf-v3';
  s.textContent = `
    @keyframes aq-pulse   { 0%,100%{opacity:.35} 50%{opacity:.7} }
    @keyframes aq-fadein  { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
    @keyframes aq-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes aq-spin    { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
    .aq-row:hover td { background: rgba(0,245,212,0.025) !important; }
    .aq-row td { transition: background .15s; }
    .aq-tab  { transition: color .18s; cursor:pointer; }
    .aq-tab:hover { color: var(--text) !important; }
    .aq-filter:hover { border-color: rgba(0,245,212,0.5) !important; color: rgba(0,245,212,0.8) !important; }
    .aq-card { transition: border-color .2s, transform .2s, box-shadow .2s; }
    .aq-card:hover { border-color: rgba(0,245,212,0.18) !important; }
    .aq-retry:hover { background: rgba(0,245,212,0.15) !important; }
    .aq-holding { transition: all .2s; }
    .aq-holding:hover { border-color: rgba(255,255,255,0.12) !important; transform:translateY(-2px); }
    .aq-close-btn { opacity:0; transition: opacity .15s; }
    .aq-row:hover .aq-close-btn { opacity:1; }
    .aq-input:focus { border-color: rgba(0,245,212,0.4) !important; outline:none; }
    .aq-input { transition: border-color .15s; }
  `;
  document.head.appendChild(s);
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Sk({ w='100%', h=16, r=6 }) {
  return <div style={{ width:w, height:h, borderRadius:r, background:'rgba(255,255,255,0.05)', animation:'aq-pulse 1.8s ease-in-out infinite' }} />;
}

function Counter({ value, prefix='$', decimals=2, style={} }) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current, to = value;
    if (from === to) return;
    const dur = 700, start = performance.now();
    const frame = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * ease);
      if (t < 1) requestAnimationFrame(frame);
      else prev.current = to;
    };
    requestAnimationFrame(frame);
  }, [value]);
  const fmt = typeof display === 'number'
    ? `${prefix}${display.toLocaleString('en-US', { minimumFractionDigits:decimals, maximumFractionDigits:decimals })}`
    : display;
  return <span style={style}>{fmt}</span>;
}

function Bar({ pct, color, h=3 }) {
  return (
    <div style={{ flex:1, height:h, background:'rgba(255,255,255,0.06)', borderRadius:h, overflow:'hidden' }}>
      <div style={{ width:`${Math.min(pct,100)}%`, height:'100%', background:color, borderRadius:h, transition:'width .6s cubic-bezier(.4,0,.2,1)', boxShadow:`0 0 6px ${color}60` }} />
    </div>
  );
}

function PieLabel({ cx, cy, midAngle, outerRadius, name, pct }) {
  if (pct < 6) return null;
  const rad = Math.PI / 180;
  const x = cx + (outerRadius + 20) * Math.cos(-midAngle * rad);
  const y = cy + (outerRadius + 20) * Math.sin(-midAngle * rad);
  return (
    <text x={x} y={y} textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central"
      style={{ ...mono, fontSize:9, fill:'rgba(255,255,255,0.4)' }}>
      {name} {pct.toFixed(0)}%
    </text>
  );
}

function LiveDot() {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
      <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%', background:T.green, boxShadow:`0 0 6px ${T.green}`, animation:'aq-blink 2s ease-in-out infinite' }}/>
      <span style={{ ...mono, fontSize:9, color:T.green, letterSpacing:'.1em' }}>LIVE</span>
    </span>
  );
}

function Label({ children, style={} }) {
  return <div style={{ ...mono, fontSize:9, letterSpacing:'.2em', textTransform:'uppercase', color:T.slate, ...style }}>{children}</div>;
}

function Divider({ style={} }) {
  return <div style={{ height:1, background:'rgba(255,255,255,0.05)', ...style }} />;
}

// ── Add Position Modal ────────────────────────────────────────────────────────
// ✅ Feature: accepte maintenant un `prefill` optionnel — { symbol, side, mode,
// existingAmount, avgEntry } — utilisé quand la modale est ouverte depuis une
// recommandation IA (BUY/TRIM/HEDGE) au lieu du bouton "+ Add Position" standard.
// En mode 'trim', un bandeau rappelle la position actuelle pour guider la
// nouvelle quantité à saisir (le endpoint fait un upsert, donc entrer un
// montant plus bas réduit effectivement la position).
function AddPositionModal({ onClose, onAdded, prefill }) {
  const [form, setForm] = useState({
    symbol:       prefill?.symbol || '',
    side:         prefill?.side   || 'long',
    amount:       '',
    averageEntry: '',
    sector:       'Crypto',
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSubmit = async () => {
    if (!form.symbol || !form.amount || !form.averageEntry) {
      setError('Symbol, amount and average entry are required'); return;
    }
    setLoading(true); setError('');
    try {
      await api.post('/portfolio/position', {
        symbol:       form.symbol.toUpperCase().trim(),
        side:         form.side,
        amount:       parseFloat(form.amount),
        averageEntry: parseFloat(form.averageEntry),
        sector:       form.sector,
      });
      onAdded();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to add position');
    } finally { setLoading(false); }
  };

  const inputStyle = {
    width:'100%', boxSizing:'border-box',
    background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)',
    borderRadius:9, padding:'10px 14px',
    color:'var(--text)', ...mono, fontSize:12,
  };
  const labelStyle = { ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:T.slate, marginBottom:7, display:'block' };

  const isTrim  = prefill?.mode === 'trim';
  const modalTitle = isTrim ? `Adjust ${prefill.symbol} Position` : prefill?.symbol ? `Open ${prefill.symbol} Position` : 'Add Position';

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(14px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'#080f1e', border:'1px solid rgba(0,245,212,0.2)', borderRadius:20, padding:32, width:460, boxShadow:'0 0 60px rgba(0,245,212,0.08), 0 32px 64px rgba(0,0,0,0.7)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:isTrim ? 12 : 24 }}>
          <div style={{ width:8, height:8, borderRadius:'50%', background:T.cyan }} />
          <span style={{ fontSize:15, fontWeight:700, color:'var(--text)' }}>{modalTitle}</span>
        </div>

        {/* Trim context banner */}
        {isTrim && (
          <div style={{ background:'rgba(245,158,11,0.06)', border:'1px solid rgba(245,158,11,0.2)', borderRadius:9, padding:'10px 14px', marginBottom:20 }}>
            <div style={{ ...mono, fontSize:10, color:T.amber, lineHeight:1.6 }}>
              Current: {prefill.existingAmount} {prefill.symbol} @ {prefill.avgEntry}. Enter a new (lower) amount below to trim the position, or use <strong>Close</strong> on the position row to exit fully.
            </div>
          </div>
        )}

        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

          {/* Symbol + Side row */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={labelStyle}>Symbol</label>
              <input className="aq-input" value={form.symbol} onChange={e => set('symbol', e.target.value.toUpperCase())}
                placeholder="BTC, ETH, AAPL..." style={inputStyle} autoFocus={!prefill?.symbol}
                readOnly={!!prefill?.symbol} />
            </div>
            <div>
              <label style={labelStyle}>Side</label>
              <div style={{ display:'flex', gap:6 }}>
                {['long','short'].map(s => (
                  <button key={s} onClick={() => set('side', s)} style={{
                    flex:1, padding:'10px 0', borderRadius:9, cursor:'pointer',
                    ...mono, fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em',
                    border:`1px solid ${form.side === s ? (s==='long'?'rgba(52,211,153,0.4)':'rgba(244,63,94,0.4)') : 'var(--border)'}`,
                    background: form.side === s ? (s==='long'?'rgba(52,211,153,0.1)':'rgba(244,63,94,0.1)') : 'transparent',
                    color: form.side === s ? (s==='long'?T.green:T.red) : T.slate,
                    transition:'all .15s',
                  }}>
                    {s === 'long' ? '↑ Long' : '↓ Short'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Amount + Avg Entry row */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={labelStyle}>{isTrim ? 'New Amount' : 'Amount'}</label>
              <input className="aq-input" type="number" value={form.amount} onChange={e => set('amount', e.target.value)}
                placeholder={isTrim ? `< ${prefill.existingAmount}` : '0.5'} style={inputStyle} autoFocus={!!prefill?.symbol} />
            </div>
            <div>
              <label style={labelStyle}>Avg Entry ($)</label>
              <input className="aq-input" type="number" value={form.averageEntry} onChange={e => set('averageEntry', e.target.value)}
                placeholder="45000" style={inputStyle} />
            </div>
          </div>

          {/* Sector */}
          <div>
            <label style={labelStyle}>Sector</label>
            <select value={form.sector} onChange={e => set('sector', e.target.value)}
              style={{ ...inputStyle, cursor:'pointer', appearance:'none' }}>
              {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Preview */}
          {form.symbol && form.amount && form.averageEntry && (
            <div style={{ background:'rgba(0,245,212,0.04)', border:'1px solid rgba(0,245,212,0.1)', borderRadius:9, padding:'12px 14px' }}>
              <div style={{ ...mono, fontSize:10, color:T.slate, marginBottom:6 }}>Preview</div>
              <div style={{ ...mono, fontSize:12, color:'var(--text)' }}>
                {form.side === 'long' ? '↑' : '↓'} {form.amount} {form.symbol} @ ${parseFloat(form.averageEntry||0).toLocaleString()}
                {' '}= <span style={{ color:T.cyan }}>${(parseFloat(form.amount||0) * parseFloat(form.averageEntry||0)).toLocaleString('en-US', { maximumFractionDigits:2 })}</span>
              </div>
            </div>
          )}

          {error && (
            <div style={{ ...mono, fontSize:10, color:T.red, background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:8, padding:'9px 13px' }}>
              ✕ {error}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display:'flex', gap:10, marginTop:24 }}>
          <button onClick={handleSubmit} disabled={loading} style={{
            flex:1, padding:12, borderRadius:9,
            border:'1px solid rgba(0,245,212,0.35)', background:'rgba(0,245,212,0.08)',
            color:T.cyan, fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700,
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
          }}>
            {loading ? '⟳ Saving...' : isTrim ? '↓ Adjust Position' : '+ Add Position'}
          </button>
          <button onClick={onClose} style={{
            padding:'12px 20px', borderRadius:9, border:'1px solid var(--border)',
            background:'transparent', color:T.slate, fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer',
          }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Close Position Modal ──────────────────────────────────────────────────────
function ClosePositionModal({ position, onClose, onClosed }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handle = async () => {
    setLoading(true); setError('');
    try {
      await api.delete(`/portfolio/position/${position.sym}/${position.side}`);
      onClosed();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to close position');
      setLoading(false);
    }
  };

  const pnlColor = position.pnl && !position.pnl.startsWith('-') ? T.green : T.red;

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(14px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'#080f1e', border:'1px solid rgba(244,63,94,0.25)', borderRadius:20, padding:32, width:400, boxShadow:'0 32px 64px rgba(0,0,0,0.7)' }}>

        <div style={{ textAlign:'center', marginBottom:24 }}>
          <div style={{ fontSize:28, marginBottom:12 }}>◎</div>
          <div style={{ fontSize:15, fontWeight:700, color:'var(--text)', marginBottom:6 }}>
            Close {position.sym} {position.side === 'long' ? 'Long' : 'Short'}?
          </div>
          <div style={{ ...mono, fontSize:11, color:T.slate, lineHeight:1.6 }}>
            This will remove the position from your portfolio.
          </div>
        </div>

        {/* Position summary */}
        <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 16px', marginBottom:20 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {[
              { label:'Amount',    value: position.amount },
              { label:'Avg Entry', value: position.avgEntry },
              { label:'Current',   value: position.price },
              { label:'P&L',       value: position.pnl, color: pnlColor },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:3, textTransform:'uppercase', letterSpacing:'.12em' }}>{label}</div>
                <div style={{ ...mono, fontSize:13, fontWeight:600, color: color || 'var(--text)' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div style={{ ...mono, fontSize:10, color:T.red, background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:8, padding:'9px 13px', marginBottom:16 }}>
            ✕ {error}
          </div>
        )}

        <div style={{ display:'flex', gap:10 }}>
          <button onClick={handle} disabled={loading} style={{
            flex:1, padding:12, borderRadius:9,
            border:'1px solid rgba(244,63,94,0.35)', background:'rgba(244,63,94,0.08)',
            color:T.red, fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer',
          }}>
            {loading ? 'Closing...' : 'Close Position'}
          </button>
          <button onClick={onClose} style={{
            padding:'12px 20px', borderRadius:9, border:'1px solid var(--border)',
            background:'transparent', color:T.slate, fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer',
          }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Portfolio() {
  const [sideFilter,  setSideFilter]  = useState('all');
  const [activeTab,   setActiveTab]   = useState('positions');
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [hero,             setHero]            = useState({ totalValue:0, todayPnL:'+$0.00', dayReturn:'+0.00%', totalPnL:'+$0.00', totalReturn:'+0.00%', openPositions:0, availableCash:'+$0.00' });
  const [allocations,      setAllocations]     = useState([]);
  const [holdingsData,     setHoldingsData]    = useState([]);
  const [allPositionsData, setAllPositionsData]= useState([]);
  const [risks,            setRisks]           = useState([]);
  const [sectorData,       setSectorData]      = useState([]);
  const [equityCurve,      setEquityCurve]     = useState([]);

  // Modals
  const [showAddModal,    setShowAddModal]    = useState(false);
  const [addPrefill,      setAddPrefill]      = useState(null); // ✅ pre-fill for recommendation-triggered Add/Trim
  const [closeTarget,     setCloseTarget]     = useState(null); // position to close

  useEffect(() => { injectStyles(); }, []);

  const fetchPortfolioData = async (silent = false) => {
    if (!silent) {} // keep loading state on first load only
    try {
      const res = await api.get('/portfolio/data');
      if (res.data.success) {
        const d = res.data;
        setHero(d.hero);
        setAllocations(d.allocations     || []);
        setHoldingsData(d.holdings       || []);
        setAllPositionsData(d.allPositions || []);
        setRisks(d.risks                 || []);
        setSectorData(d.sectors          || []);
        setEquityCurve(d.equityCurve     || []);
        setLastUpdated(new Date());
        setError(null);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Connection error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolioData();
    const iv = setInterval(() => fetchPortfolioData(true), 60000);
    return () => clearInterval(iv);
  }, []);

  const liveP = useLivePrices();
  const applyLive = (h) => {
    const live = liveP[h.sym];
    if (!live) return h;
    return { ...h, price: fmtPrice(h.sym, live.price), ch: sign(live.change), up: live.up };
  };

  const holdings = holdingsData.map(applyLive);
  const filtered = (sideFilter === 'all' ? allPositionsData : allPositionsData.filter(p => p.side === sideFilter)).map(applyLive);
  const pnlUp    = !isNeg(hero.totalPnL);
  const dayUp    = !isNeg(hero.dayReturn);

  // ✅ Feature: route chaque recommandation IA vers la modale d'action adaptée.
  // - SELL sur une position existante → ClosePositionModal (sortie complète)
  // - TRIM sur une position existante → AddPositionModal en mode 'trim'
  //   (upsert : entrer un montant plus bas réduit la position)
  // - BUY / HEDGE → AddPositionModal pré-rempli avec le symbole suggéré
  //   (HEDGE pré-sélectionne le côté "short", cohérent avec l'idée de hedge)
  // - REBALANCE sur une position existante → traité comme TRIM (ajuster le poids)
  const handleApplyRecommendation = (rec) => {
    const existing = allPositionsData.find(p => p.sym === rec.symbol);

    if (rec.action === 'SELL' && existing) {
      setCloseTarget(existing);
      return;
    }

    if ((rec.action === 'TRIM' || rec.action === 'REBALANCE') && existing) {
      setAddPrefill({
        symbol: rec.symbol, side: existing.side, mode: 'trim',
        existingAmount: existing.amount, avgEntry: existing.avgEntry,
      });
      setShowAddModal(true);
      return;
    }

    if (rec.action === 'BUY' || rec.action === 'HEDGE' || (rec.action === 'REBALANCE' && !existing)) {
      setAddPrefill({ symbol: rec.symbol, side: rec.action === 'HEDGE' ? 'short' : 'long' });
      setShowAddModal(true);
      return;
    }
    // SELL without a matching position (shouldn't normally happen) — no-op.
  };

  const closeAddModal = () => { setShowAddModal(false); setAddPrefill(null); };

  // ── Error ──
  if (!loading && error) return (
    <div style={{ background:T.surface, border:'1px solid rgba(244,63,94,0.2)', borderRadius:16, padding:56, textAlign:'center', animation:'aq-fadein .4s ease' }}>
      <div style={{ fontSize:32, marginBottom:12, opacity:.6 }}>⚠</div>
      <div style={{ ...mono, fontSize:13, color:T.red, marginBottom:6 }}>{error}</div>
      <div style={{ ...mono, fontSize:11, color:T.slate, marginBottom:24 }}>Check backend connection or session</div>
      <button className="aq-retry" onClick={() => fetchPortfolioData()} style={{ padding:'8px 28px', background:'rgba(0,245,212,0.08)', color:T.cyan, border:`1px solid ${T.cyan}40`, borderRadius:8, ...mono, fontSize:12, cursor:'pointer', transition:'background .2s' }}>Retry</button>
    </div>
  );

  // ── Skeleton ──
  if (loading) return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:28 }}>
        <Sk h={10} w="30%" /><div style={{height:12}}/><Sk h={48} w="50%"/><div style={{height:16}}/>
        <div style={{ display:'flex', gap:28 }}>{[...Array(3)].map((_,i)=><div key={i} style={{flex:1}}><Sk h={8} w="60%"/><div style={{height:6}}/><Sk h={20}/></div>)}</div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.4fr', gap:14 }}>
        <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:22 }}><Sk h={200}/></div>
        <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:22 }}><Sk h={200}/></div>
      </div>
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:22 }}><Sk h={260}/></div>
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14, animation:'aq-fadein .35s ease' }}>

      {/* Modals */}
      {showAddModal && (
        <AddPositionModal
          onClose={closeAddModal}
          onAdded={() => fetchPortfolioData(true)}
          prefill={addPrefill}
        />
      )}
      {closeTarget && (
        <ClosePositionModal
          position={closeTarget}
          onClose={() => setCloseTarget(null)}
          onClosed={() => fetchPortfolioData(true)}
        />
      )}

      {/* ══ HERO ══ */}
      <div style={{
        position:'relative', overflow:'hidden',
        background:'linear-gradient(135deg, rgba(0,245,212,0.05) 0%, rgba(167,139,250,0.03) 50%, transparent 100%)',
        border:'1px solid rgba(0,245,212,0.15)', borderRadius:16, padding:'28px 30px',
      }}>
        <div style={{ position:'absolute', inset:0, pointerEvents:'none', backgroundImage:'linear-gradient(rgba(0,245,212,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,245,212,0.03) 1px, transparent 1px)', backgroundSize:'40px 40px' }}/>
        <div style={{ position:'relative', display:'grid', gridTemplateColumns:'1fr auto', gap:24, alignItems:'start' }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
              <Label>Total Portfolio Value</Label>
              <LiveDot />
            </div>
            <div style={{ display:'flex', alignItems:'baseline', gap:14, flexWrap:'wrap' }}>
              <Counter value={typeof hero.totalValue === 'number' ? hero.totalValue : 0} decimals={2}
                style={{ ...mono, fontSize:46, fontWeight:800, color:T.cyan, lineHeight:1, letterSpacing:'-1px' }} />
              <span style={{ ...mono, fontSize:12, fontWeight:700, padding:'4px 12px', borderRadius:20,
                background: dayUp ? 'rgba(52,211,153,0.1)' : 'rgba(244,63,94,0.1)',
                color: dayUp ? T.green : T.red,
                border:`1px solid ${dayUp ? 'rgba(52,211,153,0.2)' : 'rgba(244,63,94,0.2)'}` }}>
                {hero.dayReturn} today
              </span>
            </div>
            <Divider style={{ margin:'18px 0' }} />
            <div style={{ display:'flex', gap:36, flexWrap:'wrap' }}>
              {[
                { label:"Today's P&L", value:hero.todayPnL,   up:dayUp },
                { label:'Total P&L',   value:hero.totalPnL,   up:pnlUp },
                { label:'Total Return',value:hero.totalReturn, up:pnlUp },
              ].map(({ label, value, up }) => (
                <div key={label}>
                  <Label style={{ marginBottom:5 }}>{label}</Label>
                  <div style={{ ...mono, fontSize:17, fontWeight:700, color:up ? T.green : T.red }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:10, minWidth:170 }}>
            {[
              { label:'Open Positions', value:hero.openPositions, icon:'◈' },
              { label:'Available Cash', value:hero.availableCash, icon:'◎' },
            ].map(({ label, value, icon }) => (
              <div key={label} style={{ background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:12, padding:'14px 18px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
                  <span style={{ color:T.cyan, fontSize:10, opacity:.7 }}>{icon}</span>
                  <Label>{label}</Label>
                </div>
                <div style={{ ...mono, fontSize:19, fontWeight:700, color:'var(--text)' }}>{value}</div>
              </div>
            ))}
            {lastUpdated && (
              <div style={{ ...mono, fontSize:9, color:T.slate, textAlign:'right', opacity:.6 }}>
                ↻ {lastUpdated.toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══ CHARTS ROW ══ */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.5fr', gap:14 }}>
        <div className="aq-card" style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:'20px 22px' }}>
          <Label style={{ marginBottom:16 }}>Allocation</Label>
          {allocations.length === 0 ? (
            <div style={{ ...mono, fontSize:12, color:T.slate, textAlign:'center', padding:'50px 0', opacity:.6 }}>No positions yet</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={175}>
                <PieChart>
                  <Pie data={allocations} dataKey="pct" nameKey="name" innerRadius={54} outerRadius={74} paddingAngle={2} labelLine={false} label={<PieLabel />}>
                    {allocations.map((e, i) => <Cell key={i} fill={e.color || PALETTE[i % PALETTE.length]} stroke="var(--surface)" strokeWidth={2} />)}
                  </Pie>
                  <Tooltip {...ttStyle} formatter={(v, n) => [`${v.toFixed(1)}%`, n]} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'5px 14px', marginTop:4 }}>
                {allocations.map((a, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <div style={{ width:6, height:6, borderRadius:'50%', background:a.color||PALETTE[i%PALETTE.length], flexShrink:0 }}/>
                    <span style={{ ...mono, fontSize:9, color:T.slate }}>{a.name}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="aq-card" style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:'20px 22px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <Label>Equity Curve</Label>
            {equityCurve.length >= 2 && <span style={{ ...mono, fontSize:9, color:T.slate }}>30d</span>}
          </div>
          {equityCurve.length < 2 ? (
            <div style={{ ...mono, fontSize:12, color:T.slate, textAlign:'center', padding:'50px 0', opacity:.6 }}>Accumulating data…</div>
          ) : (
            <ResponsiveContainer width="100%" height={195}>
              <AreaChart data={equityCurve} margin={{ top:4, right:4, left:0, bottom:0 }}>
                <defs>
                  <linearGradient id="aqEqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"  stopColor={T.purple} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={T.purple} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis dataKey="t" tick={{ ...mono, fontSize:9, fill:T.slate }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ ...mono, fontSize:9, fill:T.slate }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={42} />
                <Tooltip {...ttStyle} formatter={v => [`$${parseFloat(v).toLocaleString()}`, 'Value']} />
                <Area type="monotone" dataKey="v" stroke={T.purple} strokeWidth={1.5} fill="url(#aqEqGrad)" dot={false} activeDot={{ r:4, fill:T.purple, stroke:'var(--surface)', strokeWidth:2 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ══ RISK BADGES ══ */}
      {risks.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${risks.length},1fr)`, gap:12 }}>
          {risks.map((r, i) => (
            <div key={i} className="aq-card" style={{ position:'relative', overflow:'hidden', background:r.warn?'rgba(244,63,94,0.04)':'rgba(0,245,212,0.03)', border:`1px solid ${r.warn?'rgba(244,63,94,0.2)':'rgba(0,245,212,0.1)'}`, borderRadius:12, padding:'16px 20px' }}>
              <Label style={{ marginBottom:8 }}>{r.label}</Label>
              <div style={{ ...mono, fontSize:22, fontWeight:800, color:r.warn?T.red:T.cyan, letterSpacing:'-0.5px' }}>{r.value}</div>
              <div style={{ ...mono, fontSize:10, color:T.slate, marginTop:4 }}>{r.note}</div>
              <div style={{ position:'absolute', bottom:0, left:0, right:0, height:2, borderRadius:'0 0 12px 12px', background:r.warn?`linear-gradient(90deg,${T.red}40,transparent)`:`linear-gradient(90deg,${T.cyan}30,transparent)` }}/>
            </div>
          ))}
        </div>
      )}

      {/* ══ POSITIONS / SECTORS ══ */}
      <div className="aq-card" style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:'20px 24px' }}>
        {/* Tab bar + Add button */}
        <div style={{ display:'flex', alignItems:'center', gap:0, marginBottom:20, borderBottom:'1px solid rgba(255,255,255,0.05)', paddingBottom:12 }}>
          {['positions','sectors'].map(tab => (
            <button key={tab} className="aq-tab" onClick={() => setActiveTab(tab)} style={{
              ...mono, fontSize:10, letterSpacing:'.12em', textTransform:'uppercase',
              background:'none', border:'none', cursor:'pointer', padding:'4px 18px 4px 0',
              color: activeTab === tab ? 'var(--text)' : T.slate,
              borderBottom: activeTab === tab ? `2px solid ${T.cyan}` : '2px solid transparent',
              marginBottom:-13, fontWeight: activeTab === tab ? 700 : 400,
            }}>
              {tab}
            </button>
          ))}

          <div style={{ display:'flex', gap:8, marginLeft:'auto', alignItems:'center' }}>
            {activeTab === 'positions' && (
              <>
                {['all','long','short'].map(f => (
                  <button key={f} className="aq-filter" onClick={() => setSideFilter(f)} style={{
                    ...mono, fontSize:9, letterSpacing:'.08em', textTransform:'uppercase',
                    padding:'3px 12px', borderRadius:20, cursor:'pointer', transition:'all .18s',
                    border:'1px solid', borderColor:sideFilter===f?T.cyan:'rgba(255,255,255,0.08)',
                    background:sideFilter===f?'rgba(0,245,212,0.08)':'transparent',
                    color:sideFilter===f?T.cyan:T.slate,
                  }}>{f}</button>
                ))}
                <span style={{ ...mono, fontSize:9, color:T.slate }}>{filtered.length} pos</span>
              </>
            )}

            {/* Add Position button */}
            <button onClick={() => { setAddPrefill(null); setShowAddModal(true); }} style={{
              display:'flex', alignItems:'center', gap:6,
              padding:'6px 14px', borderRadius:8, cursor:'pointer',
              border:'1px solid rgba(0,245,212,0.25)', background:'rgba(0,245,212,0.06)',
              color:T.cyan, ...mono, fontSize:10, fontWeight:700, transition:'all .15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background='rgba(0,245,212,0.12)'; e.currentTarget.style.borderColor='rgba(0,245,212,0.4)'; }}
              onMouseLeave={e => { e.currentTarget.style.background='rgba(0,245,212,0.06)'; e.currentTarget.style.borderColor='rgba(0,245,212,0.25)'; }}>
              + Add Position
            </button>
          </div>
        </div>

        {/* ── Positions table ── */}
        {activeTab === 'positions' && (
          filtered.length === 0 ? (
            <div style={{ textAlign:'center', padding:'48px 0', color:T.slate, ...mono, fontSize:12, opacity:.6 }}>
              <div style={{ marginBottom:16 }}>No {sideFilter !== 'all' ? sideFilter : ''} positions</div>
              <button onClick={() => { setAddPrefill(null); setShowAddModal(true); }} style={{ padding:'8px 20px', borderRadius:8, border:'1px solid rgba(0,245,212,0.25)', background:'rgba(0,245,212,0.06)', color:T.cyan, ...mono, fontSize:10, cursor:'pointer' }}>
                + Add your first position
              </button>
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    {['Asset','Side','Amount','Avg Entry','Price','24h','P&L','Return',''].map((h, i) => (
                      <th key={i} style={{ ...mono, fontSize:9, letterSpacing:'.18em', textTransform:'uppercase', color:T.slate, textAlign:'left', paddingBottom:12, paddingRight:i < 8 ? 16 : 0, fontWeight:400, whiteSpace:'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <tr key={i} className="aq-row">
                      {/* Asset */}
                      <td style={{ ...mono, fontSize:13, fontWeight:700, color:'var(--text)', padding:'12px 16px 12px 0', verticalAlign:'middle' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <div style={{ width:28, height:28, borderRadius:8, background:`${PALETTE[i%PALETTE.length]}18`, border:`1px solid ${PALETTE[i%PALETTE.length]}30`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, color:PALETTE[i%PALETTE.length], flexShrink:0 }}>
                            {p.sym.slice(0,2)}
                          </div>
                          {p.sym}
                        </div>
                      </td>
                      {/* Side */}
                      <td style={{ padding:'12px 16px 12px 0', verticalAlign:'middle' }}>
                        <span style={{ ...mono, fontSize:8, letterSpacing:'.1em', textTransform:'uppercase', padding:'3px 8px', borderRadius:4, background:p.side==='long'?'rgba(52,211,153,0.1)':'rgba(244,63,94,0.1)', color:p.side==='long'?T.green:T.red, border:`1px solid ${p.side==='long'?'rgba(52,211,153,0.2)':'rgba(244,63,94,0.2)'}` }}>
                          {p.side}
                        </span>
                      </td>
                      {/* Amount */}
                      <td style={{ ...mono, fontSize:12, color:T.slate, padding:'12px 16px 12px 0', verticalAlign:'middle' }}>{p.amount}</td>
                      {/* Avg Entry */}
                      <td style={{ ...mono, fontSize:12, color:T.slate, padding:'12px 16px 12px 0', verticalAlign:'middle' }}>{p.avgEntry}</td>
                      {/* Price */}
                      <td style={{ ...mono, fontSize:12, color:'var(--text)', padding:'12px 16px 12px 0', fontWeight:600, verticalAlign:'middle' }}>{p.price}</td>
                      {/* 24h */}
                      <td style={{ ...mono, fontSize:12, color:p.up?T.green:T.red, padding:'12px 16px 12px 0', verticalAlign:'middle' }}>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                          <span style={{ fontSize:9 }}>{p.up?'▲':'▼'}</span>{p.ch}
                        </span>
                      </td>
                      {/* P&L */}
                      <td style={{ ...mono, fontSize:12, color:colorPnl(p.pnl), padding:'12px 16px 12px 0', fontWeight:600, verticalAlign:'middle' }}>{p.pnl}</td>
                      {/* Return */}
                      <td style={{ ...mono, fontSize:12, color:colorPnl(p.ret), padding:'12px 16px 12px 0', verticalAlign:'middle' }}>{p.ret}</td>
                      {/* Close button */}
                      <td style={{ padding:'12px 0', verticalAlign:'middle', textAlign:'right' }}>
                        <button className="aq-close-btn" onClick={() => setCloseTarget(p)} style={{
                          ...mono, fontSize:9, padding:'4px 10px', borderRadius:6, cursor:'pointer',
                          border:'1px solid rgba(244,63,94,0.25)', background:'rgba(244,63,94,0.06)',
                          color:T.red, transition:'all .15s',
                        }}
                          onMouseEnter={e => { e.currentTarget.style.background='rgba(244,63,94,0.15)'; e.currentTarget.style.opacity='1'; }}
                          onMouseLeave={e => { e.currentTarget.style.background='rgba(244,63,94,0.06)'; }}>
                          Close
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ── Sectors tab ── */}
        {activeTab === 'sectors' && (
          sectorData.length === 0 ? (
            <div style={{ textAlign:'center', padding:'48px 0', color:T.slate, ...mono, fontSize:12, opacity:.6 }}>No sector data available</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {sectorData.sort((a,b) => b.pct - a.pct).map((s, i) => (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'110px 1fr 52px', alignItems:'center', gap:16 }}>
                  <div style={{ ...mono, fontSize:11, color:'var(--text)' }}>{s.name}</div>
                  <Bar pct={s.pct} color={s.color || PALETTE[i % PALETTE.length]} h={4} />
                  <div style={{ ...mono, fontSize:11, color:T.slate, textAlign:'right' }}>{s.pct.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* ══ HOLDINGS STRIP ══ */}
      {holdings.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${Math.min(holdings.length,5)},1fr)`, gap:10 }}>
          {holdings.slice(0,5).map((h, i) => (
            <div key={i} className="aq-holding aq-card" style={{ background:T.surface, border:'1px solid rgba(255,255,255,0.06)', borderRadius:14, padding:'16px 18px', position:'relative', overflow:'hidden' }}>
              <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, ${PALETTE[i%PALETTE.length]}, transparent)` }}/>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                <div>
                  <div style={{ ...mono, fontSize:13, fontWeight:700, color:'var(--text)' }}>{h.sym}</div>
                  <div style={{ ...mono, fontSize:9, color:T.slate, marginTop:2 }}>{h.pct} of portfolio</div>
                </div>
                <span style={{ ...mono, fontSize:10, fontWeight:600, color:h.up?T.green:T.red, padding:'2px 6px', borderRadius:4, background:h.up?'rgba(52,211,153,0.08)':'rgba(244,63,94,0.08)' }}>{h.ch}</span>
              </div>
              <div style={{ ...mono, fontSize:18, fontWeight:700, color:'var(--text)', marginBottom:10 }}>{h.price}</div>
              <Bar pct={parseFloat(h.pct)} color={PALETTE[i%PALETTE.length]} h={3} />
            </div>
          ))}
        </div>
      )}

      {/* ══ AI ANALYZER ══ */}
      <PortfolioAnalyzer positions={allPositionsData} onApply={handleApplyRecommendation} />

    </div>
  );
}