import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
         ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
         ScatterChart, Scatter } from 'recharts';
import api from '../services/api';

const PERIODS = ['1M','3M','6M','1Y','All'];
const EMPTY = {
  kpis:[], equity:[], monthly:[], trades:[], attribution:[], byDow:[], rolling:[], fingerprint:[],
  distribution:{ buy:0, sell:0, hold:0, total:0 },
  confidenceOutcome: [], confidenceCorrelation: 0,
};

const tt = {
  contentStyle:{
    background:'rgba(3,7,18,0.97)',
    border:'1px solid rgba(0,245,212,0.25)',
    borderRadius:8,
    fontFamily:'JetBrains Mono,monospace',
    fontSize:11,
    boxShadow:'0 8px 32px rgba(0,0,0,0.4)',
  }
};

// Compact SVG radar — larger viewBox to fit labels
function MiniRadar({ data }) {
  if (!data?.length) return null;
  const cx=130, cy=120, r=72, N=data.length;
  const angle = i => (i/N)*2*Math.PI - Math.PI/2;
  const pt = (i, scale) => ({
    x: cx + Math.cos(angle(i))*scale*r,
    y: cy + Math.sin(angle(i))*scale*r,
  });
  const gridPoly = scale => Array.from({length:N},(_,i)=>{const p=pt(i,scale);return`${p.x},${p.y}`;}).join(' ');
  const valuePts = data.map((d,i) => pt(i, Math.max(0.05, d.value/d.max)));
  return (
    <svg width="260" height="240" viewBox="0 0 260 240">
      {[0.25,0.5,0.75,1].map(s=>(
        <polygon key={s} points={gridPoly(s)} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5"/>
      ))}
      {Array.from({length:N},(_,i)=>{
        const o=pt(i,1);
        return <line key={i} x1={cx} y1={cy} x2={o.x} y2={o.y} stroke="rgba(255,255,255,0.04)" strokeWidth="0.5"/>;
      })}
      <polygon
        points={valuePts.map(p=>`${p.x},${p.y}`).join(' ')}
        fill="rgba(0,245,212,0.09)"
        stroke="var(--cyan)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {valuePts.map((p,i)=>(
        <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="var(--cyan)" opacity="0.85"/>
      ))}
      {data.map((d,i)=>{
        const lp = pt(i, 1.38);
        // shorten long labels
        const label = d.metric === 'Diversification' ? 'Divers.' : d.metric === 'Avg Confidence' ? 'Confiance' : d.metric;
        return (
          <g key={i}>
            <text x={lp.x} y={lp.y-2} textAnchor="middle" fontSize="7.5" fill="rgba(148,163,184,0.75)" fontFamily="JetBrains Mono,monospace">{label}</text>
            <text x={lp.x} y={lp.y+10} textAnchor="middle" fontSize="9" fill="var(--cyan)" fontFamily="JetBrains Mono,monospace" fontWeight="700">{d.value}%</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Analytics() {
  const [period, setPeriod] = useState('1M');
  // Drill-down: classe sélectionnée via clic sur une ligne Attribution.
  // null = aucun filtre, toutes les métriques portent sur l'ensemble des signaux.
  const [selectedClass, setSelectedClass] = useState(null);
  const [data,   setData]   = useState(EMPTY);
  // loading = 1er chargement uniquement (skeleton). refreshing = changement de
  // période / filtre: on garde l'ancien contenu affiché au lieu de tout remplacer
  // par le skeleton (sinon le scroll saute et la table Attribution disparaît).
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,  setError]  = useState(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;
    if (firstLoad.current) setLoading(true); else setRefreshing(true);
    setError(null);
    const params = period === 'All' ? {} : { period };
    if (selectedClass) params.class = selectedClass;
    api.get('/signals/analytics', { params })
      .then(res => {
        if (cancelled) return;
        const d = res.data;
        setData({
          kpis:        Array.isArray(d.kpis)        ? d.kpis        : [],
          equity:      Array.isArray(d.equity)      ? d.equity      : [],
          monthly:     Array.isArray(d.monthly)     ? d.monthly     : [],
          trades:      Array.isArray(d.trades)      ? d.trades      : [],
          attribution: Array.isArray(d.attribution) ? d.attribution : [],
          byDow:       Array.isArray(d.byDow)       ? d.byDow       : [],
          rolling:     Array.isArray(d.rolling)     ? d.rolling     : [],
          fingerprint: Array.isArray(d.fingerprint) ? d.fingerprint : [],
          // distribution vient directement du backend (source de vérité).
          distribution: d.distribution && typeof d.distribution === 'object'
            ? d.distribution
            : { buy: 0, sell: 0, hold: 0, total: 0 },
          // Confidence vs Outcome — nuage de points confidence IA / P&L réel (trades clos).
          confidenceOutcome:     Array.isArray(d.confidenceOutcome) ? d.confidenceOutcome : [],
          confidenceCorrelation: typeof d.confidenceCorrelation === 'number' ? d.confidenceCorrelation : 0,
        });
      })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || 'Erreur analytics'); })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
        firstLoad.current = false;
      });
    return () => { cancelled = true; };
  }, [period, selectedClass]);

  // Drill-down: clic sur une ligne Attribution → filtre, ou déselectionne si déjà active
  const toggleClassFilter = (name) => {
    setSelectedClass(prev => (prev === name ? null : name));
  };

  if (loading) return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      <div style={{fontSize:11,letterSpacing:'.2em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace'}}>// Loading analytics...</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:12}}>
        {Array(5).fill(0).map((_,i)=>(
          <div key={i} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,height:90,animation:'pulse 2s infinite'}}/>
        ))}
      </div>
    </div>
  );

  if (error) return (
    <div style={{background:'var(--surface)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:10,padding:'20px',textAlign:'center',fontFamily:'JetBrains Mono,monospace',fontSize:12,color:'var(--red)'}}>{error}</div>
  );

  // total/buys/sells/holds viennent tous de la même source (data.distribution),
  // garantissant que la somme des parts = le total affiché au centre du donut.
  const { buy: buys, sell: sells, hold: holds, total } = data.distribution;
  const distItems = [
    {label:'BUY',  count:buys,  color:'var(--green)'},
    {label:'SELL', count:sells, color:'var(--red)'},
    {label:'HOLD', count:holds, color:'var(--amber)'},
  ];

  return (
    <>
      {/* ── Header ── */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
        <div>
          <div style={{fontSize:10,letterSpacing:'.18em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',marginBottom:2}}>// Performance Analytics</div>
          <div style={{fontSize:10,color:'var(--text-secondary)',fontFamily:'JetBrains Mono,monospace',display:'flex',alignItems:'center',gap:8}}>
            Trades clos (TP/SL) · Signals · R:R
            {selectedClass && (
              <span style={{
                display:'inline-flex', alignItems:'center', gap:6,
                background:'rgba(0,245,212,0.08)', border:'1px solid rgba(0,245,212,0.25)',
                borderRadius:6, padding:'2px 8px', color:'var(--cyan)', fontSize:9,
              }}>
                Filtré: {selectedClass}
                <span
                  onClick={() => setSelectedClass(null)}
                  style={{cursor:'pointer', opacity:0.7, fontWeight:700}}
                  title="Retirer le filtre"
                >✕</span>
              </span>
            )}
            {refreshing && <span style={{color:'var(--text-muted)',fontSize:9}}>actualisation…</span>}
          </div>
        </div>
        <div style={{display:'flex',gap:3,background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:9,padding:3}}>
          {PERIODS.map(p=>(
            <button key={p} onClick={()=>setPeriod(p)} style={{
              padding:'5px 14px',borderRadius:6,border:'none',
              fontFamily:'JetBrains Mono,monospace',fontSize:11,cursor:'pointer',
              background: period===p?'rgba(0,245,212,0.1)':'transparent',
              color:      period===p?'var(--cyan)':'var(--text-secondary)',
              boxShadow:  period===p?'inset 0 0 0 1px rgba(0,245,212,0.2)':'none',
              transition:'all .15s',
            }}>{p}</button>
          ))}
        </div>
      </div>

      {data.kpis.length === 0 ? (
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'32px',textAlign:'center',fontFamily:'JetBrains Mono,monospace',fontSize:12,color:'var(--text-muted)'}}>
          {selectedClass
            ? <>Aucun signal pour <strong style={{color:'var(--cyan)'}}>{selectedClass}</strong> sur cette période. <span onClick={() => setSelectedClass(null)} style={{color:'var(--cyan)', cursor:'pointer', textDecoration:'underline'}}>Retirer le filtre</span></>
            : 'Aucun signal. Lancez un scan pour générer des données.'}
        </div>
      ) : (
        <>
          {/* ── KPI Cards — compact 5-col ── */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>
            {data.kpis.map(k=>(
              <div key={k.label} style={{
                background:'var(--surface)',border:'1px solid var(--border)',
                borderRadius:10,padding:'14px 16px',position:'relative',overflow:'hidden',
                transition:'border-color .2s',
              }}
                onMouseEnter={e=>e.currentTarget.style.borderColor='rgba(0,245,212,0.15)'}
                onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}
              >
                <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:k.color,opacity:0.35,borderRadius:'10px 10px 0 0'}}/>
                <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',marginBottom:7}}>{k.label}</div>
                <div style={{fontSize:22,fontWeight:800,color:k.color,marginBottom:3,letterSpacing:'-.02em',lineHeight:1}}>{k.v}</div>
                <div style={{fontSize:9,fontFamily:'JetBrains Mono,monospace',color:'var(--text-secondary)',marginTop:6,lineHeight:1.4}}>{k.sub}</div>
              </div>
            ))}
          </div>

          {/* ── Row 2: Equity + Monthly ── */}
          {(() => {
            // Baseline = 100: totalPnl = somme des P&L des trades clos.
            const lastPf   = data.equity[data.equity.length-1]?.portfolio ?? 100;
            const totalPnl = (lastPf - 100).toFixed(2);
            const isPos    = parseFloat(totalPnl) >= 0;
            return (
              <div style={{display:'grid',gridTemplateColumns:'1.3fr 1fr',gap:12,opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>
                <div className="panel" style={{padding:18}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7,marginBottom:4}}>
                        <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                        Equity Curve
                        <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— somme des P&L par trade</span>
                      </div>
                      <div style={{display:'flex',gap:12,alignItems:'center'}}>
                        <span style={{fontSize:13,fontWeight:800,fontFamily:'JetBrains Mono,monospace',color:isPos?'var(--green)':'var(--red)'}}>
                          {isPos?'+':''}{totalPnl}%
                        </span>
                        <span style={{fontSize:9,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace'}}>
                          {data.equity.length} trades clos
                        </span>
                      </div>
                    </div>
                    <div style={{display:'flex',gap:12,fontSize:9,fontFamily:'JetBrains Mono,monospace'}}>
                      <span style={{display:'flex',alignItems:'center',gap:4}}>
                        <span style={{width:14,height:1.5,background:'var(--cyan)',display:'inline-block',borderRadius:1}}/>
                        <span style={{color:'var(--cyan)'}}>Portfolio</span>
                      </span>
                    </div>
                  </div>
                  {data.equity.length === 0 ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:160,fontSize:10,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',textAlign:'center',lineHeight:1.6}}>
                      Aucun trade clos pour l'instant.<br/>Les signaux BUY/SELL se clôturent au TP ou au SL.
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={data.equity}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                        <XAxis dataKey="day" tick={{fontSize:7,fill:'#475569',fontFamily:'JetBrains Mono,monospace'}} interval={Math.max(1,Math.floor(data.equity.length/6))}/>
                        <YAxis hide domain={['auto','auto']}/>
                        <ReferenceLine y={100} stroke="rgba(255,255,255,0.08)" strokeWidth={1}/>
                        <Tooltip {...tt} formatter={(v,n,props)=>[
                          `${v.toFixed(2)}% (trade: ${props.payload?.pnl>=0?'+':''}${props.payload?.pnl ?? 0}%)`,
                          'Portfolio',
                        ]}/>
                        <Line type="monotone" dataKey="portfolio" stroke="var(--cyan)" strokeWidth={1.5} dot={data.equity.length < 20}/>
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>

                <div className="panel" style={{padding:18}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                    <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7}}>
                      <div style={{width:5,height:5,borderRadius:'50%',background:'var(--amber)'}}/>
                      Rendements Mensuels
                      <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— P&L réel</span>
                    </div>
                    {data.monthly.length > 0 && (()=>{
                      const best  = Math.max(...data.monthly.map(m=>m.ret));
                      const worst = Math.min(...data.monthly.map(m=>m.ret));
                      return (
                        <div style={{display:'flex',gap:8,fontSize:9,fontFamily:'JetBrains Mono,monospace'}}>
                          <span style={{color:'var(--green)'}}>↑{best.toFixed(1)}%</span>
                          <span style={{color:'var(--red)'}}>↓{worst.toFixed(1)}%</span>
                        </div>
                      );
                    })()}
                  </div>
                  {data.monthly.length === 0 ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:160,fontSize:10,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace'}}>
                      Aucun trade clos
                    </div>
                  ) : data.monthly.length === 1 ? (
                    // Single month — compact stat row
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-around',height:160,gap:12,padding:'0 12px'}}>
                      <div style={{textAlign:'center'}}>
                        <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',marginBottom:6}}>Période</div>
                        <div style={{fontSize:13,fontWeight:700,color:'var(--text-primary)',fontFamily:'JetBrains Mono,monospace'}}>{data.monthly[0].month}</div>
                      </div>
                      <div style={{width:1,height:40,background:'var(--border)'}}/>
                      <div style={{textAlign:'center'}}>
                        <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',marginBottom:6}}>P&L Mois</div>
                        <div style={{fontSize:22,fontWeight:800,fontFamily:'JetBrains Mono,monospace',color:data.monthly[0].ret>=0?'var(--green)':'var(--red)',lineHeight:1}}>
                          {data.monthly[0].ret>=0?'+':''}{data.monthly[0].ret}%
                        </div>
                      </div>
                      <div style={{width:1,height:40,background:'var(--border)'}}/>
                      <div style={{textAlign:'center'}}>
                        <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',marginBottom:6}}>Trades</div>
                        <div style={{fontSize:18,fontWeight:700,color:'var(--text-primary)',fontFamily:'JetBrains Mono,monospace'}}>{data.monthly[0].count}</div>
                      </div>
                      <div style={{width:1,height:40,background:'var(--border)'}}/>
                      <div style={{textAlign:'center'}}>
                        <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',marginBottom:6}}>Win Rate</div>
                        <div style={{fontSize:18,fontWeight:700,color:'var(--amber)',fontFamily:'JetBrains Mono,monospace'}}>{data.monthly[0].winRate}%</div>
                      </div>
                      <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',opacity:0.5,textAlign:'center',maxWidth:80,lineHeight:1.4}}>
                        Graphique disponible avec 2+ mois
                      </div>
                    </div>
                  ) : (()=>{
                    const vals = data.monthly.map(m=>m.ret);
                    const maxAbs = Math.max(Math.abs(Math.max(...vals)), Math.abs(Math.min(...vals)), 1);
                    const domainPad = maxAbs * 1.3;
                    return (
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={data.monthly} barCategoryGap="30%" barSize={28}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                          <XAxis dataKey="month" tick={{fontSize:7,fill:'#475569',fontFamily:'JetBrains Mono,monospace'}}/>
                          <YAxis hide domain={[-domainPad, domainPad]}/>
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1}/>
                          {/* Recharts attend formatter → [value, name] (un seul couple).
                              Les détails du mois passent par labelFormatter. */}
                          <Tooltip {...tt}
                            formatter={(v) => [`${v>=0?'+':''}${v}%`, 'P&L']}
                            labelFormatter={(l, payload) => {
                              const p = payload?.[0]?.payload;
                              return p ? `${l} · ${p.count} trades · ${p.winRate}% win` : l;
                            }}/>
                          <Bar dataKey="ret" radius={[3,3,0,0]} maxBarSize={40}>
                            {data.monthly.map((e,i)=>(
                              <Cell key={i} fill={e.ret>=0?'rgba(52,211,153,0.75)':'rgba(248,113,113,0.75)'}/>
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    );
                  })()}
                </div>
              </div>
            );
          })()}

          {/* ── Row 3: Distribution (ring) + Journal ── */}
          <div style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:12,opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>
            <div className="panel" style={{padding:18}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--purple-bright)'}}/>
                Distribution
              </div>
              {(()=>{
                const cx=130, cy=108, R=78, r=52, gap=3;
                const hexColors = ['#34d399','#f87171','#fbbf24'];
                let cumAngle = -Math.PI/2;
                const slices = distItems.map((item,idx) => {
                  const pct   = total > 0 ? item.count / total : 0;
                  const angle = pct * 2 * Math.PI;
                  const startA = cumAngle + (gap / R);
                  const midA   = cumAngle + angle / 2;
                  const endA   = cumAngle + angle - (gap / R);
                  cumAngle += angle;
                  if (pct < 0.01) return null;
                  const x1=cx+R*Math.cos(startA), y1=cy+R*Math.sin(startA);
                  const x2=cx+R*Math.cos(endA),   y2=cy+R*Math.sin(endA);
                  const x3=cx+r*Math.cos(endA),   y3=cy+r*Math.sin(endA);
                  const x4=cx+r*Math.cos(startA), y4=cy+r*Math.sin(startA);
                  const large = angle > Math.PI ? 1 : 0;
                  // Label position — outside the arc
                  const labelR = R + 18;
                  const lx = cx + labelR * Math.cos(midA);
                  const ly = cy + labelR * Math.sin(midA);
                  // Line from arc midpoint to label
                  const lineStart = { x: cx+(R+2)*Math.cos(midA), y: cy+(R+2)*Math.sin(midA) };
                  const lineEnd   = { x: cx+(R+12)*Math.cos(midA), y: cy+(R+12)*Math.sin(midA) };
                  // Cas limite: une seule part ≈ 100% → start ≈ end, l'arc ne se
                  // dessinerait pas. On trace alors un anneau complet.
                  const full = pct > 0.999;
                  return (
                    <g key={idx}>
                      {full ? (
                        <circle cx={cx} cy={cy} r={(R+r)/2} fill="none"
                          stroke={hexColors[idx]} strokeWidth={R-r} opacity={0.82}/>
                      ) : (
                        <>
                          {/* Arc */}
                          <path
                            d={`M${x1},${y1} A${R},${R},0,${large},1,${x2},${y2} L${x3},${y3} A${r},${r},0,${large},0,${x4},${y4} Z`}
                            fill={hexColors[idx]}
                            opacity={0.82}
                          />
                          {/* Subtle glow on arc */}
                          <path
                            d={`M${x1},${y1} A${R},${R},0,${large},1,${x2},${y2} L${x3},${y3} A${r},${r},0,${large},0,${x4},${y4} Z`}
                            fill="none"
                            stroke={hexColors[idx]}
                            strokeWidth="1"
                            opacity={0.4}
                          />
                        </>
                      )}
                      {/* Tick line */}
                      {pct > 0.04 && !full && (
                        <line x1={lineStart.x} y1={lineStart.y} x2={lineEnd.x} y2={lineEnd.y}
                          stroke={hexColors[idx]} strokeWidth="0.8" opacity="0.6"/>
                      )}
                      {/* Percentage label */}
                      {pct > 0.04 && !full && (
                        <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                          fontSize="9" fontWeight="700" fill={hexColors[idx]}
                          fontFamily="JetBrains Mono,monospace">
                          {(pct*100).toFixed(0)}%
                        </text>
                      )}
                    </g>
                  );
                });
                return (
                  <div>
                    <svg width="260" height="216" style={{display:'block',margin:'0 auto'}}>
                      {/* Background ring track */}
                      <circle cx={cx} cy={cy} r={(R+r)/2} fill="none"
                        stroke="rgba(255,255,255,0.03)" strokeWidth={R-r}/>
                      {slices}
                      {/* Center: total + label */}
                      <text x={cx} y={cy-10} textAnchor="middle" fontSize="22" fontWeight="800"
                        fill="#e2e8f0" fontFamily="JetBrains Mono,monospace">{total}</text>
                      <text x={cx} y={cy+8} textAnchor="middle" fontSize="7" fill="#475569"
                        fontFamily="JetBrains Mono,monospace" letterSpacing=".12em">SIGNALS</text>
                    </svg>
                    {/* Legend row */}
                    <div style={{display:'flex',justifyContent:'center',gap:20,marginTop:2}}>
                      {distItems.map((item,idx)=>(
                        <div key={item.label} style={{display:'flex',alignItems:'center',gap:5}}>
                          <div style={{width:7,height:7,borderRadius:'50%',background:hexColors[idx],flexShrink:0}}/>
                          <span style={{fontSize:9,fontFamily:'JetBrains Mono,monospace',color:'var(--text-secondary)'}}>
                            <span style={{fontWeight:700,color:hexColors[idx]}}>{item.label}</span>
                            {' '}<span style={{color:'var(--text-muted)'}}>{item.count}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="panel" style={{padding:18}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--green)'}}/>
                Journal des Trades
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400,marginLeft:2}}>— 10 derniers BUY/SELL</span>
              </div>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead>
                    <tr>{['Date','Symbol','Direction','P&L','R:R','Résultat'].map(h=>(
                      <th key={h} style={{textAlign:'left',padding:'6px 8px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',borderBottom:'1px solid var(--border)',fontWeight:400}}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {data.trades.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{padding:'24px 8px',textAlign:'center',fontSize:10,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace'}}>
                          Aucun trade BUY/SELL sur cette période
                        </td>
                      </tr>
                    )}
                    {data.trades.map((t,i)=>{
                      const pnlStr   = String(t.pnl ?? '');
                      const isOpen   = pnlStr === 'OPEN';
                      const val      = parseFloat(pnlStr);
                      const pnlColor = isOpen || !Number.isFinite(val) || val === 0
                        ? 'var(--text-muted)'
                        : val > 0 ? 'var(--green)' : 'var(--red)';
                      const outColor = t.outcome === 'TP' ? 'var(--green)'
                        : t.outcome === 'SL' ? 'var(--red)'
                        : 'var(--text-muted)';
                      return (
                        <tr key={i}
                          onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.02)'}
                          onMouseLeave={e=>e.currentTarget.style.background='transparent'}
                          style={{transition:'background .1s'}}
                        >
                          <td style={{padding:'8px',fontSize:10,fontFamily:'JetBrains Mono,monospace',color:'var(--text-secondary)',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{t.date}</td>
                          <td style={{padding:'8px',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>
                            <span style={{background:'rgba(0,245,212,0.08)',color:'var(--cyan)',border:'1px solid rgba(0,245,212,0.15)',padding:'1px 6px',borderRadius:4,fontSize:9,fontWeight:600}}>{t.sym}</span>
                          </td>
                          <td style={{padding:'8px',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>
                            <span style={{padding:'1px 6px',borderRadius:4,fontSize:9,fontWeight:600,
                              background:t.side==='Long'?'rgba(52,211,153,0.12)':t.side==='Short'?'rgba(248,113,113,0.12)':'rgba(251,191,36,0.12)',
                              color:t.side==='Long'?'var(--green)':t.side==='Short'?'var(--red)':'var(--amber)',
                            }}>{t.side}</span>
                          </td>
                          <td style={{padding:'8px',fontSize:10,fontFamily:'JetBrains Mono,monospace',color:pnlColor,fontWeight:600,borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{pnlStr}</td>
                          <td style={{padding:'8px',fontSize:10,fontFamily:'JetBrains Mono,monospace',color:'var(--text-muted)',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{t.rr}</td>
                          <td style={{padding:'8px',fontSize:9,fontWeight:700,fontFamily:'JetBrains Mono,monospace',color:outColor,borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{t.outcome}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Row 4: Attribution — compact table, cliquable (drill-down) ── */}
          {data.attribution.length > 0 && (
            <div className="panel" style={{padding:18,opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--amber)'}}/>
                Attribution P&L · Classe d'Actifs
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400,marginLeft:4}}>— cliquez une ligne pour filtrer</span>
              </div>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr>
                    {['Classe','Allocation','Signaux','Win Rate','Avg Conf.','R:R réalisé'].map(h=>(
                      <th key={h} style={{textAlign:h==='Classe'?'left':'center',padding:'6px 10px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:'JetBrains Mono,monospace',borderBottom:'1px solid var(--border)',fontWeight:400}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.attribution.map((a)=>{
                    const isSelected = selectedClass === a.name;
                    const wrColor = a.winRate == null
                      ? 'var(--text-muted)'
                      : a.winRate >= 60 ? 'var(--green)' : a.winRate >= 45 ? 'var(--amber)' : 'var(--red)';
                    const cells = [
                      { v: a.total },
                      { v: a.winRate == null ? '—' : (Math.round(a.winRate*10)/10)+'%', c: wrColor },
                      { v: (Math.round(a.avgConf))+'%' },
                      { v: a.avgRR > 0 ? `1:${a.avgRR}` : '—' },
                    ];
                    return (
                    <tr key={a.name}
                      onClick={() => toggleClassFilter(a.name)}
                      onMouseEnter={e=>{ if (!isSelected) e.currentTarget.style.background='rgba(255,255,255,0.02)'; }}
                      onMouseLeave={e=>{ if (!isSelected) e.currentTarget.style.background='transparent'; }}
                      style={{
                        transition:'background .1s', cursor:'pointer',
                        background: isSelected ? 'rgba(0,245,212,0.06)' : 'transparent',
                      }}
                      title={isSelected ? `Retirer le filtre ${a.name}` : `Filtrer sur ${a.name}`}
                    >
                      {/* Classe */}
                      <td style={{padding:'10px',borderBottom: isSelected ? '1px solid rgba(0,245,212,0.2)' : '1px solid rgba(255,255,255,0.03)'}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{width:3,height:20,borderRadius:2,background:a.color,opacity: isSelected ? 1 : 0.8,flexShrink:0}}/>
                          <span style={{fontSize:11,fontWeight:700,color:a.color,fontFamily:'JetBrains Mono,monospace'}}>{a.name}</span>
                          {isSelected && <span style={{fontSize:8,color:'var(--cyan)'}}>●</span>}
                        </div>
                      </td>
                      {/* Allocation bar */}
                      <td style={{padding:'10px',borderBottom: isSelected ? '1px solid rgba(0,245,212,0.2)' : '1px solid rgba(255,255,255,0.03)',width:160}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{flex:1,height:4,background:'rgba(255,255,255,0.05)',borderRadius:2,overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${a.pct}%`,background:a.color,borderRadius:2,opacity:0.7,transition:'width .6s'}}/>
                          </div>
                          <span style={{fontSize:10,fontWeight:600,color:'var(--text-secondary)',fontFamily:'JetBrains Mono,monospace',minWidth:32,textAlign:'right'}}>{a.pct}%</span>
                        </div>
                      </td>
                      {/* Stats */}
                      {cells.map((cell,j)=>(
                        <td key={j} style={{padding:'10px',textAlign:'center',fontSize:11,fontWeight:600,fontFamily:'JetBrains Mono,monospace',
                          color: cell.c || 'var(--text-primary)',
                          borderBottom: isSelected ? '1px solid rgba(0,245,212,0.2)' : '1px solid rgba(255,255,255,0.03)'
                        }}>{cell.v}</td>
                      ))}
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Row 5: DoW heatmap + Rolling Win Rate ── */}
          {(data.byDow.length > 0 || data.rolling.length > 0) && (
            <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:12,alignItems:'stretch',opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>

              {/* DoW — compact strip */}
              {data.byDow.length > 0 && (
                <div className="panel" style={{padding:18,minWidth:340}}>
                  <div style={{fontSize:12,fontWeight:600,marginBottom:4,display:'flex',alignItems:'center',gap:7}}>
                    <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                    Win Rate / Jour
                  </div>
                  <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',marginBottom:12}}>Jour d'entrée (UTC) · intensité = taux de succès</div>
                  <div style={{display:'flex',gap:6}}>
                    {data.byDow.map(d=>{
                      const intensity = d.total > 0 ? d.winRate / 100 : 0;
                      return (
                        <div key={d.day} style={{
                          flex:1,
                          background: d.total===0?'rgba(255,255,255,0.02)':`rgba(0,245,212,${0.04+intensity*0.2})`,
                          border: d.total===0?'1px solid rgba(255,255,255,0.04)':`1px solid rgba(0,245,212,${0.06+intensity*0.18})`,
                          borderRadius:7,
                          padding:'9px 4px',
                          textAlign:'center',
                        }}>
                          <div style={{fontSize:8,letterSpacing:'.08em',color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',textTransform:'uppercase',marginBottom:5}}>{d.day}</div>
                          {d.total > 0 ? (
                            <>
                              <div style={{fontSize:13,fontWeight:700,color:'var(--cyan)',fontFamily:'JetBrains Mono,monospace',lineHeight:1}}>{d.winRate}%</div>
                              <div style={{fontSize:8,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',marginTop:3}}>{d.total}t</div>
                            </>
                          ) : (
                            <div style={{fontSize:11,color:'rgba(255,255,255,0.1)'}}>—</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Rolling Win Rate */}
              {data.rolling.length > 0 && (
                <div className="panel" style={{padding:18}}>
                  <div style={{fontSize:12,fontWeight:600,marginBottom:4,display:'flex',alignItems:'center',gap:7}}>
                    <div style={{width:5,height:5,borderRadius:'50%',background:'var(--green)'}}/>
                    Win Rate Glissant (30 trades)
                  </div>
                  <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',marginBottom:12}}>Fenêtre mobile · Tendance de performance</div>
                  {data.rolling.length < 3 ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:130,gap:8}}>
                      <div style={{fontSize:22,fontWeight:800,fontFamily:'JetBrains Mono,monospace',color:'var(--green)'}}>
                        {data.rolling[data.rolling.length-1]?.winRate ?? 0}%
                      </div>
                      <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:'JetBrains Mono,monospace',textAlign:'center',lineHeight:1.5}}>
                        Win rate actuel<br/>
                        <span style={{opacity:0.5}}>Graphique disponible avec plus de données</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={130}>
                        <LineChart data={data.rolling}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                          <XAxis dataKey="day" tick={{fontSize:7,fill:'#475569',fontFamily:'JetBrains Mono,monospace'}} interval={Math.max(1,Math.floor(data.rolling.length/5))}/>
                          <YAxis hide domain={[0,100]}/>
                          <ReferenceLine y={50} stroke="rgba(248,113,113,0.25)" strokeDasharray="4 4" strokeWidth={1}/>
                          <ReferenceLine y={60} stroke="rgba(52,211,153,0.2)" strokeDasharray="4 4" strokeWidth={1}/>
                          <Tooltip {...tt} formatter={v=>[v+'%','Win Rate']}/>
                          <Line type="monotone" dataKey="winRate" stroke="var(--green)" strokeWidth={1.5} dot={data.rolling.length < 10} activeDot={{r:3,fill:'var(--green)'}}/>
                        </LineChart>
                      </ResponsiveContainer>
                      <div style={{display:'flex',gap:14,marginTop:6,fontSize:8,fontFamily:'JetBrains Mono,monospace',color:'var(--text-muted)'}}>
                        <span style={{display:'flex',alignItems:'center',gap:4}}>
                          <span style={{width:10,height:1,background:'rgba(248,113,113,0.4)',display:'inline-block'}}/>Seuil 50%
                        </span>
                        <span style={{display:'flex',alignItems:'center',gap:4}}>
                          <span style={{width:10,height:1,background:'rgba(52,211,153,0.3)',display:'inline-block'}}/>Seuil 60%
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Row 6: Confidence vs Outcome — la confidence IA est-elle fiable ? ── */}
          {data.confidenceOutcome.length > 0 && (() => {
            const corr = data.confidenceCorrelation;
            const absCorr = Math.abs(corr);
            const corrLabel = absCorr >= 0.5 ? 'forte' : absCorr >= 0.25 ? 'modérée' : 'faible';
            const corrColor = absCorr >= 0.5 ? 'var(--green)' : absCorr >= 0.25 ? 'var(--amber)' : 'var(--red)';

            // Plusieurs signaux partagent souvent la même confidence/pnl exacts
            // (TP/SL à valeurs discrètes), ce qui les empile visuellement.
            // Jitter déterministe (hash du symbole, pas Math.random — sinon les
            // points sauteraient à chaque re-render). Les vraies valeurs restent
            // affichées telles quelles dans le tooltip.
            function seededJitter(str, range) {
              let hash = 0;
              for (let i = 0; i < str.length; i++) {
                hash = (hash << 5) - hash + str.charCodeAt(i);
                hash |= 0;
              }
              const normalized = (Math.abs(hash) % 1000) / 1000; // 0..1
              return (normalized - 0.5) * 2 * range; // -range..range
            }
            const withJitter = (p, idx) => {
              const seed = `${p.symbol}-${p.confidence}-${p.pnl}-${idx}`;
              const jitteredConfidence = Math.max(0, Math.min(100, p.confidence + seededJitter(seed, 1.8)));
              const jitteredPnl = p.pnl + seededJitter(seed + 'y', Math.max(0.3, Math.abs(p.pnl) * 0.06));
              return { ...p, confidence: jitteredConfidence, pnl: jitteredPnl, realConfidence: p.confidence, realPnl: p.pnl };
            };
            const buyPoints  = data.confidenceOutcome.filter(p => p.signal === 'BUY').map(withJitter);
            const sellPoints = data.confidenceOutcome.filter(p => p.signal === 'SELL').map(withJitter);

            return (
              <div className="panel" style={{padding:18,opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                  <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7}}>
                    <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                    Confidence vs Outcome
                    <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— confidence IA vs résultat réel (trades clos, n={data.confidenceOutcome.length})</span>
                  </div>
                  <div style={{display:'flex',gap:12,fontSize:9,fontFamily:'JetBrains Mono,monospace'}}>
                    <span style={{display:'flex',alignItems:'center',gap:4}}>
                      <span style={{width:7,height:7,borderRadius:'50%',background:'var(--green)',display:'inline-block'}}/>
                      <span style={{color:'var(--green)'}}>BUY</span>
                    </span>
                    <span style={{display:'flex',alignItems:'center',gap:4}}>
                      <span style={{width:7,height:7,borderRadius:'50%',background:'var(--red)',display:'inline-block'}}/>
                      <span style={{color:'var(--red)'}}>SELL</span>
                    </span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                    <XAxis type="number" dataKey="confidence" name="Confidence" unit="%" domain={[0,100]}
                      tick={{fontSize:8,fill:'#475569',fontFamily:'JetBrains Mono,monospace'}}/>
                    <YAxis type="number" dataKey="pnl" name="P&L" unit="%"
                      tick={{fontSize:8,fill:'#475569',fontFamily:'JetBrains Mono,monospace'}}/>
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1}/>
                    <Tooltip {...tt} cursor={{ strokeDasharray: '3 3' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload;
                        return (
                          <div style={tt.contentStyle}>
                            <div style={{padding:'6px 10px'}}>
                              <div style={{color:'var(--cyan)',fontWeight:700,marginBottom:2}}>{p.symbol} · {p.signal}</div>
                              <div>Confidence: {p.realConfidence}%</div>
                              <div style={{color: p.realPnl >= 0 ? 'var(--green)' : 'var(--red)'}}>P&L: {p.realPnl >= 0 ? '+' : ''}{p.realPnl}%</div>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Scatter data={buyPoints}  fill="var(--green)" opacity={0.55} r={3}/>
                    <Scatter data={sellPoints} fill="var(--red)"   opacity={0.55} r={3}/>
                  </ScatterChart>
                </ResponsiveContainer>
                <div style={{marginTop:10,padding:'8px 12px',background:'rgba(0,245,212,0.04)',border:'1px solid rgba(0,245,212,0.1)',borderRadius:7,fontSize:10,color:'var(--text-secondary)',lineHeight:1.5}}>
                  Corrélation confidence/résultat : <span style={{color:corrColor,fontWeight:700}}>r = {corr}</span> ({corrLabel}).{' '}
                  {absCorr < 0.25
                    ? 'La confidence IA ne prédit pas bien le résultat réel sur cette période — à surveiller.'
                    : corr > 0
                      ? 'Plus la confidence est haute, meilleur est le résultat — cohérent.'
                      : 'Corrélation négative inattendue — la confidence élevée coïncide avec de moins bons résultats.'}
                </div>
              </div>
            );
          })()}

          {/* ── Row 7: Strategy Fingerprint — compact horizontal ── */}
          {data.fingerprint.length > 0 && (
            <div className="panel" style={{padding:18,opacity: refreshing ? 0.6 : 1,transition:'opacity .15s'}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--purple-bright)'}}/>
                Strategy Fingerprint
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400,marginLeft:4}}>— ADN de ta stratégie</span>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:20,alignItems:'center'}}>
                {/* Radar — fixed 200px */}
                <div style={{flexShrink:0}}>
                  <MiniRadar data={data.fingerprint}/>
                </div>
                {/* Metric bars */}
                <div style={{display:'flex',flexDirection:'column',gap:7}}>
                  {data.fingerprint.map(f=>(
                    <div key={f.metric} style={{display:'grid',gridTemplateColumns:'100px 1fr 42px',alignItems:'center',gap:10}}>
                      <span style={{fontSize:9,color:'var(--text-secondary)',fontFamily:'JetBrains Mono,monospace',textAlign:'right'}}>{f.metric}</span>
                      <div style={{height:4,background:'rgba(255,255,255,0.05)',borderRadius:2,overflow:'hidden'}}>
                        <div style={{
                          height:'100%',
                          width:`${(f.value/f.max)*100}%`,
                          background: f.value>=70?'var(--green)':f.value>=40?'var(--cyan)':'var(--amber)',
                          borderRadius:2,
                          transition:'width .8s ease',
                        }}/>
                      </div>
                      <span style={{fontSize:10,fontWeight:700,color:'var(--cyan)',fontFamily:'JetBrains Mono,monospace',textAlign:'right'}}>{f.value}%</span>
                    </div>
                  ))}
                  {/* AI summary tag */}
                  <div style={{marginTop:6,padding:'8px 12px',background:'rgba(0,245,212,0.04)',border:'1px solid rgba(0,245,212,0.1)',borderRadius:7,fontSize:10,color:'var(--text-secondary)',lineHeight:1.5}}>
                    {(()=>{
                      const wr = data.fingerprint.find(f=>f.metric==='Win Rate')?.value||0;
                      const rr = data.fingerprint.find(f=>f.metric==='Risk/Reward')?.value||0;
                      if (wr>=60&&rr>=60) return '✦ Stratégie solide — bon équilibre win rate / R:R';
                      if (wr>=60) return '◈ Win rate élevé — vérifier le R:R moyen';
                      if (rr>=60) return '◈ Bon R:R — le win rate mérite amélioration';
                      return '◇ Stratégie en développement — affiner les signaux';
                    })()}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </>
  );
}