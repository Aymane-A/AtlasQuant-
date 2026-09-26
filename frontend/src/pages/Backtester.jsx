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

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF ', AUD: 'A$', CAD: 'C$', MIXED: '' };

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

// ✅ Feature (Auto-Trade gating) : snapshot des paramètres qui déterminent
// params_hash côté backend (strategyId, maxPos, posSizeMode, posSizeValue).
// Sert à détecter un "drift" — si l'utilisateur modifie le form APRÈS un run
// gate_eligible, le hash qu'enverrait createConfig ne matcherait plus celui
// stocké sur ce backtest_id, et le lien automatique échouerait silencieusement
// côté backend (findMatchingBacktest ne le retrouverait pas). On bloque donc
// le bouton "Enable Auto-Trade" tant que le form a bougé depuis le dernier run.
function paramsSnapshot(form) {
  return JSON.stringify({
    strategyId: form.strategyId,
    maxPos: form.maxPos,
    posSizeMode: form.posSizeMode,
    posSizeValue: form.posSizeValue,
  });
}

export default function Backtester() {
  const { t } = useTranslation();
  const location = useLocation();

  const [running, setRunning]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError]       = useState(null);
  const [warning, setWarning]   = useState(null);
  const [skipped, setSkipped]   = useState(null);
  const [settingsCurrency, setSettingsCurrency] = useState('$');
  const [settingsCurrencyCode, setSettingsCurrencyCode] = useState('USD');
  const settingsCurrencyCodeRef = useRef('USD');

  // ✅ Feature (Auto-Trade gating) : état du dernier run réussi, nécessaire
  // pour afficher/activer le bouton "Enable Auto-Trade" (gateEligible=true
  // implique symbols.length===1 côté backend — voir backtest.controller.js).
  const [gateEligible, setGateEligible] = useState(false);
  const [lastBacktestId, setLastBacktestId] = useState(null);
  const [lastRunSymbols, setLastRunSymbols] = useState([]);
  const [paramsAtLastRun, setParamsAtLastRun] = useState(null);

  const [showAutoTradeModal, setShowAutoTradeModal] = useState(false);
  const [autoTradeForm, setAutoTradeForm] = useState({
    exchangeId: '', probationTradesRequired: '5', maxPositionSize: '', maxDailyLossPct: '',
  });
  const [autoTradeSubmitting, setAutoTradeSubmitting] = useState(false);
  const [autoTradeError, setAutoTradeError] = useState(null);
  const [autoTradeSuccess, setAutoTradeSuccess] = useState(null);
  const [needsWatchlistAdd, setNeedsWatchlistAdd] = useState(false);
  const [addingToWatchlist, setAddingToWatchlist] = useState(false);

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
    // ✅ Reset état Auto-Trade à chaque nouveau run — un backtest précédent
    // gate_eligible ne doit plus proposer "Enable Auto-Trade" tant que le
    // nouveau run n'a pas confirmé son propre statut.
    setGateEligible(false);
    setLastBacktestId(null);
    setLastRunSymbols([]);
    setAutoTradeSuccess(null);
    setAutoTradeError(null);
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
        // ✅ Feature (Auto-Trade gating) : on capture backtestId/gateEligible/
        // symbols du run, + un snapshot des params au moment de ce run précis
        // (pour détecter un drift si le form change avant que l'user clique
        // "Enable Auto-Trade").
        setGateEligible(!!result.gateEligible);
        setLastBacktestId(result.backtestId ?? null);
        setLastRunSymbols(result.symbols || []);
        setParamsAtLastRun(paramsSnapshot(form));
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

  // ✅ Feature (Auto-Trade gating) : true si le form a changé depuis le run
  // gate_eligible — le bouton reste visible mais désactivé, avec un message
  // "re-run après modification" plutôt que de disparaître silencieusement.
  const paramsDrifted = paramsAtLastRun !== null && paramsSnapshot(form) !== paramsAtLastRun;
  const autoTradeSymbol = lastRunSymbols[0] || null;

  const openAutoTradeModal = () => {
    setAutoTradeError(null);
    setNeedsWatchlistAdd(false);
    setShowAutoTradeModal(true);
  };

  // ✅ POST /api/auto-trade/configs — payload construit pour matcher EXACTEMENT
  // computeParamsHash côté backend : {strategyId, maxPositions, positionSizeMode,
  // positionSizeValue}. Note le renommage maxPos → maxPositions (noms différents
  // entre le form Backtester et le payload attendu par auto_trade.controller.js).
  const submitAutoTradeConfig = async () => {
    if (!autoTradeSymbol || !autoTradeForm.exchangeId) {
      setAutoTradeError('exchangeId requis');
      return;
    }
    setAutoTradeSubmitting(true);
    setAutoTradeError(null);
    try {
      const res = await api.post('/auto-trade/configs', {
        symbol: autoTradeSymbol,
        strategyId: form.strategyId,
        maxPositions: form.maxPos,
        positionSizeMode: form.posSizeMode,
        positionSizeValue: form.posSizeValue,
        exchangeId: autoTradeForm.exchangeId,
        probationTradesRequired: autoTradeForm.probationTradesRequired,
        maxPositionSize: autoTradeForm.maxPositionSize || undefined,
        maxDailyLossPct: autoTradeForm.maxDailyLossPct || undefined,
      });
      if (res.data.success) {
        setAutoTradeSuccess(res.data.config);
        setShowAutoTradeModal(false);
      }
    } catch (err) {
      const msg = err.response?.data?.error || '';
      // ✅ auto_trade.controller.js rejette si symbol pas dans la watchlist —
      // message backend contient "watchlist" (voir createConfig). On propose
      // alors d'ajouter le symbole directement plutôt qu'un échec sec.
      if (/watchlist/i.test(msg)) {
        setNeedsWatchlistAdd(true);
        setAutoTradeError(msg);
      } else {
        setAutoTradeError(msg || t('backtester.genericError'));
      }
    } finally {
      setAutoTradeSubmitting(false);
    }
  };

  // ⚠️ ASSOMPTION à confirmer : endpoint POST /api/watchlist avec body
  // { symbol } — déduit du schema (table watchlist: user_id, symbol).
  // Corrige le path/body si le vrai endpoint (utilisé par Watchlist.jsx)
  // est différent.
  const addSymbolToWatchlist = async () => {
    if (!autoTradeSymbol) return;
    setAddingToWatchlist(true);
    try {
      await api.post('/watchlist', { symbol: autoTradeSymbol });
      setNeedsWatchlistAdd(false);
      setAutoTradeError(null);
      // ✅ Réessaie automatiquement la création du config une fois le symbole ajouté
      await submitAutoTradeConfig();
    } catch (err) {
      setAutoTradeError(err.response?.data?.error || t('backtester.genericError'));
    } finally {
      setAddingToWatchlist(false);
    }
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

      {autoTradeSuccess && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)',
          color: 'var(--green)', fontSize: 12, fontFamily: 'JetBrains Mono,monospace',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>✅ Auto-Trade config créé pour {autoTradeSuccess.symbol} — status: {autoTradeSuccess.status}</span>
          <button onClick={() => setAutoTradeSuccess(null)} style={{ background: 'transparent', border: 'none', color: 'var(--green)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }} aria-label="dismiss">×</button>
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
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
                {t('backtester.resultsSummary')}
              </div>
              {/* ✅ Feature (Auto-Trade gating) : visible uniquement si le dernier
                  run est gate_eligible (single-symbol, aucun skip). Désactivé +
                  tooltip si le form a dérivé depuis ce run. */}
              {gateEligible && autoTradeSymbol && (
                <button
                  onClick={openAutoTradeModal}
                  disabled={paramsDrifted}
                  title={paramsDrifted ? 'Paramètres modifiés depuis ce run — relancez le backtest' : ''}
                  style={{
                    padding: '7px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                    fontFamily: 'Syne,sans-serif', letterSpacing: '.05em', cursor: paramsDrifted ? 'not-allowed' : 'pointer',
                    background: paramsDrifted ? 'rgba(255,255,255,0.03)' : 'rgba(52,211,153,0.12)',
                    border: `1px solid ${paramsDrifted ? 'var(--border)' : 'rgba(52,211,153,0.3)'}`,
                    color: paramsDrifted ? 'var(--text-muted)' : 'var(--green)',
                  }}
                >
                  🤖 Enable Auto-Trade — {autoTradeSymbol}
                </button>
              )}
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

      {/* ✅ Feature (Auto-Trade gating) : modal minimal — exchangeId (⚠️ input texte
          libre pour l'instant, à remplacer par un select branché sur
          user_exchange_connections si un endpoint GET existe déjà) +
          probation/risk params optionnels. */}
      {showAutoTradeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ ...panel, width: 380 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
              🤖 Enable Auto-Trade — {autoTradeSymbol}
            </div>

            {autoTradeError && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', color: 'var(--red)', fontSize: 11 }}>
                {autoTradeError}
                {needsWatchlistAdd && (
                  <button
                    onClick={addSymbolToWatchlist}
                    disabled={addingToWatchlist}
                    style={{ display: 'block', marginTop: 8, padding: '6px 10px', borderRadius: 6, background: 'rgba(0,245,212,0.1)', border: '1px solid var(--cyan-dim)', color: 'var(--cyan)', fontSize: 11, cursor: 'pointer' }}
                  >
                    {addingToWatchlist ? '...' : `+ Add ${autoTradeSymbol} to Watchlist`}
                  </button>
                )}
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <div style={{ ...label10, marginBottom: 5 }}>Exchange</div>
              <input
                style={inpStyle}
                placeholder="binance, kraken..."
                value={autoTradeForm.exchangeId}
                onChange={e => setAutoTradeForm(f => ({ ...f, exchangeId: e.target.value }))}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ ...label10, marginBottom: 5 }}>Probation Trades Required</div>
              <input
                style={inpStyle}
                value={autoTradeForm.probationTradesRequired}
                onChange={e => setAutoTradeForm(f => ({ ...f, probationTradesRequired: e.target.value }))}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
              <div>
                <div style={{ ...label10, marginBottom: 5 }}>Max Position Size</div>
                <input
                  style={inpStyle}
                  placeholder="optional"
                  value={autoTradeForm.maxPositionSize}
                  onChange={e => setAutoTradeForm(f => ({ ...f, maxPositionSize: e.target.value }))}
                />
              </div>
              <div>
                <div style={{ ...label10, marginBottom: 5 }}>Max Daily Loss %</div>
                <input
                  style={inpStyle}
                  placeholder="optional"
                  value={autoTradeForm.maxDailyLossPct}
                  onChange={e => setAutoTradeForm(f => ({ ...f, maxDailyLossPct: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setShowAutoTradeModal(false)}
                style={{ flex: 1, padding: 10, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 8, cursor: 'pointer', fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                onClick={submitAutoTradeConfig}
                disabled={autoTradeSubmitting}
                style={{ flex: 1, padding: 10, background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.3)', color: 'var(--green)', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, opacity: autoTradeSubmitting ? .6 : 1 }}
              >
                {autoTradeSubmitting ? '...' : 'Enable'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}