import { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, BarElement, ArcElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { useMarketData } from '../hooks/useMarketData';
import api from '../services/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler);

// Fallback Mock Data constants
const INITIAL_INDICES = [
  { region:'USA',  name:'S&P 500',    val:'5,224.62', ch:'+1.24%', up:true,  spark:[5100,5120,5150,5180,5160,5200,5224] },
  { region:'USA',  name:'NASDAQ',     val:'16,428.10',ch:'+1.87%', up:true,  spark:[16000,16100,16200,16300,16250,16380,16428] },
  { region:'USA',  name:'Dow Jones',  val:'38,842.00',ch:'+0.72%', up:true,  spark:[38500,38600,38650,38700,38720,38800,38842] },
  { region:'UK',   name:'FTSE 100',   val:'8,147.80', ch:'−0.18%', up:false, spark:[8200,8180,8170,8160,8150,8155,8147] },
  { region:'GER',  name:'DAX',        val:'18,384.35',ch:'+0.42%', up:true,  spark:[18200,18250,18280,18310,18350,18370,18384] },
  { region:'JPN',  name:'Nikkei 225', val:'38,460.00',ch:'−0.32%', up:false, spark:[38700,38600,38550,38500,38480,38470,38460] },
  { region:'CHN',  name:'Shanghai',   val:'3,084.50', ch:'+0.88%', up:true,  spark:[3040,3050,3060,3070,3075,3080,3084] },
  { region:'HKG',  name:'Hang Seng',  val:'17,284.00',ch:'+1.14%', up:true,  spark:[17000,17050,17100,17150,17200,17250,17284] },
];

const INITIAL_SECTORS = [
  { name:'Technology', ch:'+2.14%', v:'+$12.4B', intensity:0.9  },
  { name:'Energy',     ch:'−0.82%', v:'−$2.1B',  intensity:-0.4 },
  { name:'Healthcare', ch:'+0.54%', v:'+$3.2B',  intensity:0.3  },
  { name:'Financials', ch:'+1.22%', v:'+$8.1B',  intensity:0.6  },
  { name:'Consumer',   ch:'+0.38%', v:'+$1.8B',  intensity:0.2  },
  { name:'Real Estate',ch:'−1.24%', v:'−$4.2B',  intensity:-0.7 },
  { name:'Utilities',  ch:'−0.44%', v:'−$1.2B',  intensity:-0.2 },
  { name:'Materials',  ch:'+0.72%', v:'+$2.8B',  intensity:0.4  },
];

const INITIAL_COMMS = [
  { n:'Gold',        sym:'XAU/USD', v:'$2,380.40', ch:'+0.31%', up:true  },
  { n:'Silver',      sym:'XAG/USD', v:'$28.42',    ch:'+0.84%', up:true  },
  { n:'Crude Oil',   sym:'WTI',     v:'$78.42',    ch:'−0.62%', up:false },
  { n:'Brent',       sym:'BRENT',   v:'$82.18',    ch:'−0.44%', up:false },
  { n:'Natural Gas', sym:'NG',      v:'$2.124',    ch:'+1.20%', up:true  },
  { n:'Copper',      sym:'HG',      v:'$4.482',    ch:'+0.55%', up:true  },
];

const INITIAL_FOREX = [
  { p:'EUR/USD', v:'1.0842', ch:'−0.12%', up:false },
  { p:'GBP/USD', v:'1.2720', ch:'+0.08%', up:true  },
  { p:'USD/JPY', v:'154.82', ch:'+0.35%', up:true  },
  { p:'AUD/USD', v:'0.6542', ch:'+0.22%', up:true  },
  { p:'USD/CAD', v:'1.3724', ch:'−0.11%', up:false },
  { p:'USD/CHF', v:'0.9044', ch:'+0.18%', up:true  },
];

const INITIAL_CRYPTOS = [
  { s:'BTC',  v:'$67,420', c:'+1.20%', up:true  },
  { s:'ETH',  v:'$3,540',  c:'+0.84%', up:true  },
  { s:'BNB',  v:'$582',    c:'+0.42%', up:true  },
  { s:'SOL',  v:'$142',    c:'+3.14%', up:true  },
  { s:'XRP',  v:'$0.512',  c:'−1.24%', up:false },
  { s:'ADA',  v:'$0.448',  c:'−0.88%', up:false },
  { s:'AVAX', v:'$34.82',  c:'+2.10%', up:true  },
  { s:'DOGE', v:'$0.148',  c:'+4.82%', up:true  },
];

const INITIAL_TICKS = [
  { s:'SPY',     v:'522.40',  c:'+1.24%', u:true  },
  { s:'QQQ',     v:'448.82',  c:'+1.87%', u:true  },
  { s:'AAPL',    v:'188.42',  c:'+2.34%', u:true  },
  { s:'NVDA',    v:'875.50',  c:'−0.87%', u:false },
  { s:'TSLA',    v:'242.10',  c:'−0.41%', u:false },
  { s:'BTC',     v:'67,420',  c:'+1.20%', u:true  },
  { s:'ETH',     v:'3,540',   c:'+0.84%', u:true  },
  { s:'GOLD',    v:'2,380',   c:'+0.31%', u:true  },
  { s:'OIL',     v:'78.42',   c:'−0.62%', u:false },
  { s:'EUR/USD', v:'1.0842',  c:'−0.12%', u:false },
];

const cardStyle = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:16, transition:'all .2s' };
const panel = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:22 };
const monoSm = { fontFamily:'JetBrains Mono,monospace', fontSize:12 };
const label10 = { fontSize:10, letterSpacing:'.15em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' };

// ── Mapping nom d'indice affiché → ticker exploitable par le Backtester ──
// Les noms d'indices ("Nikkei 225", "Hang Seng"...) ne sont pas des
// tickers Yahoo valides pour l'historique de prix. On redirige vers un
// ETF/ticker liquide qui réplique l'indice et dispose d'un historique fiable.
const INDEX_BACKTEST_TICKER = {
  'S&P 500':    'SPY',
  'NASDAQ':     'QQQ',
  'Dow Jones':  'DIA',
  'FTSE 100':   'ISF.L',   // iShares Core FTSE 100 ETF
  'DAX':        'EXS1.DE', // iShares Core DAX ETF
  'Nikkei 225': 'EWJ',     // iShares MSCI Japan ETF (proxy liquide, historique fiable)
  'Shanghai':   'MCHI',    // iShares MSCI China ETF (proxy liquide)
  'Hang Seng':  '2800.HK', // Tracker Fund of Hong Kong (suit le Hang Seng directement)
};

function resolveBacktestSymbol(name) {
  return INDEX_BACKTEST_TICKER[name] || name;
}

// ── Symboles éligibles à l'ajout en watchlist (crypto + forex + commodities) ──
const WATCHLISTABLE_CATEGORIES = new Set(['crypto', 'forex', 'commodity']);

// ── Bouton étoile réutilisable pour l'ajout rapide en watchlist ──
function WatchlistStar({ symbol, category, onAdd, added }) {
  if (!WATCHLISTABLE_CATEGORIES.has(category)) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onAdd(symbol); }}
      title={added ? 'In watchlist' : 'Add to watchlist'}
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: added ? 'var(--amber)' : 'var(--text-muted)',
        fontSize: 13, padding: 2, lineHeight: 1, flexShrink: 0,
        transition: 'color .15s',
      }}
    >
      {added ? '★' : '☆'}
    </button>
  );
}

export default function Markets() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const m = key => t(`marketsPage.${key}`);

  const { data: streamData, connected } = useMarketData();

  const [watchlisted, setWatchlisted] = useState(new Set());
  const [toast, setToast] = useState(null);

  const currentTicks = streamData.ticks?.length ? streamData.ticks : INITIAL_TICKS;
  const currentIndices = streamData.indices?.length ? streamData.indices : INITIAL_INDICES;
  const currentSectors = streamData.sectors?.length ? streamData.sectors : INITIAL_SECTORS;
  const currentComms = streamData.comms?.length ? streamData.comms : INITIAL_COMMS;
  const currentForex = streamData.forex?.length ? streamData.forex : INITIAL_FOREX;
  const currentCryptos = streamData.cryptos?.length ? streamData.cryptos : INITIAL_CRYPTOS;

  // Fear & Greed réel (alternative.me, via le WebSocket) — fallback sur
  // une valeur neutre tant que le premier snapshot n'est pas arrivé.
  const fg = streamData.fearGreed?.value ?? 50;
  const fgLabel = streamData.fearGreed?.label || 'Neutral';

  const topMovers = streamData.topMovers || { gainers: [], losers: [] };

  // ── Charge la watchlist existante au montage, pour griser les étoiles déjà ajoutées ──
  useEffect(() => {
    api.get('/watchlist')
      .then(res => {
        const symbols = (res.data.stocks || []).map(s => s.symbol);
        setWatchlisted(new Set(symbols));
      })
      .catch(() => {});
  }, []);

  const addToWatchlist = async (symbol) => {
    const clean = symbol.toUpperCase().trim();
    try {
      await api.post('/watchlist', { symbol: clean });
      setWatchlisted(prev => new Set(prev).add(clean));
      setToast(`${clean} added to watchlist`);
      setTimeout(() => setToast(null), 2000);
    } catch {
      setToast(`Could not add ${clean}`);
      setTimeout(() => setToast(null), 2000);
    }
  };

  // ── Navigue vers le Backtester avec le symbole pré-rempli ──
  const goToBacktest = (symbol) => {
    navigate('/backtester', { state: { prefillSymbol: symbol } });
  };

  const globalChartOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { display: false }, y: { display: false } }
  }), []);

  const spChartData = useMemo(() => {
    const points = streamData.sp500Intraday?.length ? streamData.sp500Intraday : [5100, 5120, 5150, 5180, 5160, 5200, 5224];
    return {
      labels: points.map((_, i) => i),
      datasets: [{
        data: points,
        borderColor: '#00f5d4',
        backgroundColor: 'rgba(0,245,212,0.15)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      }],
    };
  }, [streamData.sp500Intraday]);

  const spChartOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 1200 },
    plugins: {
      legend: { display: false },
      tooltip: { mode: 'index', intersect: false, backgroundColor: 'rgba(3,7,18,0.95)', borderColor: 'rgba(0,245,212,0.3)', borderWidth: 1, padding: 10 }
    },
    scales: {
      x: { display: false },
      y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { maxTicksLimit: 4, font: { size: 10 }, callback: v => '$' + v.toFixed(0) } }
    }
  }), []);

  const optimizedIndices = useMemo(() => {
    return currentIndices.map((idx) => ({
      ...idx,
      chartData: {
        labels: idx.spark.map((_, j) => j),
        datasets: [{
          data: idx.spark,
          borderColor: idx.up ? '#34d399' : '#f87171',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: .4,
          fill: false
        }]
      }
    }));
  }, [currentIndices]);

  return (
    <>
      {/* Toast notification */}
      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 28, zIndex: 1000,
          background: 'rgba(3,7,18,0.95)', border: '1px solid rgba(0,245,212,0.3)',
          borderRadius: 8, padding: '10px 16px', ...monoSm, fontSize: 12,
          color: 'var(--cyan)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>
          {toast}
        </div>
      )}

      {/* Dynamic Status Connection Badge */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, ...monoSm, fontSize: 11 }}>
        <span style={{ color: connected ? 'var(--green)' : 'var(--red)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? 'var(--green)' : 'var(--red)' }} />
          {connected ? 'LIVE STREAM CONNECTED' : 'STREAM DISCONNECTED (MOCK MODE)'}
        </span>
      </div>

      {/* Live Ticker Tape */}
      <div style={{ overflow:'hidden', borderRadius:10, border:'1px solid var(--border)', background:'rgba(3,7,18,0.5)', marginBottom: 16 }}>
        <div style={{ display:'flex', animation:'tickerScroll 30s linear infinite', whiteSpace:'nowrap' }}>
          {[...currentTicks, ...currentTicks].map((tk, i) => (
            <div key={i} style={{ padding:'10px 20px', borderRight:'1px solid var(--border)', ...monoSm, display:'inline-flex', gap:10, alignItems:'center', flexShrink:0 }}>
              <span style={{ color:'var(--text-secondary)' }}>{tk.s}</span>
              <span>{tk.v}</span>
              <span style={{ color: tk.u ? 'var(--green)' : 'var(--red)' }}>{tk.c}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Top Movers */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom: 16 }}>
        <div style={panel}>
          <div style={{ fontSize:12, fontWeight:600, marginBottom:12, display:'flex', alignItems:'center', gap:8, color:'var(--green)' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} /> {m('topGainers') || 'Top Gainers'}
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {topMovers.gainers.length === 0 ? (
              <div style={{ ...monoSm, fontSize:11, color:'var(--text-muted)' }}>—</div>
            ) : topMovers.gainers.map(g => (
              <div key={`${g.category}-${g.symbol}`} style={{ display:'flex', justifyContent:'space-between', ...monoSm, fontSize:11 }}>
                <span style={{ color:'var(--text-secondary)' }}>{g.symbol} <span style={{ color:'var(--text-muted)', fontSize:9 }}>{g.category}</span></span>
                <span style={{ color:'var(--green)', fontWeight:600 }}>+{g.changePct.toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
        <div style={panel}>
          <div style={{ fontSize:12, fontWeight:600, marginBottom:12, display:'flex', alignItems:'center', gap:8, color:'var(--red)' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--red)' }} /> {m('topLosers') || 'Top Losers'}
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {topMovers.losers.length === 0 ? (
              <div style={{ ...monoSm, fontSize:11, color:'var(--text-muted)' }}>—</div>
            ) : topMovers.losers.map(l => (
              <div key={`${l.category}-${l.symbol}`} style={{ display:'flex', justifyContent:'space-between', ...monoSm, fontSize:11 }}>
                <span style={{ color:'var(--text-secondary)' }}>{l.symbol} <span style={{ color:'var(--text-muted)', fontSize:9 }}>{l.category}</span></span>
                <span style={{ color:'var(--red)', fontWeight:600 }}>{l.changePct.toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Market Status + F&G */}
      <div style={{ display:'flex', gap:12, marginBottom: 16 }}>
        {[
          { name:'NYSE',    open:true,  infoKey:'openLeft'       },
          { name:'NASDAQ',  open:true,  infoKey:'openLeft'       },
          { name:'LSE',     open:false, infoKey:'closedOpensGmt' },
          { name:'TSE',     open:false, infoKey:'closedOpensJst' },
        ].map(mk => (
          <div key={mk.name} style={{ flex:1, ...cardStyle, display:'flex', alignItems:'center', gap:12, borderColor: mk.open ? 'rgba(52,211,153,0.2)' : 'var(--border)' }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background: mk.open ? 'var(--green)' : 'var(--text-muted)' }} />
            <div>
              <div style={{ fontSize:12, fontWeight:600 }}>{mk.name}</div>
              <div style={{ ...monoSm, fontSize:10, color: mk.open ? 'var(--green)' : 'var(--text-muted)', marginTop:2 }}>{m(mk.infoKey)}</div>
            </div>
          </div>
        ))}
        <div style={{ flex:2, ...cardStyle }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <span style={{ ...monoSm, fontSize:10, color:'var(--text-secondary)' }}>{m('fearGreed')}</span>
            <span style={{ ...monoSm, fontSize:9, color:'var(--text-muted)' }}>{fgLabel}</span>
          </div>
          <div style={{ height:8, borderRadius:4, background:'linear-gradient(90deg,#34d399,#fbbf24,#f87171)', position:'relative', margin:'12px 0' }}>
            <div style={{ position:'absolute', top:-2, left:`${fg}%`, transform:'translateX(-50%)', width:12, height:12, background:'white', borderRadius:'50%', boxShadow:'0 2px 8px rgba(0,0,0,0.5)' }} />
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', ...monoSm, fontSize:9, color:'var(--text-muted)' }}>
            <span>{m('fear')}</span>
            <span style={{ color:'var(--green)', fontSize:11, fontWeight:600 }}>{fg} {m('greedSuffix')}</span>
            <span>{m('extreme')}</span>
          </div>
        </div>
      </div>

      {/* Global Indices */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:14 }}>
          {m('globalIndices')}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
          {optimizedIndices.map((idx) => (
            <div key={idx.name} style={{ ...cardStyle, cursor:'pointer' }} onClick={() => goToBacktest(resolveBacktestSymbol(idx.name))}>
              <div style={{ ...label10, marginBottom:4 }}>{idx.region}</div>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:8 }}>{idx.name}</div>
              <div style={{ fontSize:20, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color: idx.up ? 'var(--green)' : 'var(--red)' }}>{idx.val}</div>
              <div style={{ ...monoSm, color: idx.up ? 'var(--green)' : 'var(--red)', marginTop:2, marginBottom:10, fontSize:11 }}>{idx.ch}</div>
              <div style={{ height:28 }}>
                <Line
                  data={idx.chartData}
                  options={globalChartOpts}
                  height={28}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sector Heatmap + S&P Intraday */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.2fr', gap:16, marginBottom: 16 }}>
        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} /> {m('sectorPerf')}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
            {currentSectors.map(s => {
              const pos = s.intensity > 0;
              const a = Math.abs(s.intensity);
              const bg = pos ? `rgba(52,211,153,${0.1+a*0.25})` : `rgba(248,113,113,${0.1+a*0.25})`;
              const bc = pos ? `rgba(52,211,153,${0.2+a*0.3})` : `rgba(248,113,113,${0.2+a*0.3})`;
              return (
                <div key={s.name} style={{ background:bg, border:`1px solid ${bc}`, borderRadius:10, padding:14, minHeight:80, display:'flex', flexDirection:'column', justifyContent:'space-between', transition:'transform .2s', cursor:'default' }}
                  onMouseOver={e=>e.currentTarget.style.transform='scale(1.03)'}
                  onMouseOut={e=>e.currentTarget.style.transform='scale(1)'}>
                  <div style={{ fontSize:11, fontWeight:600, color: pos?'#34d399':'#f87171' }}>{s.name}</div>
                  <div>
                    <div style={{ fontSize:16, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color: pos?'var(--green)':'var(--red)' }}>{s.ch}</div>
                    <div style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', color: pos?'#34d399':'#f87171', opacity:.7, marginTop:4 }}>{s.v}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} /> {m('spIntraday')}
          </div>
          <div style={{ position:'relative', height:240 }}>
            <Line data={spChartData} options={spChartOpts} />
          </div>
        </div>
      </div>

      {/* Commodities + Forex */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom: 16 }}>
        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} /> {m('commodities')}
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>{['', m('colCommodity'), m('colSymbol'), m('colPrice'), m('colChange')].map((h,hi)=><th key={hi} style={{ textAlign:'left', padding:'9px 12px', ...label10, borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {currentComms.map(c=>(
                <tr key={c.sym} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', cursor:'pointer' }} onClick={() => goToBacktest(c.sym)}>
                  <td style={{ padding:'11px 8px', width: 20 }}>
                    <WatchlistStar symbol={c.sym} category="commodity" onAdd={addToWatchlist} added={watchlisted.has(c.sym.toUpperCase())} />
                  </td>
                  <td style={{ padding:'11px 12px', ...monoSm }}>{c.n || c.name}</td>
                  <td style={{ padding:'11px 12px', ...monoSm, color:'var(--text-muted)' }}>{c.sym}</td>
                  <td style={{ padding:'11px 12px', ...monoSm }}>{c.v || c.val}</td>
                  <td style={{ padding:'11px 12px', ...monoSm, color: c.up?'var(--green)':'var(--red)' }}>{c.ch || c.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} /> {m('forexPairs')}
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>{['', m('colPair'), m('colRate'), m('colChange'), m('colTrend')].map((h,hi)=><th key={hi} style={{ textAlign:'left', padding:'9px 12px', ...label10, borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {currentForex.map(f=>(
                <tr key={f.p || f.pair} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', cursor:'pointer' }} onClick={() => goToBacktest(f.p)}>
                  <td style={{ padding:'11px 8px', width: 20 }}>
                    <WatchlistStar symbol={f.p} category="forex" onAdd={addToWatchlist} added={watchlisted.has((f.p || '').toUpperCase())} />
                  </td>
                  <td style={{ padding:'11px 12px', ...monoSm, fontWeight:600 }}>{f.p || f.pair}</td>
                  <td style={{ padding:'11px 12px', ...monoSm }}>{f.v || f.val}</td>
                  <td style={{ padding:'11px 12px', ...monoSm, color: f.up?'var(--green)':'var(--red)' }}>{f.ch || f.change}</td>
                  <td style={{ padding:'11px 12px' }}><div style={{ width:40, height:2, background: f.up?'rgba(52,211,153,0.4)':'rgba(248,113,113,0.4)', borderRadius:1 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Crypto */}
      <div style={panel}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} /> {m('cryptoTop8')}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(8,1fr)', gap:10 }}>
          {currentCryptos.map(c=>{
            const symbol = c.s || c.symbol;
            return (
              <div key={symbol} style={{ ...cardStyle, textAlign:'center', padding:12, cursor:'pointer', position:'relative' }}
                onClick={() => goToBacktest(symbol)}
                onMouseOver={e=>e.currentTarget.style.borderColor='rgba(0,245,212,0.2)'}
                onMouseOut={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <div style={{ position:'absolute', top:6, right:8 }}>
                  <WatchlistStar symbol={symbol} category="crypto" onAdd={addToWatchlist} added={watchlisted.has(symbol.toUpperCase())} />
                </div>
                <div style={{ fontSize:12, fontWeight:700, marginBottom:4 }}>{symbol}</div>
                <div style={{ fontSize:13, ...monoSm, fontWeight:600, color: c.up?'var(--green)':'var(--red)' }}>{c.v || c.val}</div>
                <div style={{ fontSize:10, ...monoSm, color: c.up?'var(--green)':'var(--red)', marginTop:3 }}>{c.c || c.change}</div>
              </div>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes tickerScroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      `}</style>
    </>
  );
}