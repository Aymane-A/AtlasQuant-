/**
 * components/SignalModal.jsx — AtlasQuant AI
 * Signal Intelligence Modal — usable from AlphaEngine, Dashboard, Signals page.
 *
 * Usage:
 *   import SignalModal from '../components/SignalModal';
 *   <SignalModal signal={signal} onClose={() => setSelected(null)} />
 *
 * signal shape (all optional except symbol + signal):
 *   { symbol, signal, confidence, price, entry, stop_loss, take_profit,
 *     risk_reward, reasoning, indicators, asset_class, created_at }
 */

import { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area, ReferenceLine, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import api from '../services/api';

// ── Design tokens ─────────────────────────────────────────
const mono = { fontFamily:"'JetBrains Mono','Fira Code',monospace" };
const T    = {
  cyan:'#00f5d4', purple:'#a78bfa', amber:'#f59e0b',
  red:'#f43f5e',  green:'#34d399',  slate:'#64748b',
};

// ── Style injection ───────────────────────────────────────
function injectModalStyles() {
  if (document.getElementById('aq-signal-modal-css')) return;
  const s = document.createElement('style');
  s.id = 'aq-signal-modal-css';
  s.textContent = `
    @keyframes aq-modal-in  { from{opacity:0;transform:scale(.96) translateY(12px)} to{opacity:1;transform:scale(1) translateY(0)} }
    @keyframes aq-pulse-dot { 0%,100%{opacity:.4} 50%{opacity:1} }
    @keyframes aq-bar-grow  { from{width:0} to{width:var(--w)} }
    .aq-ind-card { transition: border-color .15s, background .15s; }
    .aq-ind-card:hover { border-color: rgba(0,245,212,0.25) !important; }
    .aq-modal-btn { transition: all .15s; }
    .aq-modal-btn:hover { opacity:.85; transform:translateY(-1px); }
    .aq-modal-overlay { backdrop-filter: blur(18px); }
  `;
  document.head.appendChild(s);
}

// ── Helpers ───────────────────────────────────────────────
function sideColor(sig) {
  return sig === 'BUY' ? T.green : sig === 'SELL' ? T.red : T.amber;
}

function assetIcon(ac) {
  return { Crypto:'🪙', Forex:'💱', Commodity:'🥇', Indices:'📈' }[ac] || '◈';
}

function fmtPrice(v, dp = 2) {
  if (v == null || isNaN(v)) return '—';
  return parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── ① Mini Price Chart ────────────────────────────────────
function MiniChart({ symbol, entry, stopLoss, takeProfit, currentPrice, isBuy, isForex, isCommodity }) {
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!symbol) return;
    const isOanda = isForex || isCommodity;
    const qs = isOanda ? '?exchangeId=oanda' : '';
    // OANDA instruments use underscore (EUR_USD), crypto strip slash+USDT (BTC)
    const sym = isOanda
      ? symbol.replace('/', '_').replace(/[^A-Z0-9_]/gi, '')
      : symbol.replace('/', '').replace(/USDT$/i, '').replace(/[^A-Z0-9]/gi, '');
    api.get(`/trading/ticker/${sym}${qs}`)
      .then(res => {
        if (res.data.candles?.length) setCandles(res.data.candles.slice(-40));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [symbol]);

  const color      = isBuy ? T.green : T.red;
  const dp         = isCommodity ? 2 : isForex ? 5 : (currentPrice > 100 ? 2 : 6);
  const priceRange = candles.length
    ? { min: Math.min(...candles.map(c => c.close)), max: Math.max(...candles.map(c => c.close)) }
    : null;

  // Extend Y domain to include SL/TP lines
  const domainMin = priceRange ? Math.min(priceRange.min, stopLoss || priceRange.min) * 0.998 : 'auto';
  const domainMax = priceRange ? Math.max(priceRange.max, takeProfit || priceRange.max) * 1.002 : 'auto';

  if (loading) return (
    <div style={{ height:220, display:'flex', alignItems:'center', justifyContent:'center', ...mono, fontSize:11, color:T.slate }}>
      Loading chart...
    </div>
  );

  return (
    <div style={{ height:220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={candles} margin={{ top:8, right:60, left:0, bottom:0 }}>
          <defs>
            <linearGradient id="sm-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity={0.18}/>
              <stop offset="100%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false}/>
          <XAxis dataKey="t" hide/>
          <YAxis hide domain={[domainMin, domainMax]}/>
          <Tooltip
            contentStyle={{ background:'rgba(3,7,18,0.97)', border:`1px solid ${color}30`, borderRadius:6, ...mono, fontSize:10 }}
            formatter={v => [fmtPrice(v, dp), 'Price']}
            labelFormatter={() => ''}
          />
          {/* SL line */}
          {stopLoss && (
            <ReferenceLine y={stopLoss} stroke={T.red} strokeDasharray="4 3" strokeWidth={1.5}
              label={{ value:`SL ${fmtPrice(stopLoss, dp)}`, position:'right', fill:T.red, fontSize:9, fontFamily:'JetBrains Mono,monospace' }}/>
          )}
          {/* TP line */}
          {takeProfit && (
            <ReferenceLine y={takeProfit} stroke={T.green} strokeDasharray="4 3" strokeWidth={1.5}
              label={{ value:`TP ${fmtPrice(takeProfit, dp)}`, position:'right', fill:T.green, fontSize:9, fontFamily:'JetBrains Mono,monospace' }}/>
          )}
          {/* Entry line */}
          {entry && (
            <ReferenceLine y={entry} stroke={T.cyan} strokeDasharray="2 2" strokeWidth={1}
              label={{ value:`Entry ${fmtPrice(entry, dp)}`, position:'right', fill:T.cyan, fontSize:9, fontFamily:'JetBrains Mono,monospace' }}/>
          )}
          <Area type="monotone" dataKey="close" stroke={color} strokeWidth={1.5}
            fill="url(#sm-grad)" dot={false}
            activeDot={{ r:3, fill:color, stroke:'#080f1e', strokeWidth:2 }}/>
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── ② Indicator Cards ─────────────────────────────────────
function IndicatorCards({ indicators, signal }) {
  const ind = indicators || {};
  const rsi = ind.rsi?.value;
  const isBuy = signal === 'BUY';

  const cards = [
    {
      label: 'RSI',
      value: rsi != null ? rsi.toFixed(1) : '—',
      sub:   rsi != null ? (rsi < 35 ? 'Oversold' : rsi > 65 ? 'Overbought' : 'Neutral') : '—',
      color: rsi != null ? (rsi < 35 ? T.green : rsi > 65 ? T.red : T.slate) : T.slate,
    },
    {
      label: 'MACD',
      value: ind.macd?.crossover && ind.macd.crossover !== 'NONE'
        ? ind.macd.crossover.replace(/_/g,' ').replace('CROSS','×')
        : (ind.macd?.trend || '—'),
      sub:   ind.macd?.histogram != null ? `Hist: ${parseFloat(ind.macd.histogram).toFixed(4)}` : '',
      color: ind.macd?.trend === 'BUY' ? T.green : ind.macd?.trend === 'SELL' ? T.red : T.slate,
    },
    {
      label: 'Bollinger',
      value: ind.bollinger?.signal?.replace(/_/g,' ') || '—',
      sub:   ind.bollinger?.bandwidth != null ? `BW: ${parseFloat(ind.bollinger.bandwidth).toFixed(2)}` : '',
      color: ind.bollinger?.signal === 'OVERSOLD' ? T.green : ind.bollinger?.signal === 'OVERBOUGHT' ? T.red : T.slate,
    },
    {
      label: 'EMA',
      value: ind.ema?.crossover && ind.ema.crossover !== 'NONE'
        ? ind.ema.crossover.replace(/_/g,' ')
        : (ind.ema?.signal || '—'),
      sub:   ind.ema?.ema20 != null ? `20: ${parseFloat(ind.ema.ema20).toFixed(4)}` : '',
      color: ind.ema?.signal === 'BUY' ? T.green : ind.ema?.signal === 'SELL' ? T.red : T.slate,
    },
    {
      label: 'Volume',
      value: ind.volume?.ratio != null ? `×${parseFloat(ind.volume.ratio).toFixed(2)}` : '—',
      sub:   ind.volume?.signal?.replace(/_/g,' ') || '',
      color: ind.volume?.ratio >= 1.5 ? T.cyan : ind.volume?.ratio >= 1.0 ? T.slate : T.amber,
    },
  ];

  return (
    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
      {cards.map(c => (
        <div key={c.label} className="aq-ind-card" style={{
          flex:1, minWidth:90, background:'rgba(255,255,255,0.02)',
          border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px',
        }}>
          <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:6, textTransform:'uppercase', letterSpacing:'.1em' }}>{c.label}</div>
          <div style={{ ...mono, fontSize:13, fontWeight:800, color:c.color, marginBottom:4 }}>{c.value}</div>
          <div style={{ ...mono, fontSize:9, color:T.slate }}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ── ③ AI Reasoning ───────────────────────────────────────
function AiReasoning({ reasoning, signal, confidence }) {
  // Parse the raw reasoning string into bullet points.
  // Each sentence that starts with a positive indicator keyword gets a ✔,
  // neutral ones get ◈, and "not enough / weak" sentences get ⚠.
  const sentences = (reasoning || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  const getBulletStyle = (s) => {
    const lower = s.toLowerCase();
    const positive = ['oversold','bullish','above','increased','buy','cross','support','golden'];
    const negative = ['overbought','bearish','below','sell','death cross','resistance'];
    const weak     = ['not enough','weak','low','neutral','hold'];
    if (positive.some(k => lower.includes(k))) return { icon:'✔', color:T.green };
    if (negative.some(k => lower.includes(k))) return { icon:'✘', color:T.red   };
    if (weak.some(k => lower.includes(k)))      return { icon:'⚠', color:T.amber };
    return { icon:'◈', color:T.slate };
  };

  const color = sideColor(signal);

  return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(0,245,212,0.1)', borderRadius:12, padding:18 }}>
      <div style={{ ...mono, fontSize:10, color:T.cyan, marginBottom:12, letterSpacing:'.1em' }}>
        ⚡ ATLAS AI — WHY THIS {signal}
      </div>
      {sentences.length === 0 ? (
        <div style={{ ...mono, fontSize:11, color:T.slate }}>No reasoning available.</div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {sentences.map((s, i) => {
            const { icon, color: c } = getBulletStyle(s);
            return (
              <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                <span style={{ ...mono, fontSize:11, color:c, flexShrink:0, marginTop:1 }}>{icon}</span>
                <span style={{ ...mono, fontSize:11, color:'var(--text)', lineHeight:1.6 }}>{s}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── ④ Trade Setup ─────────────────────────────────────────
function TradeSetup({ entry, stopLoss, takeProfit, riskReward, isBuy, dp }) {
  const cells = [
    { label:'Entry',       value: entry      ? fmtPrice(entry, dp)      : '—', color:'var(--text)' },
    { label:'Stop Loss',   value: stopLoss   ? fmtPrice(stopLoss, dp)   : '—', color:T.red        },
    { label:'Take Profit', value: takeProfit ? fmtPrice(takeProfit, dp) : '—', color:T.green      },
    { label:'Risk:Reward', value: riskReward || '—',                            color:T.cyan       },
  ];
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
      {cells.map(c => (
        <div key={c.label} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 16px', textAlign:'center' }}>
          <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:8, textTransform:'uppercase', letterSpacing:'.1em' }}>{c.label}</div>
          <div style={{ ...mono, fontSize:15, fontWeight:800, color:c.color }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── ⑤ AI Confidence Breakdown ────────────────────────────
// The star feature: derived from real indicator values instead of hardcoded %.
// Each dimension is scored from the actual signal indicators so the breakdown
// is unique per signal, not a generic display.
function ConfidenceBreakdown({ confidence, indicators, signal }) {
  const ind  = indicators || {};
  const rsi  = ind.rsi?.value   || 50;
  const volR = ind.volume?.ratio || 1;
  const macdCross = ind.macd?.crossover || 'NONE';
  const emaCross  = ind.ema?.crossover  || 'NONE';
  const isBuy = signal === 'BUY';

  // Score each dimension (0-100) from real indicator data
  const trend = (() => {
    let s = 50;
    if (isBuy  && (emaCross === 'GOLDEN_CROSS' || ind.ema?.signal === 'BUY'))  s += 25;
    if (!isBuy && (emaCross === 'DEATH_CROSS'  || ind.ema?.signal === 'SELL')) s += 25;
    if (ind.bollinger?.signal === 'OVERSOLD'   && isBuy)  s += 15;
    if (ind.bollinger?.signal === 'OVERBOUGHT' && !isBuy) s += 15;
    return Math.min(98, s);
  })();

  const momentum = (() => {
    let s = 50;
    if (isBuy  && rsi < 40) s += 25;
    if (!isBuy && rsi > 60) s += 25;
    if (isBuy  && (macdCross === 'BULLISH_CROSS')) s += 20;
    if (!isBuy && (macdCross === 'BEARISH_CROSS')) s += 20;
    return Math.min(98, s);
  })();

  const volume = Math.min(98, Math.round(50 + (volR - 1) * 40));

  const volatility = (() => {
    const bw = parseFloat(ind.bollinger?.bandwidth || 0);
    if (bw === 0) return 70;
    return Math.min(95, Math.max(40, Math.round(100 - bw * 10)));
  })();

  const pattern = (() => {
    let s = 50;
    if (macdCross !== 'NONE') s += 20;
    if (emaCross  !== 'NONE') s += 20;
    if (ind.fibonacci?.trend === signal) s += 10;
    return Math.min(98, s);
  })();

  // News/sentiment: proxy from confidence level itself
  // Guard: confidence may arrive as string '78%' from older callers
  const confNum    = parseInt(String(confidence).replace('%',''), 10) || 0;
  const newsImpact = Math.round(confNum * 0.85);

  const dims = [
    { label:'Trend Analysis',      value:trend,       icon:'📈' },
    { label:'Momentum',            value:momentum,    icon:'⚡' },
    { label:'Volume',              value:volume,      icon:'📊' },
    { label:'Volatility',          value:volatility,  icon:'🌊' },
    { label:'Pattern Recognition', value:pattern,     icon:'🔮' },
    { label:'News Impact',         value:newsImpact,  icon:'📰' },
  ];

  const overall = confNum || Math.round(dims.reduce((s,d) => s + d.value, 0) / dims.length);

  return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:12, padding:18 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div style={{ ...mono, fontSize:10, color:T.slate, textTransform:'uppercase', letterSpacing:'.1em' }}>
          AI Confidence Breakdown
        </div>
        <div style={{ ...mono, fontSize:22, fontWeight:800, color: overall >= 75 ? T.green : overall >= 55 ? T.cyan : T.amber }}>
          {overall}%
        </div>
      </div>
      {/* Overall bar */}
      <div style={{ height:6, background:'rgba(255,255,255,0.06)', borderRadius:3, marginBottom:18, overflow:'hidden' }}>
        <div style={{
          height:'100%', width:`${overall}%`, borderRadius:3,
          background:`linear-gradient(90deg, ${T.cyan}, ${overall >= 75 ? T.green : T.cyan})`,
          transition:'width .6s ease',
        }}/>
      </div>
      {/* Dimension breakdown */}
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {dims.map(d => {
          const c = d.value >= 75 ? T.green : d.value >= 55 ? T.cyan : d.value >= 40 ? T.amber : T.red;
          return (
            <div key={d.label} style={{ display:'flex', alignItems:'center', gap:12 }}>
              <span style={{ fontSize:13, flexShrink:0 }}>{d.icon}</span>
              <div style={{ ...mono, fontSize:10, color:'var(--text)', width:160, flexShrink:0 }}>{d.label}</div>
              <div style={{ flex:1, height:4, background:'rgba(255,255,255,0.06)', borderRadius:2, overflow:'hidden' }}>
                <div style={{
                  height:'100%', width:`${d.value}%`, borderRadius:2, background:c,
                  transition:'width .5s ease',
                }}/>
              </div>
              <div style={{ ...mono, fontSize:11, fontWeight:800, color:c, width:36, textAlign:'right' }}>{d.value}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ⑥ Risk Status ────────────────────────────────────────
function RiskStatus({ indicators, signal, confidence }) {
  const ind     = indicators || {};
  const rsi     = ind.rsi?.value || 50;
  const volR    = ind.volume?.ratio || 1;
  const bw      = parseFloat(ind.bollinger?.bandwidth || 0);
  const isBuy   = signal === 'BUY';

  const riskLevel = confidence >= 80 && volR >= 1.3 ? 'Low'
    : confidence >= 65 ? 'Medium' : 'High';
  const riskColor = { Low:T.green, Medium:T.amber, High:T.red }[riskLevel];

  const volatility = bw > 5 ? 'High' : bw > 2 ? 'Medium' : 'Low';
  const trend      = isBuy ? 'Bullish' : signal === 'SELL' ? 'Bearish' : 'Neutral';
  const trendColor = { Bullish:T.green, Bearish:T.red, Neutral:T.slate }[trend];

  const items = [
    { label:'Risk',       value:riskLevel,  color:riskColor  },
    { label:'Volatility', value:volatility, color: volatility === 'High' ? T.red : volatility === 'Medium' ? T.amber : T.green },
    { label:'Trend',      value:trend,      color:trendColor  },
    { label:'Volume',     value: volR >= 1.5 ? 'High' : volR >= 1.0 ? 'Normal' : 'Low',
      color: volR >= 1.5 ? T.cyan : volR >= 1.0 ? T.slate : T.amber },
  ];

  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
      {items.map(item => (
        <div key={item.label} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px', textAlign:'center' }}>
          <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:6, textTransform:'uppercase', letterSpacing:'.1em' }}>{item.label}</div>
          <div style={{ ...mono, fontSize:13, fontWeight:800, color:item.color }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────
export default function SignalModal({ signal: sig, onClose }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    injectModalStyles();
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!sig) return null;

  const isBuy       = sig.signal === 'BUY';
  const color       = sideColor(sig.signal);
  const isForex     = ['Forex'].includes(sig.asset_class);
  const isCommodity = ['Commodity'].includes(sig.asset_class);
  const dp          = isCommodity ? 2 : isForex ? 5 : (parseFloat(sig.price) > 100 ? 2 : 6);

  // Navigate to Trading page with the symbol pre-filled
  const handleTrade = () => {
    const rawSym = (sig.symbol || '')
      .replace('/', '')
      .replace(/USDT$/, '')
      .toUpperCase();
    window.location.href = `/trading?symbol=${encodeURIComponent(rawSym)}`;
  };

  const handleAlert = async () => {
    if (!sig.price) return;
    try {
      await api.post('/alerts', {
        symbol:    sig.symbol, type:'typePrice',
        condition: isBuy ? 'above' : 'below',
        value:     sig.take_profit || sig.price,
        channels:  ['email'],
      });
      alert('Alert created!');
    } catch { alert('Could not create alert'); }
  };

  const handleWatchlist = async () => {
    try {
      await api.post('/watchlist', { symbol: sig.symbol });
      alert(`${sig.symbol} added to watchlist`);
    } catch { alert('Could not add to watchlist'); }
  };

  return (
    <div
      ref={overlayRef}
      className="aq-modal-overlay"
      onClick={e => e.target === overlayRef.current && onClose()}
      style={{
        position:'fixed', inset:0,
        background:'rgba(0,0,0,0.85)',
        zIndex:800,
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:20,
        overflowY:'auto',
      }}
    >
      <div style={{
        width:'100%', maxWidth:920,
        background:'#080f1e',
        border:`1px solid ${color}30`,
        borderRadius:20,
        boxShadow:`0 0 80px ${color}10, 0 40px 80px rgba(0,0,0,0.8)`,
        animation:'aq-modal-in .25s ease',
        overflow:'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'20px 28px',
          background:`linear-gradient(135deg, ${color}08, transparent)`,
          borderBottom:'1px solid rgba(255,255,255,0.05)',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:14 }}>
            <span style={{ fontSize:20 }}>{assetIcon(sig.asset_class)}</span>
            <div>
              <div style={{ fontSize:22, fontWeight:900, color:'var(--text)', letterSpacing:'-0.5px' }}>{sig.symbol}</div>
              <div style={{ ...mono, fontSize:10, color:T.slate, marginTop:2 }}>
                {sig.asset_class || 'Crypto'} · {timeAgo(sig.created_at)}
              </div>
            </div>
            <div style={{
              ...mono, fontSize:14, fontWeight:800, padding:'6px 16px',
              borderRadius:8, background:`${color}18`, color,
              border:`1px solid ${color}35`,
            }}>
              {sig.signal}
            </div>
            <div style={{
              display:'flex', alignItems:'center', gap:6,
              background:'rgba(255,255,255,0.04)', border:'1px solid var(--border)',
              borderRadius:8, padding:'6px 14px',
            }}>
              <div style={{ ...mono, fontSize:12, color:T.slate }}>AI Confidence</div>
              <div style={{ ...mono, fontSize:16, fontWeight:900, color: (parseInt(sig.confidence)||0) >= 75 ? T.green : T.amber }}>
                {parseInt(sig.confidence) || sig.conf || '—'}%
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            width:34, height:34, borderRadius:'50%', border:'1px solid var(--border)',
            background:'rgba(255,255,255,0.04)', color:T.slate,
            fontSize:16, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
          }}>✕</button>
        </div>

        {/* ── Body ── */}
        <div style={{ padding:'24px 28px', display:'flex', flexDirection:'column', gap:20 }}>

          {/* ① Chart */}
          <div style={{ background:'rgba(255,255,255,0.01)', border:'1px solid var(--border)', borderRadius:12, padding:'16px 12px' }}>
            <div style={{ ...mono, fontSize:9, color:T.slate, textTransform:'uppercase', letterSpacing:'.12em', marginBottom:10, paddingLeft:8 }}>
              Price Chart · Entry / SL / TP
            </div>
            <MiniChart
              symbol={sig.symbol}
              entry={parseFloat(sig.entry || sig.price)}
              stopLoss={parseFloat(sig.stop_loss)}
              takeProfit={parseFloat(sig.take_profit)}
              currentPrice={parseFloat(sig.price)}
              isBuy={isBuy} isForex={isForex} isCommodity={isCommodity}
            />
          </div>

          {/* ② Indicator Cards */}
          <div>
            <div style={{ ...mono, fontSize:9, color:T.slate, textTransform:'uppercase', letterSpacing:'.12em', marginBottom:10 }}>
              Technical Indicators
            </div>
            <IndicatorCards indicators={sig.indicators} signal={sig.signal} />
          </div>

          {/* ③ AI Reasoning */}
          <AiReasoning reasoning={sig.reasoning} signal={sig.signal} confidence={sig.confidence} />

          {/* ④ Trade Setup */}
          <div>
            <div style={{ ...mono, fontSize:9, color:T.slate, textTransform:'uppercase', letterSpacing:'.12em', marginBottom:10 }}>
              Trade Setup
            </div>
            <TradeSetup
              entry={sig.entry || sig.price} stopLoss={sig.stop_loss}
              takeProfit={sig.take_profit} riskReward={sig.risk_reward}
              isBuy={isBuy} dp={dp}
            />
          </div>

          {/* ⑤ Confidence Breakdown */}
          <ConfidenceBreakdown
            confidence={sig.confidence} indicators={sig.indicators} signal={sig.signal}
          />

          {/* ⑥ Risk Status */}
          <div>
            <div style={{ ...mono, fontSize:9, color:T.slate, textTransform:'uppercase', letterSpacing:'.12em', marginBottom:10 }}>
              Risk Assessment
            </div>
            <RiskStatus indicators={sig.indicators} signal={sig.signal} confidence={sig.confidence} />
          </div>

          {/* ⑦ Action Buttons */}
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', paddingTop:4 }}>
            <button className="aq-modal-btn" onClick={handleTrade} style={{
              flex:2, minWidth:160, padding:'14px 0', borderRadius:11, cursor:'pointer',
              border:`1px solid ${color}50`, background:`${color}15`, color,
              fontFamily:'Syne,sans-serif', fontSize:15, fontWeight:900, letterSpacing:'.04em',
            }}>
              🚀 Trade this Signal
            </button>
            <button className="aq-modal-btn" onClick={handleWatchlist} style={{
              flex:1, padding:'14px 0', borderRadius:11, cursor:'pointer',
              border:'1px solid var(--border)', background:'rgba(255,255,255,0.03)', color:T.slate,
              fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700,
            }}>
              ⭐ Watchlist
            </button>
            <button className="aq-modal-btn" onClick={handleAlert} style={{
              flex:1, padding:'14px 0', borderRadius:11, cursor:'pointer',
              border:'1px solid rgba(0,245,212,0.25)', background:'rgba(0,245,212,0.06)', color:T.cyan,
              fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700,
            }}>
              🔔 Alert
            </button>
            <button className="aq-modal-btn" onClick={() => {
              const text = `${sig.symbol} ${sig.signal} — ${sig.confidence}% confidence\nEntry: ${sig.entry || sig.price} | SL: ${sig.stop_loss || '—'} | TP: ${sig.take_profit || '—'}\nAtlasQuant AI`;
              navigator.clipboard?.writeText(text).then(() => alert('Copied to clipboard'));
            }} style={{
              flex:1, padding:'14px 0', borderRadius:11, cursor:'pointer',
              border:'1px solid var(--border)', background:'rgba(255,255,255,0.03)', color:T.slate,
              fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700,
            }}>
              📤 Share
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}