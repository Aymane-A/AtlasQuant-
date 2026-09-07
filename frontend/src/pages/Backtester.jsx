import { useState, useEffect, useRef } from 'react';
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

// ── Formatage currency-aware ──────────────────────────────────────────
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF ', AUD: 'A$', CAD: 'C$', MIXED: '' };

// ✅ Feature: même table que Dashboard.jsx/RiskMatrix.jsx — devise de l'user
// (Settings → Language & Region), utilisée pour le label "Capital" et le
// mode de sizing "Fixed Amount", qui avaient un $ hardcodé (indépendant de
// qc, qui lui reflète la devise du symbole tradé, connue seulement après
// avoir lancé un backtest).
const SETTINGS_CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', MAD: 'DH', GBP: '£', JPY: '¥',
  CHF: 'CHF', CAD: 'CA$', AUD: 'A$', CNY: '¥', AED: 'AED',
};

function fmtAmount(value, currency = 'USD') {
  const sym = CURRENCY_SYMBOLS[currency] ?? '';
  const num = parseFloat(value);
  return `${sym}${Number.isFinite(num) ? num.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}`;
}

function fmtSigned(str, currency = 'USD') {
  if (!str) return str;
  const sign = str[0] === '+' || str[0] === '-' ? str[0] : '';
  const rest = str.replace(/^[+-]/, '');
  const sym = CURRENCY_SYMBOLS[currency] ?? '';
  return `${sign}${sym}${rest}`;
}

// ── Registry de stratégies (frontend) ─────────────────────────────────
// Duplique intentionnellement backtestStrategies.service.js côté backend.
// Si une nouvelle stratégie est ajoutée côté backend, l'ajouter ICI aussi (même id).
const STRATEGY_OPTIONS = [
  {
    id: 'rsi_momentum',
    label: 'RSI Momentum Reversion',
    entryRules: [
      { dot: 'var(--green)', text: 'RSI(14) crosses above 30' },
      { dot: 'var(--green)', text: 'Price above EMA(200)' },
      { dot: 'var(--green)', text: 'Volume > 1.5× 20-day avg' },
    ],
    exitRules: [
      { dot: 'var(--red)', text: 'RSI(14) crosses above 70' },
      { dot: 'var(--red)', text: 'Stop loss: −5% from entry' },
    ],
  },
  {
    id: 'macd_crossover',
    label: 'MACD Crossover',
    entryRules: [
      { dot: 'var(--green)', text: 'MACD(12,26) crosses above Signal(9)' },
      { dot: 'var(--green)', text: 'Price above EMA(200)' },
    ],
    exitRules: [
      { dot: 'var(--red)', text: 'MACD(12,26) crosses below Signal(9)' },
      { dot: 'var(--red)', text: 'Stop loss: −5% from entry' },
    ],
  },
];

export default function Backtester() {
  const { t } = useTranslation();
  const location = useLocation();

  const [running, setRunning]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError]       = useState(null);
  const [warning, setWarning]   = useState(null);
  const [skipped, setSkipped]   = useState(null);
  const [settingsCurrency, setSettingsCurrency] = useState('$');
  // FIX (audit multi-asset) : on garde aussi le CODE devise (ex: 'MAD'),
  // pas seulement le symbole d'affichage ('DH') — le backend en a besoin
  // pour convertir le capital saisi vers la devise de cotation de chaque
  // symbole avant de lancer la simulation. Avant ce fix, le capital
  // saisi dans une devise ≠ USD était utilisé tel quel par le backend,
  // comme s'il était déjà dans la bonne devise.
  const [settingsCurrencyCode, setSettingsCurrencyCode] = useState('USD');
// FIX (race condition) : runBacktest() est appelé automatiquement au mount
// (voir plus bas). Avant ce fix, cet appel initial capturait
// settingsCurrencyCode='USD' (valeur par défaut du useState), car le fetch
// /settings n'avait pas encore résolu — capitalCurrency était donc TOUJOURS
// 'USD' sur le tout premier run, même si l'utilisateur a MAD/EUR en
// settings. Un ref est lu à l'exécution (pas de closure figée sur un
// ancien render), donc runBacktest() lit toujours la valeur la plus
// récente, y compris lors de l'appel synchrone déclenché juste après le
// fetch initial.
const settingsCurrencyCodeRef = useRef('USD');

useEffect(() => {
    let cancelled = false;
    api.get('/settings')
      .then(res => {
        const code = res.data?.settings?.currency || 'USD';
        if (cancelled) return;
        setSettingsCurrency(SETTINGS_CURRENCY_SYMBOLS[code] || '$');
        setSettingsCurrencyCode(code);
        settingsCurrencyCodeRef.current = code;
      })
      .catch(() => {})
      .finally(() => {
        // Le premier backtest ne se lance qu'une fois /settings résolu
        // (succès ou échec) — plus jamais avec 'USD' par défaut alors que
        // l'utilisateur a une autre devise configurée.
        if (!cancelled) runBacktest();
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prefillSymbol = location.state?.prefillSymbol;

  const [form, setForm] = useState({
    name: 'RSI Momentum Reversion v2',
    strategyId: 'rsi_momentum',
    universe: prefillSymbol || 'SPY, QQQ, AAPL, MSFT, NVDA',
    from: '2020-01-01',
    to: '2024-12-31',
    tf: '4H',
    capital: '100,000',
    maxPos: '5',
    posSizeMode: 'fixed_pct',
    posSizeValue: '10',
  });

  const [savedConfigs, setSavedConfigs] = useState([]);
  const [showConfigList, setShowConfigList] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const [metrics, setMetrics] = useState({
    totalReturn: '0.0%', sharpe: '0.00', maxDrawdown: '0.0%',
    winRate: '0.0%', avgRR: '1:0.0', totalTrades: '0',
    avgWin: '+0', avgLoss: '-0', avgHold: '0d', quoteCurrency: 'USD'
  });

  const [backtestData, setBacktestData] = useState({
    stratData: [], bhData: [], ddData: [], annualReturns: [], trades: []
  });

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const runBacktest = async () => {
    setRunning(true);
    setError(null);
    setWarning(null);
    setSkipped(null);
    setProgress(5);
    // FIX (stale results on error) : sans ça, un backtest qui échoue
    // (ex: connectionError) laisse les métriques et l'equity curve du
    // run PRÉCÉDENT affichées à l'écran, comme si c'était le résultat
    // du run actuel — trompeur. On réinitialise à l'état neutre avant
    // de lancer le nouveau run.
    setMetrics({
      totalReturn: '0.0%', sharpe: '0.00', maxDrawdown: '0.0%',
      winRate: '0.0%', avgRR: '1:0.0', totalTrades: '0',
      avgWin: '+0', avgLoss: '-0', avgHold: '0d', quoteCurrency: 'USD'
    });
    setBacktestData({ stratData: [], bhData: [], ddData: [], annualReturns: [], trades: [] });

    try {
      const progressInterval = setInterval(() => {
        setProgress(p => (p >= 85 ? 85 : p + 12));
      }, 100);

      const payload = {
        name: form.name,
        strategyId: form.strategyId,
        universe: form.universe,
        strategy: form.name,
        timeframe: form.tf,
        tf: form.tf,
        startDate: form.from,
        from: form.from,
        endDate: form.to,
        to: form.to,
        capital: form.capital,
        // FIX : le backend a besoin de savoir dans quelle devise `capital`
        // et `positionSizeValue` (mode fixed_dollar) sont exprimés, pour
        // pouvoir les convertir vers la devise de chaque symbole.
        capitalCurrency: settingsCurrencyCodeRef.current,        
        maxPos: form.maxPos,
        positionSizeMode: form.posSizeMode,
        positionSizeValue: form.posSizeValue,
      };

      const res = await api.post('/backtest', payload);

      clearInterval(progressInterval);
      const result = res.data;

      if (result.success) {
        setProgress(100);
        setMetrics(result.metrics);
        setWarning(result.warning || null);
        setSkipped(result.skipped || null);
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

  const loadSavedConfigs = async () => {
    try {
      const res = await api.get('/backtest/configs');
      if (res.data.success) setSavedConfigs(res.data.configs);
    } catch (err) {
      console.error('Failed to load saved configs:', err);
    }
  };

  const saveCurrentConfig = async () => {
    const name = window.prompt(t('backtester.configNamePrompt'));
    if (!name || !name.trim()) return;

    setSavingConfig(true);
    try {
      await api.post('/backtest/configs', { name: name.trim(), config: form });
      await loadSavedConfigs();
    } catch (err) {
      console.error('Failed to save config:', err);
      setError(err.response?.data?.error || t('backtester.genericError'));
    } finally {
      setSavingConfig(false);
    }
  };

  const applyConfig = (cfg) => {
    setForm(cfg.config);
    setShowConfigList(false);
  };

  const deleteConfig = async (id, e) => {
    e.stopPropagation();
    try {
      await api.delete(`/backtest/configs/${id}`);
      setSavedConfigs(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('Failed to delete config:', err);
    }
  };

  const toggleConfigList = () => {
    if (!showConfigList) loadSavedConfigs();
    setShowConfigList(prev => !prev);
  };

  

  const qc = metrics.quoteCurrency || 'USD';
  const selectedStrategy = STRATEGY_OPTIONS.find(s => s.id === form.strategyId) || STRATEGY_OPTIONS[0];
  const ENTRY_RULES = selectedStrategy.entryRules;
  const EXIT_RULES = selectedStrategy.exitRules;

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
    { key: 'avgWin',      v: fmtSigned(metrics.avgWin, qc),  c: 'var(--green)' },
    { key: 'avgLoss',     v: fmtSigned(metrics.avgLoss, qc), c: 'var(--red)' },
    { key: 'avgHold',     v: metrics.avgHold,     c: 'var(--cyan)' },
  ];

  const TABLE_HEADERS = [
    t('backtester.num'),      t('backtester.symbol'),   t('backtester.direction'),
    t('backtester.entry'),    t('backtester.exit'),     t('backtester.pnl'),
    t('backtester.rr'),       t('backtester.duration'),
  ];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={label10}>{t('backtester.engine')}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono,monospace' }}>
          {t('backtester.dataRange')}
        </div>
      </div>

      {error && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
          color: 'var(--red)', fontSize: 12, fontFamily: 'JetBrains Mono,monospace',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }} aria-label="dismiss">×</button>
        </div>
      )}

      {warning && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
          color: 'var(--amber)', fontSize: 12, fontFamily: 'JetBrains Mono,monospace',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>{warning}</span>
          <button onClick={() => setWarning(null)} style={{ background: 'transparent', border: 'none', color: 'var(--amber)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }} aria-label="dismiss">×</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>

        <div style={panel}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cyan)' }} />
            {t('backtester.stratConfig')}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.strategyType')}</div>
            <select
              style={{ ...inpStyle, color: 'var(--text-secondary)' }}
              value={form.strategyId}
              onChange={e => setForm(f => ({ ...f, strategyId: e.target.value }))}
            >
              {STRATEGY_OPTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.stratName')}</div>
            <input style={inpStyle} value={form.name} onChange={set('name')} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.universe')}</div>
            <input style={inpStyle} value={form.universe} onChange={set('universe')} />
          </div>
          <div style={{ marginTop: -8, marginBottom: 14, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono,monospace' }}>
            {t('backtester.universeHint')}
          </div>

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
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.capital', { symbol: settingsCurrency })}</div>
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: form.posSizeMode !== 'kelly' ? 10 : 16 }}>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.posSize')}</div>
              <select
                style={{ ...inpStyle, color: 'var(--text-secondary)' }}
                value={form.posSizeMode}
                onChange={e => setForm(f => ({
                  ...f,
                  posSizeMode: e.target.value,
                  posSizeValue: e.target.value === 'fixed_dollar' ? '1000' : '10',
                }))}
              >
                <option value="fixed_pct">{t('backtester.posSizeFixedPct')}</option>
                <option value="kelly">{t('backtester.posSizeKelly')}</option>
                <option value="fixed_dollar">{t('backtester.posSizeFixedDollar')}</option>
              </select>
            </div>
            <div>
              <div style={{ ...label10, marginBottom: 5 }}>{t('backtester.maxPos')}</div>
              <input style={inpStyle} value={form.maxPos} onChange={set('maxPos')} />
            </div>
          </div>

          {form.posSizeMode !== 'kelly' ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...label10, marginBottom: 5 }}>
                {form.posSizeMode === 'fixed_dollar'
                  ? t('backtester.posSizeValueCurrency', { symbol: settingsCurrency })
                  : t('backtester.posSizeValuePct')}
              </div>
              <input style={inpStyle} value={form.posSizeValue} onChange={set('posSizeValue')} />
            </div>
          ) : (
            <div style={{ marginBottom: 16, fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono,monospace', lineHeight: 1.5 }}>
              {t('backtester.kellyExplanation')}
            </div>
          )}

          {skipped && skipped.length > 0 && (
            <div style={{ marginBottom: 12, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono,monospace' }}>
              {t('backtester.skippedSymbols', { count: skipped.length, symbols: skipped.map(s => s.symbol).join(', ') })}
            </div>
          )}

          {running && (
            <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', width: `${Math.min(progress, 100)}%`, background: 'linear-gradient(90deg,var(--cyan),var(--purple-bright))', borderRadius: 2, transition: 'width .1s linear' }} />
            </div>
          )}

          {/* FIX : le bouton "Run Backtest" était dupliqué deux fois de
              suite (copy-paste) — un seul bouton ici, même onClick. */}
          <button
            onClick={runBacktest}
            disabled={running}
            style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg,rgba(0,196,170,0.3),rgba(0,245,212,0.15))', border: '1px solid var(--cyan-dim)', color: 'var(--cyan)', fontSize: 14, fontWeight: 700, fontFamily: 'Syne,sans-serif', letterSpacing: '.08em', borderRadius: 10, cursor: 'pointer', opacity: running ? .7 : 1, transition: 'all .3s' }}
          >
            {running ? t('backtester.running', { pct: Math.min(Math.round(progress), 100) }) : t('backtester.runBacktest')}
          </button>

          <div style={{ display: 'flex', gap: 8, marginTop: 8, position: 'relative' }}>
            <button
              onClick={saveCurrentConfig}
              disabled={savingConfig}
              style={{ flex: 1, padding: 10, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, fontFamily: 'Syne,sans-serif', letterSpacing: '.05em', borderRadius: 8, cursor: 'pointer', opacity: savingConfig ? .6 : 1 }}
            >
              {t('backtester.saveConfig')}
            </button>
            <button
              onClick={toggleConfigList}
              style={{ flex: 1, padding: 10, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, fontFamily: 'Syne,sans-serif', letterSpacing: '.05em', borderRadius: 8, cursor: 'pointer' }}
            >
              {t('backtester.loadConfig')}
            </button>

            {showConfigList && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, maxHeight: 220, overflowY: 'auto', zIndex: 20 }}>
                {savedConfigs.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>{t('backtester.noSavedConfigs')}</div>
                ) : (
                  savedConfigs.map(cfg => (
                    <div
                      key={cfg.id}
                      onClick={() => applyConfig(cfg)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', fontSize: 12, color: 'var(--text)', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                    >
                      <span>{cfg.name}</span>
                      <span onClick={(e) => deleteConfig(cfg.id, e)} style={{ color: 'var(--red)', cursor: 'pointer', padding: '0 4px' }}>×</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
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
              <Line data={eqChartData} options={{ ...baseOpts, animation: { duration: 1000 }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { maxTicksLimit: 4, font: { size: 10 }, callback: v => fmtAmount(v, qc) } } } }} />
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
                      <tr key={`${tr.sym}-${tr.n}-${tr.exitDate}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '9px 12px', ...monoSm, color: 'var(--text-muted)' }}>{tr.n}</td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>
                          <span style={{ background: 'rgba(0,245,212,0.08)', color: 'var(--cyan)', border: '1px solid rgba(0,245,212,0.15)', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>{tr.sym}</span>
                        </td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>
                          <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, background: tr.type === 'SHORT' ? 'rgba(248,113,113,0.12)' : 'rgba(52,211,153,0.12)', color: tr.type === 'SHORT' ? 'var(--red)' : 'var(--green)' }}>
                            {tr.type || 'LONG'}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>{fmtAmount(tr.entry, tr.qc)}</td>
                        <td style={{ padding: '9px 12px', ...monoSm }}>{fmtAmount(tr.exit, tr.qc)}</td>
                        <td style={{ padding: '9px 12px', ...monoSm, color: tr.isW ? 'var(--green)' : 'var(--red)' }}>{fmtSigned(tr.pnl, tr.qc)}</td>
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