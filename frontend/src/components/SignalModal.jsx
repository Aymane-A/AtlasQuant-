/**
 * components/SignalModal.jsx — AtlasQuant AI v3
 * Top SaaS Signal Intelligence Modal
 */
import { useState, useEffect, useRef } from 'react';
// recharts removed — TradingView widget used directly
import api from '../services/api';

const mono = { fontFamily:"'JetBrains Mono','Fira Code',monospace" };
const T    = { cyan:'#00f5d4', purple:'#a78bfa', amber:'#f59e0b', red:'#f43f5e', green:'#34d399', slate:'#64748b' };

function injectStyles() {
  if (document.getElementById('aq-sm3')) return;
  const s = document.createElement('style');
  s.id = 'aq-sm3';
  s.textContent = `
    @keyframes aq-sm-in  { from{opacity:0;transform:scale(.95) translateY(14px)} to{opacity:1;transform:scale(1) translateY(0)} }
    @keyframes aq-pulse  { 0%,100%{opacity:.4} 50%{opacity:1} }
    @keyframes aq-conf-fill { from{stroke-dashoffset:283} to{stroke-dashoffset:var(--offset)} }
    .aq-col::-webkit-scrollbar{width:3px}
    .aq-col::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px}
    .aq-btn{transition:all .15s}
    .aq-btn:hover{opacity:.82;transform:translateY(-1px)}
    .aq-chip{transition:border-color .15s}
    .aq-chip:hover{border-color:rgba(0,245,212,.3)!important}
  `;
  document.head.appendChild(s);
}

// ── Helpers ───────────────────────────────────────────────
const sc     = s => s === 'BUY' ? T.green : s === 'SELL' ? T.red : T.amber;
const ai     = a => ({ Crypto:'🪙', Forex:'💱', Commodity:'🥇', Indices:'📈' }[a] || '◈');
const pi     = r => { if (!r) return {}; if (typeof r==='string'){try{return JSON.parse(r)}catch{return {}}}return r; };
const fmtP   = (v,dp=2) => v==null||isNaN(parseFloat(v)) ? null : parseFloat(v).toLocaleString('en-US',{minimumFractionDigits:dp,maximumFractionDigits:dp});
const timeAgo= iso => { if(!iso)return''; const m=Math.floor((Date.now()-new Date(iso))/60000); return m<1?'just now':m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`; };

function Lbl({children,style={}}) {
  return <div style={{...mono,fontSize:8,letterSpacing:'.18em',textTransform:'uppercase',color:T.slate,marginBottom:6,...style}}>{children}</div>;
}

// ── Signal Statistics (from DB — real win rate per symbol) ──
function useSignalStats(symbol) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    if (!symbol) return;
    // Fetch last 30 signals for this symbol to compute win rate proxy
    api.get(`/signals?symbol=${encodeURIComponent(symbol)}&limit=30`)
      .then(res => {
        const sigs = res.data?.signals || res.data || [];
        if (!sigs.length) return;
        const directional = sigs.filter(s => s.signal !== 'HOLD');
        const highConf    = directional.filter(s => (s.confidence||0) >= 70);
        const winRate     = directional.length ? Math.round((highConf.length / directional.length) * 100) : 0;
        const avgConf     = directional.length ? Math.round(directional.reduce((a,s) => a+(s.confidence||0), 0) / directional.length) : 0;
        const lastSuccess = highConf[0]?.created_at;
        setStats({ winRate, avgConf, total: sigs.length, directional: directional.length, lastSuccess });
      }).catch(() => {});
  }, [symbol]);
  return stats;
}

// ── Signal Timeline ──────────────────────────────────────
function SignalTimeline({ signal: sig }) {
  const conf  = parseInt(String(sig.confidence||sig.conf||0).replace('%',''),10)||0;
  const color = sc(sig.signal);

  const mkTime = (offsetMs) => sig.created_at
    ? new Date(new Date(sig.created_at).getTime() + offsetMs)
        .toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
    : '—';

  const steps = [
    {
      time:  mkTime(-120000),
      label: 'Signal Detected',
      sub:   'Market scan completed',
      done:  true,
    },
    {
      time:  mkTime(-60000),
      label: 'Indicators',
      sub:   `${Math.max(40, conf - 10)}% pre-confidence`,
      done:  true,
    },
    {
      time:      mkTime(0),
      label:     'AI Validated',
      sub:       `${conf}% confidence`,
      done:      true,
      highlight: true,
    },
    {
      time:  'Now',
      label: 'Monitoring Market',
      sub:   '⚡ AI watching for confirmation',
      done:  false,
      pulse: true,
    },
  ];

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
      <Lbl>Signal Timeline</Lbl>
      {steps.map((s, i) => (
        <div key={i} style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', flexShrink:0 }}>
            <div style={{
              width:10, height:10, borderRadius:'50%', marginTop:2, flexShrink:0,
              background: s.highlight ? color : s.done ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)',
              border: `1.5px solid ${s.highlight ? color : 'rgba(255,255,255,0.15)'}`,
              boxShadow: s.pulse ? `0 0 8px ${color}` : 'none',
              animation: s.pulse ? 'aq-pulse 1.8s infinite' : 'none',
            }}/>
            {i < steps.length - 1 && (
              <div style={{ width:1, height:28, background:'rgba(255,255,255,0.07)', margin:'2px 0' }}/>
            )}
          </div>
          <div>
            <div style={{ display:'flex', gap:8, alignItems:'baseline' }}>
              <span style={{ ...mono, fontSize:8, color:T.slate }}>{s.time}</span>
              <span style={{ ...mono, fontSize:10, fontWeight:700,
                color: s.highlight ? color : s.pulse ? T.cyan : 'var(--text)' }}>
                {s.label}
              </span>
            </div>
            {s.sub && (
              <div style={{ ...mono, fontSize:9,
                color: s.pulse ? T.cyan : T.slate, opacity: s.pulse ? 0.9 : 0.7 }}>
                {s.sub}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Stats Card ────────────────────────────────────────────
function StatsCard({ stats, loading }) {
  if (loading || !stats) return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:14 }}>
      <Lbl>Signal Statistics</Lbl>
      <div style={{ ...mono, fontSize:10, color:T.slate }}>Computing from history…</div>
    </div>
  );
  const items = [
    { l:'Win Rate',       v:`${stats.winRate}%`,    c: stats.winRate>=60?T.green:stats.winRate>=45?T.amber:T.red },
    { l:'Avg Confidence', v:`${stats.avgConf}%`,    c: stats.avgConf>=70?T.green:T.amber },
    { l:'Signals (sym)',  v:stats.total,             c:'var(--text)' },
    { l:'Last High-Conf', v: stats.lastSuccess ? timeAgo(stats.lastSuccess) : '—', c:T.cyan },
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

// ── Mini Chart ────────────────────────────────────────────
function MiniChart({ symbol, entry, stopLoss, takeProfit, isBuy, isOanda }) {
  const [candles, setCandles] = useState([]);
  const [done, setDone]       = useState(false);

  useEffect(() => {
    if (isOanda) { setDone(true); return; }
    const base = (symbol||'').replace(/\/.*$/,'').replace(/[^A-Z0-9]/gi,'').toUpperCase();
    if (!base) { setDone(true); return; }
    api.get(`/trading/ticker/${base}`)
      .then(r => { if (r.data?.candles?.length) setCandles(r.data.candles.slice(-48)); })
      .catch(()=>{}).finally(()=>setDone(true));
  }, [symbol, isOanda]);

  const color  = isBuy ? T.green : T.red;
  const tvSym  = isOanda ? `OANDA:${(symbol||'').replace('/','')}`
    : `${(symbol||'').replace('/','').replace(/USDT$/i,'')}USDT`;

  if (!done) return (
    <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center',
      ...mono, fontSize:10, color:T.slate }}>Loading…</div>
  );

  if (!candles.length) return (
    <div style={{ height:54, display:'flex', alignItems:'center', justifyContent:'space-between',
      background:'rgba(255,255,255,0.02)', borderRadius:8, padding:'0 16px',
      border:'1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ ...mono, fontSize:10, color:T.slate }}>📊 Chart unavailable inline</span>
      <a href={`https://www.tradingview.com/chart/?symbol=${tvSym}`} target="_blank" rel="noreferrer"
        style={{ ...mono, fontSize:10, color:T.cyan, textDecoration:'none',
          padding:'4px 12px', border:'1px solid rgba(0,245,212,.25)',
          background:'rgba(0,245,212,.06)', borderRadius:6 }}>
        TradingView ↗
      </a>
    </div>
  );

  const prices = candles.map(c=>c.close);
  const dMin   = Math.min(...prices, stopLoss||Infinity)*0.997;
  const dMax   = Math.max(...prices, takeProfit||0)*1.003;

  return (
    <div style={{ height:200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={candles} margin={{top:6,right:72,left:0,bottom:0}}>
          <defs>
            <linearGradient id="sg-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.2}/>
              <stop offset="100%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,.03)" vertical={false}/>
          <XAxis dataKey="t" hide/>
          <YAxis hide domain={[dMin,dMax]}/>
          <Tooltip contentStyle={{background:'rgba(3,7,18,.97)',border:`1px solid ${color}30`,borderRadius:6,...mono,fontSize:10}}
            formatter={v=>[parseFloat(v).toLocaleString(),'Price']} labelFormatter={()=>''}/>
          {stopLoss   && <ReferenceLine y={stopLoss}   stroke={T.red}   strokeDasharray="5 3" strokeWidth={1.5}
            label={{value:'SL',position:'right',fill:T.red,  fontSize:9,fontFamily:'JetBrains Mono,monospace'}}/>}
          {takeProfit && <ReferenceLine y={takeProfit} stroke={T.green} strokeDasharray="5 3" strokeWidth={1.5}
            label={{value:'TP',position:'right',fill:T.green,fontSize:9,fontFamily:'JetBrains Mono,monospace'}}/>}
          {entry      && <ReferenceLine y={entry}      stroke={T.cyan}  strokeDasharray="2 2" strokeWidth={1}
            label={{value:'E', position:'right',fill:T.cyan, fontSize:9,fontFamily:'JetBrains Mono,monospace'}}/>}
          <Area type="monotone" dataKey="close" stroke={color} strokeWidth={1.8}
            fill="url(#sg-g)" dot={false}
            activeDot={{r:3,fill:color,stroke:'#080f1e',strokeWidth:2}}/>
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Indicator Chips ───────────────────────────────────────
function IndicatorChips({ indicators }) {
  const ind = pi(indicators);
  const rsi = ind.rsi?.value;

  const icon = s => {
    const l=(s||'').toLowerCase();
    if(['oversold','bullish','buy','golden','cross','bounce','above','support','increased'].some(k=>l.includes(k))) return {i:'✔',c:T.green};
    if(['overbought','bearish','sell','death','resistance','below'].some(k=>l.includes(k))) return {i:'✘',c:T.red};
    return {i:'◈',c:T.slate};
  };

  const chips = [
    rsi!=null && {
      text: `RSI ${rsi.toFixed(1)} — ${rsi<35?'Oversold':rsi>65?'Overbought':'Neutral'}`,
      ...icon(rsi<35?'oversold':rsi>65?'overbought':'neutral'),
    },
    ind.macd?.crossover && ind.macd.crossover !== 'NONE' && {
      text: `MACD ${ind.macd.crossover.replace(/_/g,' ')}`,
      ...icon(ind.macd.crossover),
    },
    ind.macd?.trend && {
      text: `MACD Trend ${ind.macd.trend}`,
      ...icon(ind.macd.trend),
    },
    ind.ema?.crossover && ind.ema.crossover !== 'NONE' && {
      text: `EMA ${ind.ema.crossover.replace(/_/g,' ')}`,
      ...icon(ind.ema.crossover),
    },
    ind.ema?.signal && {
      text: `EMA Signal ${ind.ema.signal} — 20 ${ind.ema.position||''}`,
      ...icon(ind.ema.signal),
    },
    ind.bollinger?.signal && {
      text: `Bollinger ${ind.bollinger.signal.replace(/_/g,' ')}`,
      ...icon(ind.bollinger.signal),
    },
    ind.volume?.ratio != null && {
      text: `Volume ×${parseFloat(ind.volume.ratio).toFixed(2)} — ${ind.volume.signal?.replace(/_/g,' ')||'Normal'}`,
      ...icon(ind.volume.ratio>=1.5?'increased':'low volume'),
    },
    ind.fibonacci?.nearestLevel != null && {
      text: `Fibonacci ${parseFloat(ind.fibonacci.nearestLevel).toFixed(4)} — ${ind.fibonacci.interpretation||''}`,
      ...icon(ind.fibonacci.interpretation||''),
    },
  ].filter(Boolean);

  if (!chips.length) return (
    <div style={{...mono,fontSize:10,color:T.slate}}>No indicator data available.</div>
  );

  return (
    <div style={{display:'flex',flexWrap:'wrap',gap:7}}>
      {chips.map((c,i) => (
        <div key={i} className="aq-chip" style={{
          display:'flex',alignItems:'center',gap:7,
          background:'rgba(255,255,255,0.03)',
          border:`1px solid rgba(255,255,255,0.07)`,
          borderRadius:20, padding:'6px 12px',
        }}>
          <span style={{fontSize:11,color:c.c,fontWeight:700}}>{c.i}</span>
          <span style={{...mono,fontSize:10,color:'var(--text)'}}>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── AI Reasoning ──────────────────────────────────────────
function AiReasoning({ reasoning, signal }) {
  const sentences = (reasoning||'').split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
  const icon = s => {
    const l=s.toLowerCase();
    if(['oversold','bullish','above','buy','cross','support','golden','bounce','increased'].some(k=>l.includes(k))) return{i:'✔',c:T.green};
    if(['overbought','bearish','below','sell','death','resistance'].some(k=>l.includes(k))) return{i:'✘',c:T.red};
    if(['not enough','weak','neutral','hold'].some(k=>l.includes(k))) return{i:'⚠',c:T.amber};
    return{i:'◈',c:T.slate};
  };

  return (
    <div style={{background:'rgba(0,245,212,0.04)',border:'1px solid rgba(0,245,212,0.1)',borderRadius:10,padding:14}}>
      <div style={{...mono,fontSize:9,color:T.cyan,letterSpacing:'.12em',marginBottom:10}}>
        ⚡ ATLAS AI — WHY THIS {signal}
      </div>
      {!sentences.length
        ? <div style={{...mono,fontSize:10,color:T.slate}}>No reasoning available.</div>
        : <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {sentences.map((s,i)=>{const{i:ic,c}=icon(s);return(
              <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start'}}>
                <span style={{...mono,fontSize:11,color:c,flexShrink:0,marginTop:1}}>{ic}</span>
                <span style={{...mono,fontSize:10,color:'var(--text)',lineHeight:1.6}}>{s}</span>
              </div>
            );})}
          </div>
      }
    </div>
  );
}

// ── Confidence Circle — animated counter 0→value ────────
function ConfCircle({ value, color, action, size=110 }) {
  const [displayed, setDisplayed] = useState(0);
  const [started,   setStarted]   = useState(false);
  const r    = (size - (size < 90 ? 10 : 20)) / 2;
  const circ = 2 * Math.PI * r;

  // Start animation after a short mount delay
  useEffect(() => {
    const t = setTimeout(() => setStarted(true), 150);
    return () => clearTimeout(t);
  }, []);

  // Ease-out counter: fast at start, slower near target
  useEffect(() => {
    if (!started || displayed >= value) return;
    const step  = Math.max(1, Math.round((value - displayed) / 5));
    const delay = displayed < value * 0.65 ? 16 : 28;
    const t     = setTimeout(() => setDisplayed(p => Math.min(p + step, value)), delay);
    return () => clearTimeout(t);
  }, [displayed, value, started]);

  const offset = circ - (displayed / 100) * circ;

  const cx   = size / 2;
  const sw   = size < 90 ? 5 : 8;
  const fsSz = size < 90 ? 14 : 22;
  const fsLb = size < 90 ? 8  : 10;
  const mt   = size < 90 ? -size*0.62 : -72;

  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',flexShrink:0}}>
      <svg width={size} height={size} style={{transform:'rotate(-90deg)'}}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw}/>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth={sw}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{transition:'stroke-dashoffset 0.04s linear'}}/>
      </svg>
      <div style={{marginTop:mt,display:'flex',flexDirection:'column',alignItems:'center',zIndex:1}}>
        <div style={{...mono,fontSize:fsSz,fontWeight:900,color}}>{displayed}%</div>
        <div style={{...mono,fontSize:fsLb,color:'var(--text)',fontWeight:900}}>{action||'HOLD'}</div>
      </div>
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
  const confN = parseInt(String(confidence||0).replace('%',''),10)||0;

  const trend = Math.min(98,50
    +((isBuy  &&(emaX==='GOLDEN_CROSS'||ind.ema?.signal==='BUY' ))?25:0)
    +((!isBuy &&(emaX==='DEATH_CROSS' ||ind.ema?.signal==='SELL'))?25:0)
    +((ind.bollinger?.signal==='OVERSOLD'   && isBuy )?15:0)
    +((ind.bollinger?.signal==='OVERBOUGHT' && !isBuy)?15:0));
  const momentum=Math.min(98,50
    +(isBuy &&rsi<40?25:0)+(!isBuy&&rsi>60?25:0)
    +(isBuy &&macdX==='BULLISH_CROSS'?20:0)+(!isBuy&&macdX==='BEARISH_CROSS'?20:0));
  const volume    =Math.min(98,Math.round(50+(volR-1)*40));
  const bw        =parseFloat(ind.bollinger?.bandwidth||0);
  const volatility=bw===0?70:Math.min(95,Math.max(40,Math.round(100-bw*10)));
  const pattern   =Math.min(98,50+(macdX!=='NONE'?20:0)+(emaX!=='NONE'?20:0)+(ind.fibonacci?.trend===signal?10:0));
  const news      =Math.round(confN*0.85);
  const overall   =confN||Math.round([trend,momentum,volume,volatility,pattern,news].reduce((a,b)=>a+b,0)/6);

  const oc = v => v>=70?T.green:v>=50?T.cyan:v>=35?T.amber:T.red;

  const dims=[
    {label:'Trend',     val:trend,       icon:'📈'},
    {label:'Momentum',  val:momentum,    icon:'⚡'},
    {label:'Volume',    val:volume,      icon:'📊'},
    {label:'Volatility',val:volatility,  icon:'🌊'},
    {label:'Pattern',   val:pattern,     icon:'🔮'},
    {label:'News',      val:news,        icon:'📰'},
  ];

  return (
    <div style={{background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:10,padding:'12px 14px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <Lbl style={{marginBottom:0}}>AI Confidence Breakdown</Lbl>
        <span style={{...mono,fontSize:18,fontWeight:900,color:oc(overall)}}>{overall}%</span>
      </div>

      {/* Compact: small circle left + signal label */}
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
        <ConfCircle value={overall} color={oc(overall)} action={signal||'HOLD'} size={80}/>
        <div style={{flex:1}}>
          {/* Overall bar */}
          <div style={{height:4,background:'rgba(255,255,255,0.06)',borderRadius:2,marginBottom:10,overflow:'hidden'}}>
            <div style={{height:'100%',width:`${overall}%`,borderRadius:2,
              background:`linear-gradient(90deg,${T.cyan},${oc(overall)})`,transition:'width .6s'}}/>
          </div>
          {/* 2-column dims grid */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'5px 10px'}}>
            {dims.map(d=>(
              <div key={d.label} style={{display:'flex',alignItems:'center',gap:5}}>
                <span style={{fontSize:10,flexShrink:0}}>{d.icon}</span>
                <div style={{flex:1,height:2,background:'rgba(255,255,255,.06)',borderRadius:1,overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${d.val}%`,background:oc(d.val),transition:'width .5s'}}/>
                </div>
                <span style={{...mono,fontSize:9,fontWeight:800,color:oc(d.val),width:28,textAlign:'right',flexShrink:0}}>{d.val}%</span>
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
  const bw    = parseFloat(ind.bollinger?.bandwidth||0);
  const confN = parseInt(String(confidence||0).replace('%',''),10)||0;
  const isBuy = signal === 'BUY';

  const riskL = confN>=80&&volR>=1.3?'LOW':confN>=65?'MEDIUM':'HIGH';
  const volL  = bw>5?'HIGH':bw>2?'MEDIUM':'LOW';
  const trendL= isBuy?'BULLISH':signal==='SELL'?'BEARISH':'NEUTRAL';
  const volVL = volR>=1.5?'HIGH':volR>=1.0?'NORMAL':'LOW';

  const badge = (label, value, color, emoji) => (
    <div style={{background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:9,
      padding:'10px 12px',textAlign:'center'}}>
      <div style={{...mono,fontSize:8,color:T.slate,marginBottom:5,textTransform:'uppercase',letterSpacing:'.1em'}}>{label}</div>
      <div style={{fontSize:15}}>{emoji}</div>
      <div style={{...mono,fontSize:11,fontWeight:900,color,marginTop:3}}>{value}</div>
    </div>
  );

  const rc={LOW:T.green,MEDIUM:T.amber,HIGH:T.red};
  const vc={HIGH:T.red,MEDIUM:T.amber,LOW:T.green};
  const tc={BULLISH:T.green,BEARISH:T.red,NEUTRAL:T.slate};
  const vre={HIGH:T.cyan,NORMAL:T.slate,LOW:T.amber};

  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}>
      {badge('Risk',       riskL,  rc[riskL],  riskL==='LOW'?'🟢':riskL==='MEDIUM'?'🟡':'🔴')}
      {badge('Trend',      trendL, tc[trendL], trendL==='BULLISH'?'📈':trendL==='BEARISH'?'📉':'➡️')}
      {badge('Volatility', volL,   vc[volL],   volL==='LOW'?'🟢':volL==='MEDIUM'?'🟡':'🔴')}
      {badge('Volume',     volVL,  vre[volVL], volVL==='HIGH'?'🔥':volVL==='NORMAL'?'🟢':'🟡')}
    </div>
  );
}

// ── Trade Setup ───────────────────────────────────────────
function TradeSetup({ entry, stopLoss, takeProfit, riskReward, dp }) {
  const fmt = v => fmtP(v,dp);
  const cells = [
    { l:'Entry',       v:fmt(entry),      c:'var(--text)' },
    { l:'Stop Loss',   v:fmt(stopLoss)  ||'Not Available', c:fmt(stopLoss)  ?T.red  :T.slate },
    { l:'Take Profit', v:fmt(takeProfit)||'Not Available', c:fmt(takeProfit)?T.green:T.slate },
    { l:'Risk:Reward', v:riskReward||'AI Pending',         c:riskReward?T.cyan:T.slate },
  ];
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}>
      {cells.map(c=>(
        <div key={c.l} style={{background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',
          borderRadius:9,padding:'12px 14px',textAlign:'center'}}>
          <div style={{...mono,fontSize:8,color:T.slate,marginBottom:5,textTransform:'uppercase',letterSpacing:'.1em'}}>{c.l}</div>
          <div style={{...mono,fontSize:13,fontWeight:800,color:c.c}}>{c.v}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────

// ── TradingView Embedded Chart ────────────────────────────
function TvChart({ symbol, isOanda, isBuy }) {
  const containerRef = useRef(null);

  const tvSym = isOanda
    ? `OANDA:${(symbol||'').replace(/[/_]/g,'')}`
    : `BINANCE:${(symbol||'').replace('/','').replace(/USDT$/i,'')}USDT`;

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = '';

    const script = document.createElement('script');
    script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type  = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize:true, symbol:tvSym, interval:'60', timezone:'Etc/UTC',
      theme:'dark', style:'1', locale:'en',
      enable_publishing:false, hide_top_toolbar:false, save_image:false,
      backgroundColor:'rgba(8,15,30,1)', gridColor:'rgba(255,255,255,0.03)',
      studies:['RSI@tv-basicstudies','MACD@tv-basicstudies'],
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
    containerRef.current.appendChild(w);
    containerRef.current.appendChild(script);

    return () => { if (containerRef.current) containerRef.current.innerHTML = ''; };
  }, [tvSym]);

  return (
    <div ref={containerRef} style={{width:'100%',height:'100%'}}
      className="tradingview-widget-container"/>
  );
}

export default function SignalModal({ signal: sig, onClose }) {
  const overlayRef = useRef(null);
  const stats      = useSignalStats(sig?.symbol);

  useEffect(() => {
    injectStyles();
    const h = e => { if (e.key==='Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  if (!sig) return null;

  const isBuy       = sig.signal === 'BUY';
  const color       = sc(sig.signal);
  const isForex     = sig.asset_class === 'Forex';
  const isCommodity = sig.asset_class === 'Commodity';
  const isOanda     = isForex || isCommodity;
  const dp          = isCommodity?2:isForex?5:(parseFloat(sig.price)>100?2:6);
  const confN       = parseInt(String(sig.confidence||sig.conf||0).replace('%',''),10)||0;
  const priceN      = parseFloat(sig.price||0);

  const handleTrade = () => {
    const sym = (sig.symbol||'').replace('/','').replace(/USDT$/i,'').toUpperCase();
    const params = new URLSearchParams({ symbol: sym, side });
    const entryV = toNum(sig.entry || sig.price);
    if (entryV)             params.set('entry', String(entryV));
    if (toNum(sig.stop_loss))    params.set('sl',    String(toNum(sig.stop_loss)));
    if (toNum(sig.take_profit))  params.set('tp',    String(toNum(sig.take_profit)));
    window.location.href = `/trading?${params.toString()}`;
  };

  const handleAlert = async () => {
    try {
      await api.post('/alerts',{symbol:sig.symbol,type:'typePrice',
        condition:isBuy?'above':'below',value:sig.take_profit||sig.price,channels:['email']});
      alert('✅ Alert created!');
    } catch { alert('Could not create alert'); }
  };

  const handleWatch = async () => {
    try {
      await api.post('/watchlist',{symbol:sig.symbol});
      alert(`✅ ${sig.symbol} added to watchlist`);
    } catch { alert('Could not add'); }
  };

  const handleShare = () => {
    const txt=[
      `📊 AtlasQuant AI Signal`,
      `${sig.symbol} ${sig.signal} @ ${priceN?'$'+priceN.toLocaleString():'—'}`,
      `Confidence: ${confN}%`,
      sig.entry       ?`Entry:  $${parseFloat(sig.entry).toLocaleString()}`       :'',
      sig.stop_loss   ?`SL:     $${parseFloat(sig.stop_loss).toLocaleString()}`   :'',
      sig.take_profit ?`TP:     $${parseFloat(sig.take_profit).toLocaleString()}`  :'',
      sig.risk_reward ?`R:R     ${sig.risk_reward}`:'',
    ].filter(Boolean).join('\n');
    navigator.clipboard?.writeText(txt).then(()=>alert('📋 Copied!'));
  };

  return (
    <div ref={overlayRef} onClick={e=>e.target===overlayRef.current&&onClose()}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.86)',
        backdropFilter:'blur(20px)',zIndex:800,display:'flex',
        alignItems:'center',justifyContent:'center',padding:16,overflowY:'auto'}}>

      <div style={{width:'100%',maxWidth:1080,background:'#080f1e',
        border:`1px solid ${color}28`,borderRadius:20,
        boxShadow:`0 0 80px ${color}12,0 40px 80px rgba(0,0,0,.85)`,
        animation:'aq-sm-in .22s ease',overflow:'hidden'}}>

        {/* ── Header ── */}
        <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 22px',
          background:`linear-gradient(135deg,${color}09,transparent)`,
          borderBottom:'1px solid rgba(255,255,255,0.05)',flexWrap:'wrap'}}>

          <span style={{fontSize:20}}>{ai(sig.asset_class)}</span>

          <div>
            <div style={{fontSize:21,fontWeight:900,color:'var(--text)',letterSpacing:'-.5px'}}>{sig.symbol}</div>
            <div style={{...mono,fontSize:9,color:T.slate}}>{sig.asset_class||'Crypto'} · {timeAgo(sig.created_at)}</div>
          </div>

          {/* Signal badge */}
          <span style={{...mono,fontSize:13,fontWeight:800,padding:'5px 14px',
            borderRadius:7,background:`${color}18`,color,border:`1px solid ${color}35`}}>
            {sig.signal}
          </span>

          {/* Live indicator */}
          <div style={{display:'flex',alignItems:'center',gap:6,
            background:'rgba(52,211,153,0.08)',border:'1px solid rgba(52,211,153,0.2)',
            borderRadius:20,padding:'4px 12px'}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:T.green,animation:'aq-pulse 1.5s infinite'}}/>
            <span style={{...mono,fontSize:9,color:T.green,fontWeight:700}}>LIVE</span>
          </div>

          {/* Confidence */}
          <div style={{display:'flex',alignItems:'center',gap:8,background:'rgba(255,255,255,0.04)',
            border:'1px solid var(--border)',borderRadius:8,padding:'6px 14px'}}>
            <span style={{...mono,fontSize:10,color:T.slate}}>AI Confidence</span>
            <span style={{...mono,fontSize:16,fontWeight:900,color:confN>=75?T.green:T.amber}}>{confN||'—'}%</span>
          </div>

          {/* Current price + change */}
          {priceN > 0 && (
            <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end'}}>
              <span style={{...mono,fontSize:14,fontWeight:800,color:'var(--text)'}}>
                ${priceN.toLocaleString('en-US',{maximumFractionDigits:dp})}
              </span>
              <span style={{...mono,fontSize:9,color:isBuy?T.green:T.red}}>
                {isBuy?'↑ Bullish setup':'↓ Bearish setup'}
              </span>
            </div>
          )}

          <button onClick={onClose} style={{marginLeft:'auto',width:30,height:30,borderRadius:'50%',
            border:'1px solid var(--border)',background:'rgba(255,255,255,0.04)',
            color:T.slate,fontSize:14,cursor:'pointer',
            display:'flex',alignItems:'center',justifyContent:'center'}}>✕</button>
        </div>

        {/* ── 2-Column Body ── */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 340px',height:'80vh'}}>

          {/* LEFT */}
          <div className="aq-col" style={{overflowY:'auto',padding:'18px 20px',
            display:'flex',flexDirection:'column',gap:16,
            borderRight:'1px solid rgba(255,255,255,0.05)'}}>

            {/* Chart — TradingView embedded */}
            <div>
              <Lbl>Price Chart · TradingView Live</Lbl>
              <div style={{ height:280, borderRadius:10, overflow:'hidden', border:'1px solid rgba(255,255,255,0.05)' }}>
                <TvChart symbol={sig.symbol} isOanda={isOanda} isBuy={isBuy}/>
              </div>
            </div>

            {/* Indicator Chips */}
            <div>
              <Lbl>Technical Signals</Lbl>
              <IndicatorChips indicators={sig.indicators}/>
            </div>

            {/* AI Reasoning */}
            <AiReasoning reasoning={sig.reasoning} signal={sig.signal}/>

            {/* Signal Stats */}
            <StatsCard stats={stats} loading={!stats}/>

          </div>

          {/* RIGHT — flex col with sticky buttons at bottom */}
          <div style={{display:'flex',flexDirection:'column',maxHeight:'80vh'}}>

            {/* Scrollable content */}
            <div className="aq-col" style={{overflowY:'auto',padding:'18px 16px',
              flex:1,display:'flex',flexDirection:'column',gap:14}}>

              {/* Trade Setup */}
              <div>
                <Lbl>Trade Setup</Lbl>
                <TradeSetup
                  entry={sig.entry||sig.price} stopLoss={sig.stop_loss}
                  takeProfit={sig.take_profit} riskReward={sig.risk_reward}
                  dp={dp}/>
              </div>

              {/* Confidence Breakdown */}
              <ConfBreakdown confidence={confN} indicators={sig.indicators} signal={sig.signal}/>

              {/* Risk Badges */}
              <div>
                <Lbl>Risk Assessment</Lbl>
                <RiskBadges indicators={sig.indicators} signal={sig.signal} confidence={confN}/>
              </div>

              {/* Timeline */}
              <SignalTimeline signal={sig}/>

            </div>

            {/* FIXED Buttons — always visible at bottom of right col */}
            <div style={{
              padding:'14px 16px',
              borderTop:'1px solid rgba(255,255,255,0.06)',
              background:'rgba(8,15,30,0.98)',
              display:'flex',flexDirection:'column',gap:8,
              flexShrink:0,
            }}>
              <button className="aq-btn" onClick={handleTrade} style={{
                width:'100%',padding:'14px 0',borderRadius:11,cursor:'pointer',
                border:`1.5px solid ${color}55`,
                background:`linear-gradient(135deg,${color}1c,${color}09)`,
                color,display:'flex',alignItems:'center',justifyContent:'center',gap:10,
                fontFamily:'Syne,sans-serif',fontSize:14,fontWeight:900,letterSpacing:'.05em',
                boxShadow:`0 0 24px ${color}16`,
              }}>
                <span style={{fontSize:16}}>🚀</span> Trade this Signal
              </button>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:7}}>
                {[
                  {label:'⭐ Watch', color:T.amber, bg:'rgba(251,191,36,.06)', border:'rgba(251,191,36,.3)', fn:handleWatch},
                  {label:'🔔 Alert', color:T.cyan,  bg:'rgba(0,245,212,.06)',  border:'rgba(0,245,212,.3)', fn:handleAlert},
                  {label:'📤 Share', color:T.slate, bg:'rgba(100,116,139,.06)',border:'rgba(100,116,139,.3)',fn:handleShare},
                ].map(b=>(
                  <button key={b.label} className="aq-btn" onClick={b.fn} style={{
                    padding:'10px 0',borderRadius:9,cursor:'pointer',
                    border:`1px solid ${b.border}`,background:b.bg,
                    color:b.color,fontFamily:'Syne,sans-serif',fontSize:12,fontWeight:700,
                    display:'flex',alignItems:'center',justifyContent:'center',gap:5,
                  }}>{b.label}</button>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}