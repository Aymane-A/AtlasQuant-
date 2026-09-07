import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom'; // adjust import if your router setup differs
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

// ── Icon set (inline SVG — avoids emoji glyphs rendering as blank/white
// boxes on systems without a color-emoji font installed) ────────────
const BellIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const BoltIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
  </svg>
);

const CloseIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <path d="M18 6 6 18" />
    <path d="M6 6l12 12" />
  </svg>
);

// Small circular icon button used for card-level quick actions
// (alert / trade / remove). Consistent bg-pill style across all three
// instead of bare emoji glyphs that render inconsistently.
const IconButton = ({ onClick, title, color, bg, border, children }) => (
  <button onClick={onClick} title={title} style={{
    width:26, height:26, borderRadius:'50%', display:'flex',
    alignItems:'center', justifyContent:'center', cursor:'pointer',
    background: bg, border: `1px solid ${border}`, color, flexShrink:0,
    transition:'transform .15s, filter .15s',
  }}
    onMouseEnter={e => { e.currentTarget.style.transform='scale(1.08)'; e.currentTarget.style.filter='brightness(1.2)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform='scale(1)'; e.currentTarget.style.filter='none'; }}
  >
    {children}
  </button>
);

// ── Toast notification (lightweight, no external deps) ──────
const Toast = ({ message, type = 'success', onDone }) => {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);

  const cfg = {
    success: { bg:'rgba(52,211,153,0.12)', border:'rgba(52,211,153,0.3)', color:'var(--green)', icon:'✓' },
    error:   { bg:'rgba(248,113,113,0.12)', border:'rgba(248,113,113,0.3)', color:'var(--red)',  icon:'✕' },
  }[type];

  return (
    <div style={{
      position:'fixed', bottom:24, right:24, zIndex:1100,
      display:'flex', alignItems:'center', gap:10,
      background:'var(--surface)', border:`1px solid ${cfg.border}`,
      borderRadius:10, padding:'12px 18px', boxShadow:'0 8px 24px rgba(0,0,0,0.4)',
    }}>
      <span style={{ color:cfg.color, fontSize:14, fontWeight:700 }}>{cfg.icon}</span>
      <span style={{ fontSize:12, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>
        {message}
      </span>
    </div>
  );
};

// ── Quick Alert Modal ────────────────────────────────────────
const AlertModal = ({ symbol, onClose, onCreated }) => {
  const [condition, setCondition] = useState('above');
  const [value,     setValue]     = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  const submit = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/alerts', {
        symbol,
        type: 'typePrice',
        condition,
        value: parseFloat(value),
        channels: [], // in-app only by default; user can add email/telegram from Alerts page
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create alert');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
    }} onClick={onClose}>
      <div style={{
        background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14,
        padding:24, width:340, boxSizing:'border-box',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:14, fontWeight:700, fontFamily:'Syne,sans-serif', color:'var(--text-primary)', marginBottom:16 }}>
          <span style={{ color:'var(--amber)' }}><BellIcon size={16} /></span>
          Alert on {symbol}
        </div>

        <div style={{ display:'flex', gap:8, marginBottom:14 }}>
          {['above','below'].map(c => (
            <button key={c} onClick={() => setCondition(c)} style={{
              flex:1, padding:'8px 0', borderRadius:8, cursor:'pointer',
              border: condition===c ? '1px solid var(--cyan-dim)' : '1px solid var(--border)',
              background: condition===c ? 'var(--cyan-glow)' : 'transparent',
              color: condition===c ? 'var(--cyan)' : 'var(--text-secondary)',
              fontFamily:'JetBrains Mono,monospace', fontSize:12, fontWeight:600,
            }}>
              {c === 'above' ? '▲ Above' : '▼ Below'}
            </button>
          ))}
        </div>

        <input
          type="number"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Target price"
          style={{
            width:'100%', background:'rgba(255,255,255,0.04)',
            border:'1px solid var(--border)', borderRadius:8,
            padding:'10px 14px', color:'var(--text-primary)',
            fontFamily:'JetBrains Mono,monospace', fontSize:13, outline:'none',
            boxSizing:'border-box', marginBottom: error ? 8 : 16,
          }}
          autoFocus
        />

        {error && (
          <div style={{ fontSize:11, color:'var(--red)', fontFamily:'JetBrains Mono,monospace', marginBottom:12 }}>
            {error}
          </div>
        )}

        <div style={{ display:'flex', gap:10 }}>
          <button onClick={submit} disabled={saving || !value.trim()} style={{
            flex:1, padding:'10px 0', borderRadius:8, border:'none',
            background:'var(--cyan)', color:'#000', fontWeight:700,
            fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer',
            opacity: (saving || !value.trim()) ? 0.6 : 1,
          }}>
            {saving ? '...' : 'Create Alert'}
          </button>
          <button onClick={onClose} style={{
            padding:'10px 16px', borderRadius:8, border:'1px solid var(--border)',
            background:'transparent', color:'var(--text-secondary)', cursor:'pointer',
          }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default function Watchlist() {
  const navigate = useNavigate();

  const [stocks,      setStocks]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tab,         setTab]         = useState('card');
  const [input,       setInput]       = useState('');
  const [adding,      setAdding]      = useState(false);
  const [showAdd,     setShowAdd]     = useState(false);
  const [sortBy,      setSortBy]      = useState('none'); // 'none' | 'change-desc' | 'change-asc'
  const [alertSymbol, setAlertSymbol] = useState(null);   // symbol currently targeted by the alert modal
  const [toast,       setToast]       = useState(null);   // { message, type } | null
  const [flash,       setFlash]       = useState({});     // { [sym]: 'up' | 'down' } — brief price-move highlight

  const prevPrices = useRef({}); // holds last-seen price per symbol, used only to detect direction of change

  const fetchWatchlist = (isInitial = false) => {
    if (isInitial) setLoading(true); else setRefreshing(true);
    api.get('/watchlist')
      .then(res => {
        const newStocks = res.data.stocks || [];

        // Diff against previous prices to trigger the flash animation
        const moved = {};
        newStocks.forEach(s => {
          const prev = prevPrices.current[s.sym];
          if (prev !== undefined && s.price && s.price !== prev) {
            moved[s.sym] = s.price > prev ? 'up' : 'down';
          }
          prevPrices.current[s.sym] = s.price;
        });

        if (Object.keys(moved).length) {
          setFlash(f => ({ ...f, ...moved }));
          // Clear the flash after the animation window so the price
          // returns to its normal color until the next tick.
          setTimeout(() => {
            setFlash(f => {
              const next = { ...f };
              Object.keys(moved).forEach(k => delete next[k]);
              return next;
            });
          }, 900);
        }

        setStocks(newStocks);
        setLastUpdated(new Date());
      })
      .catch(err => console.error('Watchlist error:', err))
      .finally(() => { setLoading(false); setRefreshing(false); });
  };

  useEffect(() => {
    fetchWatchlist(true);

    // Poll every 15s — skip the tick while the tab isn't visible to
    // avoid burning API calls/rate limits in the background.
    const interval = setInterval(() => {
      if (!document.hidden) fetchWatchlist(false);
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  const sortedStocks = useMemo(() => {
    if (sortBy === 'none') return stocks;
    const sorted = [...stocks].sort((a, b) => (a.change || 0) - (b.change || 0));
    return sortBy === 'change-desc' ? sorted.reverse() : sorted;
  }, [stocks, sortBy]);

  
  const addSymbol = async () => {
    if (!input.trim()) return;
    setAdding(true);
    try {
      await api.post('/watchlist', { symbol: input.trim().toUpperCase() });
      setInput('');
      setShowAdd(false);
      fetchWatchlist();
      setToast({ message: `${input.trim().toUpperCase()} added to watchlist`, type: 'success' });
    } catch (err) {
      console.error('Add error:', err);
      setToast({ message: err.response?.data?.error || 'Failed to add symbol', type: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const removeSymbol = async (sym) => {
    try {
      await api.delete(`/watchlist/${encodeURIComponent(sym)}`);
      fetchWatchlist();
      setToast({ message: `${sym} removed from watchlist`, type: 'success' });
    } catch (err) {
      console.error('Remove error:', err);
      setToast({ message: err.response?.data?.error || 'Failed to remove symbol', type: 'error' });
    }
  };

  // ── Quick Trade routing — crypto, forex & commodities all supported ──
  // Crypto (no slash, e.g. "BTCUSDT") routes to Trading.jsx's default
  // crypto/ccxt flow. Forex & Commodity symbols (e.g. "EUR/USD", "XAU/USD")
  // carry a slash — Trading.jsx's OANDA integration expects underscore
  // instrument names ("EUR_USD"), and we also need to tell the page to
  // select the OANDA exchange explicitly (otherwise it defaults to
  // whichever exchange connected first, which is usually a crypto one).
  const goToTrade = (sym) => {
    if (!sym.includes('/')) {
      // Trading.jsx appends "USDT" itself, so strip it here to avoid "BTCUSDTUSDT".
      const cleanSymbol = sym.replace(/USDT$/, '');
      navigate(`/trading?symbol=${encodeURIComponent(cleanSymbol)}`);
      return;
    }
    const oandaSymbol = sym.toUpperCase().replace('/', '_');
    navigate(`/trading?symbol=${encodeURIComponent(oandaSymbol)}&exchangeId=oanda`);
  };

  return (
    <>
      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
            // Watchlist
          </div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {stocks.length} actifs surveillés · Prix temps réel · Signaux IA
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:6 }}>
            <span style={{
              width:6, height:6, borderRadius:'50%', background:'var(--green)',
              boxShadow:'0 0 6px var(--green)', animation:'livePulse 1.6s infinite',
              opacity: refreshing ? 1 : 0.7,
            }} />
            Live · auto-refresh 15s
            {lastUpdated && <span style={{ opacity:0.6 }}>· updated {lastUpdated.toLocaleTimeString('en-GB')}</span>}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          {/* Sort control */}
          <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:4 }}>
            {[
              ['none',        '— Default'],
              ['change-desc', '▲ Top gainers'],
              ['change-asc',  '▼ Top losers'],
            ].map(([k,l]) => (
              <button key={k} onClick={() => setSortBy(k)} style={{
                padding:'6px 12px', borderRadius:7, border:'none',
                fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer',
                background: sortBy===k ? 'rgba(0,245,212,0.1)' : 'transparent',
                color:      sortBy===k ? 'var(--cyan)' : 'var(--text-secondary)',
                boxShadow:  sortBy===k ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
              }}>{l}</button>
            ))}
          </div>

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
          {sortedStocks.map(s => {
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
                {/* Top-right action icons */}
                <div style={{ position:'absolute', top:12, right:12, display:'flex', gap:8 }}>
                  <IconButton
                    onClick={() => setAlertSymbol(s.sym)}
                    title="Set price alert"
                    color="var(--amber)" bg="rgba(251,191,36,0.1)" border="rgba(251,191,36,0.25)"
                  ><BellIcon /></IconButton>
                  {/* Quick trade — supports crypto, forex & commodities (OANDA) */}
                  <IconButton
                    onClick={() => goToTrade(s.sym)}
                    title="Quick trade"
                    color="var(--cyan)" bg="rgba(0,245,212,0.1)" border="rgba(0,245,212,0.25)"
                  ><BoltIcon /></IconButton>
                  <IconButton
                    onClick={() => removeSymbol(s.sym)}
                    title="Remove from watchlist"
                    color="var(--red)" bg="rgba(248,113,113,0.1)" border="rgba(248,113,113,0.25)"
                  ><CloseIcon /></IconButton>
                </div>

                {/* Symbol + Signal */}
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap', paddingRight:96 }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, background: up?'var(--green)':'var(--red)', boxShadow: up?'0 0 8px var(--green)':'0 0 8px var(--red)' }} />
                  <span style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>{s.sym}</span>
                  <SignalBadge signal={s.signal} confidence={s.confidence} />
                </div>

                {/* Price */}
                <div style={{
                  fontSize:22, fontWeight:700, marginBottom:4,
                  color: flash[s.sym] === 'up' ? 'var(--green)' : flash[s.sym] === 'down' ? 'var(--red)' : 'var(--text-primary)',
                  transition:'color .5s ease',
                }}>
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
                {['Symbole','Prix','24h %','H/L 24h','Volume','Signal IA','Actions'].map(h => (
                  <th key={h} style={{ textAlign:'left', padding:'14px 18px', fontSize:10, letterSpacing:'.15em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedStocks.map(s => {
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
                    <td style={{
                      padding:'14px 18px', fontSize:13, fontFamily:'JetBrains Mono,monospace',
                      color: flash[s.sym] === 'up' ? 'var(--green)' : flash[s.sym] === 'down' ? 'var(--red)' : 'var(--text-primary)',
                      transition:'color .5s ease',
                    }}>
                      ${parseFloat(s.price || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 })}
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:12, fontFamily:'JetBrains Mono,monospace', color: up?'var(--green)':'var(--red)', fontWeight:600 }}>
                      {up ? '▲' : '▼'} {Math.abs(s.change || 0).toFixed(2)}%
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
                      <span style={{ color:'var(--green)' }}>{s.high24h ? `$${parseFloat(s.high24h).toLocaleString('en-US',{maximumFractionDigits:4})}` : '—'}</span>
                      <span style={{ color:'var(--text-muted)', margin:'0 4px' }}>/</span>
                      <span style={{ color:'var(--red)' }}>{s.low24h ? `$${parseFloat(s.low24h).toLocaleString('en-US',{maximumFractionDigits:4})}` : '—'}</span>
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>
                      {s.volume || '—'}
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <SignalBadge signal={s.signal} confidence={s.confidence} />
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', gap:8 }}>
                        <IconButton
                          onClick={() => setAlertSymbol(s.sym)}
                          title="Set price alert"
                          color="var(--amber)" bg="rgba(251,191,36,0.1)" border="rgba(251,191,36,0.25)"
                        ><BellIcon size={12} /></IconButton>
                        {/* Quick trade — supports crypto, forex & commodities (OANDA) */}
                        <IconButton
                          onClick={() => goToTrade(s.sym)}
                          title="Quick trade"
                          color="var(--cyan)" bg="rgba(0,245,212,0.1)" border="rgba(0,245,212,0.25)"
                        ><BoltIcon size={12} /></IconButton>
                        <button onClick={() => removeSymbol(s.sym)} style={{
                          background:'rgba(248,113,113,0.08)', border:'1px solid rgba(248,113,113,0.2)',
                          color:'var(--red)', borderRadius:6, padding:'4px 10px',
                          fontSize:11, fontFamily:'JetBrains Mono,monospace', cursor:'pointer',
                        }}>Remove</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {alertSymbol && (
        <AlertModal
          symbol={alertSymbol}
          onClose={() => setAlertSymbol(null)}
          onCreated={() => setToast({ message: `Alert created for ${alertSymbol}`, type: 'success' })}
        />
      )}

      {toast && (
        <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes livePulse { 0%,100%{opacity:0.4; transform:scale(0.85)} 50%{opacity:1; transform:scale(1.15)} }
      `}</style>
    </>
  );
}