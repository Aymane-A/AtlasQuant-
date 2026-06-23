import { useState, useEffect } from 'react';
import api from '../services/api';

const SPARKLINE = ({ data = [], up }) => {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const w = 80, h = 28;
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`
  ).join(' ');
  return (
    <svg width={w} height={h}>
      <polyline points={pts} fill="none"
        stroke={up ? 'var(--green)' : 'var(--red)'}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const SignalBadge = ({ signal, confidence }) => {
  if (!signal) return <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>—</span>;
  const cfg = {
    BUY:  { bg:'rgba(52,211,153,0.12)',  color:'var(--green)', border:'rgba(52,211,153,0.25)'  },
    SELL: { bg:'rgba(248,113,113,0.12)', color:'var(--red)',   border:'rgba(248,113,113,0.25)' },
    HOLD: { bg:'rgba(251,191,36,0.12)',  color:'var(--amber)', border:'rgba(251,191,36,0.25)'  },
  };
  const c = cfg[signal] || cfg.HOLD;
  return (
    <span style={{
      padding:'3px 10px', borderRadius:6, fontSize:10, fontWeight:700,
      fontFamily:'JetBrains Mono,monospace',
      background: c.bg, color: c.color, border:`1px solid ${c.border}`,
    }}>
      {signal} {confidence ? `${confidence}%` : ''}
    </span>
  );
};

export default function Watchlist() {
  const [stocks,  setStocks]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab,     setTab]     = useState('card');
  const [input,   setInput]   = useState('');
  const [adding,  setAdding]  = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const fetchWatchlist = () => {
    setLoading(true);
    api.get('/watchlist')
      .then(res => setStocks(res.data.stocks || []))
      .catch(err => console.error('Watchlist error:', err))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchWatchlist(); }, []);

  const addSymbol = async () => {
    if (!input.trim()) return;
    setAdding(true);
    try {
      await api.post('/watchlist', { symbol: input.trim().toUpperCase() });
      setInput('');
      setShowAdd(false);
      fetchWatchlist();
    } catch (err) {
      console.error('Add error:', err);
    } finally {
      setAdding(false);
    }
  };

  const removeSymbol = async (sym) => {
    try {
      await api.delete(`/watchlist/${encodeURIComponent(sym)}`);
      fetchWatchlist();
    } catch (err) {
      console.error('Remove error:', err);
    }
  };

  return (
    <>
      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
            // Watchlist
          </div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {stocks.length} actifs surveillés · Prix temps réel · Signaux IA
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:4 }}>
            {[['card','⊞ Cards'],['table','≡ Table']].map(([k,l]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                padding:'6px 14px', borderRadius:7, border:'none',
                fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer',
                background: tab===k ? 'rgba(0,245,212,0.1)' : 'transparent',
                color:      tab===k ? 'var(--cyan)' : 'var(--text-secondary)',
                boxShadow:  tab===k ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
              }}>{l}</button>
            ))}
          </div>
          <button onClick={() => setShowAdd(v => !v)} style={{
            padding:'9px 20px', borderRadius:9, border:'1px solid var(--cyan-dim)',
            background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:13,
            fontWeight:700, fontFamily:'Syne,sans-serif', cursor:'pointer',
          }}>
            + Add Symbol
          </button>
        </div>
      </div>

      {/* ── Add Input ── */}
      {showAdd && (
        <div style={{ display:'flex', gap:10, alignItems:'flex-start', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'16px 20px' }}>
          <div style={{ flex:1 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSymbol()}
              placeholder="Crypto: BTCUSDT · Forex: EUR/USD · Commo: XAU/USD"
              style={{
                width:'100%', background:'rgba(255,255,255,0.04)',
                border:'1px solid var(--border)', borderRadius:8,
                padding:'10px 14px', color:'var(--text-primary)',
                fontFamily:'JetBrains Mono,monospace', fontSize:13, outline:'none',
                boxSizing:'border-box',
              }}
              autoFocus
            />
            <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:6 }}>
              Exemples: ETHUSDT · GBP/USD · XAU/USD · XAG/USD · SPY · QQQ
            </div>
          </div>
          <button onClick={addSymbol} disabled={adding} style={{
            padding:'10px 20px', borderRadius:8, border:'none',
            background:'var(--cyan)', color:'#000', fontWeight:700,
            fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer',
            opacity: adding ? 0.7 : 1, flexShrink:0,
          }}>
            {adding ? '...' : 'Add'}
          </button>
          <button onClick={() => setShowAdd(false)} style={{
            padding:'10px 14px', borderRadius:8, border:'1px solid var(--border)',
            background:'transparent', color:'var(--text-secondary)', cursor:'pointer', flexShrink:0,
          }}>✕</button>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          {Array(6).fill(0).map((_,i) => (
            <div key={i} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, height:160, animation:'pulse 2s infinite' }} />
          ))}
        </div>
      )}

      {/* ── Empty State ── */}
      {!loading && stocks.length === 0 && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'80px 0', gap:16 }}>
          <div style={{ fontSize:40, opacity:0.15 }}>◉</div>
          <div style={{ fontSize:13, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', textAlign:'center', lineHeight:1.8 }}>
            Watchlist vide — ajoutez des actifs à surveiller
          </div>
          <button onClick={() => setShowAdd(true)} style={{
            padding:'10px 28px', borderRadius:9, border:'1px solid var(--cyan-dim)',
            background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:13,
            fontWeight:700, fontFamily:'Syne,sans-serif', cursor:'pointer',
          }}>+ Ajouter un actif</button>
        </div>
      )}

      {/* ── Card View ── */}
      {!loading && tab === 'card' && stocks.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          {stocks.map(s => {
            const up    = (s.change || 0) >= 0;
            const spark = s.sparkline || s.history || [];
            return (
              <div key={s.sym} style={{
                background:'var(--surface)', border:'1px solid var(--border)',
                borderRadius:12, padding:'18px 20px', position:'relative',
                transition:'border-color .2s',
              }}
                onMouseEnter={e => e.currentTarget.style.borderColor='rgba(0,245,212,0.2)'}
                onMouseLeave={e => e.currentTarget.style.borderColor='var(--border)'}
              >
                {/* Remove */}
                <button onClick={() => removeSymbol(s.sym)} style={{
                  position:'absolute', top:12, right:12, background:'transparent',
                  border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:14,
                }}>✕</button>

                {/* Symbol + Signal */}
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap' }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, background: up?'var(--green)':'var(--red)', boxShadow: up?'0 0 8px var(--green)':'0 0 8px var(--red)' }} />
                  <span style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>{s.sym}</span>
                  <SignalBadge signal={s.signal} confidence={s.confidence} />
                </div>

                {/* Price */}
                <div style={{ fontSize:22, fontWeight:700, color:'var(--text-primary)', marginBottom:4 }}>
                  ${parseFloat(s.price || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 })}
                </div>

                {/* Change */}
                <div style={{ fontSize:12, fontFamily:'JetBrains Mono,monospace', color: up?'var(--green)':'var(--red)', marginBottom:12 }}>
                  {up ? '▲' : '▼'} {Math.abs(s.change || 0).toFixed(2)}%
                </div>

                {/* 24h stats */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom: spark.length ? 12 : 0 }}>
                  {[
                    { label:'24H H', value: s.high24h ? `$${parseFloat(s.high24h).toLocaleString('en-US',{maximumFractionDigits:4})}` : '—' },
                    { label:'24H L', value: s.low24h  ? `$${parseFloat(s.low24h).toLocaleString('en-US', {maximumFractionDigits:4})}` : '—' },
                    { label:'Vol',   value: s.volume  || '—' },
                  ].map(item => (
                    <div key={item.label}>
                      <div style={{ fontSize:9, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', letterSpacing:'.1em', marginBottom:2 }}>{item.label}</div>
                      <div style={{ fontSize:10, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>{item.value}</div>
                    </div>
                  ))}
                </div>

                {spark.length > 0 && <SPARKLINE data={spark} up={up} />}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Table View ── */}
      {!loading && tab === 'table' && stocks.length > 0 && (
        <div className="panel" style={{ padding:0, overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                {['Symbole','Prix','24h %','H/L 24h','Volume','Signal IA','Action'].map(h => (
                  <th key={h} style={{ textAlign:'left', padding:'14px 18px', fontSize:10, letterSpacing:'.15em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stocks.map(s => {
                const up = (s.change || 0) >= 0;
                return (
                  <tr key={s.sym}
                    style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', transition:'background .15s' }}
                    onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}
                  >
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:7, height:7, borderRadius:'50%', background: up?'var(--green)':'var(--red)' }} />
                        <span style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace' }}>{s.sym}</span>
                      </div>
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:13, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>
                      ${parseFloat(s.price || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 })}
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:12, fontFamily:'JetBrains Mono,monospace', color: up?'var(--green)':'var(--red)', fontWeight:600 }}>
                      {up ? '▲' : '▼'} {Math.abs(s.change || 0).toFixed(2)}%
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
                      <span style={{ color:'var(--green)' }}>{s.high24h ? `$${parseFloat(s.high24h).toFixed(2)}` : '—'}</span>
                      <span style={{ color:'var(--text-muted)', margin:'0 4px' }}>/</span>
                      <span style={{ color:'var(--red)' }}>{s.low24h ? `$${parseFloat(s.low24h).toFixed(2)}` : '—'}</span>
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>
                      {s.volume || '—'}
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <SignalBadge signal={s.signal} confidence={s.confidence} />
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <button onClick={() => removeSymbol(s.sym)} style={{
                        background:'rgba(248,113,113,0.08)', border:'1px solid rgba(248,113,113,0.2)',
                        color:'var(--red)', borderRadius:6, padding:'4px 10px',
                        fontSize:11, fontFamily:'JetBrains Mono,monospace', cursor:'pointer',
                      }}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </>
  );
}