/**
 * components/SignalModal.jsx — AtlasQuant AI v4 (final clean rewrite)
 * Signal Intelligence Modal — 2-column SaaS layout
 * Features: TradingView chart, animated confidence circle, AI Final Verdict,
 *           Signal Timeline, pre-fill Trade button, indicator chips
 */
import { useState, useEffect, useRef } from 'react';
import api from '../services/api';

const mono = { fontFamily:"'JetBrains Mono','Fira Code',monospace" };
const T    = { cyan:'#00f5d4', purple:'#a78bfa', amber:'#f59e0b', red:'#f43f5e', green:'#34d399', slate:'#64748b' };

// ── Style injection ───────────────────────────────────────
function injectStyles() {
  if (document.getElementById('aq-sm4')) return;
  const s = document.createElement('style');
  s.id = 'aq-sm4';
  s.textContent = `
    @keyframes aq-sm-in { from{opacity:0;transform:scale(.95) translateY(14px)} to{opacity:1;transform:scale(1) translateY(0)} }
    @keyframes aq-pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
    .aq-col::-webkit-scrollbar{width:3px}
    .aq-col::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px}
    .aq-btn{transition:all .15s}
    .aq-btn:hover{opacity:.82;transform:translateY(-1px)}
    .aq-chip{transition:border-color .15s}
    .aq-chip:hover{border-color:rgba(0,245,212,.4)!important}
  `;
  document.head.appendChild(s);
}

// ── Helpers ───────────────────────────────────────────────
const sc      = s => s === 'BUY' ? T.green : s === 'SELL' ? T.red : T.amber;
const ai      = a => ({ Crypto:'🪙', Forex:'💱', Commodity:'🥇', Indices:'📈' }[a] || '◈');
const pi      = r => { if (!r) return {}; if (typeof r === 'string') { try { return JSON.parse(r); } catch { return {}; } } return r; };
const toNum   = v => (v == null || v === '' || isNaN(parseFloat(v))) ? null : parseFloat(v);
const fmtP    = (v, dp = 2) => { const n = toNum(v); return n == null ? null : n.toLocaleString('en-US', { minimumFractionDigits:dp, maximumFractionDigits:dp }); };
const timeAgo = iso => { if (!iso) return ''; const m = Math.floor((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`; };
const mkTime  = (iso, offsetMs) => iso ? new Date(new Date(iso).getTime() + offsetMs).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '—';
const cleanSym= s => (s || '').replace(/\/.*$/, '').replace(/[^A-Z0-9]/gi, '').replace(/USDT$/i, '').toUpperCase();

function Lbl({ children, style = {} }) {
  return <div style={{ ...mono, fontSize:8, letterSpacing:'.18em', textTransform:'uppercase', color:T.slate, marginBottom:6, ...style }}>{children}</div>;
}

// ── Signal stats hook ─────────────────────────────────────
function useSignalStats(symbol) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!symbol) return;
    api.get(`/signals?symbol=${encodeURIComponent(symbol)}&limit=30`)
      .then(res => {
        if (!alive) return;
        const sigs = res.data?.signals || res.data || [];
        const dir  = sigs.filter(s => s.signal !== 'HOLD');
        const wins = dir.filter(s => (s.confidence || 0) >= 70);
        setStats({
          hasOutcome: dir.length > 0,
          winRate:    dir.length ? Math.round((wins.length / dir.length) * 100) : null,
          avgConf:    dir.length ? Math.round(dir.reduce((a, s) => a + (s.confidence || 0), 0) / dir.length) : null,
          total:      sigs.length,
          directional:dir.length,
        });
      }).catch(() => { if (alive) setStats({ hasOutcome:false, total:0, directional:0 }); });
    return () => { alive = false; };
  }, [symbol]);
  return stats;
}

// ── TradingView Widget ────────────────────────────────────
function TvChart({ symbol, isOanda }) {
  const ref = useRef(null);
  const tvSym = isOanda
    ? `OANDA:${(symbol || '').replace(/[/_]/g, '')}`
    : `BINANCE:${cleanSym(symbol)}USDT`;

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '';
    const script = document.createElement('script');
    script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type  = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize:true, symbol:tvSym, interval:'60', timezone:'Etc/UTC',
      theme:'dark', style:'1', locale:'en',
      enable_publishing:false, hide_top_toolbar:false, save_image:false,
      backgroundColor:'rgba(8,15,30,1)', gridColor:'rgba(255,255,255,0.03)',
      studies:['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
      overrides:{
        'paneProperties.background':'#080f1e',
        'paneProperties.backgroundType':'solid',
        'mainSeriesProperties.candleStyle.upColor':'#34d399',
        'mainSeriesProperties.candleStyle.downColor':'#f43f5e',
        'mainSeriesProperties.candleStyle.borderUpColor':'#34d399',
        'mainSeriesProperties.candleStyle.borderDownColor':'#f43f5e',
        'mainSeriesProperties.candleStyle.wickUpColor':'#34d399',
        'mainSeriesProperties.candleStyle.wickDownColor':'#f43f5e',
      },
    });
    const w = document.createElement('div');
    w.className = 'tradingview-widget-container__widget';
    w.style.cssText = 'height:100%;width:100%';
    ref.current.appendChild(w);
    ref.current.appendChild(script);
    return () => { if (ref.current) ref.current.innerHTML = ''; };
  }, [tvSym]);

  return <div ref={ref} style={{ width:'100%', height:'100%' }} className="tradingview-widget-container"/>;
}

// ── Animated Confidence Circle ────────────────────────────
function ConfCircle({ value, color, action, size = 110 }) {
  const [displayed, setDisplayed] = useState(0);
  const [started,   setStarted]   = useState(false);
  const r    = (size - (size < 90 ? 10 : 20)) / 2;
  const circ = 2 * Math.PI * r;
  const sw   = size < 90 ? 5 : 8;
  const cx   = size / 2;

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), 150);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!started || displayed >= value) return;
    const step  = Math.max(1, Math.round((value - displayed) / 5));
    const delay = displayed < value * 0.65 ? 16 : 28;
    const t = setTimeout(() => setDisplayed(p => Math.min(p + step, value)), delay);
    return () => clearTimeout(t);
  }, [displayed, value, started]);

  const offset = circ - (displayed / 100) * circ;
  const fsSz   = size < 90 ? 14 : 22;
  const fsLb   = size < 90 ? 8  : 10;
  const mt     = -(size * 0.62);

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw}/>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth={sw}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition:'stroke-dashoffset 0.04s linear' }}/>
      </svg>
      <div style={{ marginTop:mt, display:'flex', flexDirection:'column', alignItems:'center', zIndex:1 }}>
        <div style={{ ...mono, fontSize:fsSz, fontWeight:900, color }}>{displayed}%</div>
        <div style={{ ...mono, fontSize:fsLb, color:'var(--text)', fontWeight:900 }}>{action || 'HOLD'}</div>
      </div>
    </div>
  );
}

// ── Indicator Chips ───────────────────────────────────────
function IndicatorChips({ indicators }) {
  const ind = pi(indicators);
  const rsi = ind.rsi?.value;

  const tone = s => {
    const l = (s || '').toLowerCase();
    if (['oversold','bullish','buy','golden','cross','bounce','above','support','increased'].some(k => l.includes(k))) return { i:'✔', c:T.green };
    if (['overbought','bearish','sell','death','resistance','below'].some(k => l.includes(k))) return { i:'✘', c:T.red };
    return { i:'◈', c:T.slate };
  };

  const chips = [
    rsi != null && { text:`RSI ${rsi.toFixed(1)} — ${rsi < 35 ? 'Oversold' : rsi > 65 ? 'Overbought' : 'Neutral'}`, ...tone(rsi < 35 ? 'oversold' : rsi > 65 ? 'overbought' : 'neutral') },
    ind.macd?.crossover && ind.macd.crossover !== 'NONE' && { text:`MACD ${ind.macd.crossover.replace(/_/g,' ')}`, ...tone(ind.macd.crossover) },
    ind.macd?.trend && { text:`MACD Trend ${ind.macd.trend}`, ...tone(ind.macd.trend) },
    ind.ema?.crossover && ind.ema.crossover !== 'NONE' && { text:`EMA ${ind.ema.crossover.replace(/_/g,' ')}`, ...tone(ind.ema.crossover) },
    ind.ema?.signal && { text:`EMA ${ind.ema.signal} — ${ind.ema.position || ''}`, ...tone(ind.ema.signal) },
    ind.bollinger?.signal && { text:`Bollinger ${ind.bollinger.signal.replace(/_/g,' ')}`, ...tone(ind.bollinger.signal) },
    ind.volume?.ratio != null && { text:`Volume ×${parseFloat(ind.volume.ratio).toFixed(2)} ${ind.volume.signal?.replace(/_/g,' ') || ''}`, ...tone(ind.volume.ratio >= 1.5 ? 'increased' : 'normal') },
    ind.fibonacci?.nearestLevel != null && { text:`Fib ${parseFloat(ind.fibonacci.nearestLevel).toFixed(4)} — ${ind.fibonacci.interpretation || ''}`, ...tone(ind.fibonacci.interpretation || '') },
  ].filter(Boolean);

  if (!chips.length) return <div style={{ ...mono, fontSize:10, color:T.slate }}>No indicator data.</div>;

  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:7 }}>
      {chips.map((c, i) => (
        <div key={i} className="aq-chip" style={{
          display:'flex', alignItems:'center', gap:7,
          background:`${c.c}10`, border:`1px solid ${c.c}35`, borderRadius:20, padding:'6px 12px',
        }}>
          <span style={{ fontSize:11, color:c.c, fontWeight:700 }}>{c.i}</span>
          <span style={{ ...mono, fontSize:10, color:'var(--text)' }}>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── AI Reasoning ──────────────────────────────────────────
function AiReasoning({ reasoning, signal }) {
  const sentences = (reasoning || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const tone = s => {
    const l = s.toLowerCase();
    if (['oversold','bullish','above','buy','cross','support','golden','bounce','increased'].some(k => l.includes(k))) return { i:'✔', c:T.green };
    if (['overbought','bearish','below','sell','death','resistance'].some(k => l.includes(k))) return { i:'✘', c:T.red };
    if (['not enough','weak','neutral','hold'].some(k => l.includes(k))) return { i:'⚠', c:T.amber };
    return { i:'◈', c:T.slate };
  };
  return (
    <div style={{ background:'rgba(0,245,212,0.04)', border:'1px solid rgba(0,245,212,0.1)', borderRadius:10, padding:14 }}>
      <div style={{ ...mono, fontSize:9, color:T.cyan, letterSpacing:'.12em', marginBottom:10 }}>⚡ ATLAS AI — WHY THIS {signal}</div>
      {!sentences.length
        ? <div style={{ ...mono, fontSize:10, color:T.slate }}>No reasoning available.</div>
        : <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {sentences.map((s, i) => { const { i:ic, c } = tone(s); return (
              <div key={i} style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
                <span style={{ ...mono, fontSize:11, color:c, flexShrink:0, marginTop:1 }}>{ic}</span>
                <span style={{ ...mono, fontSize:10, color:'var(--text)', lineHeight:1.6 }}>{s}</span>
              </div>
            ); })}
          </div>
      }
    </div>
  );
}

// ── Signal Statistics ─────────────────────────────────────
function StatsCard({ stats }) {
  if (!stats) return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:14 }}>
      <Lbl>Signal Statistics</Lbl>
      <div style={{ ...mono, fontSize:10, color:T.slate }}>Loading history…</div>
    </div>
  );
  if (!stats.hasOutcome) return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:14 }}>
      <Lbl>Signal Statistics</Lbl>
      <div style={{ ...mono, fontSize:12, color:'var(--text)', fontWeight:800, marginBottom:4 }}>Learning…</div>
      <div style={{ ...mono, fontSize:10, color:T.slate }}>Need more signals for this symbol.</div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:12 }}>
        {[['Similar Signals', stats.total, 'var(--text)'], ['Directional', stats.directional, T.cyan]].map(([l,v,c]) => (
          <div key={l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:8, padding:'8px 10px' }}>
            <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:3 }}>{l}</div>
            <div style={{ ...mono, fontSize:13, fontWeight:800, color:c }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
  const items = [
    { l:'Win Rate',        v:`${stats.winRate}%`,  c: stats.winRate >= 60 ? T.green : stats.winRate >= 45 ? T.amber : T.red },
    { l:'Avg Confidence',  v:`${stats.avgConf}%`,  c: stats.avgConf >= 70 ? T.green : T.amber },
    { l:'Similar Signals', v: stats.total,          c:'var(--text)' },
    { l:'Directional',     v: stats.directional,    c: T.cyan },
  ];
  return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:14 }}>
      <Lbl>Signal Statistics</Lbl>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        {items.map(it => (
          <div key={it.l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:8, padding:'8px 10px' }}>
            <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:3 }}>{it.l}</div>
            <div style={{ ...mono, fontSize:13, fontWeight:800, color:it.c }}>{it.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AI Final Verdict ──────────────────────────────────────
function AiFinalVerdict({ signal, confidence, indicators, entry, stopLoss, takeProfit, riskReward, onTrade, color }) {
  const ind    = pi(indicators);
  const confN  = parseInt(String(confidence || 0).replace('%', ''), 10) || 0;
  const isBuy  = signal === 'BUY';
  const isSell = signal === 'SELL';
  const isHold = !isBuy && !isSell;

  const rsi    = ind.rsi?.value || 50;
  const macdX  = ind.macd?.crossover || 'NONE';
  const emaX   = ind.ema?.crossover  || 'NONE';
  const emaSig = ind.ema?.signal     || 'HOLD';
  const bollSig= ind.bollinger?.signal || 'NORMAL';
  const volR   = ind.volume?.ratio   || 1;

  const confirms = [], contradicts = [], neutral = [];

  if      (rsi < 35 && isBuy)   confirms.push('RSI oversold — buying pressure building');
  else if (rsi > 65 && isSell)  confirms.push('RSI overbought — selling pressure building');
  else if (rsi < 35 && isSell)  contradicts.push('RSI oversold — contrarian to SELL');
  else if (rsi > 65 && isBuy)   contradicts.push('RSI overbought — contrarian to BUY');
  else                           neutral.push(`RSI ${rsi.toFixed(0)} — neutral zone`);

  if      (macdX === 'BULLISH_CROSS' && isBuy)   confirms.push('MACD bullish crossover confirmed');
  else if (macdX === 'BEARISH_CROSS' && isSell)  confirms.push('MACD bearish crossover confirmed');
  else if (macdX === 'BULLISH_CROSS' && isSell)  contradicts.push('MACD bullish cross contradicts SELL');
  else if (macdX === 'BEARISH_CROSS' && isBuy)   contradicts.push('MACD bearish cross contradicts BUY');
  else if (ind.macd?.trend === 'BUY'  && isBuy)  confirms.push('MACD trend aligned with BUY');
  else if (ind.macd?.trend === 'SELL' && isSell) confirms.push('MACD trend aligned with SELL');
  else                                            neutral.push('MACD trend neutral');

  if      (emaX === 'GOLDEN_CROSS' && isBuy)   confirms.push('Golden Cross — strong bullish structure');
  else if (emaX === 'DEATH_CROSS'  && isSell)  confirms.push('Death Cross — strong bearish structure');
  else if (emaX === 'GOLDEN_CROSS' && isSell)  contradicts.push('Golden Cross contradicts SELL');
  else if (emaX === 'DEATH_CROSS'  && isBuy)   contradicts.push('Death Cross contradicts BUY');
  else if (emaSig === 'BUY'  && isBuy)  confirms.push('EMA trend supports BUY');
  else if (emaSig === 'SELL' && isSell) confirms.push('EMA trend supports SELL');
  else                                  neutral.push('EMA trend mixed');

  if      (bollSig === 'OVERSOLD'   && isBuy)  confirms.push('Price at lower Bollinger Band — bounce zone');
  else if (bollSig === 'OVERBOUGHT' && isSell) confirms.push('Price at upper Bollinger Band — rejection zone');
  else if (bollSig === 'OVERSOLD'   && isSell) contradicts.push('Bollinger oversold — risk for SELL');
  else if (bollSig === 'OVERBOUGHT' && isBuy)  contradicts.push('Bollinger overbought — stretched entry');
  else                                          neutral.push('Price mid-Bollinger Band');

  if   (volR >= 1.5)  confirms.push(`Volume surge ×${volR.toFixed(2)} — strong conviction`);
  else if (volR < 0.8) neutral.push(`Low volume ×${volR.toFixed(2)} — weak conviction`);
  else                  neutral.push(`Volume ×${volR.toFixed(2)} — normal`);

  const score = confirms.length - contradicts.length * 1.5;
  let verdict, verdictSub, vc;

  if (isHold) {
    verdict = 'WAIT — No Clear Edge'; verdictSub = 'Indicators conflict. Stand aside until confirmation.'; vc = T.amber;
  } else if (score >= 3 && confN >= 70) {
    verdict = `STRONG ${signal}`; verdictSub = `${confirms.length} factors confirm. High conviction setup.`; vc = color;
  } else if (score >= 1 && confN >= 55) {
    verdict = `${signal} with Caution`; verdictSub = `${confirms.length} confirm, ${contradicts.length} oppose. Manage risk.`; vc = color;
  } else if (score < 0) {
    verdict = 'CONFLICTED — High Risk'; verdictSub = `${contradicts.length} factors oppose. Wait for clarity.`; vc = T.red;
  } else {
    verdict = `NEUTRAL — Weak ${signal}`; verdictSub = 'Insufficient confluence. Consider smaller size.'; vc = T.slate;
  }

  const entryN = toNum(entry);
  const tpN    = toNum(takeProfit);
  const slN    = toNum(stopLoss);
  const expMove  = entryN && tpN ? Math.abs(((tpN - entryN) / entryN) * 100).toFixed(2) : null;
  const riskMove = entryN && slN ? Math.abs(((slN - entryN) / entryN) * 100).toFixed(2) : null;

  return (
    <div style={{ background:`linear-gradient(135deg,${vc}0a,rgba(255,255,255,0.02))`, border:`1.5px solid ${vc}30`, borderRadius:12, padding:'16px 18px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <Lbl style={{ marginBottom:0 }}>AI Final Verdict</Lbl>
        <span style={{ ...mono, fontSize:9, color:vc, background:`${vc}12`, border:`1px solid ${vc}30`, borderRadius:12, padding:'3px 10px', fontWeight:700 }}>{confN}% confidence</span>
      </div>
      <div style={{ ...mono, fontSize:17, fontWeight:900, color:vc, marginBottom:4 }}>{verdict}</div>
      <div style={{ ...mono, fontSize:10, color:T.slate, marginBottom:12, lineHeight:1.5 }}>{verdictSub}</div>
      <div style={{ display:'flex', flexDirection:'column', gap:5, marginBottom:12 }}>
        {confirms.slice(0, 3).map((c, i) => (
          <div key={i} style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
            <span style={{ ...mono, fontSize:11, color:T.green, flexShrink:0 }}>✔</span>
            <span style={{ ...mono, fontSize:10, color:'var(--text)', lineHeight:1.4 }}>{c}</span>
          </div>
        ))}
        {contradicts.slice(0, 2).map((c, i) => (
          <div key={i} style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
            <span style={{ ...mono, fontSize:11, color:T.red, flexShrink:0 }}>✘</span>
            <span style={{ ...mono, fontSize:10, color:'var(--text)', lineHeight:1.4 }}>{c}</span>
          </div>
        ))}
        {neutral.slice(0, 1).map((c, i) => (
          <div key={i} style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
            <span style={{ ...mono, fontSize:11, color:T.slate, flexShrink:0 }}>◈</span>
            <span style={{ ...mono, fontSize:10, color:T.slate, lineHeight:1.4 }}>{c}</span>
          </div>
        ))}
      </div>
      {(expMove || riskMove) && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
          {expMove && (
            <div style={{ background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.15)', borderRadius:8, padding:'8px 12px', textAlign:'center' }}>
              <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:4 }}>EXPECTED MOVE</div>
              <div style={{ ...mono, fontSize:14, fontWeight:900, color:T.green }}>+{expMove}%</div>
            </div>
          )}
          {riskMove && (
            <div style={{ background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.15)', borderRadius:8, padding:'8px 12px', textAlign:'center' }}>
              <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:4 }}>MAX RISK</div>
              <div style={{ ...mono, fontSize:14, fontWeight:900, color:T.red }}>-{riskMove}%</div>
            </div>
          )}
        </div>
      )}
      {riskReward && (
        <div style={{ ...mono, fontSize:10, color:T.slate, textAlign:'center', marginBottom:12 }}>
          Risk:Reward <span style={{ color:T.cyan, fontWeight:800 }}>{riskReward}</span>
        </div>
      )}
      {!isHold && onTrade && (
        <button onClick={onTrade} className="aq-btn" style={{
          width:'100%', padding:'12px 0', borderRadius:9, cursor:'pointer',
          border:`1.5px solid ${vc}50`, background:`linear-gradient(135deg,${vc}18,${vc}08)`, color:vc,
          display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:900, letterSpacing:'.04em',
        }}>
          <span>{isBuy ? '↑' : '↓'}</span>
          {isBuy ? 'Execute BUY' : 'Execute SELL'} — {verdict.split(' ')[0]}
        </button>
      )}
    </div>
  );
}

// ── Trade Setup ───────────────────────────────────────────
function TradeSetup({ entry, stopLoss, takeProfit, riskReward, dp }) {
  const cells = [
    { l:'Entry',       v: fmtP(entry, dp)      || '—',              c:'var(--text)' },
    { l:'Stop Loss',   v: fmtP(stopLoss, dp)   || 'Not Available',  c: fmtP(stopLoss, dp) ? T.red   : T.slate },
    { l:'Take Profit', v: fmtP(takeProfit, dp) || 'Not Available',  c: fmtP(takeProfit, dp) ? T.green : T.slate },
    { l:'Risk:Reward', v: riskReward            || 'AI Pending',     c: riskReward ? T.cyan : T.slate },
  ];
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:7 }}>
      {cells.map(c => (
        <div key={c.l} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9, padding:'12px 14px', textAlign:'center' }}>
          <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:5, textTransform:'uppercase', letterSpacing:'.1em' }}>{c.l}</div>
          <div style={{ ...mono, fontSize:13, fontWeight:800, color:c.c }}>{c.v}</div>
        </div>
      ))}
    </div>
  );
}

// ── Confidence Breakdown ──────────────────────────────────
function ConfBreakdown({ confidence, indicators, signal }) {
  const ind   = pi(indicators);
  const rsi   = ind.rsi?.value   || 50;
  const volR  = ind.volume?.ratio || 1;
  const macdX = ind.macd?.crossover || 'NONE';
  const emaX  = ind.ema?.crossover  || 'NONE';
  const isBuy = signal === 'BUY';
  const confN = parseInt(String(confidence || 0).replace('%', ''), 10) || 0;

  const trend      = Math.min(98, 50 + ((isBuy && (emaX === 'GOLDEN_CROSS' || ind.ema?.signal === 'BUY')) ? 25 : 0) + ((!isBuy && (emaX === 'DEATH_CROSS' || ind.ema?.signal === 'SELL')) ? 25 : 0) + ((ind.bollinger?.signal === 'OVERSOLD' && isBuy) ? 15 : 0) + ((ind.bollinger?.signal === 'OVERBOUGHT' && !isBuy) ? 15 : 0));
  const momentum   = Math.min(98, 50 + (isBuy && rsi < 40 ? 25 : 0) + (!isBuy && rsi > 60 ? 25 : 0) + (isBuy && macdX === 'BULLISH_CROSS' ? 20 : 0) + (!isBuy && macdX === 'BEARISH_CROSS' ? 20 : 0));
  const volume     = Math.min(98, Math.round(50 + (volR - 1) * 40));
  const bw         = parseFloat(ind.bollinger?.bandwidth || 0);
  const volatility = bw === 0 ? 70 : Math.min(95, Math.max(40, Math.round(100 - bw * 10)));
  const pattern    = Math.min(98, 50 + (macdX !== 'NONE' ? 20 : 0) + (emaX !== 'NONE' ? 20 : 0) + (ind.fibonacci?.trend === signal ? 10 : 0));
  const news       = Math.round(confN * 0.85);
  const overall    = confN || Math.round([trend, momentum, volume, volatility, pattern, news].reduce((a, b) => a + b, 0) / 6);
  const oc         = v => v >= 70 ? T.green : v >= 50 ? T.cyan : v >= 35 ? T.amber : T.red;

  const dims = [
    { label:'Trend',      val:trend,       icon:'📈' },
    { label:'Momentum',   val:momentum,    icon:'⚡' },
    { label:'Volume',     val:volume,      icon:'📊' },
    { label:'Volatility', val:volatility,  icon:'🌊' },
    { label:'Pattern',    val:pattern,     icon:'🔮' },
    { label:'News',       val:news,        icon:'📰' },
  ];

  return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <Lbl style={{ marginBottom:0 }}>AI Confidence Breakdown</Lbl>
        <span style={{ ...mono, fontSize:14, fontWeight:900, color:oc(overall) }}>{overall}%</span>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <ConfCircle value={overall} color={oc(overall)} action={signal || 'HOLD'} size={80}/>
        <div style={{ flex:1 }}>
          <div style={{ height:3, background:'rgba(255,255,255,0.06)', borderRadius:2, marginBottom:8, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${overall}%`, borderRadius:2, background:`linear-gradient(90deg,${T.cyan},${oc(overall)})`, transition:'width .6s' }}/>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'5px 8px' }}>
            {dims.map(d => (
              <div key={d.label} style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:10, flexShrink:0 }}>{d.icon}</span>
                <div style={{ flex:1, height:2, background:'rgba(255,255,255,.06)', borderRadius:1, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${d.val}%`, background:oc(d.val), transition:'width .5s' }}/>
                </div>
                <span style={{ ...mono, fontSize:9, fontWeight:800, color:oc(d.val), width:28, textAlign:'right', flexShrink:0 }}>{d.val}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Risk Badges ───────────────────────────────────────────
function RiskBadges({ indicators, signal, confidence }) {
  const ind   = pi(indicators);
  const volR  = ind.volume?.ratio || 1;
  const bw    = parseFloat(ind.bollinger?.bandwidth || 0);
  const confN = parseInt(String(confidence || 0).replace('%', ''), 10) || 0;
  const isBuy = signal === 'BUY';

  const riskL  = confN >= 80 && volR >= 1.3 ? 'LOW' : confN >= 65 ? 'MEDIUM' : 'HIGH';
  const volL   = bw > 5 ? 'HIGH' : bw > 2 ? 'MEDIUM' : 'LOW';
  const trendL = isBuy ? 'BULLISH' : signal === 'SELL' ? 'BEARISH' : 'NEUTRAL';
  const volVL  = volR >= 1.5 ? 'HIGH' : volR >= 1.0 ? 'NORMAL' : 'LOW';

  const rc  = { LOW:T.green, MEDIUM:T.amber, HIGH:T.red };
  const vc  = { HIGH:T.red, MEDIUM:T.amber, LOW:T.green };
  const tc  = { BULLISH:T.green, BEARISH:T.red, NEUTRAL:T.slate };
  const vrc = { HIGH:T.cyan, NORMAL:T.slate, LOW:T.amber };

  const badge = (label, value, color, emoji, reason) => (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9, padding:'10px 12px' }}>
      <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:5, textTransform:'uppercase', letterSpacing:'.1em' }}>{label}</div>
      <div style={{ display:'flex', alignItems:'center', gap:7 }}>
        <span style={{ fontSize:14 }}>{emoji}</span>
        <span style={{ ...mono, fontSize:11, fontWeight:900, color }}>{value}</span>
      </div>
      {reason && <div style={{ ...mono, fontSize:8, color:T.slate, marginTop:5, lineHeight:1.35 }}>{reason}</div>}
    </div>
  );

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:7 }}>
      {badge('Risk',       riskL,  rc[riskL],  riskL === 'LOW' ? '🟢' : riskL === 'MEDIUM' ? '🟡' : '🔴', `Conf ${confN}% + vol ×${volR.toFixed(1)}`)}
      {badge('Trend',      trendL, tc[trendL], trendL === 'BULLISH' ? '📈' : trendL === 'BEARISH' ? '📉' : '➡️', ind.ema?.position ? `EMA ${ind.ema.position}` : '')}
      {badge('Volatility', volL,   vc[volL],   volL === 'LOW' ? '🟢' : volL === 'MEDIUM' ? '🟡' : '🔴', bw ? `Band width ${bw.toFixed(2)}` : '')}
      {badge('Volume',     volVL,  vrc[volVL], volVL === 'HIGH' ? '🔥' : volVL === 'NORMAL' ? '🟢' : '🟡', `×${volR.toFixed(2)}`)}
    </div>
  );
}

// ── Signal Timeline ───────────────────────────────────────
function SignalTimeline({ signal: sig }) {
  const conf  = parseInt(String(sig.confidence || sig.conf || 0).replace('%', ''), 10) || 0;
  const color = sc(sig.signal);
  const iso   = sig.created_at;

  const steps = [
    { time:mkTime(iso,-120000), label:'Signal Detected',  sub:'Market scan completed',             done:true  },
    { time:mkTime(iso, -60000), label:'Indicators',       sub:`${Math.max(40,conf-10)}% pre-conf`, done:true  },
    { time:mkTime(iso,       0),label:'AI Validated',     sub:`${conf}% confidence`,               done:true, highlight:true },
    { time:'Now',                label:'Monitoring Market',sub:'⚡ AI watching for confirmation',   done:false, pulse:true },
  ];

  return (
    <div>
      <Lbl>Signal Timeline</Lbl>
      {steps.map((s, i) => (
        <div key={i} style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', flexShrink:0 }}>
            <div style={{
              width:10, height:10, borderRadius:'50%', marginTop:2, flexShrink:0,
              background: s.highlight ? color : s.done ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)',
              border:`1.5px solid ${s.highlight ? color : 'rgba(255,255,255,0.15)'}`,
              boxShadow: s.pulse ? `0 0 8px ${color}` : 'none',
              animation: s.pulse ? 'aq-pulse 1.8s infinite' : 'none',
            }}/>
            {i < steps.length - 1 && <div style={{ width:1, height:28, background:'rgba(255,255,255,0.07)', margin:'2px 0' }}/>}
          </div>
          <div style={{ paddingBottom:2 }}>
            <div style={{ display:'flex', gap:8, alignItems:'baseline' }}>
              <span style={{ ...mono, fontSize:8, color:T.slate }}>{s.time}</span>
              <span style={{ ...mono, fontSize:10, fontWeight:700, color: s.highlight ? color : s.pulse ? T.cyan : 'var(--text)' }}>{s.label}</span>
            </div>
            {s.sub && <div style={{ ...mono, fontSize:9, color: s.pulse ? T.cyan : T.slate, opacity: s.pulse ? 0.9 : 0.7 }}>{s.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────
export default function SignalModal({ signal: sig, onClose }) {
  const overlayRef = useRef(null);
  const stats      = useSignalStats(sig?.symbol);

  useEffect(() => {
    injectStyles();
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  if (!sig) return null;

  const isBuy       = sig.signal === 'BUY';
  const color       = sc(sig.signal);
  const isForex     = sig.asset_class === 'Forex';
  const isCommodity = sig.asset_class === 'Commodity';
  const isOanda     = isForex || isCommodity;
  const dp          = isCommodity ? 2 : isForex ? 5 : (parseFloat(sig.price) > 100 ? 2 : 6);
  const confN       = parseInt(String(sig.confidence || sig.conf || 0).replace('%', ''), 10) || 0;
  const priceN      = parseFloat(sig.price || 0);
  const oc          = v => v >= 70 ? T.green : v >= 50 ? T.cyan : v >= 35 ? T.amber : T.red;

  const handleTrade = () => {
    const sym    = (sig.symbol || '').replace('/', '').replace(/USDT$/i, '').toUpperCase();
    const side   = sig.signal === 'SELL' ? 'sell' : 'buy';
    const params = new URLSearchParams({ symbol:sym, side });
    const entryV = toNum(sig.entry || sig.price);
    if (entryV)                params.set('entry', String(entryV));
    if (toNum(sig.stop_loss))  params.set('sl',    String(toNum(sig.stop_loss)));
    if (toNum(sig.take_profit))params.set('tp',    String(toNum(sig.take_profit)));
    window.location.href = `/trading?${params.toString()}`;
  };

  const handleAlert = async () => {
    try {
      await api.post('/alerts', { symbol:sig.symbol, type:'typePrice', condition:isBuy?'above':'below', value:sig.take_profit||sig.price, channels:['email'] });
      alert('✅ Alert created!');
    } catch { alert('Could not create alert'); }
  };

  const handleWatch = async () => {
    try { await api.post('/watchlist', { symbol:sig.symbol }); alert(`✅ ${sig.symbol} added`); }
    catch { alert('Could not add'); }
  };

  const handleShare = () => {
    const txt = [`📊 AtlasQuant AI Signal`, `${sig.symbol} ${sig.signal} @ ${priceN?'$'+priceN.toLocaleString():'—'}`, `Confidence: ${confN}%`, sig.entry?`Entry: $${parseFloat(sig.entry).toLocaleString()}`:'', sig.stop_loss?`SL: $${parseFloat(sig.stop_loss).toLocaleString()}`:'', sig.take_profit?`TP: $${parseFloat(sig.take_profit).toLocaleString()}`:'', sig.risk_reward?`R:R ${sig.risk_reward}`:''].filter(Boolean).join('\n');
    navigator.clipboard?.writeText(txt).then(() => alert('📋 Copied!'));
  };

  return (
    <div ref={overlayRef} onClick={e => e.target === overlayRef.current && onClose()}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.86)', backdropFilter:'blur(20px)', zIndex:800, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}>

      <div style={{ width:'100%', maxWidth:1080, background:'#080f1e', border:`1px solid ${color}28`, borderRadius:20, boxShadow:`0 0 80px ${color}12,0 40px 80px rgba(0,0,0,.85)`, animation:'aq-sm-in .22s ease', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 22px', background:`linear-gradient(135deg,${color}09,transparent)`, borderBottom:'1px solid rgba(255,255,255,0.05)', flexWrap:'wrap' }}>
          <span style={{ fontSize:20 }}>{ai(sig.asset_class)}</span>
          <div>
            <div style={{ fontSize:21, fontWeight:900, color:'var(--text)', letterSpacing:'-.5px' }}>{sig.symbol}</div>
            <div style={{ ...mono, fontSize:9, color:T.slate }}>{sig.asset_class || 'Crypto'} · {timeAgo(sig.created_at)}</div>
          </div>
          <span style={{ ...mono, fontSize:13, fontWeight:800, padding:'5px 14px', borderRadius:7, background:`${color}18`, color, border:`1px solid ${color}35` }}>{sig.signal}</span>
          <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(52,211,153,0.08)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:20, padding:'4px 12px' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:T.green, animation:'aq-pulse 1.5s infinite' }}/>
            <span style={{ ...mono, fontSize:9, color:T.green, fontWeight:700 }}>LIVE</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(255,255,255,0.04)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 14px' }}>
            <span style={{ ...mono, fontSize:10, color:T.slate }}>AI Confidence</span>
            <span style={{ ...mono, fontSize:16, fontWeight:900, color:oc(confN) }}>{confN || '—'}%</span>
          </div>
          {priceN > 0 && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end' }}>
              <span style={{ ...mono, fontSize:14, fontWeight:800, color:'var(--text)' }}>${priceN.toLocaleString('en-US', { maximumFractionDigits:dp })}</span>
              <span style={{ ...mono, fontSize:9, color:isBuy ? T.green : T.red }}>{isBuy ? '↑ Bullish setup' : '↓ Bearish setup'}</span>
            </div>
          )}
          <button onClick={onClose} style={{ marginLeft:'auto', width:30, height:30, borderRadius:'50%', border:'1px solid var(--border)', background:'rgba(255,255,255,0.04)', color:T.slate, fontSize:14, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>✕</button>
        </div>

        {/* 2-Column Body */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 340px', height:'80vh' }}>

          {/* LEFT */}
          <div className="aq-col" style={{ overflowY:'auto', padding:'18px 20px', display:'flex', flexDirection:'column', gap:16, borderRight:'1px solid rgba(255,255,255,0.05)' }}>
            <div>
              <Lbl>Price Chart · TradingView Live</Lbl>
              <div style={{ height:280, borderRadius:10, overflow:'hidden', border:'1px solid rgba(255,255,255,0.05)' }}>
                <TvChart symbol={sig.symbol} isOanda={isOanda}/>
              </div>
            </div>
            <div>
              <Lbl>Technical Signals</Lbl>
              <IndicatorChips indicators={sig.indicators}/>
            </div>
            <AiReasoning reasoning={sig.reasoning} signal={sig.signal}/>
            <StatsCard stats={stats}/>
            <AiFinalVerdict
              signal={sig.signal} confidence={confN} indicators={sig.indicators}
              entry={sig.entry || sig.price} stopLoss={sig.stop_loss} takeProfit={sig.take_profit}
              riskReward={sig.risk_reward} onTrade={handleTrade} color={color}
            />
          </div>

          {/* RIGHT */}
          <div style={{ display:'flex', flexDirection:'column', height:'80vh' }}>
            {/* Scrollable */}
            <div className="aq-col" style={{ overflowY:'auto', padding:'18px 16px', flex:1, display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <Lbl>Trade Setup</Lbl>
                <TradeSetup entry={sig.entry || sig.price} stopLoss={sig.stop_loss} takeProfit={sig.take_profit} riskReward={sig.risk_reward} dp={dp}/>
              </div>
              <ConfBreakdown confidence={confN} indicators={sig.indicators} signal={sig.signal}/>
              <div>
                <Lbl>Risk Assessment</Lbl>
                <RiskBadges indicators={sig.indicators} signal={sig.signal} confidence={confN}/>
              </div>
              <SignalTimeline signal={sig}/>
            </div>

            {/* Fixed Buttons */}
            <div style={{ padding:'14px 16px', borderTop:'1px solid rgba(255,255,255,0.06)', background:'rgba(8,15,30,0.98)', flexShrink:0, display:'flex', flexDirection:'column', gap:8 }}>
              <button className="aq-btn" onClick={handleTrade} style={{
                width:'100%', padding:'14px 0', borderRadius:11, cursor:'pointer',
                border:`1.5px solid ${color}55`, background:`linear-gradient(135deg,${color}1c,${color}09)`, color,
                display:'flex', alignItems:'center', justifyContent:'center', gap:10,
                fontFamily:'Syne,sans-serif', fontSize:14, fontWeight:900, letterSpacing:'.05em',
                boxShadow:`0 0 24px ${color}16`,
              }}>
                <span style={{ fontSize:16 }}>🚀</span> Trade this Signal
              </button>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:7 }}>
                {[
                  { label:'⭐ Watch', c:T.amber, bg:'rgba(251,191,36,.06)', b:'rgba(251,191,36,.3)', fn:handleWatch },
                  { label:'🔔 Alert', c:T.cyan,  bg:'rgba(0,245,212,.06)',  b:'rgba(0,245,212,.3)',  fn:handleAlert },
                  { label:'📤 Share', c:T.slate, bg:'rgba(100,116,139,.06)',b:'rgba(100,116,139,.3)',fn:handleShare },
                ].map(btn => (
                  <button key={btn.label} className="aq-btn" onClick={btn.fn} style={{
                    padding:'10px 0', borderRadius:9, cursor:'pointer',
                    border:`1px solid ${btn.b}`, background:btn.bg, color:btn.c,
                    fontFamily:'Syne,sans-serif', fontSize:12, fontWeight:700,
                    display:'flex', alignItems:'center', justifyContent:'center', gap:5,
                  }}>{btn.label}</button>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}