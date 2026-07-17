import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend } from 'chart.js';
import api from '../services/api';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

const RISK_COLOR = { low:'var(--green)', med:'var(--amber)', high:'var(--red)' };
const RISK_BG    = { low:'rgba(52,211,153,0.12)', med:'rgba(251,191,36,0.1)', high:'rgba(248,113,113,0.12)' };
const ACTION_COLOR = { REDUCE:'var(--red)', INCREASE:'var(--green)', HOLD:'var(--text-secondary)' };

const monoSm    = { fontFamily:'JetBrains Mono,monospace', fontSize:12 };
const label10   = { fontSize:10, letterSpacing:'.15em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' };
const panel     = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:22 };
const chartBase = { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } } };
const inpStyle  = { padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono,monospace', fontSize: 12, outline: 'none' };

const SECTOR_COLORS = {
  Technology: 'rgba(248,113,113,0.7)',
  Financials: 'rgba(0,245,212,0.6)',
  Consumer:   'rgba(167,139,250,0.6)',
  Healthcare: 'rgba(251,191,36,0.6)',
  Energy:     'rgba(52,211,153,0.6)',
  Crypto:     'rgba(0,245,212,0.4)',
  'Index/ETF': 'rgba(167,139,250,0.4)',
  Other:      'rgba(100,116,139,0.4)',
};

const HORIZONS = ['1D', '1W', '1M'];

function corrColor(v) {
  if (v >= .8) return 'rgba(248,113,113,0.7)';
  if (v >= .6) return 'rgba(251,191,36,0.5)';
  if (v >= .3) return 'rgba(255,255,255,0.08)';
  if (v >= 0)  return 'rgba(0,245,212,0.2)';
  return 'rgba(52,211,153,0.5)';
}

export default function RiskMatrix() {
  const { t } = useTranslation();

  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]     = useState(null);
  const [data, setData]       = useState(null);
  const [bars, setBars]       = useState([]);
  const [horizon, setHorizon] = useState('1D');

  const [customShock, setCustomShock]   = useState('-15');
  const [customSector, setCustomSector] = useState('all');
  const [customResult, setCustomResult] = useState(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError]   = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadRisk() {
      if (data) setRefreshing(true); else setLoading(true);
      setError(null);
      try {
        const res = await api.get('/risk/matrix', { params: { horizon } });
        if (cancelled) return;

        if (res.data.success) {
          setData(res.data.data);
        } else {
          setError(res.data.error || t('riskMatrix.genericError'));
        }
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error || t('riskMatrix.connectionError'));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    loadRisk();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, horizon]);

  useEffect(() => {
    if (!data?.stressTests) return;
    const timer = setTimeout(() => {
      setBars(data.stressTests.map(s => Math.abs(s.impactPct) / 55 * 100));
    }, 300);
    return () => clearTimeout(timer);
  }, [data]);

  const runCustomStressTest = async () => {
    setCustomLoading(true);
    setCustomError(null);
    setCustomResult(null);
    try {
      const res = await api.post('/risk/stress-test', {
        shockPct: parseFloat(customShock),
        sector: customSector,
      });
      if (res.data.success) {
        setCustomResult(res.data.data);
      } else {
        setCustomError(res.data.error || t('riskMatrix.genericError'));
      }
    } catch (err) {
      setCustomError(err.response?.data?.error || t('riskMatrix.connectionError'));
    } finally {
      setCustomLoading(false);
    }
  };

  // ✅ Feature: Correlation Insights — dérive avg/max/min pairwise correlation
  // directement de correlationMatrix.matrix (déjà en mémoire, aucun appel
  // réseau supplémentaire). Remplit l'espace vide qui restait dans le panel
  // Correlation Matrix quand il n'y a que 2-3 positions (grille 3x3 minuscule
  // dans un panel large) et donne une lecture immédiate — pas besoin de
  // scruter chaque cellule pour repérer la paire la plus corrélée.
  const correlationInsights = useMemo(() => {
    const cm = data?.correlationMatrix;
    if (!cm || cm.symbols.length < 2) return null;

    const pairs = [];
    for (let i = 0; i < cm.symbols.length; i++) {
      for (let j = i + 1; j < cm.symbols.length; j++) {
        pairs.push({
          a: cm.symbols[i],
          b: cm.symbols[j],
          v: cm.matrix[i][j],
        });
      }
    }
    if (pairs.length === 0) return null;

    const avg = pairs.reduce((sum, p) => sum + p.v, 0) / pairs.length;
    const highest = pairs.reduce((max, p) => (p.v > max.v ? p : max), pairs[0]);
    const lowest  = pairs.reduce((min, p) => (p.v < min.v ? p : min), pairs[0]);

    return {
      avg: parseFloat(avg.toFixed(2)),
      highest,
      lowest,
      pairCount: pairs.length,
    };
  }, [data]);

  if (loading && !data) {
    return (
      <div style={{ ...panel, textAlign: 'center', padding: 60 }}>
        <div style={{ ...monoSm, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 11 }}>
          {t('riskMatrix.loading')}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ ...panel, textAlign: 'center', padding: 60, border: '1px solid rgba(248,113,113,0.25)' }}>
        <div style={{ ...monoSm, color: 'var(--red)', fontSize: 12 }}>{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ ...panel, textAlign: 'center', padding: 60 }}>
        <div style={{ ...monoSm, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 11 }}>
          {t('riskMatrix.noPositions')}
        </div>
      </div>
    );
  }

  const { kpis, positions, correlationMatrix, stressTests, sectorRisk, returnDistribution, sectorConcentration } = data;
  const availableSectors = [...new Set(positions.map(p => p.sector))];

  const KPIS = [
    { lbl: t('riskMatrix.dailyVar'),   val: `−$${Math.abs(kpis.dailyVaR).toLocaleString()}`, sub: `${kpis.dailyVaRPct}%`,            border:'rgba(248,113,113,0.2)',  vc:'var(--red)'   },
    { lbl: t('riskMatrix.cvar'),       val: `−$${Math.abs(kpis.cvar).toLocaleString()}`,      sub: `${kpis.cvarPct}%`,                border:'rgba(248,113,113,0.15)', vc:'var(--amber)' },
    { lbl: t('riskMatrix.beta'),       val: kpis.beta.toFixed(2),                              sub: t('riskMatrix.betaSub'),           border:'var(--border)',          vc:'var(--amber)' },
    { lbl: t('riskMatrix.volatility'), val: `${kpis.volatility}%`,                             sub: t('riskMatrix.volSub'),            border:'var(--border)',          vc:'var(--cyan)'  },
    { lbl: t('riskMatrix.riskScore'),  val: `${kpis.riskScore}/100`,                           sub: t('riskMatrix.riskScoreSub'),      border:'rgba(52,211,153,0.15)',  vc:'var(--amber)' },
    { lbl: t('riskMatrix.diversification'), val: `${kpis.diversificationScore}/100`,           sub: t('riskMatrix.diversificationSub'),border:'rgba(0,245,212,0.15)',   vc:'var(--cyan)'  },
  ];

  const TABLE_HEADERS = [
    t('riskMatrix.symbol'),   t('riskMatrix.value'),
    t('riskMatrix.weight'),
    t('riskMatrix.beta_col'), t('riskMatrix.contribVar'),
    t('riskMatrix.margRisk'), t('riskMatrix.suggestion'),
  ];

  const varChart = {
    labels: returnDistribution.labels,
    datasets: [{
      data: returnDistribution.counts,
      backgroundColor: returnDistribution.labels.map(b => {
        const v = parseFloat(b);
        if (v < -0.001) return 'rgba(248,113,113,0.5)';
        if (v > 0.001)  return 'rgba(52,211,153,0.5)';
        return 'rgba(100,116,139,0.3)';
      }),
      borderRadius: 3,
    }],
  };

  const sectorRiskChart = {
    labels: sectorRisk.map(s => s.sector),
    datasets: [{
      data: sectorRisk.map(s => s.weightPct),
      backgroundColor: sectorRisk.map(s => SECTOR_COLORS[s.sector] || SECTOR_COLORS.Other),
      borderWidth: 0,
    }],
  };

  const sectorCenterTextPlugin = {
    id: 'sectorCenterText',
    afterDraw(chart) {
      if (!sectorConcentration) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const centerX = (chartArea.left + chartArea.right) / 2;
      const centerY = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = "700 18px 'JetBrains Mono', monospace";
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${sectorConcentration.pct}%`, centerX, centerY - 9);
      ctx.font = "600 9px 'JetBrains Mono', monospace";
      ctx.fillStyle = '#64748b';
      ctx.fillText(sectorConcentration.sector, centerX, centerY + 10);
      ctx.restore();
    },
  };

  const corrSymbols = correlationMatrix.symbols;

  return (
    <>

      {/* ── Header + Horizon toggle ──────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={label10}>{t('riskMatrix.engine')}</div>
          {refreshing && (
            <div style={{ ...label10, color:'var(--cyan)', display:'flex', alignItems:'center', gap:5 }}>
              <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--cyan)', animation:'riskPulse 1s infinite' }} />
              Updating
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
            {HORIZONS.map(h => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                style={{
                  padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontFamily: 'JetBrains Mono,monospace', fontSize: 11, fontWeight: 600,
                  background: horizon === h ? 'rgba(0,245,212,0.15)' : 'transparent',
                  color: horizon === h ? 'var(--cyan)' : 'var(--text-muted)',
                  transition: 'all .15s',
                }}
              >
                {h}
              </button>
            ))}
          </div>
          <div style={{ fontSize:12, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {t('riskMatrix.liveUpdate')}
          </div>
        </div>
      </div>

      {sectorConcentration?.isHighConcentration && (
        <div style={{
          ...panel, padding:'14px 18px', display:'flex', alignItems:'center', gap:12,
          border:'1px solid rgba(251,191,36,0.3)', background:'rgba(251,191,36,0.05)',
        }}>
          <div style={{ fontSize:18, flexShrink:0 }}>⚠️</div>
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--amber)' }}>
              High sector concentration
            </div>
            <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
              {sectorConcentration.pct}% of your portfolio is in {sectorConcentration.sector}. Consider diversifying across other sectors to reduce correlated risk.
            </div>
          </div>
        </div>
      )}

      {/* ── KPIs ───────────────────────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12 }}>
        {KPIS.map(k => (
          <div key={k.lbl} style={{ background:'var(--surface)', border:`1px solid ${k.border}`, borderRadius:12, padding:'16px 18px' }}>
            <div style={{ ...label10, marginBottom:8 }}>{k.lbl}</div>
            <div style={{ fontSize:22, fontWeight:700, color:k.vc }}>{k.val}</div>
            <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:4 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Correlation + Risk by Position ─────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>

        <div style={{ ...panel, display:'flex', flexDirection:'column' }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
            {t('riskMatrix.corrMatrix')}
          </div>
          <div style={{ fontSize:10, ...monoSm, color:'var(--text-muted)', marginBottom:8 }}>
            {corrSymbols.join(' · ')}
          </div>
          {corrSymbols.length === 0 ? (
            <div style={{ ...monoSm, color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', padding: 20 }}>
              {t('riskMatrix.notEnoughData')}
            </div>
          ) : (
            // ✅ Fix layout: la grille est maintenant centrée horizontalement
            // et ses cellules agrandies (52px au lieu de 42px) — avant, avec
            // seulement 2-3 positions, la petite grille flottait à gauche
            // d'un panel large, laissant beaucoup d'espace vide à droite.
            <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <div style={{ display:'flex', flexDirection:'column', gap:4, overflowX: 'auto' }}>
                <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <div style={{ width:64, flexShrink: 0 }} />
                  {corrSymbols.map(s => (
                    <div key={s} style={{ width:52, flexShrink: 0, textAlign:'center', fontSize:9, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' }}>{s}</div>
                  ))}
                </div>
                {correlationMatrix.matrix.map((row, ri) => (
                  <div key={ri} style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <div style={{ width:64, flexShrink: 0, fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', textAlign:'right', paddingRight:8 }}>{corrSymbols[ri]}</div>
                    {row.map((v, ci) => (
                      <div key={ci}
                        title={`${corrSymbols[ri]}×${corrSymbols[ci]}: ${v.toFixed(2)}`}
                        style={{ width:52, height:36, flexShrink: 0, borderRadius:4, background:corrColor(v), display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'rgba(255,255,255,0.85)', transition:'transform .15s', cursor:'default' }}
                        onMouseOver={e => e.currentTarget.style.transform='scale(1.12)'}
                        onMouseOut={e  => e.currentTarget.style.transform='scale(1)'}
                      >
                        {v.toFixed(2)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:'flex', gap:12, marginTop:12, fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', justifyContent:'center' }}>
            <span style={{ color:'var(--red)' }}>▮ +1.0</span>
            <span>▮ 0.5</span>
            <span style={{ color:'var(--cyan)' }}>▮ 0.0</span>
            <span>▮ −0.5</span>
            <span style={{ color:'var(--green)' }}>▮ −1.0</span>
          </div>

          {/* ✅ Feature: Correlation Insights — dérivé de correlationMatrix,
              remplit l'espace restant sous la grille et donne une lecture
              directe sans devoir comparer les cellules à l'œil. */}
          {correlationInsights && (
            <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid var(--border)', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
              <div style={{ textAlign:'center' }}>
                <div style={{ ...label10, fontSize:9, marginBottom:6 }}>Avg Pairwise</div>
                <div style={{ fontSize:16, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--cyan)' }}>
                  {correlationInsights.avg.toFixed(2)}
                </div>
              </div>
              <div style={{ textAlign:'center' }}>
                <div style={{ ...label10, fontSize:9, marginBottom:6 }}>Most Correlated</div>
                <div style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--red)' }}>
                  {correlationInsights.highest.a}·{correlationInsights.highest.b}
                </div>
                <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                  {correlationInsights.highest.v.toFixed(2)}
                </div>
              </div>
              <div style={{ textAlign:'center' }}>
                <div style={{ ...label10, fontSize:9, marginBottom:6 }}>Least Correlated</div>
                <div style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--green)' }}>
                  {correlationInsights.lowest.a}·{correlationInsights.lowest.b}
                </div>
                <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>
                  {correlationInsights.lowest.v.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--amber)' }} />
            {t('riskMatrix.riskByPos')}
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                {TABLE_HEADERS.map(h => (
                  <th key={h} style={{ textAlign:'left', padding:'9px 12px', ...label10, borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(p => (
                <tr key={p.symbol} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding:'9px 12px', ...monoSm }}>
                    <span style={{ background:'rgba(0,245,212,0.08)', color:'var(--cyan)', border:'1px solid rgba(0,245,212,0.15)', padding:'2px 7px', borderRadius:4, fontSize:10, fontWeight:600 }}>{p.symbol}</span>
                  </td>
                  <td style={{ padding:'9px 12px', ...monoSm, color:'var(--text-secondary)' }}>
                    ${p.marketValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td style={{ padding:'9px 12px', ...monoSm }}>{p.weight}%</td>
                  <td style={{ padding:'9px 12px', ...monoSm, color:p.beta>1?'var(--amber)':'var(--green)' }}>{p.beta.toFixed(2)}</td>
                  <td style={{ padding:'9px 12px', ...monoSm, color:'var(--red)' }}>${Math.abs(p.contribVar).toLocaleString()}</td>
                  <td style={{ padding:'9px 12px', ...monoSm }}>
                    <span style={{ padding:'2px 8px', borderRadius:4, fontSize:10, background:RISK_BG[p.marginalRisk], color:RISK_COLOR[p.marginalRisk] }}>
                      {t(`riskMatrix.${p.marginalRisk}`)}
                    </span>
                  </td>
                  <td style={{ padding:'9px 12px', ...monoSm, fontSize: 10 }} title={p.sizing?.reason}>
                    <span style={{ color: ACTION_COLOR[p.sizing?.action] || 'var(--text-secondary)', fontWeight: 600 }}>
                      {t(`riskMatrix.action_${p.sizing?.action}`)}
                    </span>
                    {p.sizing?.action !== 'HOLD' && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                        → {p.sizing?.suggestedWeightPct}%
                        {typeof p.sizing?.deltaDollar === 'number' && (
                          <span style={{ marginLeft: 4 }}>
                            ({p.sizing.deltaDollar >= 0 ? '+' : '−'}${Math.abs(p.sizing.deltaDollar).toLocaleString(undefined, { maximumFractionDigits: 0 })})
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Stress Tests ───────────────────────────────────────────────────── */}
      <div style={panel}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--red)' }} />
          {t('riskMatrix.stressTests')}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {stressTests.map((s, i) => {
            const isPos = s.impactPct > 0;
            const col   = isPos ? 'var(--green)' : 'var(--red)';
            return (
              <div key={i}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, transition:'border-color .2s' }}
                onMouseOver={e => e.currentTarget.style.borderColor='rgba(0,245,212,0.15)'}
                onMouseOut={e  => e.currentTarget.style.borderColor='var(--border)'}
              >
                <div style={{ width:180, fontSize:12, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)', flexShrink:0 }}>{s.name}</div>
                <div style={{ flex:1, height:5, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${bars[i] || 0}%`, background:col, opacity:.7, borderRadius:3, transition:'width 1s ease' }} />
                </div>
                <div style={{ width:80, textAlign:'right', fontSize:13, fontWeight:600, fontFamily:'JetBrains Mono,monospace', color:col }}>
                  {isPos ? '+' : ''}{s.impactPct}%
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Custom Stress Scenario Builder ──────────────────────────── */}
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
          <div style={{ ...label10, marginBottom: 12 }}>{t('riskMatrix.customScenario')}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ ...label10, marginBottom: 5, fontSize: 9 }}>{t('riskMatrix.marketShock')}</div>
              <input
                type="number"
                step="1"
                style={{ ...inpStyle, width: 100 }}
                value={customShock}
                onChange={e => setCustomShock(e.target.value)}
              />
            </div>
            <div>
              <div style={{ ...label10, marginBottom: 5, fontSize: 9 }}>{t('riskMatrix.sectorFocus')}</div>
              <select
                style={{ ...inpStyle, width: 160, color: 'var(--text-secondary)' }}
                value={customSector}
                onChange={e => setCustomSector(e.target.value)}
              >
                <option value="all">{t('riskMatrix.allSectors')}</option>
                {availableSectors.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <button
              onClick={runCustomStressTest}
              disabled={customLoading}
              style={{ padding: '10px 18px', background: 'linear-gradient(135deg,rgba(0,196,170,0.3),rgba(0,245,212,0.15))', border: '1px solid var(--cyan-dim)', color: 'var(--cyan)', fontSize: 12, fontWeight: 700, fontFamily: 'Syne,sans-serif', letterSpacing: '.05em', borderRadius: 8, cursor: 'pointer', opacity: customLoading ? .6 : 1 }}
            >
              {customLoading ? t('riskMatrix.calculating') : t('riskMatrix.runScenario')}
            </button>

            {customResult && (
              <div style={{ display: 'flex', gap: 16, marginLeft: 8, alignItems: 'center' }}>
                <div>
                  <div style={{ ...label10, fontSize: 9 }}>{t('riskMatrix.estimatedImpact')}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'JetBrains Mono,monospace', color: customResult.impactPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {customResult.impactPct >= 0 ? '+' : ''}{customResult.impactPct}%
                  </div>
                </div>
                <div>
                  <div style={{ ...label10, fontSize: 9 }}>{t('riskMatrix.dollarImpact')}</div>
                  <div style={{ fontSize: 14, fontFamily: 'JetBrains Mono,monospace', color: customResult.impactDollar >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {customResult.impactDollar >= 0 ? '+' : '−'}${Math.abs(customResult.impactDollar).toLocaleString()}
                  </div>
                </div>
              </div>
            )}
          </div>
          {customError && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--red)', ...monoSm }}>{customError}</div>
          )}
        </div>
      </div>

      {/* ── VaR Distribution + Sector Risk ─────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright)' }} />
            {t('riskMatrix.returnDist')}
          </div>
          <div style={{ position:'relative', height:160 }}>
            <Bar data={varChart} options={{ ...chartBase, animation:{duration:900}, scales:{ x:{grid:{display:false},ticks:{font:{size:9}}}, y:{display:false} } }} />
          </div>
        </div>

        <div style={panel}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--cyan)' }} />
            {t('riskMatrix.sectorRisk')}
          </div>
          <div style={{ position:'relative', height:160 }}>
            <Doughnut
              data={sectorRiskChart}
              options={{ ...chartBase, animation:{duration:900,delay:400}, plugins:{ legend:{ display:true, position:'right', labels:{ boxWidth:8, font:{size:10}, padding:8 } } }, cutout:'60%' }}
              plugins={[sectorCenterTextPlugin]}
            />
          </div>
        </div>
      </div>

      <style>{`
        @keyframes riskPulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }
      `}</style>

    </>
  );
}