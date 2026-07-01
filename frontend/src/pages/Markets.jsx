import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, BarElement, ArcElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { useMarketData } from '../hooks/useMarketData';
import { useSignals } from '../hooks/useSignals';
import api from '../services/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler);

const cardStyle = { borderRadius:12, padding:16, transition:'all .2s' };
const panel = { borderRadius:14, padding:22 };
const monoSm = { fontFamily:'JetBrains Mono,monospace', fontSize:12 };
const label10 = { fontSize:10, letterSpacing:'.15em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' };

const SIGNAL_COLOR = { BUY:'var(--green)', SELL:'var(--red)', HOLD:'var(--amber)' };
// Seuil minimum pour afficher un badge de signal — évite la saturation
// visuelle quand la majorité des actifs ont un signal BUY/SELL faible.
const SIGNAL_MIN_CONFIDENCE = 70;

const NEWS_CATEGORY_COLOR = { Crypto:'var(--cyan)', Forex:'var(--purple-bright)', Commodity:'var(--amber)' };

// ── Mapping nom d'indice affiché → ticker exploitable par le Backtester ──
const INDEX_BACKTEST_TICKER = {
  'S&P 500':    'SPY',
  'NASDAQ':     'QQQ',
  'Dow Jones':  'DIA',
  'FTSE 100':   'ISF.L',
  'DAX':        'EXS1.DE',
  'Nikkei 225': 'EWJ',
  'Shanghai':   'MCHI',
  'Hang Seng':  '2800.HK',
};

function resolveBacktestSymbol(name) {
  return INDEX_BACKTEST_TICKER[name] || name;
}

const WATCHLISTABLE_CATEGORIES = new Set(['crypto', 'forex', 'commodity']);

const MARKET_TO_SIGNAL_SYMBOL = {
  WTI:    'OIL/USD',
  NG:     'NATGAS',
  HG:     'COPPER',
  BRENT:  null,
};

function toSignalSymbol(rawSymbol, category) {
  if (!rawSymbol) return null;
  const clean = rawSymbol.toUpperCase().trim();
  if (category === 'crypto') return clean;
  if (MARKET_TO_SIGNAL_SYMBOL[clean] !== undefined) return MARKET_TO_SIGNAL_SYMBOL[clean];
  return clean;
}

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

// ── Badge signal — uniquement pour les signaux à forte confiance ──
function SignalDot({ symbol, category, signalMap }) {
  const sigKey = toSignalSymbol(symbol, category);
  if (!sigKey) return null;

  let match = signalMap.get(sigKey);
  if (!match && category === 'crypto') {
    for (const [k, v] of signalMap) {
      if (k.startsWith(sigKey)) { match = v; break; }
    }
  }
  if (!match || match.signal === 'HOLD' || match.confidence < SIGNAL_MIN_CONFIDENCE) return null;

  const color = SIGNAL_COLOR[match.signal];
  return (
    <span
      title={`Active ${match.signal} signal — ${match.confidence}% confidence`}
      style={{
        display:'inline-flex', alignItems:'center', gap:3, marginLeft:6,
        fontSize:9, fontFamily:'JetBrains Mono,monospace', fontWeight:700,
        padding:'1px 6px', borderRadius:4, background:`${color}1a`, color,
        border:`1px solid ${color}33`, letterSpacing:'.05em',
      }}
    >
      ◈ {match.signal}
    </span>
  );
}

function PanelState({ loading, empty, label }) {
  if (!loading && !empty) return null;
  return (
    <div style={{
      padding:'30px 12px', textAlign:'center', ...monoSm, fontSize:11,
      color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.08em',
    }}>
      {loading ? `Loading ${label}...` : `No ${label} data available`}
    </div>
  );
}

// ── Formate un temps écoulé lisible ("just now", "5m ago", "2h ago") ──
function timeAgo(iso) {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 10)  return 'just now';
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function Markets() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const m = key => t(`marketsPage.${key}`);

  const { data: streamData, connected } = useMarketData();
  const { signals } = useSignals('4h');

  const [watchlisted, setWatchlisted] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');

  const [calendar, setCalendar] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(true);

  const [news, setNews] = useState([]);
  const [newsLoading, setNewsLoading] = useState(true);

  // ── "Updated Xs ago" — se déclenche à chaque nouveau snapshot WebSocket ──
  const [lastSnapshotAt, setLastSnapshotAt] = useState(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (streamData && Object.keys(streamData).length > 0) {
      setLastSnapshotAt(streamData.fetchedAt ? new Date(streamData.fetchedAt) : new Date());
    }
  }, [streamData]);

  useEffect(() => {
    const id = setInterval(() => forceTick(x => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ticks    = streamData.ticks    || [];
  const indices  = streamData.indices  || [];
  const sectors  = streamData.sectors  || [];
  const comms    = streamData.comms    || [];
  const forex    = streamData.forex    || [];
  const cryptos  = streamData.cryptos  || [];

  const dataReady = connected && (indices.length > 0 || comms.length > 0 || forex.length > 0 || cryptos.length > 0);
  const loading    = !connected || (!dataReady && indices.length === 0 && comms.length === 0 && forex.length === 0 && cryptos.length === 0);

  const fg      = streamData.fearGreed?.value ?? null;
  const fgLabel = streamData.fearGreed?.label || '—';

  const topMovers = streamData.topMovers || { gainers: [], losers: [] };

  const signalMap = useMemo(() => {
    const map = new Map();
    (signals || []).forEach(s => {
      if (s.signal && s.signal !== 'HOLD') map.set(s.symbol.toUpperCase(), s);
    });
    return map;
  }, [signals]);

  useEffect(() => {
    api.get('/watchlist')
      .then(res => {
        const symbols = (res.data.stocks || []).map(s => s.symbol);
        setWatchlisted(new Set(symbols));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.get('/market/economic-calendar')
      .then(res => setCalendar(res.data.events || []))
      .catch(() => {})
      .finally(() => setCalendarLoading(false));
  }, []);

  useEffect(() => {
    api.get('/market/news')
      .then(res => setNews(res.data.articles || []))
      .catch(() => {})
      .finally(() => setNewsLoading(false));
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

  const goToBacktest = (symbol) => {
    navigate('/backtester', { state: { prefillSymbol: symbol } });
  };

  const fmtEventTime = (dt) => {
    if (!dt) return '—';
    const d = new Date(dt);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Today ${time}`;
    return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  };

  const globalChartOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { display: false }, y: { display: false } }
  }), []);

  const spChartData = useMemo(() => {
    const points = streamData.sp500Intraday?.length ? streamData.sp500Intraday : [];
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
    return indices.map((idx) => ({
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
  }, [indices]);

  const matchesSearch = (name = '', symbol = '') => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return name.toLowerCase().includes(q) || symbol.toLowerCase().includes(q);
  };

  const filteredIndices = useMemo(() => optimizedIndices.filter(i => matchesSearch(i.name, i.region)), [optimizedIndices, search]);
  const filteredComms   = useMemo(() => comms.filter(c => matchesSearch(c.n, c.sym)), [comms, search]);
  const filteredForex   = useMemo(() => forex.filter(f => matchesSearch(f.p, f.p)), [forex, search]);
  const filteredCryptos = useMemo(() => cryptos.filter(c => matchesSearch(c.s, c.s)), [cryptos, search]);

  return (
    <>
      {toast && (
        <div className="glass-panel" style={{
          position: 'fixed', top: 80, right: 28, zIndex: 1000,
          borderRadius: 8, padding: '10px 16px', ...monoSm, fontSize: 12,
          color: 'var(--cyan)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          borderColor: 'rgba(0,245,212,0.3)',
        }}>
          {toast}
        </div>
      )}

      {/* Status + Last update */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 14, marginBottom: 10, ...monoSm, fontSize: 11 }}>
        {lastSnapshotAt && (
          <span style={{ color: 'var(--text-muted)' }}>
            Updated {timeAgo(lastSnapshotAt.toISOString())}
          </span>
        )}
        <span style={{ color: connected ? 'var(--green)' : 'var(--red)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? 'var(--green)' : 'var(--red)' }} />
          {connected ? 'LIVE STREAM CONNECTED' : 'CONNECTING TO STREAM...'}
        </span>
      </div>

      {/* Search Bar */}
      <div className="glass-panel" style={{ borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>⌕</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbol or asset (e.g. gold, EUR, BTC)..."
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontFamily: 'JetBrains Mono,monospace', fontSize: 12,
          }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>×</button>
        )}
      </div>

      {/* Live Ticker Tape */}
      <div className="glass-panel" style={{ overflow:'hidden', borderRadius:10, marginBottom: 16, minHeight: 42 }}>
        {ticks.length === 0 ? (
          <PanelState loading={loading} empty={!loading} label="ticker" />
        ) : (
          <div style={{ display:'flex', animation:'tickerScroll 30s linear infinite', whiteSpace:'nowrap' }}>
            {[...ticks, ...ticks].map((tk, i) => (
              <div key={i} style={{ padding:'10px 20px', borderRight:'1px solid var(--border)', ...monoSm, display:'inline-flex', gap:10, alignItems:'center', flexShrink:0 }}>
                <span style={{ color:'var(--text-secondary)' }}>{tk.s}</span>
                <span>{tk.v}</span>
                <span style={{ color: tk.u ? 'var(--green)' : 'var(--red)' }}>{tk.c}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top Movers */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom: 16 }}>
        <div className="glass-panel" style={panel}>
          <div style={{ fontSize:12, fontWeight:600, marginBottom:12, display:'flex', alignItems:'center', gap:8, color:'var(--green)' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} /> {m('topGainers') || 'Top Gainers'}
          </div>
          {loading ? (
            <PanelState loading label="gainers" />
          ) : topMovers.gainers.length === 0 ? (
            <div style={{ ...monoSm, fontSize:11, color:'var(--text-muted)' }}>—</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {topMovers.gainers.map(g => (
                <div key={`${g.category}-${g.symbol}`} style={{ display:'flex', justifyContent:'space-between', ...monoSm, fontSize:11 }}>
                  <span style={{ color:'var(--text-secondary)' }}>{g.symbol} <span style={{ color:'var(--text-muted)', fontSize:9 }}>{g.category}</span></span>
                  <span style={{ color:'var(--green)', fontWeight:600 }}>+{g.changePct.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="glass-panel" style={panel}>
          <div style={{ fontSize:12, fontWeight:600, marginBottom:12, display:'flex', alignItems:'center', gap:8, color:'var(--red)' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--red)' }} /> {m('topLosers') || 'Top Losers'}
          </div>
          {loading ? (
            <PanelState loading label="losers" />
          ) : topMovers.losers.length === 0 ? (
            <div style={{ ...monoSm, fontSize:11, color:'var(--text-muted)' }}>—</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {topMovers.losers.map(l => (
                <div key={`${l.category}-${l.symbol}`} style={{ display:'flex', justifyContent:'space-between', ...monoSm, fontSize:11 }}>
                  <span style={{ color:'var(--text-secondary)' }}>{l.symbol} <span style={{ color:'var(--text-muted)', fontSize:9 }}>{l.category}</span></span>
                  <span style={{ color:'var(--red)', fontWeight:600 }}>{l.changePct.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          )}
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
          <div key={mk.name} className="glass-panel" style={{ flex:1, ...cardStyle, display:'flex', alignItems:'center', gap:12, borderColor: mk.open ? 'rgba(52,211,153,0.2)' : undefined }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background: mk.open ? 'var(--green)' : 'var(--text-muted)' }} />
            <div>
              <div style={{ fontSize:12, fontWeight:600 }}>{mk.name}</div>
              <div style={{ ...monoSm, fontSize:10, color: mk.open ? 'var(--green)' : 'var(--text-muted)', marginTop:2 }}>{m(mk.infoKey)}</div>
            </div>
          </div>
        ))}
        <div className="glass-panel" style={{ flex:2, ...cardStyle }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <span style={{ ...monoSm, fontSize:10, color:'var(--text-secondary)' }}>{m('fearGreed')}</span>
            <span style={{ ...monoSm, fontSize:9, color:'var(--text-muted)' }}>{fgLabel}</span>
          </div>
          {fg === null ? (
            <div style={{ ...monoSm, fontSize:11, color:'var(--text-muted)', textAlign:'center', padding:'10px 0' }}>—</div>
          ) : (
            <>
              <div style={{ height:8, borderRadius:4, background:'linear-gradient(90deg,#34d399,#fbbf24,#f87171)', position:'relative', margin:'12px 0' }}>
                <div style={{ position:'absolute', top:-2, left:`${fg}%`, transform:'translateX(-50%)', width:12, height:12, background:'white', borderRadius:'50%', boxShadow:'0 2px 8px rgba(0,0,0,0.5)' }} />
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', ...monoSm, fontSize:9, color:'var(--text-muted)' }}>
                <span>{m('fear')}</span>
                <span style={{ color:'var(--green)', fontSize:11, fontWeight:600 }}>{fg} {m('greedSuffix')}</span>
                <span>{m('extreme')}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Global Indices */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:14 }}>
          {m('globalIndices')}
        </div>
        {indices.length === 0 ? (
          <div className="glass-panel" style={{ borderRadius:12 }}>
            <PanelState loading={loading} empty={!loading} label="indices" />
          </div>
        ) : filteredIndices.length === 0 ? (
          <div className="glass-panel" style={{ borderRadius:12 }}>
            <PanelState loading={false} empty label="matching indices" />
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
            {filteredIndices.map((idx) => (
              <div key={idx.name} className="glass-panel" style={{ ...cardStyle, cursor:'pointer' }} onClick={() => goToBacktest(resolveBacktestSymbol(idx.name))}>
                <div style={{ ...label10, marginBottom:4 }}>{idx.region}</div>
                <div style={{ fontSize:13, fontWeight:600, marginBottom:8 }}>{idx.name}</div>
                <div style={{ fontSize:20, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color: idx.up ? 'var(--green)' : 'var(--red)' }}>{idx.val}</div>
                <div style={{ ...monoSm, color: idx.up ? 'var(--green)' : 'var(--red)', marginTop:2, marginBottom:10, fontSize:11 }}>{idx.ch}</div>
                <div style={{ height:28 }}>
                  <Line data={idx.chartData} options={globalChartOpts} height={28} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sector Heatmap + S&P Intraday */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.2fr', gap:16, marginBottom: 16 }}>
        <div className="glass-panel" style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} /> {m('sectorPerf')}
          </div>
          {sectors.length === 0 ? (
            <PanelState loading={loading} empty={!loading} label="sectors" />
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
              {sectors.map(s => {
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
                      {s.v && <div style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', color: pos?'#34d399':'#f87171', opacity:.7, marginTop:4 }}>{s.v}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass-panel" style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} /> {m('spIntraday')}
          </div>
          <div style={{ position:'relative', height:240 }}>
            {spChartData.labels.length === 0 ? (
              <PanelState loading={loading} empty={!loading} label="chart" />
            ) : (
              <Line data={spChartData} options={spChartOpts} />
            )}
          </div>
        </div>
      </div>

      {/* Economic Calendar */}
      <div className="glass-panel" style={{ ...panel, marginBottom: 16 }}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--red)' }} />
          Economic Calendar
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 6 }}>
            This week
          </span>
        </div>
        {calendarLoading ? (
          <PanelState loading label="calendar" />
        ) : calendar.length === 0 ? (
          <div style={{ ...monoSm, fontSize: 11, color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
            No upcoming events
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
            {calendar.map((ev, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px',
                borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
              }}>
                <div style={{ width: 4, height: 32, borderRadius: 2, background: ev.impactColor, flexShrink: 0 }} />
                <div style={{ width: 42, flexShrink: 0, ...monoSm, fontSize: 10, color: 'var(--text-muted)' }}>
                  {ev.country}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {ev.title}
                  </div>
                  <div style={{ ...monoSm, fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {fmtEventTime(ev.datetime)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, ...monoSm, fontSize: 10, flexShrink: 0 }}>
                  {ev.actual && <span style={{ color: 'var(--cyan)' }}>A: {ev.actual}</span>}
                  {ev.forecast && <span style={{ color: 'var(--text-secondary)' }}>F: {ev.forecast}</span>}
                  {ev.previous && <span style={{ color: 'var(--text-muted)' }}>P: {ev.previous}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Commodities + Forex */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom: 16 }}>
        <div className="glass-panel" style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} /> {m('commodities')}
          </div>
          {comms.length === 0 ? (
            <PanelState loading={loading} empty={!loading} label="commodities" />
          ) : filteredComms.length === 0 ? (
            <PanelState loading={false} empty label="matching commodities" />
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>{['', m('colCommodity'), m('colSymbol'), m('colPrice'), m('colChange')].map((h,hi)=><th key={hi} style={{ textAlign:'left', padding:'9px 12px', ...label10, borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {filteredComms.map(c=>(
                  <tr key={c.sym} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', cursor:'pointer' }} onClick={() => goToBacktest(c.sym)}>
                    <td style={{ padding:'11px 8px', width: 20 }}>
                      <WatchlistStar symbol={c.sym} category="commodity" onAdd={addToWatchlist} added={watchlisted.has(c.sym.toUpperCase())} />
                    </td>
                    <td style={{ padding:'11px 12px', ...monoSm }}>
                      {c.n || c.name}
                      <SignalDot symbol={c.sym} category="commodity" signalMap={signalMap} />
                    </td>
                    <td style={{ padding:'11px 12px', ...monoSm, color:'var(--text-muted)' }}>{c.sym}</td>
                    <td style={{ padding:'11px 12px', ...monoSm }}>{c.v}</td>
                    <td style={{ padding:'11px 12px', ...monoSm, color: c.up?'var(--green)':'var(--red)' }}>{c.ch}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="glass-panel" style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} /> {m('forexPairs')}
          </div>
          {forex.length === 0 ? (
            <PanelState loading={loading} empty={!loading} label="forex pairs" />
          ) : filteredForex.length === 0 ? (
            <PanelState loading={false} empty label="matching pairs" />
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>{['', m('colPair'), m('colRate'), m('colChange'), m('colTrend')].map((h,hi)=><th key={hi} style={{ textAlign:'left', padding:'9px 12px', ...label10, borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {filteredForex.map(f=>(
                  <tr key={f.p} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', cursor:'pointer' }} onClick={() => goToBacktest(f.p)}>
                    <td style={{ padding:'11px 8px', width: 20 }}>
                      <WatchlistStar symbol={f.p} category="forex" onAdd={addToWatchlist} added={watchlisted.has((f.p || '').toUpperCase())} />
                    </td>
                    <td style={{ padding:'11px 12px', ...monoSm, fontWeight:600 }}>
                      {f.p}
                      <SignalDot symbol={f.p} category="forex" signalMap={signalMap} />
                    </td>
                    <td style={{ padding:'11px 12px', ...monoSm }}>{f.v}</td>
                    <td style={{ padding:'11px 12px', ...monoSm, color: f.up?'var(--green)':'var(--red)' }}>{f.ch}</td>
                    <td style={{ padding:'11px 12px' }}><div style={{ width:40, height:2, background: f.up?'rgba(52,211,153,0.4)':'rgba(248,113,113,0.4)', borderRadius:1 }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Crypto */}
      <div className="glass-panel" style={{ ...panel, marginBottom: 16 }}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} /> {m('cryptoTop8')}
        </div>
        {cryptos.length === 0 ? (
          <PanelState loading={loading} empty={!loading} label="crypto" />
        ) : filteredCryptos.length === 0 ? (
          <PanelState loading={false} empty label="matching coins" />
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(8,1fr)', gap:10 }}>
            {filteredCryptos.map(c=>{
              const symbol = c.s;
              return (
                <div key={symbol} className="glass-panel" style={{ ...cardStyle, textAlign:'center', padding:12, cursor:'pointer', position:'relative' }}
                  onClick={() => goToBacktest(symbol)}
                  onMouseOver={e=>e.currentTarget.style.borderColor='rgba(0,245,212,0.2)'}
                  onMouseOut={e=>e.currentTarget.style.borderColor='var(--border)'}>
                  <div style={{ position:'absolute', top:6, right:8 }}>
                    <WatchlistStar symbol={symbol} category="crypto" onAdd={addToWatchlist} added={watchlisted.has(symbol.toUpperCase())} />
                  </div>
                  <div style={{ fontSize:12, fontWeight:700, marginBottom:4, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {symbol}
                    <SignalDot symbol={symbol} category="crypto" signalMap={signalMap} />
                  </div>
                  <div style={{ fontSize:13, ...monoSm, fontWeight:600, color: c.up?'var(--green)':'var(--red)' }}>{c.v}</div>
                  <div style={{ fontSize:10, ...monoSm, color: c.up?'var(--green)':'var(--red)', marginTop:3 }}>{c.c}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Market News */}
      <div className="glass-panel" style={panel}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
          Market News
        </div>
        {newsLoading ? (
          <PanelState loading label="news" />
        ) : news.length === 0 ? (
          <div style={{ ...monoSm, fontSize: 11, color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
            No news available
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px' }}>
            {news.map((article, i) => (
              <a
                key={i}
                href={article.link}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 12px',
                  borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                  textDecoration: 'none', transition: 'background .15s',
                }}
                onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                  {article.title}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...monoSm, fontSize: 10 }}>
                  <span style={{
                    color: NEWS_CATEGORY_COLOR[article.category] || 'var(--text-muted)',
                    fontWeight: 600, letterSpacing: '.05em',
                  }}>
                    {article.category}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span style={{ color: 'var(--text-muted)' }}>{article.source}</span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span style={{ color: 'var(--text-muted)' }}>{timeAgo(article.publishedAt)}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes tickerScroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      `}</style>
    </>
  );
}