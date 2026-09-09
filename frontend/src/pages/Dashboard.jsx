import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useSignals } from '../hooks/useSignals';
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

// ✅ Feature: même table que Settings.jsx (CURRENCY_SYMBOLS) — l'user choisit
// sa devise dans Settings → Language & Region, et ce symbole remplace le $
// qui était hardcodé dans tout le Dashboard (KPIs + prix live des signaux).
const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', MAD: 'DH', GBP: '£', JPY: '¥',
  CHF: 'CHF', CAD: 'CA$', AUD: 'A$', CNY: '¥', AED: 'AED',
};

// Fallback day labels — 7 slots (Sun→Sat) to match Postgres EXTRACT(DOW).
// Crypto trades 24/7 so weekend buckets are real and must not collapse
// into a 5-day Mon–Fri array.
const FALLBACK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Helper: extract numeric price from any shape ──────────
const extractPrice = (p) => {
  if (!p) return 0;
  if (typeof p === 'number') return p;
  if (typeof p === 'object') return parseFloat(p.price ?? p.lastPrice ?? p.last ?? Object.values(p)[0] ?? 0);
  return parseFloat(p) || 0;
};

// ── Smart price formatter — gère PEPE/SHIB (micro-cap) jusqu'à XAU ──
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

export default function Dashboard() {
  const { t }                                    = useTranslation();
  const { signals, loading: signalsLoading }     = useSignals('4h');
  const { user }                                 = useAuth();
  const navigate                                 = useNavigate();

  const [prices, setPrices]       = useState({});
  const [dashLoading, setDashLoading] = useState(true);
  const [dashData, setDashData]   = useState({
    stats: null, equityCurve: [], volumeChart: [],
    alertsSummary: { active: 0, triggeredToday: 0 },
    recentActivity: [],
  });
  const [currencySymbol, setCurrencySymbol] = useState('$');

  useEffect(() => {
    // Live prices (Binance only — sert au lookup live des signaux Crypto)
    marketAPI.prices()
      .then(r => setPrices(r?.data?.prices || {}))
      .catch(() => {});

    // ✅ Feature: devise de l'user (Settings → Language & Region), appliquée
    // aux KPIs et aux prix live ci-dessous au lieu du $ hardcodé.
    api.get('/settings')
      .then(res => {
        const code = res.data?.settings?.currency || 'USD';
        setCurrencySymbol(CURRENCY_SYMBOLS[code] || '$');
      })
      .catch(() => {});

    // Dashboard summary
    api.get('/dashboard/summary')
      .then(res => {
        if (res.data.success) {
          setDashData({
            stats:           res.data.stats,
            equityCurve:     res.data.equityCurve,
            volumeChart:     res.data.volumeChart,
            alertsSummary:   res.data.alertsSummary   || { active: 0, triggeredToday: 0 },
            recentActivity:  res.data.recentActivity  || [],
          });
        }
      })
      .catch(err => console.error('[dashboard] summary error:', err))
      .finally(() => setDashLoading(false));
  }, []);

  // ✅ Fix #6 — use the real day-of-week (dow) returned by the backend
  // instead of the array *position*, which silently mislabeled bars
  // whenever trades skipped a day (common for a 24/7 crypto platform).
  const volume = useMemo(() => {
    const daysArray = t('dashboard.days', { returnObjects: true });
    const safeDays  = Array.isArray(daysArray) && daysArray.length === 7
      ? daysArray
      : FALLBACK_DAYS;
    return dashData.volumeChart.map(item => ({
      day:    item.dow != null ? (safeDays[item.dow] ?? item.day) : item.day,
      volume: item.volume,
    }));
  }, [dashData.volumeChart, t]);

  const topSignals = signals ? signals.slice(0, 5) : [];
  const COLOR      = { BUY: 'var(--green)', SELL: 'var(--red)', HOLD: 'var(--amber)' };

  // ✅ Fix (CRITICAL) — pvUp/dpUp used to be computed unconditionally
  // against dashData.stats before the null-check, which threw
  // "Cannot read properties of null" on every first render (stats
  // starts as null until /dashboard/summary resolves) and crashed the
  // whole page. Everything now lives inside the same `stats ? … : []`
  // guard as `kpis`.
  const kpis = dashData.stats ? (() => {
    const pvUp = dashData.stats.portfolioValue.value >= 0;
    const dpUp = dashData.stats.dailyPnl.value >= 0;

    return [
      {
        label: t('dashboard.portfolioValue'),
        value: `${currencySymbol}${dashData.stats.portfolioValue.value.toLocaleString()}`,
        // ✅ Fix #2 — arrow now reflects the actual sign instead of a
        // hardcoded ▲.
        delta: `${pvUp ? '▲' : '▼'} ${dashData.stats.portfolioValue.delta}`,
        up:    pvUp,
        color: 'var(--cyan)',
        // ⚠️ Still not fully accurate — see note below kpis: this delta
        // is cumulative totalPnl, not an actual day-over-day comparison
        // against yesterday's portfolio_snapshots value.
        sub:   t('dashboard.vsYesterday'),
      },
      {
        label: t('dashboard.dailyPnl'),
        // ✅ Fix #1 — '+' was hardcoded and produced "+$-45" on a
        // negative day. Now conditional on the actual sign.
        value: `${dpUp ? '+' : ''}${currencySymbol}${dashData.stats.dailyPnl.value.toLocaleString()}`,
        delta: `${dpUp ? '▲' : '▼'} ${dashData.stats.dailyPnl.delta}`,
        up:    dpUp,
        color: dpUp ? 'var(--green)' : 'var(--red)',
        // ✅ Fix #3 — this figure is realized P&L from trades closed
        // today (status='closed'), not unrealized mark-to-market on
        // open positions. Renamed the label key accordingly; add
        // "realizedToday" to i18n.js across all 10 locales.
        sub:   t('dashboard.realizedToday', 'Realized (Today)'),
      },
      {
        label: t('dashboard.openPositions'),
        value: dashData.stats.openPositions.value.toString(),
        delta: `▼ ${dashData.stats.openPositions.delta}`,
        up:    true, // neutral count metric, not a P&L figure
        color: 'var(--purple-bright)',
        sub:   t('dashboard.closedToday'),
      },
      {
        label: t('dashboard.winRate'),
        value: dashData.stats.winRate.value,
        delta: `▲ ${dashData.stats.winRate.delta}`,
        up:    true,
        color: 'var(--amber)',
        sub:   t('dashboard.thisMonth'),
      },
    ];
  })() : [];

  return (
    <>
      {/* ── KPIs ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16 }}>
        {dashLoading
          ? Array.from({ length:4 }).map((_, i) => (
              <div key={i} style={{ ...kpiStyle, height:124, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
                LOADING DATA...
              </div>
            ))
          : kpis.map(k => (
              <div key={k.label} style={kpiStyle}>
                <div style={labelStyle}>{k.label}</div>
                <div style={{ fontSize:30, fontWeight:700, color:k.color, letterSpacing:'-.02em', marginBottom:10 }}>{k.value}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, fontFamily:'JetBrains Mono,monospace' }}>
                  {/* ✅ Fix #2 — badge background/color now follow k.up
                      instead of a hardcoded green, so a negative KPI no
                      longer shows a green "up" badge around a negative
                      number. */}
                  <span style={{
                    padding:'2px 6px', borderRadius:4, fontSize:11,
                    background: k.up ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
                    color:      k.up ? 'var(--green)' : 'var(--red)',
                  }}>{k.delta}</span>
                  <span style={{ color:'var(--text-secondary)' }}>{k.sub}</span>
                </div>
              </div>
            ))
        }
      </div>

      {/* ── Charts ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, margin:'16px 0' }}>
        {/* Equity Curve */}
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
            {t('dashboard.equityCurve')}
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={dashData.equityCurve}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
              <XAxis dataKey="day" hide />
              <YAxis hide />
              <Tooltip
                contentStyle={{ background:'rgba(3,7,18,0.95)', border:'1px solid rgba(0,245,212,0.3)', borderRadius:8, fontFamily:'JetBrains Mono,monospace', fontSize:11 }}
                formatter={v => currencySymbol + Math.round(v).toLocaleString()}
              />
              <Line type="monotone" dataKey="value" stroke="var(--cyan)" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Volume Chart */}
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} />
            {t('dashboard.volume')}
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={volume}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
              <XAxis dataKey="day" tick={{ fontSize:10, fill:'#64748b', fontFamily:'JetBrains Mono,monospace' }} />
              <YAxis hide />
              <Tooltip
                contentStyle={{ background:'rgba(3,7,18,0.95)', border:'1px solid rgba(167,139,250,0.3)', borderRadius:8, fontFamily:'JetBrains Mono,monospace', fontSize:11 }}
                formatter={v => v + ' signals'}
              />
              <Bar dataKey="volume" fill="rgba(167,139,250,0.5)" radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Alpha Signals Live ── */}
      <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
          <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
            {t('dashboard.alphaSignals')}
          </div>
          <button onClick={() => navigate('/signals')} style={{ fontSize:12, color:'var(--cyan)', background:'none', border:'none', fontFamily:'JetBrains Mono,monospace', cursor:'pointer' }}>
            {t('dashboard.viewAll')}
          </button>
        </div>

        {signalsLoading ? (
          <div style={{ color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:12, padding:20 }}>
            {t('dashboard.loading')}
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {topSignals.map(sig => {
              const assetClass = sig.asset_class || 'Crypto';
              const classColor = CLASS_COLOR[assetClass] || 'var(--text-secondary)';

              // Live price lookup — uniquement pour Crypto (Binance feed).
              // Forex/Commodity/Indices n'ont pas de live feed Binance → fallback direct sur sig.price.
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
                        fontSize:8, fontFamily:'JetBrains Mono,monospace', fontWeight:600,
                        letterSpacing:'.08em', padding:'1px 5px', borderRadius:3,
                        background:`${classColor}1a`, color: classColor,
                      }}>
                        {assetClass.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                      {sig.indicators?.rsi?.interpretation || 'Analyzing market trend...'}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:13, fontWeight:600, fontFamily:'JetBrains Mono,monospace', color: COLOR[sig.signal] || 'var(--text-primary)' }}>
                      {currencySymbol}{fmt(displayPrice)}
                    </div>
                    <div style={{ fontSize:11, color: changePct >= 0 ? 'var(--green)' : 'var(--red)', fontFamily:'JetBrains Mono,monospace' }}>
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
      <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:16 }}>

        {/* Recent Activity */}
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} />
              {t('dashboard.recentActivity', 'Recent Activity')}
            </div>
            <button onClick={() => navigate('/portfolio')} style={{ fontSize:12, color:'var(--cyan)', background:'none', border:'none', fontFamily:'JetBrains Mono,monospace', cursor:'pointer' }}>
              {t('dashboard.viewAll')}
            </button>
          </div>

          {dashLoading ? (
            <div style={{ color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:12, padding:20 }}>
              {t('dashboard.loading')}
            </div>
          ) : dashData.recentActivity.length === 0 ? (
            <div style={{ color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11, padding:'20px 0', textAlign:'center' }}>
              {t('dashboard.noTradesYet', 'No trades yet')}
            </div>
          ) : (
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
                        {tr.symbol} <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', textTransform:'uppercase' }}>{tr.side}</span>
                      </div>
                      <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                        {isClosed ? 'Closed' : 'Opened'} · {timeAgo(tr.timestamp)}
                      </div>
                    </div>
                    {isClosed && tr.pnl !== null && (
                      <div style={{ fontSize:13, fontWeight:600, fontFamily:'JetBrains Mono,monospace', color: pnlPositive ? 'var(--green)' : 'var(--red)' }}>
                        {pnlPositive ? '+' : ''}{tr.pnl.toFixed(2)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Active Alerts */}
        <div className="panel" style={{ padding:22, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
              {t('dashboard.alerts', 'Alerts')}
            </div>
            <button onClick={() => navigate('/alerts')} style={{ fontSize:12, color:'var(--cyan)', background:'none', border:'none', fontFamily:'JetBrains Mono,monospace', cursor:'pointer' }}>
              {t('dashboard.viewAll')}
            </button>
          </div>

          {dashLoading ? (
            <div style={{ color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:12, padding:20 }}>
              {t('dashboard.loading')}
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
                <span style={{ fontSize:36, fontWeight:700, color:'var(--cyan)' }}>{dashData.alertsSummary.active}</span>
                <span style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', textTransform:'uppercase' }}>active</span>
              </div>
              {dashData.alertsSummary.triggeredToday > 0 ? (
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:8, background:'rgba(251,191,36,0.08)', border:'1px solid rgba(251,191,36,0.2)' }}>
                  <span style={{ fontSize:13 }}>🔔</span>
                  <span style={{ fontSize:11, color:'var(--amber)', fontFamily:'JetBrains Mono,monospace' }}>
                    {t('dashboard.alertsTriggeredCount', '{{count}} triggered today', { count: dashData.alertsSummary.triggeredToday })}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>
                  {t('dashboard.noAlertsToday', 'No alerts triggered today')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}