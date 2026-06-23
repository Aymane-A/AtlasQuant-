import { useEffect, useState, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ThreeBackground from '../components/ThreeBackground';
import { useTranslation } from 'react-i18next';
import LangSwitcher from '../components/LangSwitcher';

const INITIAL_TICKERS = [
  { symbol: 'BTC/USDT',   price: '…',  change: '…',   up: true  },
  { symbol: 'ETH/USDT',   price: '…',  change: '…',   up: false },
  { symbol: 'SOL/USDT',   price: '…',  change: '…',   up: false },
  { symbol: 'XRP/USDT',   price: '…',  change: '…',   up: true  },
  { symbol: 'BNB/USDT',   price: '…',  change: '…',   up: true  },
  { symbol: 'EUR/USD',    price: '…',  change: '…',   up: true  },
  { symbol: 'XAU/USD',    price: '…',  change: '…',   up: true  },
  { symbol: 'PEPE/USDT',  price: '…',  change: '…',   up: true  },
  { symbol: 'FEAR/GREED', price: '…',  change: '…',   up: false },
];

function fmtCryptoPrice(symbol, price) {
  if (symbol === 'PEPEUSDT') return `$${price.toFixed(8)}`;
  if (price >= 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (price >= 1)    return `$${price.toFixed(4)}`;
  return `$${price.toFixed(6)}`;
}

const BINANCE_MAP = {
  BTCUSDT:  'BTC/USDT',
  ETHUSDT:  'ETH/USDT',
  SOLUSDT:  'SOL/USDT',
  XRPUSDT:  'XRP/USDT',
  BNBUSDT:  'BNB/USDT',
  PEPEUSDT: 'PEPE/USDT',
};

// ─── CSS Stylesheet Isolation ────────────────────────────────────────────────
const css = `
html:has(.landing-page),
body:has(.landing-page),
#root:has(.landing-page) { background: #020408; }
body:has(.landing-page)::-webkit-scrollbar { width: 0; background: transparent; }
body:has(.landing-page):hover::-webkit-scrollbar { width: 8px; }
body:has(.landing-page)::-webkit-scrollbar-thumb { background: rgba(0,212,255,0.3); border-radius: 999px; }

.landing-page {
  --landing-bg: #020408; --landing-surface: #080d14; --landing-cyan: #00d4ff; --landing-cyan2: #0ea5e9;
  --landing-green: #00ff88; --landing-amber: #f59e0b; --landing-red: #ff4466; --landing-border: rgba(0,212,255,0.12);
  --landing-text: #e2f0ff; --landing-muted: #4a6080;
  min-height: 100vh; background: var(--landing-bg); color: var(--landing-text); overflow-x: hidden; position: relative;
}
.landing-grid { position: fixed; inset: 0; z-index: 0; pointer-events: none; background-image: linear-gradient(rgba(0,212,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,0.03) 1px,transparent 1px); background-size: 60px 60px; mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, black, transparent); }
.landing-orb { position: fixed; border-radius: 50%; filter: blur(80px); pointer-events: none; z-index: 0; }
.landing-orb.one { width:600px; height:600px; top:-200px; left:-100px; background:rgba(0,212,255,0.06); }
.landing-orb.two { width:400px; height:400px; bottom:100px; right:-100px; background:rgba(124,58,237,0.06); }
.landing-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between; padding: 20px 48px; background: linear-gradient(to bottom, rgba(2,4,8,0.95), transparent); backdrop-filter: blur(12px); }
.landing-logo { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; background: linear-gradient(135deg, var(--landing-cyan), var(--landing-cyan2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.landing-links { display: flex; gap: 32px; }
.landing-links a { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--landing-muted); text-decoration: none; }
.landing-links a:hover { color: var(--landing-cyan); }
.landing-cta { padding: 10px 24px; background: transparent; border: 1px solid var(--landing-cyan); color: var(--landing-cyan); font-size: 13px; font-weight: 700; letter-spacing: 0.06em; border-radius: 2px; cursor: pointer; }
.landing-cta:hover { background: var(--landing-cyan); color: var(--landing-bg); }
.landing-hero { position: relative; z-index: 2; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 120px 24px 80px; }
.landing-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border: 1px solid var(--landing-border); background: rgba(0,212,255,0.05); border-radius: 2px; margin-bottom: 32px; font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.1em; color: var(--landing-cyan); animation: landingFadeUp 0.8s ease both; }
.landing-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--landing-green); animation: landingPulse 1.5s infinite; }
.landing-title { font-size: clamp(44px, 7vw, 96px); font-weight: 800; line-height: 0.95; letter-spacing: -0.04em; margin: 0 0 24px; animation: landingFadeUp 0.8s 0.1s ease both; }
.landing-title span { display: block; }
.landing-gradient-text { background: linear-gradient(135deg, var(--landing-cyan) 0%, #7c3aed 50%, var(--landing-cyan2) 100%); background-size: 200% 200%; -webkit-background-clip: text; -webkit-text-fill-color: transparent; animation: landingGrad 4s ease infinite; }
.landing-sub { max-width: 520px; margin: 0 auto 40px; font-size: 16px; line-height: 1.7; color: var(--landing-muted); animation: landingFadeUp 0.8s 0.2s ease both; }
.landing-actions { display: flex; gap: 16px; justify-content: center; animation: landingFadeUp 0.8s 0.3s ease both; }
.landing-btn { padding: 14px 36px; font-size: 14px; font-weight: 700; letter-spacing: 0.05em; border-radius: 2px; cursor: pointer; border: none; transition: all 0.2s; }
.landing-btn.primary { background: linear-gradient(135deg, var(--landing-cyan), var(--landing-cyan2)); color: var(--landing-bg); box-shadow: 0 0 40px rgba(0,212,255,0.3); }
.landing-btn.secondary { background: transparent; border: 1px solid var(--landing-border); color: var(--landing-text); }
.landing-btn:hover { transform: translateY(-2px); }
.ticker-wrap { position: relative; z-index: 2; width: 100%; overflow: hidden; border-top: 1px solid var(--landing-border); border-bottom: 1px solid var(--landing-border); background: rgba(0,212,255,0.03); padding: 12px 0; }
.ticker-track { display: flex; animation: landingTicker 30s linear infinite; white-space: nowrap; }
.ticker-item { display: inline-flex; align-items: center; gap: 10px; padding: 0 36px; font-family: "JetBrains Mono", monospace; font-size: 12px; border-right: 1px solid var(--landing-border); }
@keyframes priceFlash { 0% { opacity: 0.3; transform: scale(0.96); } 40% { opacity: 1; transform: scale(1.04); } 100% { opacity: 1; transform: scale(1); } }
.price-updated { animation: priceFlash 0.4s ease; }
.landing-section { position: relative; z-index: 2; max-width: 1200px; margin: 0 auto; padding: 100px 24px; }
.section-label { font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--landing-cyan); margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
.section-label::before { content: ''; width: 32px; height: 1px; background: var(--landing-cyan); }
.section-title { font-size: clamp(32px, 5vw, 56px); font-weight: 800; line-height: 1.05; letter-spacing: -0.03em; margin: 0 0 16px; }
.section-sub { font-size: 16px; color: var(--landing-muted); max-width: 480px; line-height: 1.7; margin: 0 0 64px; }
.features-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: var(--landing-border); border: 1px solid var(--landing-border); }
.feature-card { background: var(--landing-surface); padding: 40px 32px; position: relative; overflow: hidden; }
.feature-card:hover { background: rgba(0,212,255,0.04); }
.feature-icon { width: 48px; height: 48px; margin-bottom: 24px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--landing-border); color: var(--landing-cyan); font-family: "JetBrains Mono", monospace; font-size: 12px; }
.feature-title { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
.feature-desc { font-size: 14px; color: var(--landing-muted); line-height: 1.7; }
.demo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.demo-card { background: var(--landing-surface); border: 1px solid var(--landing-border); padding: 28px; border-radius: 2px; position: relative; overflow: hidden; }
.signal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.signal-symbol { font-family: "JetBrains Mono", monospace; font-size: 20px; font-weight: 500; }
.signal-badge { padding: 4px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; border-radius: 2px; }
.signal-buy  { background: rgba(0,255,136,0.1); color: var(--landing-green); border: 1px solid rgba(0,255,136,0.3); }
.signal-sell { background: rgba(255,68,102,0.1); color: var(--landing-red);   border: 1px solid rgba(255,68,102,0.3); }
.signal-price { font-size: 32px; font-weight: 800; letter-spacing: -0.03em; margin-bottom: 20px; }
.indicator-row { display: flex; align-items: center; justify-content: space-between; font-family: "JetBrains Mono", monospace; font-size: 12px; margin-bottom: 10px; }
.ind-name { color: var(--landing-muted); width: 74px; }
.ind-bar-wrap { flex: 1; margin: 0 12px; height: 3px; background: rgba(255,255,255,0.05); border-radius: 2px; }
.ind-bar { height: 100%; border-radius: 2px; }
.ind-val { width: 54px; text-align: right; font-weight: 500; }
.confidence-ring { position: relative; width: 80px; height: 80px; margin: 20px auto 0; }
.confidence-ring svg { transform: rotate(-90deg); }
.confidence-ring .track { fill: none; stroke: rgba(255,255,255,0.05); stroke-width: 4; }
.confidence-ring .progress { fill: none; stroke-width: 4; stroke-linecap: round; }
.conf-label { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: "JetBrains Mono", monospace; }
.conf-pct { font-size: 18px; font-weight: 500; }
.conf-text { font-size: 9px; color: var(--landing-muted); letter-spacing: 0.08em; margin-top: 2px; }
.ai-box { margin-top: 24px; border-color: rgba(0,212,255,0.2); }
.ai-title { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--landing-cyan); letter-spacing: 0.1em; }
.ai-text { font-size: 14px; color: var(--landing-muted); line-height: 1.8; font-family: "JetBrains Mono", monospace; }
.stats-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 1px; background: var(--landing-border); border: 1px solid var(--landing-border); }
.stat-item { background: var(--landing-surface); padding: 40px 32px; text-align: center; }
.stat-val { font-size: 48px; font-weight: 800; letter-spacing: -0.04em; background: linear-gradient(135deg, var(--landing-cyan), var(--landing-cyan2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; line-height: 1; }
.stat-label { font-size: 12px; color: var(--landing-muted); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 8px; }
.markets-row { display: grid; grid-template-columns: repeat(3,1fr); gap: 16px; }
.market-pill { display: flex; align-items: center; gap: 14px; padding: 20px 24px; background: var(--landing-surface); border: 1px solid var(--landing-border); transition: all 0.2s; }
.market-pill:hover { border-color: var(--landing-cyan); transform: translateY(-2px); }
.market-icon { font-family: "JetBrains Mono", monospace; color: var(--landing-cyan); font-size: 14px; width: 38px; }
.market-name { font-size: 15px; font-weight: 700; }
.market-desc { font-size: 12px; color: var(--landing-muted); margin-top: 2px; }
.cta-section { position: relative; z-index: 2; text-align: center; padding: 100px 24px; background: linear-gradient(to bottom, transparent, rgba(0,212,255,0.03), transparent); border-top: 1px solid var(--landing-border); border-bottom: 1px solid var(--landing-border); }
.cta-glow { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 600px; height: 300px; background: radial-gradient(ellipse, rgba(0,212,255,0.08) 0%, transparent 70%); pointer-events: none; }
.landing-footer { position: relative; z-index: 2; padding: 40px 48px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--landing-border); font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--landing-muted); }
@keyframes landingFadeUp { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:translateY(0); } }
@keyframes landingPulse   { 0%,100%{opacity:1;transform:scale(1);} 50%{opacity:.4;transform:scale(.8);} }
@keyframes landingGrad    { 0%,100%{background-position:0% 50%;} 50%{background-position:100% 50%;} }
@keyframes landingTicker  { from{transform:translateX(0);} to{transform:translateX(-50%);} }

@media (max-width: 900px) {
  .landing-nav { padding: 16px 24px; }
  .landing-links { display: none; }
  .features-grid, .demo-grid, .markets-row { grid-template-columns: 1fr; }
  .stats-grid { grid-template-columns: repeat(2,1fr); }
  .landing-footer { flex-direction: column; gap: 16px; align-items: flex-start; }
}
`;

// ─── SignalCard Component ────────────────────────────────────────────────────
function SignalCard({ signal }) {
  const dash = 213.6;
  const offset = dash * (1 - signal.confidence / 100);
  return (
    <div className="demo-card">
      <div className="signal-header">
        <div className="signal-symbol">{signal.symbol}</div>
        <div className={`signal-badge ${signal.side === 'BUY' ? 'signal-buy' : 'signal-sell'}`}>{signal.side}</div>
      </div>
      <div className="signal-price">
        {signal.price}<span style={{ fontSize: 18, color: 'var(--landing-muted)' }}>{signal.cents}</span>
      </div>
      <div>
        {signal.indicators.map(ind => (
          <div className="indicator-row" key={ind.name}>
            <span className="ind-name">{ind.name}</span>
            <div className="ind-bar-wrap">
              <div className="ind-bar" style={{ width: `${ind.width}%`, background: ind.color }} />
            </div>
            <span className="ind-val" style={{ color: ind.color }}>{ind.value}</span>
          </div>
        ))}
      </div>
      <div className="confidence-ring">
        <svg width="80" height="80" viewBox="0 0 80 80">
          <circle className="track" cx="40" cy="40" r="34" />
          <circle className="progress" cx="40" cy="40" r="34" stroke={signal.color} strokeDasharray={dash} strokeDashoffset={offset} />
        </svg>
        <div className="conf-label">
          <span className="conf-pct" style={{ color: signal.color }}>{signal.confidence}%</span>
          <span className="conf-text">CONF</span>
        </div>
      </div>
    </div>
  );
}

// ─── TickerItem Component ────────────────────────────────────────────────────
function TickerItem({ ticker }) {
  const [flash, setFlash] = useState(false);
  const prevPriceRef = useRef(ticker.price);

  useEffect(() => {
    if (ticker.price !== prevPriceRef.current && ticker.price !== '…') {
      prevPriceRef.current = ticker.price;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 500);
      return () => clearTimeout(t);
    }
  }, [ticker.price]);

  return (
    <div className="ticker-item">
      <span style={{ color: 'var(--landing-cyan)', fontWeight: 500 }}>{ticker.symbol}</span>
      <span className={flash ? 'price-updated' : ''}>{ticker.price}</span>
      <span style={{ color: ticker.up ? 'var(--landing-green)' : 'var(--landing-red)' }}>{ticker.change}</span>
    </div>
  );
}

// ─── Main Landing Component ──────────────────────────────────────────────────
export default function Landing() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [tickers, setTickers] = useState(INITIAL_TICKERS);
  const [reasonIndex, setReasonIndex] = useState(0);

  // Use standard refs to properly safeguard memory layout configurations
  const prevEurRef = useRef(null);
  const prevXauRef = useRef(null);

  const updateTicker = (symbol, patch) =>
    setTickers(prev => prev.map(t => t.symbol === symbol ? { ...t, ...patch } : t));

  // 🛠️ Dynamic Localization Mapping for Arrays (100% Translation Ready)
  const features = useMemo(() => [
    { icon: 'API', title: t('landing.featuresList.api.title', 'Live Market Data'), desc: t('landing.featuresList.api.desc', 'Binance, CoinGecko, and Forex endpoints synchronized.') },
    { icon: 'TA',  title: t('landing.featuresList.ta.title', 'Technical Indicators'), desc: t('landing.featuresList.ta.desc', 'RSI-14, MACD, Bollinger Bands computed in real time.') },
    { icon: 'AI',  title: t('landing.featuresList.ai.title', 'Groq AI Analysis'), desc: t('landing.featuresList.ai.desc', 'LLaMA 3.3-70B structural decision parsing trees.') },
    { icon: 'GEM', title: t('landing.featuresList.gem.title', 'Gem Screener'), desc: t('landing.featuresList.gem.desc', 'Scans 250+ low-cap coins for volume breakout waves.') },
    { icon: 'RISK',title: t('landing.featuresList.risk.title', 'Risk Management'), desc: t('landing.featuresList.risk.desc', 'Automated Kelly sizing matrix metrics execution protection.') },
    { icon: 'AUTO',title: t('landing.featuresList.auto.title', 'Auto Execution'), desc: t('landing.featuresList.auto.desc', 'Secure direct integration keys with risk stop limit parameters.') },
  ], [t]);

  const signals = useMemo(() => [
    {
      symbol: 'BTC/USDT', side: 'BUY', price: '$80,429', cents: '.27', color: 'var(--landing-green)', confidence: 60,
      indicators: [
        { name: 'RSI', value: '43.06', width: 43, color: 'var(--landing-amber)' },
        { name: 'MACD', value: t('landing.signalsData.buy', 'BUY'), width: 72, color: 'var(--landing-green)' },
        { name: 'Fibonacci', value: '61.8%', width: 68, color: 'var(--landing-cyan)' },
        { name: 'EMA-50', value: t('landing.signalsData.above', 'Above'), width: 55, color: 'var(--landing-green)' },
      ],
    },
    {
      symbol: 'SOL/USDT', side: 'SELL', price: '$94', cents: '.32', color: 'var(--landing-red)', confidence: 70,
      indicators: [
        { name: 'RSI', value: '37.33', width: 37, color: 'var(--landing-amber)' },
        { name: 'MACD', value: t('landing.signalsData.sell', 'SELL'), width: 68, color: 'var(--landing-red)' },
        { name: 'Fibonacci', value: t('landing.signalsData.buy', 'BUY'), width: 40, color: 'var(--landing-green)' },
        { name: 'EMA-50', value: t('landing.signalsData.below', 'Below'), width: 60, color: 'var(--landing-red)' },
      ],
    },
  ], [t]);

  const reasons = useMemo(() => [
    { symbol: 'BTC/USDT', color: 'var(--landing-cyan)', text: t('landing.reasonsList.btc', 'MACD crossover plus Fibonacci 61.8% support.') },
    { symbol: 'BNB/USDT', color: 'var(--landing-amber)', text: t('landing.reasonsList.bnb', 'RSI 57.55 neutral with MA20 and MA50 both bullish.') },
    { symbol: 'SOL/USDT', color: 'var(--landing-red)', text: t('landing.reasonsList.sol', 'MACD bearish with declining purchase validation volumes.') },
  ], [t]);

  const stats = useMemo(() => [
    { value: '4', label: t('landing.statsList.apis', 'APIs Connected') },
    { value: '5+', label: t('landing.statsList.indicators', 'Indicators') },
    { value: '250+', label: t('landing.statsList.coins', 'Coins Screened') },
    { value: '24/7', label: t('landing.statsList.monitoring', 'Auto Monitoring') },
  ], [t]);

  const markets = useMemo(() => [
    { icon: 'BTC', name: t('landing.marketsList.crypto.name', 'Cryptocurrency'), desc: t('landing.marketsList.crypto.desc', 'BTC, ETH, SOL, XRP plus low-cap micro gem pairs') },
    { icon: 'FX',  name: t('landing.marketsList.forex.name', 'Forex'), desc: t('landing.marketsList.forex.desc', 'EUR/USD, GBP/USD and global asset currencies') },
    { icon: 'XAU', name: t('landing.marketsList.gold.name', 'Gold'), desc: t('landing.marketsList.gold.desc', 'XAU/USD real-time mathematical price evaluation models') },
  ], [t]);

  const currentReason = reasons[reasonIndex] || reasons[0];

  // ── 1. Binance WebSocket Stream (Safe Memory Execution Lifecycle) ──────────
  useEffect(() => {
    let ws = null;
    let isCancelled = false;

    const connect = () => {
      if (isCancelled) return;
      const streams = Object.keys(BINANCE_MAP).map(s => `${s.toLowerCase()}@ticker`).join('/');
      ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

      ws.onmessage = (event) => {
        try {
          const { data: d } = JSON.parse(event.data);
          const symbol = BINANCE_MAP[d.s];
          if (!symbol) return;
          const price = parseFloat(d.c);
          const change = parseFloat(d.P);
          const up = change >= 0;
          updateTicker(symbol, {
            price: fmtCryptoPrice(d.s, price),
            change: `${up ? '+' : ''}${change.toFixed(2)}%`,
            up,
          });
        } catch { /* Fail-silent stream structure parsing overrides */ }
      };

      ws.onerror = () => ws.close();
      ws.onclose = () => { if (!isCancelled) setTimeout(connect, 5000); };
    };

    connect();
    return () => { isCancelled = true; if (ws) ws.close(); };
  }, []);

  // ── 2. Fear & Greed Index Stream ───────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('https://api.alternative.me/fng/?limit=1');
        const json = await res.json();
        const val = json.data[0].value;
        const txt = json.data[0].value_classification;
        updateTicker('FEAR/GREED', { price: val, change: txt, up: parseInt(val, 10) >= 50 });
      } catch { /* Fallback fail-silent protection */ }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── 3. EUR/USD API Sync ────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('https://open.er-api.com/v6/latest/EUR');
        const json = await res.json();
        if (json.result !== 'success') return;
        const rate = json.rates.USD;
        const prev = prevEurRef.current;
        const diff = prev ? ((rate - prev) / prev * 100) : 0;
        prevEurRef.current = rate;
        updateTicker('EUR/USD', {
          price: rate.toFixed(4),
          change: prev ? `${diff >= 0 ? '+' : ''}${diff.toFixed(3)}%` : '+0.000%',
          up: diff >= 0,
        });
      } catch (e) { console.error('EUR/USD Sync Failure:', e); }
    };
    load();
    const id = setInterval(load, 60 * 60 * 1000); // Sensible 1h refreshing matrix
    return () => clearInterval(id);
  }, []);

  // ── 4. XAU/USD API Sync ────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd&include_24hr_change=true');
        const json = await res.json();
        const p = json['pax-gold'].usd;
        const c = json['pax-gold'].usd_24h_change ?? 0;
        const up = c >= 0;
        prevXauRef.current = p;
        updateTicker('XAU/USD', {
          price: `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
          change: `${up ? '+' : ''}${c.toFixed(2)}%`,
          up,
        });
      } catch { /* Maintain structural indicators dashboard placeholder safely */ }
    };
    load();
    const id = setInterval(load, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── Carousel Lifecycle & Smooth Scroller Hooks ─────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setReasonIndex(i => (i + 1) % reasons.length), 4000);
    return () => clearInterval(id);
  }, [reasons.length]);

  useEffect(() => {
    const prevBodyOF = document.body.style.overflow;
    const prevBodyOFY = document.body.style.overflowY;
    const prevBodyBG = document.body.style.background;
    const prevHtmlBG = document.documentElement.style.background;
    const prevScroll = document.documentElement.style.scrollBehavior;

    document.body.style.overflow = 'auto';
    document.body.style.overflowY = 'auto';
    document.body.style.background = '#020408';
    document.documentElement.style.background = '#020408';
    document.documentElement.style.scrollBehavior = 'smooth';

    return () => {
      document.body.style.overflow = prevBodyOF;
      document.body.style.overflowY = prevBodyOFY;
      document.body.style.background = prevBodyBG;
      document.documentElement.style.background = prevHtmlBG;
      document.documentElement.style.scrollBehavior = prevScroll;
    };
  }, []);

  return (
    <div className="landing-page">
      <style>{css}</style>
      <ThreeBackground />
      <div className="landing-grid" />
      <div className="landing-orb one" />
      <div className="landing-orb two" />

      {/* Navbar section */}
      <nav className="landing-nav">
        <div className="landing-logo">AtlasQuant AI</div>
        <div className="landing-links">
          <a href="#features">{t('landing.features')}</a>
          <a href="#signals">{t('landing.signals')}</a>
          <a href="#markets">{t('landing.markets')}</a>
          <a href="#pricing">{t('landing.getStart')}</a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="landing-cta" onClick={() => navigate('/login')}>
            {t('landing.launch')}
          </button>
          <LangSwitcher variant="landing" />
        </div>
      </nav>

      {/* Hero section */}
      <section className="landing-hero">
        <div className="landing-badge">
          <span className="landing-dot" />
          {t('landing.badge')}
        </div>
        <h1 className="landing-title">
          <span>{t('landing.title1')}</span>
          <span className="landing-gradient-text">{t('landing.title2')}</span>
        </h1>
        <p className="landing-sub">{t('landing.sub')}</p>
        <div className="landing-actions">
          <button className="landing-btn primary" onClick={() => navigate('/login')}>
            {t('landing.cta1')}
          </button>
          <button className="landing-btn secondary" onClick={() => navigate('/login?redirect=/signals')}>
            {t('landing.cta2')}
          </button>
        </div>
      </section>

      {/* Marquee ticker tape section */}
      <div className="ticker-wrap">
        <div className="ticker-track">
          {[...tickers, ...tickers].map((ticker, index) => (
            <TickerItem key={`${ticker.symbol}-${index}`} ticker={ticker} />
          ))}
        </div>
      </div>

      {/* Features specification showcase matrix */}
      <section className="landing-section" id="features">
        <div className="section-label">{t('landing.features')}</div>
        <h2 className="section-title">{t('landing.fTitle')}</h2>
        <p className="section-sub">{t('landing.fSub')}</p>
        <div className="features-grid">
          {features.map(f => (
            <div className="feature-card" key={f.title}>
              <div className="feature-icon">{f.icon}</div>
              <div className="feature-title">{f.title}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Interactive live metrics preview signals modules */}
      <section className="landing-section" id="signals">
        <div className="section-label">{t('landing.signals')}</div>
        <h2 className="section-title">{t('landing.sTitle')}</h2>
        <p className="section-sub">{t('landing.sSub')}</p>
        <div className="demo-grid">
          {signals.map(s => <SignalCard key={s.symbol} signal={s} />)}
        </div>
        <div className="demo-card ai-box">
          <div className="ai-title">GROQ AI — LLAMA 3.3-70B REASONING</div>
          <p className="ai-text">
            <span style={{ color: currentReason.color }}>{currentReason.symbol}</span> — {currentReason.text}
          </p>
        </div>
      </section>

      {/* Micro quantitative performance indicators overview stats layout */}
      <section className="landing-section" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <div className="stats-grid">
          {stats.map(item => (
            <div className="stat-item" key={item.label}>
              <div className="stat-val">{item.value}</div>
              <div className="stat-label">{item.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Tradable assets structural categorization component mapping */}
      <section className="landing-section" id="markets">
        <div className="section-label">{t('landing.markets')}</div>
        <h2 className="section-title">{t('landing.mTitle')}</h2>
        <p className="section-sub">{t('landing.mSub')}</p>
        <div className="markets-row">
          {markets.map(m => (
            <div className="market-pill" key={m.name}>
              <div className="market-icon">{m.icon}</div>
              <div>
                <div className="market-name">{m.name}</div>
                <div className="market-desc">{m.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Final promotional lead validation target segment layout */}
      <div className="cta-section" id="pricing">
        <div className="cta-glow" />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-label" style={{ justifyContent: 'center' }}>
            {t('landing.getStart')}
          </div>
          <h2 className="section-title" style={{ marginBottom: 16 }}>
            {t('landing.ctaTitle')}
          </h2>
          <p style={{ fontSize: 16, color: 'var(--landing-muted)', margin: '0 auto 40px', maxWidth: 400, lineHeight: 1.7 }}>
            {t('landing.ctaSub')}
          </p>
          <div className="landing-actions">
            <button className="landing-btn primary" onClick={() => navigate('/login')}>
              {t('landing.ctaBtn1')}
            </button>
            <button className="landing-btn secondary" onClick={() => navigate('/login?redirect=/dashboard')}>
              {t('landing.ctaBtn2')}
            </button>
          </div>
        </div>
      </div>

      {/* Application localized base interface footer layout specifications */}
      <footer className="landing-footer">
        <div>AtlasQuant AI 2026 — Built by Aymane Khiar</div>
        <div style={{ display: 'flex', gap: 24 }}>
          <span>v1.0.0</span>
          <span style={{ color: 'var(--landing-cyan)' }}>Live</span>
          <span>Paper Trading: ON</span>
        </div>
      </footer>
    </div>
  );
}