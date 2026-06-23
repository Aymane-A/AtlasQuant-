import { useState } from 'react';
import api from '../services/api';

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT',
  'XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT',
  'LINKUSD','UNIUSDT','AAVEUSDT','MATICUSDT',
  'ARBUSDT','OPUSDT','SHIBUSDT','PEPEUSDT',
];

const DISPLAY = {
  BTCUSDT:'BTC/USDT',   ETHUSDT:'ETH/USDT',   BNBUSDT:'BNB/USDT',
  SOLUSDT:'SOL/USDT',   XRPUSDT:'XRP/USDT',   ADAUSDT:'ADA/USDT',
  AVAXUSDT:'AVAX/USDT', DOGEUSDT:'DOGE/USDT',  LINKUSDT:'LINK/USDT',
  UNIUSDT:'UNI/USDT',   AAVEUSDT:'AAVE/USDT',  MATICUSDT:'MATIC/USDT',
  ARBUSDT:'ARB/USDT',   OPUSDT:'OP/USDT',      SHIBUSDT:'SHIB/USDT',
  PEPEUSDT:'PEPE/USDT',
};


const FILTERS = ['All','BUY','SELL','HOLD'];

export default function Screener() {
  const [results,  setResults]  = useState([]);
  const [scanning, setScanning] = useState(false);
  const [filter,   setFilter]   = useState('All');
  const [sortBy,   setSortBy]   = useState('confidence');
  const [scannedAt, setScannedAt] = useState(null);
  const [error,    setError]    = useState(null);

  const runScan = async () => {
  setScanning(true);
  setError(null);
  try {
    const res = await api.get('/signals?interval=4h&refresh=true', {
      timeout: 160000
    });
    const data = res.data;
    if (data.signals) {
      setResults(data.signals);
      setScannedAt(new Date());
    } else {
      setError('No signals returned from backend.');
    }
  } catch (err) {
    setError(err?.error || 'Scan failed. Is the backend running?');
  } finally {
    setScanning(false);
  }
};

  const filtered = results
    .filter(r => filter === 'All' || r.signal === filter)
    .sort((a, b) => {
      if (sortBy === 'confidence') return b.confidence - a.confidence;
      if (sortBy === 'price')      return b.price - a.price;
      if (sortBy === 'rr')         return (parseFloat(b.risk_reward)||0) - (parseFloat(a.risk_reward)||0);
      return 0;
    });

  const stats = {
    total: results.length,
    buy:   results.filter(r => r.signal === 'BUY').length,
    sell:  results.filter(r => r.signal === 'SELL').length,
    hold:  results.filter(r => r.signal === 'HOLD').length,
    avgConf: results.length
      ? Math.round(results.reduce((a, r) => a + (r.confidence || 0), 0) / results.length)
      : 0,
  };

  return (
    <>
      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
            // Market Screener
          </div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {scannedAt
              ? `Dernière analyse : ${scannedAt.toLocaleTimeString()} — ${results.length} actifs scannés`
              : 'Lancez un scan pour analyser le marché en temps réel'}
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          style={{
            display:'flex', alignItems:'center', gap:8,
            padding:'10px 24px', borderRadius:9,
            border:'1px solid var(--cyan-dim)',
            background: scanning ? 'rgba(0,245,212,0.05)' : 'var(--cyan-glow)',
            color:'var(--cyan)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor: scanning ? 'not-allowed' : 'pointer',
            opacity: scanning ? 0.7 : 1,
          }}
        >
          {scanning ? (
            <>
              <span style={{ display:'inline-block', width:12, height:12, border:'2px solid var(--cyan)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
              Scanning...
            </>
          ) : (
            <>▶ Run Screener</>
          )}
        </button>
      </div>

      {/* ── KPI Cards ── */}
      {results.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12 }}>
          {[
            { label:'Scannés',      v: stats.total,       color:'var(--cyan)'  },
            { label:'BUY',         v: stats.buy,          color:'var(--green)' },
            { label:'SELL',        v: stats.sell,         color:'var(--red)'   },
            { label:'HOLD',        v: stats.hold,         color:'var(--amber)' },
            { label:'Avg Confiance',v: stats.avgConf+'%', color:'var(--cyan)'  },
          ].map(k => (
            <div key={k.label} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'16px 20px' }}>
              <div style={{ fontSize:10, letterSpacing:'.12em', color:'var(--text-secondary)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:8 }}>{k.label}</div>
              <div style={{ fontSize:26, fontWeight:700, color:k.color }}>{k.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters & Sort ── */}
      {results.length > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:4 }}>
            {FILTERS.map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding:'6px 16px', borderRadius:7, border:'none',
                fontFamily:'JetBrains Mono,monospace', fontSize:12, cursor:'pointer',
                background: filter===f ? 'rgba(0,245,212,0.1)' : 'transparent',
                color:      filter===f ? 'var(--cyan)' : 'var(--text-secondary)',
                boxShadow:  filter===f ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
              }}>{f}</button>
            ))}
          </div>

          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8, fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            Trier par:
            {[['confidence','Confiance'],['price','Prix'],['rr','R:R']].map(([k,l]) => (
              <button key={k} onClick={() => setSortBy(k)} style={{
                padding:'4px 12px', borderRadius:6, border:'1px solid var(--border)',
                fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer',
                background: sortBy===k ? 'var(--cyan-glow)' : 'transparent',
                color:      sortBy===k ? 'var(--cyan)' : 'var(--text-secondary)',
              }}>{l}</button>
            ))}
            <span style={{ color:'var(--cyan)', marginLeft:8 }}>{filtered.length} résultats</span>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{ background:'rgba(248,113,113,0.08)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:10, padding:'14px 18px', fontSize:12, color:'var(--red)', fontFamily:'JetBrains Mono,monospace' }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Empty State ── */}
      {!scanning && results.length === 0 && !error && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'80px 0', gap:16 }}>
          <div style={{ fontSize:40, opacity:0.15 }}>◈</div>
          <div style={{ fontSize:13, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', textAlign:'center', lineHeight:1.8 }}>
            Aucune donnée — lancez un scan pour analyser<br/>
            {SYMBOLS.length} paires crypto en temps réel via l'IA
          </div>
          <button onClick={runScan} style={{
            marginTop:8, padding:'10px 28px', borderRadius:9,
            border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)',
            color:'var(--cyan)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor:'pointer',
          }}>
            ▶ Lancer le premier scan
          </button>
        </div>
      )}

      {/* ── Scanning skeleton ── */}
      {scanning && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          {Array(6).fill(0).map((_,i) => (
            <div key={i} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:20, height:160, animation:'pulse 2s infinite' }} />
          ))}
        </div>
      )}

      {/* ── Results Table ── */}
      {!scanning && filtered.length > 0 && (
        <div className="panel" style={{ padding:0, overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                {['Symbole','Prix','Signal','Confiance','R:R','Tendance'].map(h => (
                  <th key={h} style={{ textAlign:'left', padding:'14px 18px', fontSize:10, letterSpacing:'.15em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const isBuy  = r.signal === 'BUY';
                const isSell = r.signal === 'SELL';
                const conf   = r.confidence || 0;
                const rr     = parseFloat(r.risk_reward) || 0;
                return (
                  <tr key={r.id || i} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', transition:'background .15s' }}
                    onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}
                  >
                    {/* Symbol */}
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:8, height:8, borderRadius:'50%', background: isBuy?'var(--green)':isSell?'var(--red)':'var(--amber)', boxShadow: isBuy?'0 0 8px var(--green)':isSell?'0 0 8px var(--red)':'0 0 8px var(--amber)' }} />
                        <span style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>
                          {DISPLAY[r.rawSymbol] || r.symbol}
                        </span>
                      </div>
                    </td>
                    {/* Price */}
                    <td style={{ padding:'14px 18px', fontSize:13, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>
                      ${r.price?.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 }) || '—'}
                    </td>
                    {/* Signal */}
                    <td style={{ padding:'14px 18px' }}>
                      <span style={{
                        padding:'4px 12px', borderRadius:6, fontSize:11, fontWeight:700, fontFamily:'JetBrains Mono,monospace',
                        background: isBuy?'rgba(52,211,153,0.12)':isSell?'rgba(248,113,113,0.12)':'rgba(251,191,36,0.12)',
                        color:      isBuy?'var(--green)':isSell?'var(--red)':'var(--amber)',
                        border:     `1px solid ${isBuy?'rgba(52,211,153,0.2)':isSell?'rgba(248,113,113,0.2)':'rgba(251,191,36,0.2)'}`,
                      }}>
                        {r.signal}
                      </span>
                    </td>
                    {/* Confidence bar */}
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:80, height:5, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                          <div style={{ width:`${conf}%`, height:'100%', borderRadius:3, background: conf>=75?'var(--green)':conf>=50?'var(--amber)':'var(--red)' }} />
                        </div>
                        <span style={{ fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>{conf}%</span>
                      </div>
                    </td>
                    {/* R:R */}
                    <td style={{ padding:'14px 18px', fontSize:12, fontFamily:'JetBrains Mono,monospace', color: rr>=1.5?'var(--green)':rr>=1?'var(--amber)':'var(--red)' }}>
                      {rr > 0 ? rr.toFixed(2) : '—'}
                    </td>
                    {/* Score bars */}
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', gap:6, alignItems:'center', fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' }}>
                        <span style={{ color:'var(--green)' }}>▲{r.score?.bullish ?? '—'}</span>
                        <span>/</span>
                        <span style={{ color:'var(--red)' }}>▼{r.score?.bearish ?? '—'}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </>
  );
}