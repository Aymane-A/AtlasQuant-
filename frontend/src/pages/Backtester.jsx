import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, BarElement, Tooltip, Legend, Filler,
} from 'chart.js';
import api from '../services/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

const inpStyle = { padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono,monospace', fontSize: 12, outline: 'none', width: '100%' };
const monoSm   = { fontFamily: 'JetBrains Mono,monospace', fontSize: 12 };
const label10  = { fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase', fontFamily: 'JetBrains Mono,monospace', color: 'var(--text-muted)' };
const panel    = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22 };
const baseOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

export default function Backtester() {
  const { t } = useTranslation();
  const location = useLocation();

  const [running, setRunning]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError]       = useState(null);

  // Si on arrive depuis Markets.jsx (clic sur un symbole), on pré-remplit
  // l'univers avec ce symbole plutôt que la liste par défaut.
  const prefillSymbol = location.state?.prefillSymbol;

  const [form, setForm] = useState({
    name: 'RSI Momentum Reversion v2',
    universe: prefillSymbol || 'SPY, QQQ, AAPL, MSFT, NVDA',
    from: '2020-01-01',
    to: '2024-12-31',
    tf: '4H',
    capital: '100,000',
    maxPos: '5',
  });

  const [metrics, setMetrics] = useState({
    totalReturn: '0.0%', sharpe: '0.00', maxDrawdown: '0.0%',
    winRate: '0.0%', avgRR: '1:0.0', totalTrades: '0',
    avgWin: '+$0', avgLoss: '−$0', avgHold: '0d'
  });

  const [backtestData, setBacktestData] = useState({
    stratData: [],
    bhData: [],
    ddData: [],
    annualReturns: [],
    trades: []
  });

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const runBacktest = async () => {
    setRunning(true);
    setError(null);
    setProgress(5);

    try {
      const progressInterval = setInterval(() => {
        setProgress(p => (p >= 85 ? 85 : p + 12));
      }, 100);

      // Le backend attend symbol/strategy/timeframe/startDate/endDate —
      // on mappe les champs du formulaire (universe/tf/from/to) vers ce format.
      const payload = {
        name: form.name,
        universe: form.universe,
        strategy: form.name,
        timeframe: form.tf,
        tf: form.tf,
        startDate: form.from,
        from: form.from,
        endDate: form.to,
        to: form.to,
        capital: form.capital,
        maxPos: form.maxPos,
      };

      const res = await api.post('/backtest', payload);

      clearInterval(progressInterval);
      const result = res.data;

      if (result.success) {
        setProgress(100);
        setMetrics(result.metrics);
        setBacktestData({
          stratData: result.charts?.stratData || [],
          bhData: result.charts?.bhData || [],
          ddData: result.charts?.ddData || [],
          annualReturns: result.charts?.annualReturns || [],
          trades: result.trades || []
        });
      } else {
        console.error('Backtest engine error:', result.error);
        setError(result.error || t('backtester.genericError'));
      }
    } catch (err) {
      const serverMessage = err.response?.data?.error;
      console.error('Failed to connect to backtest server:', err);
      setError(serverMessage || t('backtester.connectionError'));
    } finally {
      setTimeout(() => setRunning(false), 200);
    }
  };

  useEffect(() => {
    runBacktest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eqChartData = {
    labels: backtestData.stratData.map((_, i) => i),
    datasets: [
      { data: backtestData.stratData, borderColor: '#00f5d4', backgroundColor: 'rgba(0,245,212,0.15)', borderWidth: 1.5, pointRadius: 0, tension: .2, fill: true },
      { data: backtestData.bhData, borderColor: 'rgba(167,139,250,0.4)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: .2, fill: false, borderDash: [4, 4] },
    ],
  };

  const ddChartData = {
    labels: backtestData.ddData.map((_, i) => i),
    datasets: [{ data: backtestData.ddData, borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.18)', borderWidth: 1.5, pointRadius: 0, tension: .2, fill: true }],
  };

  // Rendements annuels réels, calculés par le backend à partir de
  // l'equity curve groupée par année calendaire.
  const annualReturnsData = backtestData.annualReturns || [];
  const annualData = {
    labels: annualReturnsData.map(r => r.year),
    datasets: [{
      data: annualReturnsData.map(r => r.returnPct),
      backgroundColor: annualReturnsData.map(r => r.returnPct >= 0 ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)'),
      borderRadius: 4,
    }],
  };

  const METRICS_LIST = [
    { key: 'totalReturn', v: metrics.totalReturn, c: 'var(--green)' },
    { key: 'sharpe',      v: metrics.sharpe,      c: 'var(--cyan)' },
    { key: 'maxDrawdown', v: metrics.maxDrawdown, c: 'var(--red)' },
    { key: 'winRate',     v: metrics.winRate,     c: 'var(--amber)' },
    { key: 'avgRR',       v: metrics.avgRR,       c: 'var(--purple-bright)' },
    { key: 'totalTrades', v: metrics.totalTrades, c: 'var(--text-primary)' },
    { key: 'avgWin',      v: metrics.avgWin,      c: 'var(--green)' },
    { key: 'avgLoss',     v: metrics.avgLoss,     c: 'var(--red)' },
    { key: 'avgHold',     v: metrics.avgHold,     c: 'var(--cyan)' },
  ];

  const TABLE_HEADERS = [
    t('backtester.num'),      t('backtester.symbol'),   t('backtester.direction'),
    t('backtester.entry'),    t('backtester.exit'),     t('backtester.pnl'),
    t('backtester.rr'),       t('backtester.duration'),
  ];

  const ENTRY_RULES = [
    { dot: 'var(--green)', text: 'RSI(14) crosses above 30' },
    { dot: 'var(--green)', text: 'Price above EMA(200)' },
    { dot: 'var(--green)', text: 'Volume > 1.5× 20-day avg' },
  ];
  const EXIT_RULES = [
    { dot: 'var(--red)', text: 'RSI(14) crosses above 70' },
    { dot: 'var(--red)', text: 'Stop loss: −5% from entry' },
  ];

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={label10}>{t('backtester.engine')}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono,monospace' }}>
          {t('backtester.dataRange')}
        </div>
      </div>

      {/* ── Bandeau d'erreur ──────────────────────────────────────────────── */}
      {error && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
          color: 'var(--red)', fontSize: 12, fontFamily: 'JetBrains Mono,monospace',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Core Layout ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>

        <div style={panel}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cyan)' }} />
            {t('backtester.stratConfig')}
          </div>

          {[
            { lbl: t('backtester.stratName'), key: 'name' },
            { lbl: t('backtester.universe'),  key: 'universe' },
          ].map(f => (
            <div key={f.key} style={{ marginBottom: 14 }}>
              <div style={{ ...label10, marginBottom: 5 }}>{f.lbl}</div>
              <input style={inpStyle} value={form[f.key]} onChange={set(f.key)} />
            </div>
          ))}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.from')}</div>
              <input style={inpStyle} type="date" value={form.from} onChange={set('from')} />
            </div>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.to')}</div>
              <input style={inpStyle} type="date" value={form.to} onChange={set('to')} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.timeframe')}</div>
              <select style={{ ...inpStyle, color: 'var(--text-secondary)' }} value={form.tf} onChange={set('tf')}>
                {['Daily', '4H', '1H', '15M'].map(tf => <option key={tf}>{tf}</option>)}
              </select>
            </div>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.capital')}</div>
              <input style={inpStyle} value={form.capital} onChange={set('capital')} />
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '18px 0' }} />

          <div style={{ marginBottom: 14 }}>
            <div style={{ ...label10, marginBottom: 10 }}>{t('backtester.entryRules')}</div>
            {ENTRY_RULES.map(r => (
              <div key={r.text} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, ...monoSm, color: 'var(--text-secondary)', marginBottom: 8, fontSize: 11 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: r.dot, flexShrink: 0 }} />{r.text}
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ ...label10, marginBottom: 10 }}>{t('backtester.exitRules')}</div>
            {EXIT_RULES.map(r => (
              <div key={r.text} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, ...monoSm, color: 'var(--text-secondary)', marginBottom: 8, fontSize: 11 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: r.dot, flexShrink: 0 }} />{r.text}
              </div>
            ))}
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '18px 0' }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.posSize')}</div>
              <select style={{ ...inpStyle, color: 'var(--text-secondary)' }}>
                <option>Fixed 10%</option>
                <option>Kelly Criterion</option>
                <option>Fixed $</option>
              </select>
            </div>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.maxPos')}</div>
              <input style={inpStyle} value={form.maxPos} onChange={set('maxPos')} />
            </div>
          </div>

          {running && (
            <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', width: `${Math.min(progress, 100)}%`, background: 'linear-gradient(90deg,var(--cyan),var(--purple-bright))', borderRadius: 2, transition: 'width .1s linear' }} />
            </div>
          )}

          <button
            onClick={runBacktest}
            disabled={running}
            style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg,rgba(0,196,170,0.3),rgba(0,245,212,0.15))', border: '1px solid var(--cyan-dim)', color: 'var(--cyan)', fontSize: 14, fontWeight: 700, fontFamily: 'Syne,sans-serif', letterSpacing: '.08em', borderRadius: 10, cursor: 'pointer', opacity: running ? .7 : 1, transition: 'all .3s' }}
          >
            {running ? t('backtester.running', { pct: Math.min(Math.round(progress), 100) }) : t('backtester.runBacktest')}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div style={panel}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
              {t('backtester.resultsSummary')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {METRICS_LIST.map(m => (
                <div key={m.key} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, textAlign: 'center' }}>
                  <div style={{ fontSize: 19, fontWeight: 700, fontFamily: 'JetBrains Mono,monospace', letterSpacing: '-.02em', color: m.c }}>{m.v}</div>
                  <div style={{ ...label10, marginTop: 4 }}>{t(`backtester.${m.key}`)}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={panel}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cyan)' }} />
                {t('backtester.equityCurve')}
              </div>
              <div style={{ display: 'flex', gap: 12, ...monoSm, fontSize: 11 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 2, background: 'var(--cyan)', display: 'inline-block' }} />
                  {t('backtester.strategy')}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 2, background: 'rgba(167,139,250,0.5)', display: 'inline-block' }} />
                  {t('backtester.buyHold')}
                </span>
              </div>
            </div>
            <div style={{ position: 'relative', height: 190 }}>
              <Line data={eqChartData} options={{ ...baseOpts, animation: { duration: 1000 }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { maxTicksLimit: 4, font: { size: 10 }, callback: v => '$' + Math.round(v).toLocaleString() } } } }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={panel}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)' }} />
                {t('backtester.drawdown')}
              </div>
              <div style={{ position: 'relative', height: 120 }}>
                <Line data={ddChartData} options={{ ...baseOpts, animation: { duration: 800 }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { maxTicksLimit: 3, font: { size: 9 }, callback: v => v + '%' } } } }} />
              </div>
            </div>
            <div style={panel}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)' }} />
                {t('backtester.annualReturns')}
              </div>
              <div style={{ position: 'relative', height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {annualData.labels.length === 0 ? (
                  <span style={{ ...monoSm, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    {t('backtester.annualReturnsUnavailable')}
                  </span>
                ) : (
                  <Bar data={annualData} options={{ ...baseOpts, animation: { duration: 800 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw >= 0 ? '+' : ''}${ctx.raw}%` } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { maxTicksLimit: 4, font: { size: 9 }, callback: v => v + '%' } } } }} />
                )}
              </div>
            </div>
          </div>

          <div style={panel}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--purple-bright)' }} />
              {t('backtester.tradeLog')}
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                {t('backtester.last10')}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {TABLE_HEADERS.map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '9px 12px', ...label10, borderBottom: '1px solid var(--border)', fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {backtestData.trades.length === 0 ? (
                    <tr>
                      <td colSpan={TABLE_HEADERS.length} style={{ padding: '24px', textTransform: 'uppercase', textAlign: 'center', ...monoSm, color: 'var(--text-muted)' }}>
                        {t('backtester.noTrades')}
                      </td>
                    </tr>
                  ) : (
                    backtestData.trades.map(tr => (
                      <tr key={tr.n} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '9px 12px', ...monoSm, color: 'var(--text-muted)' }}>{tr.n}</td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>
                          <span style={{ background: 'rgba(0,245,212,0.08)', color: 'var(--cyan)', border: '1px solid rgba(0,245,212,0.15)', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>{tr.sym}</span>
                        </td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>
                          <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, background: tr.type === 'SHORT' ? 'rgba(248,113,113,0.12)' : 'rgba(52,211,153,0.12)', color: tr.type === 'SHORT' ? 'var(--red)' : 'var(--green)' }}>
                            {tr.type || 'LONG'}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>${parseFloat(tr.entry).toLocaleString()}</td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>${parseFloat(tr.exit).toLocaleString()}</td>
                        <td style={{ padding: '9px 12px', ...monoSm, color: tr.isW ? 'var(--green)' : 'var(--red)' }}>{tr.pnl}</td>
                        <td style={{ padding: '9px 12px', ...monoSm, color: tr.isW ? 'var(--amber)' : 'var(--red)' }}>{tr.rr}</td>
                        <td style={{ padding: '9px 12px', ...monoSm, color: 'var(--text-secondary)' }}>{tr.dur}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}