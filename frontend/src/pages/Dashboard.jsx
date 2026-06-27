import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useSignals } from '../hooks/useSignals';
import api, { marketAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';

const kpiStyle   = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'20px 20px 16px', position:'relative', overflow:'hidden', transition:'all .3s' };
const labelStyle = { fontSize:11, letterSpacing:'.12em', color:'var(--text-secondary)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:12 };

// ── Helper: extract numeric price from any shape ──────────
const extractPrice = (p) => {
  if (!p) return 0;
  if (typeof p === 'number') return p;
  if (typeof p === 'object') return parseFloat(p.price ?? p.lastPrice ?? p.last ?? Object.values(p)[0] ?? 0);
  return parseFloat(p) || 0;
};

const fmt = (n, digits = 2) =>
  extractPrice(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function Dashboard() {
  const { t }                                    = useTranslation();
  const { signals, loading: signalsLoading }     = useSignals('4h');
  const { user }                                 = useAuth();
  const navigate                                 = useNavigate();

  const [prices, setPrices]       = useState({});
  const [dashLoading, setDashLoading] = useState(true);
  const [dashData, setDashData]   = useState({ stats: null, equityCurve: [], volumeChart: [] });

  useEffect(() => {
    // Live prices
    marketAPI.prices()
      .then(r => setPrices(r?.data?.prices || {}))
      .catch(() => {});

    // Dashboard summary
    api.get('/dashboard/summary')
      .then(res => {
        if (res.data.success) {
          setDashData({
            stats:       res.data.stats,
            equityCurve: res.data.equityCurve,
            volumeChart: res.data.volumeChart,
          });
        }
      })
      .catch(err => console.error('[dashboard] summary error:', err))
      .finally(() => setDashLoading(false));
  }, []);

  const volume = useMemo(() => {
    const daysArray = t('dashboard.days', { returnObjects: true });
    const safeDays  = Array.isArray(daysArray) ? daysArray : ['Mon','Tue','Wed','Thu','Fri'];
    return dashData.volumeChart.map(item => ({
      day:    safeDays[item.index % safeDays.length],
      volume: item.volume,
    }));
  }, [dashData.volumeChart, t]);

  const topSignals = signals ? signals.slice(0, 5) : [];
  const COLOR      = { BUY: 'var(--green)', SELL: 'var(--red)', HOLD: 'var(--amber)' };

  const kpis = dashData.stats ? [
    {
      label: t('dashboard.portfolioValue'),
      value: `$${dashData.stats.portfolioValue.value.toLocaleString()}`,
      delta: `▲ ${dashData.stats.portfolioValue.delta}`,
      color: 'var(--cyan)',
      sub:   t('dashboard.vsYesterday'),
    },
    {
      label: t('dashboard.dailyPnl'),
      value: `+$${dashData.stats.dailyPnl.value.toLocaleString()}`,
      delta: `▲ ${dashData.stats.dailyPnl.delta}`,
      color: 'var(--green)',
      sub:   t('dashboard.unrealized'),
    },
    {
      label: t('dashboard.openPositions'),
      value: dashData.stats.openPositions.value.toString(),
      delta: `▼ ${dashData.stats.openPositions.delta}`,
      color: 'var(--purple-bright)',
      sub:   t('dashboard.closedToday'),
    },
    {
      label: t('dashboard.winRate'),
      value: dashData.stats.winRate.value,
      delta: `▲ ${dashData.stats.winRate.delta}`,
      color: 'var(--amber)',
      sub:   t('dashboard.thisMonth'),
    },
  ] : [];

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
                  <span style={{ padding:'2px 6px', borderRadius:4, background:'rgba(52,211,153,0.12)', color:'var(--green)', fontSize:11 }}>{k.delta}</span>
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
                formatter={v => '$' + Math.round(v).toLocaleString()}
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
              // Try to get live price for this symbol from prices map
              const liveEntry = prices[sig.symbol] || prices[sig.symbol + 'USDT'];
              const livePrice = liveEntry ? extractPrice(liveEntry) : null;
              const displayPrice = livePrice || sig.price || 0;
              const changePct = liveEntry?.changePct ?? sig.change24h ?? 0;

              return (
                <div key={sig.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', borderRadius:8, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', transition:'all .2s' }}>
                  <div style={{ width:32, height:32, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, background: sig.signal==='BUY'?'rgba(52,211,153,0.12)':'rgba(248,113,113,0.12)', color: COLOR[sig.signal] || 'var(--text-primary)' }}>
                    {sig.signal === 'BUY' ? '▲' : sig.signal === 'SELL' ? '▼' : '◈'}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:600 }}>{sig.symbol}</div>
                    <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                      {sig.indicators?.rsi?.interpretation || 'Analyzing market trend...'}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:13, fontWeight:600, fontFamily:'JetBrains Mono,monospace', color: COLOR[sig.signal] || 'var(--text-primary)' }}>
                      ${fmt(displayPrice)}
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

      {/* ── Quick Crypto Prices ── */}
      {Object.keys(prices).length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10 }}>
          {Object.entries(prices).slice(0, 5).map(([sym, priceObj]) => {
            const p      = extractPrice(priceObj);
            const change = typeof priceObj === 'object' ? (priceObj.changePct ?? 0) : 0;
            return (
              <div key={sym} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px', textAlign:'center' }}>
                <div style={{ fontSize:11, fontWeight:700, color:'var(--text-secondary)', marginBottom:4 }}>
                  {sym.replace('USDT', '')}
                </div>
                <div style={{ fontSize:14, fontWeight:600, fontFamily:'JetBrains Mono,monospace', color:'var(--cyan)' }}>
                  ${fmt(p)}
                </div>
                <div style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', color: change >= 0 ? 'var(--green)' : 'var(--red)', marginTop:4 }}>
                  {change >= 0 ? '+' : ''}{parseFloat(change).toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}