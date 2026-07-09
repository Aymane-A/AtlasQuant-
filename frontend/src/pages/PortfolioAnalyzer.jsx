import { useState } from 'react';
import api from '../services/api';

const mono = { fontFamily: 'JetBrains Mono,monospace' };

const VERDICT_CFG = {
  'Strong':         { color: '#34d399', bg: 'rgba(52,211,153,0.08)',   border: 'rgba(52,211,153,0.25)',  icon: '◆' },
  'Good':           { color: '#00f5d4', bg: 'rgba(0,245,212,0.08)',    border: 'rgba(0,245,212,0.25)',   icon: '◈' },
  'Needs Attention':{ color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',   border: 'rgba(245,158,11,0.25)',  icon: '⬡' },
  'Urgent Action':  { color: '#f43f5e', bg: 'rgba(244,63,94,0.08)',    border: 'rgba(244,63,94,0.25)',   icon: '⚠' },
};

const ACTION_CFG = {
  BUY:       { color: '#34d399', bg: 'rgba(52,211,153,0.1)'   },
  SELL:      { color: '#f43f5e', bg: 'rgba(244,63,94,0.1)'    },
  TRIM:      { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'   },
  HOLD:      { color: '#64748b', bg: 'rgba(100,116,139,0.1)'  },
  REBALANCE: { color: '#a78bfa', bg: 'rgba(167,139,250,0.1)'  },
  HEDGE:     { color: '#38bdf8', bg: 'rgba(56,189,248,0.1)'   },
};

const PRIORITY_CFG = {
  high:   { color: '#f43f5e', label: 'HIGH'   },
  medium: { color: '#f59e0b', label: 'MED'    },
  low:    { color: '#64748b', label: 'LOW'    },
};

const RISK_CFG = {
  'Low':       { color: '#34d399', w: '25%'  },
  'Moderate':  { color: '#f59e0b', w: '50%'  },
  'High':      { color: '#fb923c', w: '75%'  },
  'Very High': { color: '#f43f5e', w: '100%' },
};

// ✅ Feature: quel label et quelle modale déclencher pour chaque type d'action.
// 'HOLD' et les recommandations globales ('PORTFOLIO') n'ont pas d'action
// applicable sur une position unique — pas de bouton Apply pour celles-là.
const APPLY_LABEL = {
  BUY:       'Open →',
  SELL:      'Close →',
  TRIM:      'Adjust →',
  REBALANCE: 'Adjust →',
  HEDGE:     'Open →',
};

function ScoreRing({ score }) {
  const r   = 36;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 70 ? '#34d399' : score >= 50 ? '#f59e0b' : '#f43f5e';

  return (
    <svg width={96} height={96} viewBox="0 0 96 96">
      <circle cx={48} cy={48} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={8} />
      <circle cx={48} cy={48} r={r} fill="none" stroke={color} strokeWidth={8}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 48 48)" style={{ transition:'stroke-dasharray 1s ease' }} />
      <text x={48} y={48} textAnchor="middle" dominantBaseline="central"
        style={{ ...mono, fontSize:20, fontWeight:800, fill:color }}>{score}</text>
    </svg>
  );
}

function Pill({ text, color, bg }) {
  return (
    <span style={{ ...mono, fontSize:9, fontWeight:700, letterSpacing:'.08em',
      padding:'2px 8px', borderRadius:4, color, background:bg, border:`1px solid ${color}30` }}>
      {text}
    </span>
  );
}

// ── Skeleton loader ───────────────────────────────────────
function AnalysisSkeleton() {
  const Sk = ({ w='100%', h=14 }) => (
    <div style={{ width:w, height:h, borderRadius:4,
      background:'rgba(255,255,255,0.06)',
      animation:'aq-pulse 1.6s ease-in-out infinite' }} />
  );
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      {/* Header skeleton */}
      <div style={{ display:'flex', gap:20, alignItems:'center',
        background:'var(--surface)', border:'1px solid var(--border)',
        borderRadius:14, padding:24 }}>
        <div style={{ width:96, height:96, borderRadius:'50%', background:'rgba(255,255,255,0.06)',
          animation:'aq-pulse 1.6s ease-in-out infinite', flexShrink:0 }} />
        <div style={{ flex:1, display:'flex', flexDirection:'column', gap:10 }}>
          <Sk w="40%" h={20} />
          <Sk w="70%" h={12} />
          <Sk w="55%" h={12} />
        </div>
      </div>
      {/* Recs skeleton */}
      {[1,2,3].map(i => (
        <div key={i} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:18 }}>
          <div style={{ display:'flex', gap:12, marginBottom:10 }}>
            <Sk w={40} h={20} />
            <Sk w={60} h={20} />
          </div>
          <Sk h={12} />
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────
// ✅ Feature: props `positions` (allPositionsData depuis Portfolio.jsx) et
// `onApply(rec)` — permet à chaque recommandation de déclencher directement
// la modale d'action correspondante côté parent, au lieu de rester un texte
// que l'utilisateur doit appliquer manuellement lui-même.
export default function PortfolioAnalyzer({ positions = [], onApply }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [expanded, setExpanded] = useState({});

  const analyze = async () => {
    setLoading(true);
    setError('');
    setAnalysis(null);
    try {
      const res = await api.post('/portfolio/analyze');
      if (res.data.success) {
        setAnalysis(res.data.analysis);
      } else {
        setError(res.data.error || 'Analysis failed');
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Connection error');
    } finally {
      setLoading(false);
    }
  };

  const verdict    = analysis ? (VERDICT_CFG[analysis.verdict] || VERDICT_CFG['Good']) : null;
  const riskCfg    = analysis ? (RISK_CFG[analysis.risk_level] || RISK_CFG['Moderate']) : null;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* ── Trigger button ── */}
      {!analysis && !loading && (
        <div style={{
          background:'linear-gradient(135deg, rgba(0,245,212,0.06) 0%, rgba(167,139,250,0.04) 100%)',
          border:'1px solid rgba(0,245,212,0.15)',
          borderRadius:16, padding:'32px 28px',
          display:'flex', flexDirection:'column', alignItems:'center', gap:16, textAlign:'center',
        }}>
          <div style={{ fontSize:36 }}>◎</div>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:'var(--text-primary)', marginBottom:6 }}>
              AI Portfolio Analysis
            </div>
            <div style={{ ...mono, fontSize:11, color:'var(--text-muted)', lineHeight:1.7, maxWidth:400 }}>
              Atlas AI analyzes your positions, risk exposure, sector allocation,
              and P&L to give you actionable recommendations.
            </div>
          </div>
          {error && (
            <div style={{ ...mono, fontSize:11, color:'#f43f5e',
              background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.2)',
              borderRadius:8, padding:'8px 16px', width:'100%', maxWidth:400 }}>
              ✕ {error}
            </div>
          )}
          <button onClick={analyze} style={{
            display:'flex', alignItems:'center', gap:10,
            padding:'12px 32px', borderRadius:10,
            border:'1px solid rgba(0,245,212,0.3)',
            background:'rgba(0,245,212,0.08)',
            color:'var(--cyan)', fontFamily:'Syne,sans-serif',
            fontSize:14, fontWeight:700, cursor:'pointer',
            transition:'all .2s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background='rgba(0,245,212,0.15)'; e.currentTarget.style.borderColor='rgba(0,245,212,0.5)'; }}
            onMouseLeave={e => { e.currentTarget.style.background='rgba(0,245,212,0.08)'; e.currentTarget.style.borderColor='rgba(0,245,212,0.3)'; }}
          >
            <span style={{ fontSize:18 }}>⚡</span>
            Analyze My Portfolio
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ ...mono, fontSize:11, color:'var(--cyan)', display:'flex', alignItems:'center', gap:10,
            background:'rgba(0,245,212,0.04)', border:'1px solid rgba(0,245,212,0.1)',
            borderRadius:10, padding:'12px 18px' }}>
            <span style={{ animation:'spin 1s linear infinite', display:'inline-block' }}>◈</span>
            Atlas AI is analyzing your portfolio...
          </div>
          <AnalysisSkeleton />
          <style>{`
            @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
            @keyframes aq-pulse { 0%,100%{opacity:.4} 50%{opacity:.8} }
            @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
          `}</style>
        </div>
      )}

      {/* ── Results ── */}
      {analysis && !loading && (
        <div style={{ display:'flex', flexDirection:'column', gap:14, animation:'fadeUp .4s ease' }}>
          <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>

          {/* ── Header: score + verdict ── */}
          <div style={{
            background: verdict.bg,
            border: `1px solid ${verdict.border}`,
            borderRadius:16, padding:'24px 28px',
            display:'grid', gridTemplateColumns:'auto 1fr auto',
            gap:24, alignItems:'center',
          }}>
            <ScoreRing score={analysis.score} />

            <div>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                <span style={{ fontSize:20, color:verdict.color }}>{verdict.icon}</span>
                <span style={{ fontSize:20, fontWeight:800, color:verdict.color }}>{analysis.verdict}</span>
              </div>
              <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:10 }}>
                {analysis.verdict_reason}
              </div>
              <div style={{ fontSize:12, color:'var(--text-muted)', lineHeight:1.7 }}>
                {analysis.summary}
              </div>
            </div>

            {/* Risk level */}
            <div style={{ textAlign:'right', minWidth:120 }}>
              <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:8 }}>
                Risk Level
              </div>
              <div style={{ ...mono, fontSize:16, fontWeight:800, color:riskCfg.color, marginBottom:8 }}>
                {analysis.risk_level}
              </div>
              <div style={{ height:4, background:'rgba(255,255,255,0.06)', borderRadius:2, overflow:'hidden' }}>
                <div style={{ height:'100%', width:riskCfg.w, background:riskCfg.color, borderRadius:2, transition:'width 1s ease' }} />
              </div>
              <div style={{ ...mono, fontSize:9, color:'var(--text-muted)', marginTop:6 }}>
                Diversification {analysis.diversification?.score}/100
              </div>
            </div>
          </div>

          {/* ── Strengths + Risks ── */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>

            <div style={{ background:'var(--surface)', border:'1px solid rgba(52,211,153,0.15)', borderRadius:14, padding:20 }}>
              <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'#34d399', marginBottom:14 }}>
                ◆ Strengths
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {(analysis.strengths || []).map((s, i) => (
                  <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                    <span style={{ color:'#34d399', fontSize:10, marginTop:2, flexShrink:0 }}>✓</span>
                    <span style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.5 }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background:'var(--surface)', border:'1px solid rgba(244,63,94,0.15)', borderRadius:14, padding:20 }}>
              <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'#f43f5e', marginBottom:14 }}>
                ⚠ Risks
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {(analysis.risks || []).map((r, i) => (
                  <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                    <span style={{ color:'#f43f5e', fontSize:10, marginTop:2, flexShrink:0 }}>✕</span>
                    <span style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.5 }}>{r}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Recommendations ── */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:22 }}>
            <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:16 }}>
              Recommendations
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {(analysis.recommendations || []).map((rec, i) => {
                const actCfg  = ACTION_CFG[rec.action]   || ACTION_CFG.HOLD;
                const priCfg  = PRIORITY_CFG[rec.priority] || PRIORITY_CFG.low;
                const isOpen  = expanded[i];

                // ✅ Feature: pas de bouton Apply pour une recommandation globale
                // ('PORTFOLIO', pas un symbole précis) ou pour un simple HOLD
                // (rien à exécuter — c'est déjà l'état actuel).
                const applyLabel = APPLY_LABEL[rec.action];
                const canApply   = applyLabel && rec.symbol && rec.symbol !== 'PORTFOLIO';

                return (
                  <div key={i}
                    onClick={() => setExpanded(e => ({ ...e, [i]: !e[i] }))}
                    style={{
                      background: isOpen ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.02)',
                      border:`1px solid ${isOpen ? 'rgba(0,245,212,0.15)' : 'var(--border)'}`,
                      borderRadius:10, padding:'14px 16px', cursor:'pointer',
                      transition:'all .15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor='rgba(0,245,212,0.15)'; }}
                    onMouseLeave={e => { if (!isOpen) e.currentTarget.style.borderColor='var(--border)'; }}
                  >
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      {/* Action badge */}
                      <span style={{ ...mono, fontSize:9, fontWeight:800, letterSpacing:'.1em',
                        padding:'3px 9px', borderRadius:5,
                        color:actCfg.color, background:actCfg.bg,
                        border:`1px solid ${actCfg.color}30`, flexShrink:0 }}>
                        {rec.action}
                      </span>

                      {/* Symbol */}
                      <span style={{ ...mono, fontSize:13, fontWeight:700, color:'var(--text-primary)' }}>
                        {rec.symbol}
                      </span>

                      {/* Priority */}
                      <span style={{ ...mono, fontSize:9, color:priCfg.color, flexShrink:0 }}>
                        ● {priCfg.label}
                      </span>

                      {/* Reason preview */}
                      <span style={{ fontSize:11, color:'var(--text-muted)', flex:1,
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace: isOpen ? 'normal' : 'nowrap' }}>
                        {rec.reason}
                      </span>

                      {/* Apply button — déclenche onApply(rec) côté parent, sans
                          toggler l'accordéon (stopPropagation) */}
                      {canApply && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onApply?.(rec); }}
                          style={{
                            ...mono, fontSize:9, fontWeight:700, letterSpacing:'.05em',
                            padding:'4px 10px', borderRadius:6, cursor:'pointer', flexShrink:0,
                            border:`1px solid ${actCfg.color}40`, background:actCfg.bg, color:actCfg.color,
                            transition:'all .15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = actCfg.color + '25'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = actCfg.bg; }}
                        >
                          {applyLabel}
                        </button>
                      )}

                      <span style={{ ...mono, fontSize:10, color:'var(--text-muted)', flexShrink:0 }}>
                        {isOpen ? '▲' : '▼'}
                      </span>
                    </div>

                    {isOpen && (
                      <div style={{ marginTop:12, paddingTop:12, borderTop:'1px solid var(--border)' }}>
                        <div style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:8 }}>
                          {rec.reason}
                        </div>
                        {rec.impact && (
                          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                            <span style={{ ...mono, fontSize:9, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.1em' }}>
                              Expected impact:
                            </span>
                            <span style={{ ...mono, fontSize:10, color:'var(--cyan)' }}>{rec.impact}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Diversification score ── */}
          {analysis.diversification && (
            <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:'16px 22px',
              display:'flex', alignItems:'center', gap:20 }}>
              <div style={{ flex:1 }}>
                <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:6 }}>
                  Diversification
                </div>
                <div style={{ height:6, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                  <div style={{
                    height:'100%', borderRadius:3, transition:'width 1s ease',
                    width:`${analysis.diversification.score}%`,
                    background: analysis.diversification.score >= 70 ? '#34d399'
                      : analysis.diversification.score >= 40 ? '#f59e0b' : '#f43f5e',
                  }} />
                </div>
              </div>
              <div style={{ ...mono, fontSize:22, fontWeight:800,
                color: analysis.diversification.score >= 70 ? '#34d399'
                  : analysis.diversification.score >= 40 ? '#f59e0b' : '#f43f5e' }}>
                {analysis.diversification.score}<span style={{ fontSize:12, color:'var(--text-muted)' }}>/100</span>
              </div>
              <div style={{ fontSize:11, color:'var(--text-muted)', maxWidth:200, lineHeight:1.5 }}>
                {analysis.diversification.note}
              </div>
            </div>
          )}

          {/* ── Footer: re-analyze ── */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ ...mono, fontSize:9, color:'var(--text-muted)' }}>
              Analyzed {new Date(analysis._meta?.analyzedAt).toLocaleTimeString()} ·{' '}
              {analysis._meta?.positions} positions · ${parseFloat(analysis._meta?.totalValue || 0).toLocaleString('en-US', { maximumFractionDigits:0 })}
            </div>
            <button onClick={analyze}
              style={{ ...mono, fontSize:10, padding:'6px 16px', borderRadius:7,
                border:'1px solid var(--border)', background:'transparent',
                color:'var(--text-muted)', cursor:'pointer', transition:'all .15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor='rgba(0,245,212,0.3)'; e.currentTarget.style.color='var(--cyan)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.color='var(--text-muted)'; }}>
              ↻ Re-analyze
            </button>
          </div>
        </div>
      )}
    </div>
  );
}