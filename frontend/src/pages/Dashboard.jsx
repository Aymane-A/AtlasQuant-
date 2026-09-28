import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useSignals } from '../hooks/useSignals';
import { useDashboardData } from '../hooks/useDashboardData';
import api, { marketAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';

const kpiStyle   = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'20px 20px 16px', position:'relative', overflow:'hidden', transition:'all .3s' };
const labelStyle = { fontSize:11, letterSpacing:'.12em', color:'var(--text-secondary)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:12 };

const CLASS_COLOR = {
  Crypto:    'var(--cyan)',
  Forex:     'var(--purple-bright)',
  Commodity: 'var(--amber)',
  Indices:   'var(--green)',
};

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', MAD: 'DH', GBP: '£', JPY: '¥',
  CHF: 'CHF', CAD: 'CA$', AUD: 'A$', CNY: '¥', AED: 'AED',
};

const FALLBACK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const RANGE_OPTIONS = [
  { key: '7',  label: '7D'  },
  { key: '30', label: '30D' },
  { key: '90', label: '90D' },
  { key: 'all', label: 'ALL' },
];

// ✅ Feature: benchmark overlay on the Equity Curve (same benchmarks as the
// Portfolio page). 'OFF' is a UI-only value — it's sent to the backend as
// 'NONE', which skips the external benchmark fetch entirely.
const BENCHMARK_OPTIONS = ['OFF', 'BTC', 'SPY'];

const FALLBACK_POLL_MS = 60_000;

const extractPrice = (p) => {
  if (!p) return 0;
  if (typeof p === 'number') return p;
  if (typeof p === 'object') return parseFloat(p.price ?? p.lastPrice ?? p.last ?? Object.values(p)[0] ?? 0);
  return parseFloat(p) || 0;
};

const fmt = (p) => {
  const n = extractPrice(p);
  if (!n) return '0.00';
  if (n >= 10000)   return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000)    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)       return n.toFixed(2);
  if (n >= 0.01)    return n.toFixed(4);
  if (n >= 0.0001)  return n.toFixed(6);
  return n.toFixed(8);
};

const timeAgo = (ts) => {
  if (!ts) return '—';
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

export default function Dashboard() {
  const { t }                                    = useTranslation();
  const { signals, loading: signalsLoading }     = useSignals('4h');
  const { user }                                 = useAuth();
  const navigate                                 = useNavigate();

  const [prices, setPrices]           = useState({});
  const [pricesError, setPricesError] = useState(false);
  const [dashLoading, setDashLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [range, setRange]             = useState('30');
  const [benchmark, setBenchmark]     = useState('BTC');
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [dashData, setDashData]       = useState({
    stats: null, equityCurve: [], isSimulated: false, volumeChart: [],
    alertsSummary: { active: 0, triggeredToday: 0 },
    recentActivity: [], hasMoreActivity: false,
    benchmarkCurve: [], alpha: null, benchmarkSymbol: null,
  });
  const [currencySymbol, setCurrencySymbol] = useState('$');

  const [toast, setToast] = useState(null);
  const prevTriggeredRef  = useRef(null);
  const activityOffsetRef = useRef(0);
  // Ref mirror so fetchSummary (used inside intervals/callbacks) always
  // reads the *current* benchmark instead of a stale closure value.
  const benchmarkRef      = useRef('BTC');

  const { data: wsData, connected: wsConnected } = useDashboardData(range);

  // ── Shared merge logic for both REST responses and WS pushes ────────
  // fromWs=true never touches benchmark fields (the WS payload carries an
  // empty benchmarkCurve by design — see includeBenchmark:false in
  // dashboardSocket.server.js) and never overwrites a paginated Recent
  // Activity list the user has already "Loaded more" on.
  const applyIncomingData = useCallback((d, { fromWs }) => {
    if (!d) return;

    if (prevTriggeredRef.current !== null && d.alertsSummary?.triggeredToday > prevTriggeredRef.current) {
      setToast(`🔔 ${d.alertsSummary.triggeredToday - prevTriggeredRef.current} new alert(s) triggered`);
    }
    if (d.alertsSummary?.triggeredToday != null) {
      prevTriggeredRef.current = d.alertsSummary.triggeredToday;
    }

    setDashData(prev => ({
      stats:           d.stats ?? prev.stats,
      equityCurve:     d.equityCurve ?? prev.equityCurve,
      isSimulated:     d.isSimulated != null ? !!d.isSimulated : prev.isSimulated,
      volumeChart:     d.volumeChart ?? prev.volumeChart,
      alertsSummary:   d.alertsSummary || prev.alertsSummary,
      recentActivity:  (fromWs && activityOffsetRef.current > 0) ? prev.recentActivity : (d.recentActivity ?? prev.recentActivity),
      hasMoreActivity: fromWs ? prev.hasMoreActivity : (d.hasMoreActivity ?? prev.hasMoreActivity),
      benchmarkCurve:  fromWs ? prev.benchmarkCurve  : (d.benchmarkCurve || []),
      alpha:           fromWs ? prev.alpha           : (d.alpha ?? null),
      benchmarkSymbol: fromWs ? prev.benchmarkSymbol : (d.benchmarkSymbol ?? null),
    }));
  }, []);

  // ── REST fetch — initial load, range/benchmark change, "Load More" ──
  // silent=true skips the full-dashboard "LOADING DATA..." state (used when
  // only the benchmark changes — no reason to blank every panel for that).
  const fetchSummary = useCallback((rangeParam, offset = 0, { append = false, silent = false } = {}) => {
    if (!silent) setDashLoading(offset === 0 && !append);
    if (append) setLoadingMore(true);

    const bm = benchmarkRef.current;
    const params = {
      range: rangeParam,
      activityLimit: 5,
      activityOffset: offset,
      // "Load more" only needs the next activity page — don't make the
      // backend hit the external benchmark API for it.
      benchmark: (append || bm === 'OFF') ? 'NONE' : bm,
    };

    return api.get('/dashboard/summary', { params })
      .then(res => {
        if (!res.data.success) return;
        const d = res.data;

        if (append) {
          setDashData(prev => ({
            ...prev,
            recentActivity:  [...prev.recentActivity, ...(d.recentActivity || [])],
            hasMoreActivity: !!d.hasMoreActivity,
          }));
        } else {
          applyIncomingData(d, { fromWs: false });
        }
        activityOffsetRef.current = offset;
      })
      .catch(err => console.error('[dashboard] summary error:', err))
      .finally(() => { setDashLoading(false); setLoadingMore(false); });
  }, [applyIncomingData]);

  useEffect(() => {
    marketAPI.prices()
      .then(r => setPrices(r?.data?.prices || {}))
      .catch(err => { console.error('[dashboard] prices error:', err); setPricesError(true); });

    api.get('/settings')
      .then(res => {
        const code = res.data?.settings?.currency || 'USD';
        setCurrencySymbol(CURRENCY_SYMBOLS[code] || '$');
      })
      .catch(err => console.error('[dashboard] settings error:', err));

    fetchSummary(range, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (wsData) applyIncomingData(wsData, { fromWs: true });
  }, [wsData, applyIncomingData]);

  useEffect(() => {
    if (wsConnected) return;
    const id = setInterval(() => fetchSummary(range, 0), FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [wsConnected, range, fetchSummary]);

  const handleRangeChange = (key) => {
    if (key === range) return;
    setRange(key);
    fetchSummary(key, 0);
  };

  const handleBenchmarkChange = (b) => {
    if (b === benchmark) return;
    benchmarkRef.current = b;
    setBenchmark(b);

    if (b === 'OFF') {
      // Nothing to fetch — just drop the overlay. Later REST calls read
      // benchmarkRef and send 'NONE', so it stays off.
      setDashData(prev => ({ ...prev, benchmarkCurve: [], alpha: null, benchmarkSymbol: null }));
      return;
    }
    setBenchmarkLoading(true);
    fetchSummary(range, 0, { silent: true }).finally(() => setBenchmarkLoading(false));
  };

  const handleLoadMore = () => {
    fetchSummary(range, activityOffsetRef.current + 5, { append: true });
  };

  const volume = useMemo(() => {
    const daysArray = t('dashboard.days', { returnObjects: true });
    const safeDays  = Array.isArray(daysArray) && daysArray.length === 7
      ? daysArray
      : FALLBACK_DAYS;
    return dashData.volumeChart.map(item => ({
      day:    item.dow != null ? (safeDays[item.dow] ?? item.day) : item.day,
      date:   item.date,
      volume: item.volume,
    }));
  }, [dashData.volumeChart, t]);

  const handleVolumeBarClick = (data) => {
    if (data?.date) navigate(`/portfolio?date=${data.date}`);
  };

  const sparkline = useMemo(() => dashData.equityCurve.slice(-7), [dashData.equityCurve]);

  // ✅ Feature: merge equity curve + benchmark by *label* (not array index).
  // The WS can push a fresh equity curve with one more day than the REST
  // response the benchmark came from; matching by label means a point the
  // benchmark doesn't cover yet just gets null (line connects across it)
  // instead of every point after it shifting by one.
  const chartData = useMemo(() => {
    const bm = new Map(dashData.benchmarkCurve.map(b => [b.t, b]));
    return dashData.equityCurve.map(p => {
      const b = bm.get(p.day);
      return {
        day:          p.day,
        value:        p.value,
        portfolioPct: b?.portfolio ?? null,
        benchmarkPct: b?.benchmark ?? null,
      };
    });
  }, [dashData.equityCurve, dashData.benchmarkCurve]);

  const showBenchmark = benchmark !== 'OFF' && !dashData.isSimulated && dashData.benchmarkCurve.length > 0;
  const benchmarkUnavailable = benchmark !== 'OFF' && !dashData.isSimulated && !benchmarkLoading && !dashLoading && dashData.benchmarkCurve.length === 0;
  const benchmarkLabel = dashData.benchmarkSymbol || benchmark;

  const topSignals = signals ? signals.slice(0, 5) : [];
  const COLOR      = { BUY: 'var(--green)', SELL: 'var(--red)', HOLD: 'var(--amber)' };

  const kpis = dashData.stats ? (() => {
    const pvUp = dashData.stats.portfolioValue.value >= 0;
    const dpUp = dashData.stats.dailyPnl.value >= 0;

    return [
      {
        label: t('dashboard.portfolioValue'),
        value: `${currencySymbol}${dashData.stats.portfolioValue.value.toLocaleString()}`,
        delta: `${pvUp ? '▲' : '▼'} ${dashData.stats.portfolioValue.delta}`,
        signed: true, up: pvUp,
        color: 'var(--cyan)',
        sub:   t('dashboard.vsYesterday'),
        sparkline: true,
      },
      {
        label: t('dashboard.dailyPnl'),
        value: `${dpUp ? '+' : ''}${currencySymbol}${dashData.stats.dailyPnl.value.toLocaleString()}`,
        delta: `${dpUp ? '▲' : '▼'} ${dashData.stats.dailyPnl.delta}`,
        signed: true, up: dpUp,
        color: dpUp ? 'var(--green)' : 'var(--red)',
        sub:   t('dashboard.realizedToday', 'Realized (Today)'),
      },
      {
        label: t('dashboard.openPositions'),
        value: dashData.stats.openPositions.value.toString(),
        delta: `${dashData.stats.openPositions.delta} closed today`,
        signed: false,
        color: 'var(--purple-bright)',
        sub:   t('dashboard.closedToday'),
      },
      {
        label: t('dashboard.winRate'),
        value: dashData.stats.winRate.value,
        delta: dashData.stats.winRate.delta,
        signed: false,
        color: 'var(--amber)',
        sub:   t('dashboard.thisMonth'),
      },
    ];
  })() : [];

  const monoFont = 'JetBrains Mono,monospace';

  return (
    <>
      <style>{`
        .kpiGrid { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
        @media (max-width: 900px) { .kpiGrid { grid-template-columns:repeat(2,1fr); } }
        @media (max-width: 520px) { .kpiGrid { grid-template-columns:1fr; } }
        .chartsGrid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:16px 0; }
        @media (max-width: 900px) { .chartsGrid { grid-template-columns:1fr; } }
        .bottomGrid { display:grid; grid-template-columns:1.4fr 1fr; gap:16px; }
        @media (max-width: 900px) { .bottomGrid { grid-template-columns:1fr; } }
      `}</style>

      {pricesError && (
        <div style={{ fontSize:11, color:'var(--amber)', fontFamily:monoFont, marginBottom:8 }}>
          ⚠ Live prices unavailable — showing last known values.
        </div>
      )}

      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:6 }}>
        <span style={{ fontSize:10, fontFamily:monoFont, color: wsConnected ? 'var(--green)' : 'var(--text-muted)', display:'flex', alignItems:'center', gap:5 }}>
          <span style={{ width:6, height:6, borderRadius:'50%', background: wsConnected ? 'var(--green)' : 'var(--text-muted)' }} />
          {wsConnected ? 'LIVE' : 'RECONNECTING…'}
        </span>
      </div>

      {/* ── KPIs ── */}
      <div className="kpiGrid">
        {dashLoading
          ? Array.from({ length:4 }).map((_, i) => (
              <div key={i} style={{ ...kpiStyle, height:124, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)', fontFamily:monoFont, fontSize:11 }}>
                LOADING DATA...
              </div>
            ))
          : kpis.map(k => (
              <div key={k.label} style={kpiStyle}>
                <div style={labelStyle}>{k.label}</div>
                <div style={{ fontSize:30, fontWeight:700, color:k.color, letterSpacing:'-.02em', marginBottom:10 }}>{k.value}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, fontFamily:monoFont }}>
                  <span style={{
                    padding:'2px 6px', borderRadius:4, fontSize:11,
                    background: k.signed ? (k.up ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)') : 'rgba(148,163,184,0.12)',
                    color:      k.signed ? (k.up ? 'var(--green)' : 'var(--red)') : 'var(--text-secondary)',
                  }}>{k.delta}</span>
                  <span style={{ color:'var(--text-secondary)' }}>{k.sub}</span>
                </div>
                {k.sparkline && sparkline.length > 1 && (
                  <div style={{ position:'absolute', bottom:0, right:0, width:90, height:36, opacity:0.6 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={sparkline}>
                        <Line type="monotone" dataKey="value" stroke={k.color} strokeWidth={1.5} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            ))
        }
      </div>

      {/* ── Charts ── */}
      <div className="chartsGrid">
        {/* Equity Curve */}
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
              {t('dashboard.equityCurve')}
              {dashData.isSimulated && !dashLoading && (
                <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, background:'rgba(251,191,36,0.12)', color:'var(--amber)', fontFamily:monoFont, textTransform:'uppercase', letterSpacing:'.06em' }}>
                  Simulated preview
                </span>
              )}
            </div>
            <div style={{ display:'flex', gap:4 }}>
              {RANGE_OPTIONS.map(o => (
                <button
                  key={o.key}
                  onClick={() => handleRangeChange(o.key)}
                  style={{
                    fontSize:10, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                    fontFamily:monoFont,
                    background: range === o.key ? 'rgba(0,245,212,0.15)' : 'transparent',
                    color:      range === o.key ? 'var(--cyan)' : 'var(--text-secondary)',
                    border:     '1px solid var(--border)',
                  }}
                >{o.label}</button>
              ))}
            </div>
          </div>

          {/* ✅ Feature: benchmark selector + alpha. Hidden for the simulated
              preview — comparing synthetic data to a real market benchmark
              would be meaningless (the backend skips it there too). */}
          {!dashData.isSimulated && !dashLoading && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:monoFont, textTransform:'uppercase', letterSpacing:'.06em', marginRight:4 }}>
                  {t('dashboard.benchmark', 'Benchmark')}
                </span>
                {BENCHMARK_OPTIONS.map(b => (
                  <button
                    key={b}
                    onClick={() => handleBenchmarkChange(b)}
                    style={{
                      fontSize:10, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                      fontFamily:monoFont,
                      background: benchmark === b ? 'rgba(251,191,36,0.15)' : 'transparent',
                      color:      benchmark === b ? 'var(--amber)' : 'var(--text-secondary)',
                      border:     '1px solid var(--border)',
                    }}
                  >{b}</button>
                ))}
                {benchmarkLoading && (
                  <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:monoFont, marginLeft:6 }}>…</span>
                )}
              </div>

              {showBenchmark && dashData.alpha != null && (
                <span style={{
                  fontSize:11, padding:'2px 8px', borderRadius:4, fontFamily:monoFont,
                  background: dashData.alpha >= 0 ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
                  color:      dashData.alpha >= 0 ? 'var(--green)' : 'var(--red)',
                }}>
                  {t('dashboard.alpha', 'Alpha')} {fmtPct(dashData.alpha)}
                </span>
              )}
              {benchmarkUnavailable && (
                <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:monoFont }}>
                  {t('dashboard.benchmarkUnavailable', 'Benchmark unavailable')}
                </span>
              )}
            </div>
          )}

          {dashLoading ? (
            <div style={{ height:160, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)', fontFamily:monoFont, fontSize:11 }}>
              LOADING DATA...
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                {showBenchmark ? (
                  // % return mode — both series start at 0% so they're
                  // directly comparable regardless of portfolio size.
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
                    <XAxis dataKey="day" hide />
                    <YAxis hide domain={['auto', 'auto']} />
                    <Tooltip
                      contentStyle={{ background:'rgba(3,7,18,0.95)', border:'1px solid rgba(0,245,212,0.3)', borderRadius:8, fontFamily:monoFont, fontSize:11 }}
                      formatter={(v, name) => [fmtPct(v), name]}
                    />
                    <Line type="monotone" dataKey="portfolioPct" name={t('dashboard.portfolio', 'Portfolio')} stroke="var(--cyan)" strokeWidth={1.5} dot={false} connectNulls />
                    <Line type="monotone" dataKey="benchmarkPct" name={benchmarkLabel} stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
                  </LineChart>
                ) : (
                  <LineChart data={dashData.equityCurve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
                    <XAxis dataKey="day" hide />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{ background:'rgba(3,7,18,0.95)', border:'1px solid rgba(0,245,212,0.3)', borderRadius:8, fontFamily:monoFont, fontSize:11 }}
                      formatter={v => currencySymbol + Math.round(v).toLocaleString()}
                    />
                    <Line type="monotone" dataKey="value" stroke="var(--cyan)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                )}
              </ResponsiveContainer>

              {showBenchmark && (
                <div style={{ display:'flex', gap:14, marginTop:8, fontSize:10, fontFamily:monoFont, color:'var(--text-secondary)' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ width:10, height:2, background:'var(--cyan)' }} />
                    {t('dashboard.portfolio', 'Portfolio')}
                  </span>
                  <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ width:10, height:0, borderTop:'2px dashed var(--amber)' }} />
                    {benchmarkLabel}
                  </span>
                </div>
              )}

              {dashData.isSimulated && dashData.recentActivity.length === 0 && (
                <button
                  onClick={() => navigate('/signals')}
                  style={{ marginTop:12, fontSize:11, padding:'8px 12px', borderRadius:6, cursor:'pointer', background:'rgba(0,245,212,0.1)', color:'var(--cyan)', border:'1px solid rgba(0,245,212,0.3)', fontFamily:monoFont, width:'100%' }}
                >
                  View signals → make your first trade
                </button>
              )}
            </>
          )}
        </div>

        {/* Volume Chart */}
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} />
            {t('dashboard.volume')}
          </div>
          {dashLoading ? (
            <div style={{ height:160, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)', fontFamily:monoFont, fontSize:11 }}>
              LOADING DATA...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={volume}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
                <XAxis dataKey="day" tick={{ fontSize:10, fill:'#64748b', fontFamily:monoFont }} />
                <YAxis hide />
                <Tooltip
                  contentStyle={{ background:'rgba(3,7,18,0.95)', border:'1px solid rgba(167,139,250,0.3)', borderRadius:8, fontFamily:monoFont, fontSize:11 }}
                  formatter={v => v + ' signals'}
                />
                <Bar dataKey="volume" fill="rgba(167,139,250,0.5)" radius={[4,4,0,0]} cursor="pointer" onClick={handleVolumeBarClick} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Alpha Signals Live ── */}
      <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
          <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
            {t('dashboard.alphaSignals')}
          </div>
          <button onClick={() => navigate('/signals')} style={{ fontSize:12, color:'var(--cyan)', background:'none', border:'none', fontFamily:monoFont, cursor:'pointer' }}>
            {t('dashboard.viewAll')}
          </button>
        </div>

        {signalsLoading ? (
          <div style={{ color:'var(--text-secondary)', fontFamily:monoFont, fontSize:12, padding:20 }}>
            {t('dashboard.loading')}
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {topSignals.map(sig => {
              const assetClass = sig.asset_class || 'Crypto';
              const classColor = CLASS_COLOR[assetClass] || 'var(--text-secondary)';
              const liveEntry = assetClass === 'Crypto'
                ? (prices[sig.symbol] || prices[sig.symbol + 'USDT'])
                : null;
              const livePrice = liveEntry ? extractPrice(liveEntry) : null;
              const displayPrice = livePrice || sig.price || 0;
              const changePct = liveEntry?.changePct ?? sig.change24h ?? 0;

              return (
                <div key={sig.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', borderRadius:8, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', transition:'all .2s' }}>
                  <div style={{ width:32, height:32, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, background: sig.signal==='BUY'?'rgba(52,211,153,0.12)':'rgba(248,113,113,0.12)', color: COLOR[sig.signal] || 'var(--text-primary)' }}>
                    {sig.signal === 'BUY' ? '▲' : sig.signal === 'SELL' ? '▼' : '◈'}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                      <span style={{ fontSize:13, fontWeight:600 }}>{sig.symbol}</span>
                      <span style={{
                        fontSize:8, fontFamily:monoFont, fontWeight:600,
                        letterSpacing:'.08em', padding:'1px 5px', borderRadius:3,
                        background:`${classColor}1a`, color: classColor,
                      }}>
                        {assetClass.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:monoFont, marginTop:2 }}>
                      {sig.indicators?.rsi?.interpretation || 'Analyzing market trend...'}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:13, fontWeight:600, fontFamily:monoFont, color: COLOR[sig.signal] || 'var(--text-primary)' }}>
                      {currencySymbol}{fmt(displayPrice)}
                    </div>
                    <div style={{ fontSize:11, color: changePct >= 0 ? 'var(--green)' : 'var(--red)', fontFamily:monoFont }}>
                      {changePct >= 0 ? '+' : ''}{parseFloat(changePct).toFixed(2)}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Recent Activity + Active Alerts ── */}
      <div className="bottomGrid">
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} />
              {t('dashboard.recentActivity', 'Recent Activity')}
            </div>
            <button onClick={() => navigate('/portfolio')} style={{ fontSize:12, color:'var(--cyan)', background:'none', border:'none', fontFamily:monoFont, cursor:'pointer' }}>
              {t('dashboard.viewAll')}
            </button>
          </div>

          {dashLoading ? (
            <div style={{ color:'var(--text-secondary)', fontFamily:monoFont, fontSize:12, padding:20 }}>
              {t('dashboard.loading')}
            </div>
          ) : dashData.recentActivity.length === 0 ? (
            <div style={{ color:'var(--text-muted)', fontFamily:monoFont, fontSize:11, padding:'20px 0', textAlign:'center' }}>
              {t('dashboard.noTradesYet', 'No trades yet')}
            </div>
          ) : (
            <>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {dashData.recentActivity.map(tr => {
                  const isClosed = tr.status === 'closed';
                  const pnlPositive = (tr.pnl ?? 0) >= 0;
                  return (
                    <div key={tr.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', borderRadius:8, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)' }}>
                      <div style={{ width:28, height:28, borderRadius:7, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, background: isClosed ? (pnlPositive ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)') : 'rgba(0,245,212,0.1)', color: isClosed ? (pnlPositive ? 'var(--green)' : 'var(--red)') : 'var(--cyan)' }}>
                        {isClosed ? '✓' : '◈'}
                      </div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:13, fontWeight:600 }}>
                          {tr.symbol} <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:monoFont, textTransform:'uppercase' }}>{tr.side}</span>
                        </div>
                        <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:monoFont, marginTop:2 }}>
                          {isClosed ? 'Closed' : 'Opened'} · {timeAgo(tr.timestamp)}
                        </div>
                      </div>
                      {isClosed && tr.pnl !== null && (
                        <div style={{ fontSize:13, fontWeight:600, fontFamily:monoFont, color: pnlPositive ? 'var(--green)' : 'var(--red)' }}>
                          {pnlPositive ? '+' : ''}{tr.pnl.toFixed(2)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {dashData.hasMoreActivity && (
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  style={{ marginTop:12, width:'100%', fontSize:11, padding:'8px', borderRadius:6, cursor: loadingMore ? 'default' : 'pointer', background:'rgba(255,255,255,0.03)', color:'var(--text-secondary)', border:'1px solid var(--border)', fontFamily:monoFont }}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>

        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
              {t('dashboard.alerts', 'Alerts')}
            </div>
            <button onClick={() => navigate('/alerts')} style={{ fontSize:12, color:'var(--cyan)', background:'none', border:'none', fontFamily:monoFont, cursor:'pointer' }}>
              {t('dashboard.viewAll')}
            </button>
          </div>

          {dashLoading ? (
            <div style={{ color:'var(--text-secondary)', fontFamily:monoFont, fontSize:12, padding:20 }}>
              {t('dashboard.loading')}
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
                <span style={{ fontSize:36, fontWeight:700, color:'var(--cyan)' }}>{dashData.alertsSummary.active}</span>
                <span style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:monoFont, textTransform:'uppercase' }}>active</span>
              </div>
              {dashData.alertsSummary.triggeredToday > 0 ? (
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:8, background:'rgba(251,191,36,0.08)', border:'1px solid rgba(251,191,36,0.2)' }}>
                  <span style={{ fontSize:13 }}>🔔</span>
                  <span style={{ fontSize:11, color:'var(--amber)', fontFamily:monoFont }}>
                    {t('dashboard.alertsTriggeredCount', '{{count}} triggered today', { count: dashData.alertsSummary.triggeredToday })}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:monoFont }}>
                  {t('dashboard.noAlertsToday', 'No alerts triggered today')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div
          onClick={() => setToast(null)}
          style={{ position:'fixed', bottom:24, right:24, zIndex:50, background:'rgba(3,7,18,0.95)', border:'1px solid rgba(251,191,36,0.3)', color:'var(--amber)', padding:'12px 16px', borderRadius:8, fontFamily:monoFont, fontSize:12, cursor:'pointer', boxShadow:'0 4px 20px rgba(0,0,0,0.4)' }}
        >
          {toast}
        </div>
      )}
    </>
  );
}