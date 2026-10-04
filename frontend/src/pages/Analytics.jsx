import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
         ResponsiveContainer, CartesianGrid, ReferenceLine, Cell } from 'recharts';
import api from '../services/api';
import MyPnL from './MyPnL';

const PERIODS    = ['1M','3M','6M','1Y','All'];
const REFRESH_MS = 60_000;   // auto-refresh silencieux
const PAGE_SIZE  = 10;       // trades par page dans le journal

// Seuils de win rate. Avec un R:R de 1:2 (ATR x2), le breakeven est 1/(1+2) = 33.4%.
// En dessous: la stratégie perd de l'argent même si le win rate "paraît" correct.
const BREAKEVEN_WR = 33.4;
const GOOD_WR      = 40;
const wrColor = wr =>
  wr == null ? 'var(--text-muted)'
  : wr >= GOOD_WR ? 'var(--green)'
  : wr >= BREAKEVEN_WR ? 'var(--amber)'
  : 'var(--red)';

const EMPTY = {
  kpis:[], equity:[], monthly:[], trades:[], attribution:[], byDow:[], rolling:[],
  metrics:[], confidenceBuckets:[],
  distribution:{ buy:0, sell:0, hold:0, total:0 },
  sample:{ closed:0, open:0, min:30, low:true },
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

const MONO = 'JetBrains Mono,monospace';
const toneColor = tone => tone === 'pos' ? 'var(--green)' : tone === 'neg' ? 'var(--red)' : 'var(--text-primary)';

function SignalsAnalytics() {
  const [period, setPeriod] = useState('1M');
  // Drill-down: classe sélectionnée via clic sur une ligne Attribution.
  const [selectedClass, setSelectedClass] = useState(null);
  const [data,   setData]   = useState(EMPTY);
  // loading = 1er chargement uniquement (skeleton). refreshing = changement de
  // période / filtre / bouton refresh: on garde l'ancien contenu affiché.
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);        // incrémenté => recharge
  const [page, setPage] = useState(0);        // pagination du journal
  const firstLoad = useRef(true);
  const silentRef = useRef(false);            // refresh auto = pas de dim de l'écran

  // Auto-refresh toutes les 60s (seulement si l'onglet est visible)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      silentRef.current = true;
      setTick(t => t + 1);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const silent = silentRef.current;
    silentRef.current = false;

    if (firstLoad.current) setLoading(true);
    else if (!silent) setRefreshing(true);

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
          metrics:     Array.isArray(d.metrics)     ? d.metrics     : [],
          confidenceBuckets: Array.isArray(d.confidenceBuckets) ? d.confidenceBuckets : [],
          distribution: d.distribution && typeof d.distribution === 'object'
            ? d.distribution
            : { buy: 0, sell: 0, hold: 0, total: 0 },
          sample: d.sample && typeof d.sample === 'object' ? d.sample : EMPTY.sample,
        });
        setError(null);
        setLoadedOnce(true);
        setLastUpdated(new Date());
      })
      // En cas d'erreur on GARDE les anciennes données (affichées avec un bandeau).
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || 'Erreur analytics'); })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
        firstLoad.current = false;
      });
    return () => { cancelled = true; };
  }, [period, selectedClass, tick]);

  const toggleClassFilter = (name) => {
    setPage(0);
    setSelectedClass(prev => (prev === name ? null : name));
  };
  const changePeriod = (p) => { setPage(0); setPeriod(p); };
  const manualRefresh = () => { silentRef.current = false; setTick(t => t + 1); };

  if (loading) return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      <div style={{fontSize:11,letterSpacing:'.2em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO}}>// Loading analytics...</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:12}}>
        {Array(5).fill(0).map((_,i)=>(
          <div key={i} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,height:90,animation:'pulse 2s infinite'}}/>
        ))}
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
      </div>
    </div>
  );

  // Erreur au tout 1er chargement (rien à afficher)
  if (error && !loadedOnce) return (
    <div style={{background:'var(--surface)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:10,padding:'20px',textAlign:'center',fontFamily:MONO,fontSize:12,color:'var(--red)'}}>
      {error}
      <div style={{marginTop:12}}>
        <button onClick={manualRefresh} style={{background:'transparent',border:'1px solid rgba(248,113,113,0.4)',color:'var(--red)',borderRadius:6,padding:'4px 12px',fontFamily:MONO,fontSize:11,cursor:'pointer'}}>Réessayer</button>
      </div>
    </div>
  );

  // total/buys/sells/holds viennent de la même source (data.distribution).
  const { buy: buys, sell: sells, hold: holds, total } = data.distribution;
  const distItems = [
    {label:'BUY',  count:buys,  color:'var(--green)'},
    {label:'SELL', count:sells, color:'var(--red)'},
    {label:'HOLD', count:holds, color:'var(--amber)'},
  ];

  // Pagination du journal
  const pages    = Math.max(1, Math.ceil(data.trades.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages - 1);
  const shown    = data.trades.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);

  const dim = { opacity: refreshing ? 0.6 : 1, transition:'opacity .15s' };

  return (
    <>
      {/* ── Header ── */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
        <div>
          <div style={{fontSize:10,letterSpacing:'.18em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:2}}>// Performance Analytics</div>
          <div style={{fontSize:10,color:'var(--text-secondary)',fontFamily:MONO,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            Trades clos (TP/SL) · Signals · R:R
            {selectedClass && (
              <span style={{
                display:'inline-flex', alignItems:'center', gap:6,
                background:'rgba(0,245,212,0.08)', border:'1px solid rgba(0,245,212,0.25)',
                borderRadius:6, padding:'2px 8px', color:'var(--cyan)', fontSize:9,
              }}>
                Filtré: {selectedClass}
                <span
                  onClick={() => { setPage(0); setSelectedClass(null); }}
                  style={{cursor:'pointer', opacity:0.7, fontWeight:700}}
                  title="Retirer le filtre"
                >✕</span>
              </span>
            )}
            {refreshing && <span style={{color:'var(--text-muted)',fontSize:9}}>actualisation…</span>}
            {lastUpdated && !refreshing && (
              <span style={{color:'var(--text-muted)',fontSize:9}}>
                MAJ {lastUpdated.toLocaleTimeString('fr-FR')} · auto 60s
              </span>
            )}
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <button
            onClick={manualRefresh}
            title="Actualiser maintenant"
            style={{
              width:30,height:30,borderRadius:8,border:'1px solid var(--border)',
              background:'rgba(255,255,255,0.02)',color:'var(--text-secondary)',
              cursor:'pointer',fontSize:14,lineHeight:1,
            }}
          >↻</button>
          <div style={{display:'flex',gap:3,background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:9,padding:3}}>
            {PERIODS.map(p=>(
              <button key={p} onClick={()=>changePeriod(p)} style={{
                padding:'5px 14px',borderRadius:6,border:'none',
                fontFamily:MONO,fontSize:11,cursor:'pointer',
                background: period===p?'rgba(0,245,212,0.1)':'transparent',
                color:      period===p?'var(--cyan)':'var(--text-secondary)',
                boxShadow:  period===p?'inset 0 0 0 1px rgba(0,245,212,0.2)':'none',
                transition:'all .15s',
              }}>{p}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Erreur de rafraîchissement: on garde les données affichées */}
      {error && loadedOnce && (
        <div style={{background:'rgba(248,113,113,0.06)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:8,padding:'8px 12px',fontSize:10,color:'var(--red)',fontFamily:MONO}}>
          Actualisation impossible ({error}). Données affichées: {lastUpdated ? lastUpdated.toLocaleTimeString('fr-FR') : '—'}.
        </div>
      )}

      {data.kpis.length === 0 ? (
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'32px',textAlign:'center',fontFamily:MONO,fontSize:12,color:'var(--text-muted)'}}>
          {selectedClass
            ? <>Aucun signal pour <strong style={{color:'var(--cyan)'}}>{selectedClass}</strong> sur cette période. <span onClick={() => setSelectedClass(null)} style={{color:'var(--cyan)', cursor:'pointer', textDecoration:'underline'}}>Retirer le filtre</span></>
            : 'Aucun signal. Lancez un scan pour générer des données.'}
        </div>
      ) : (
        <>
          {/* Échantillon faible */}
          {data.sample.low && (
            <div style={{background:'rgba(251,191,36,0.06)',border:'1px solid rgba(251,191,36,0.25)',borderRadius:8,padding:'8px 12px',fontSize:10,color:'var(--amber)',fontFamily:MONO,lineHeight:1.5}}>
              ⚠ Échantillon faible: {data.sample.closed} trade(s) clos sur {data.sample.min} minimum. Les pourcentages ci-dessous sont indicatifs et ne prouvent rien tant que l'échantillon reste petit.
            </div>
          )}

          {/* ── KPI Cards ── */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,...dim}}>
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
                <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:7}}>{k.label}</div>
                <div style={{fontSize:22,fontWeight:800,color:k.color,marginBottom:3,letterSpacing:'-.02em',lineHeight:1}}>{k.v}</div>
                <div style={{fontSize:9,fontFamily:MONO,color:'var(--text-secondary)',marginTop:6,lineHeight:1.4}}>{k.sub}</div>
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
              <div style={{display:'grid',gridTemplateColumns:'1.3fr 1fr',gap:12,...dim}}>
                <div className="panel" style={{padding:18}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7,marginBottom:4}}>
                        <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                        P&L Cumulé
                        <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— somme des % par trade, sans frais ni slippage</span>
                      </div>
                      <div style={{display:'flex',gap:12,alignItems:'center'}}>
                        <span style={{fontSize:13,fontWeight:800,fontFamily:MONO,color:isPos?'var(--green)':'var(--red)'}}>
                          {isPos?'+':''}{totalPnl}%
                        </span>
                        <span style={{fontSize:9,color:'var(--text-muted)',fontFamily:MONO}}>
                          {data.equity.length} trades clos
                        </span>
                      </div>
                    </div>
                  </div>
                  {data.equity.length === 0 ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:160,fontSize:10,color:'var(--text-muted)',fontFamily:MONO,textAlign:'center',lineHeight:1.6}}>
                      Aucun trade clos pour l'instant.<br/>Les signaux BUY/SELL se clôturent au TP ou au SL.
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={data.equity}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                        <XAxis dataKey="day" tick={{fontSize:7,fill:'#475569',fontFamily:MONO}} interval={Math.max(1,Math.floor(data.equity.length/6))}/>
                        <YAxis hide domain={['auto','auto']}/>
                        <ReferenceLine y={100} stroke="rgba(255,255,255,0.08)" strokeWidth={1}/>
                        <Tooltip {...tt} formatter={(v,n,props)=>[
                          `${v.toFixed(2)}% (trade: ${props.payload?.pnl>=0?'+':''}${props.payload?.pnl ?? 0}%)`,
                          'Cumul',
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
                        <div style={{display:'flex',gap:8,fontSize:9,fontFamily:MONO}}>
                          <span style={{color:'var(--green)'}}>↑{best.toFixed(1)}%</span>
                          <span style={{color:'var(--red)'}}>↓{worst.toFixed(1)}%</span>
                        </div>
                      );
                    })()}
                  </div>
                  {data.monthly.length === 0 ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:160,fontSize:10,color:'var(--text-muted)',fontFamily:MONO}}>
                      Aucun trade clos
                    </div>
                  ) : data.monthly.length === 1 ? (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-around',height:160,gap:12,padding:'0 12px'}}>
                      {[
                        { l:'Période', v:data.monthly[0].month, size:13, color:'var(--text-primary)' },
                        { l:'P&L Mois', v:`${data.monthly[0].ret>=0?'+':''}${data.monthly[0].ret}%`, size:22, color:data.monthly[0].ret>=0?'var(--green)':'var(--red)' },
                        { l:'Trades', v:data.monthly[0].count, size:18, color:'var(--text-primary)' },
                        { l:'Win Rate', v:`${data.monthly[0].winRate}%`, size:18, color:wrColor(data.monthly[0].winRate) },
                      ].map((c,i,arr)=>(
                        <div key={c.l} style={{display:'flex',alignItems:'center',gap:12}}>
                          <div style={{textAlign:'center'}}>
                            <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:6}}>{c.l}</div>
                            <div style={{fontSize:c.size,fontWeight:800,color:c.color,fontFamily:MONO,lineHeight:1}}>{c.v}</div>
                          </div>
                          {i < arr.length-1 && <div style={{width:1,height:40,background:'var(--border)'}}/>}
                        </div>
                      ))}
                    </div>
                  ) : (()=>{
                    const vals = data.monthly.map(m=>m.ret);
                    const maxAbs = Math.max(Math.abs(Math.max(...vals)), Math.abs(Math.min(...vals)), 1);
                    const domainPad = maxAbs * 1.3;
                    return (
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={data.monthly} barCategoryGap="30%" barSize={28}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                          <XAxis dataKey="month" tick={{fontSize:7,fill:'#475569',fontFamily:MONO}}/>
                          <YAxis hide domain={[-domainPad, domainPad]}/>
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1}/>
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

          {/* ── Row 3: Distribution (ring) + Journal paginé ── */}
          <div style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:12,...dim}}>
            <div className="panel" style={{padding:18}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--purple-bright)'}}/>
                Distribution
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— signaux</span>
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
                  const labelR = R + 18;
                  const lx = cx + labelR * Math.cos(midA);
                  const ly = cy + labelR * Math.sin(midA);
                  const lineStart = { x: cx+(R+2)*Math.cos(midA), y: cy+(R+2)*Math.sin(midA) };
                  const lineEnd   = { x: cx+(R+12)*Math.cos(midA), y: cy+(R+12)*Math.sin(midA) };
                  // Une seule part ≈ 100% → start ≈ end, l'arc ne se dessinerait pas.
                  const full = pct > 0.999;
                  return (
                    <g key={idx}>
                      {full ? (
                        <circle cx={cx} cy={cy} r={(R+r)/2} fill="none"
                          stroke={hexColors[idx]} strokeWidth={R-r} opacity={0.82}/>
                      ) : (
                        <>
                          <path
                            d={`M${x1},${y1} A${R},${R},0,${large},1,${x2},${y2} L${x3},${y3} A${r},${r},0,${large},0,${x4},${y4} Z`}
                            fill={hexColors[idx]}
                            opacity={0.82}
                          />
                          <path
                            d={`M${x1},${y1} A${R},${R},0,${large},1,${x2},${y2} L${x3},${y3} A${r},${r},0,${large},0,${x4},${y4} Z`}
                            fill="none"
                            stroke={hexColors[idx]}
                            strokeWidth="1"
                            opacity={0.4}
                          />
                        </>
                      )}
                      {pct > 0.04 && !full && (
                        <line x1={lineStart.x} y1={lineStart.y} x2={lineEnd.x} y2={lineEnd.y}
                          stroke={hexColors[idx]} strokeWidth="0.8" opacity="0.6"/>
                      )}
                      {pct > 0.04 && !full && (
                        <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                          fontSize="9" fontWeight="700" fill={hexColors[idx]}
                          fontFamily={MONO}>
                          {(pct*100).toFixed(0)}%
                        </text>
                      )}
                    </g>
                  );
                });
                return (
                  <div>
                    <svg width="260" height="216" style={{display:'block',margin:'0 auto'}}>
                      <circle cx={cx} cy={cy} r={(R+r)/2} fill="none"
                        stroke="rgba(255,255,255,0.03)" strokeWidth={R-r}/>
                      {slices}
                      <text x={cx} y={cy-10} textAnchor="middle" fontSize="22" fontWeight="800"
                        fill="#e2e8f0" fontFamily={MONO}>{total}</text>
                      <text x={cx} y={cy+8} textAnchor="middle" fontSize="7" fill="#475569"
                        fontFamily={MONO} letterSpacing=".12em">SIGNALS</text>
                    </svg>
                    <div style={{display:'flex',justifyContent:'center',gap:20,marginTop:2}}>
                      {distItems.map((item,idx)=>(
                        <div key={item.label} style={{display:'flex',alignItems:'center',gap:5}}>
                          <div style={{width:7,height:7,borderRadius:'50%',background:hexColors[idx],flexShrink:0}}/>
                          <span style={{fontSize:9,fontFamily:MONO,color:'var(--text-secondary)'}}>
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
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7}}>
                  <div style={{width:5,height:5,borderRadius:'50%',background:'var(--green)'}}/>
                  Journal des Trades
                  <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400,marginLeft:2}}>— BUY/SELL uniquement</span>
                </div>
                {data.trades.length > PAGE_SIZE && (
                  <div style={{display:'flex',alignItems:'center',gap:8,fontSize:10,fontFamily:MONO,color:'var(--text-secondary)'}}>
                    <button
                      onClick={()=>setPage(Math.max(0,pageSafe-1))}
                      disabled={pageSafe===0}
                      style={{background:'transparent',border:'1px solid var(--border)',color:'var(--text-secondary)',borderRadius:5,padding:'1px 8px',cursor:pageSafe===0?'default':'pointer',opacity:pageSafe===0?0.4:1}}
                    >‹</button>
                    <span>{pageSafe+1} / {pages}</span>
                    <button
                      onClick={()=>setPage(Math.min(pages-1,pageSafe+1))}
                      disabled={pageSafe>=pages-1}
                      style={{background:'transparent',border:'1px solid var(--border)',color:'var(--text-secondary)',borderRadius:5,padding:'1px 8px',cursor:pageSafe>=pages-1?'default':'pointer',opacity:pageSafe>=pages-1?0.4:1}}
                    >›</button>
                  </div>
                )}
              </div>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead>
                    <tr>{['Date','Symbol','Direction','Entrée','Sortie','P&L','Durée','Résultat'].map(h=>(
                      <th key={h} style={{textAlign:'left',padding:'6px 8px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,borderBottom:'1px solid var(--border)',fontWeight:400}}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={8} style={{padding:'24px 8px',textAlign:'center',fontSize:10,color:'var(--text-muted)',fontFamily:MONO}}>
                          Aucun trade BUY/SELL sur cette période
                        </td>
                      </tr>
                    )}
                    {shown.map((t,i)=>{
                      const pnlStr   = String(t.pnl ?? '');
                      const isOpen   = pnlStr === 'OPEN';
                      const val      = parseFloat(pnlStr);
                      const pnlColor = isOpen || !Number.isFinite(val) || val === 0
                        ? 'var(--text-muted)'
                        : val > 0 ? 'var(--green)' : 'var(--red)';
                      const outColor = t.outcome === 'TP' ? 'var(--green)'
                        : t.outcome === 'SL' ? 'var(--red)'
                        : 'var(--text-muted)';
                      const cell = { padding:'8px', borderBottom:'1px solid rgba(255,255,255,0.03)' };
                      const mono = { ...cell, fontSize:10, fontFamily:MONO, color:'var(--text-secondary)' };
                      return (
                        <tr key={`${pageSafe}-${i}`}
                          onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.02)'}
                          onMouseLeave={e=>e.currentTarget.style.background='transparent'}
                          style={{transition:'background .1s'}}
                        >
                          <td style={mono}>{t.date}</td>
                          <td style={cell}>
                            <span style={{background:'rgba(0,245,212,0.08)',color:'var(--cyan)',border:'1px solid rgba(0,245,212,0.15)',padding:'1px 6px',borderRadius:4,fontSize:9,fontWeight:600}}>{t.sym}</span>
                          </td>
                          <td style={cell}>
                            <span style={{padding:'1px 6px',borderRadius:4,fontSize:9,fontWeight:600,
                              background:t.side==='Long'?'rgba(52,211,153,0.12)':'rgba(248,113,113,0.12)',
                              color:t.side==='Long'?'var(--green)':'var(--red)',
                            }}>{t.side}</span>
                          </td>
                          <td style={mono}>{t.entry}</td>
                          <td style={mono}>{t.exit}</td>
                          <td style={{...cell,fontSize:10,fontFamily:MONO,color:pnlColor,fontWeight:600}}>{pnlStr}</td>
                          <td style={mono}>{t.duration}</td>
                          <td style={{...cell,fontSize:9,fontWeight:700,fontFamily:MONO,color:outColor}}>{t.outcome}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Row 4: Attribution — table cliquable (drill-down) ── */}
          {data.attribution.length > 0 && (
            <div className="panel" style={{padding:18,...dim}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--amber)'}}/>
                Attribution · Classe d'Actifs
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400,marginLeft:4}}>— cliquez une ligne pour filtrer</span>
              </div>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr>
                    {['Classe','Allocation','Signaux','Win Rate (n)','Avg Conf.','R:R réalisé'].map(h=>(
                      <th key={h} style={{textAlign:h==='Classe'?'left':'center',padding:'6px 10px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,borderBottom:'1px solid var(--border)',fontWeight:400}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.attribution.map((a)=>{
                    const isSelected = selectedClass === a.name;
                    const cells = [
                      { v: a.total },
                      { v: a.winRate == null ? '—' : `${(Math.round(a.winRate*10)/10)}% (${a.closed})`, c: wrColor(a.winRate) },
                      { v: a.avgConf == null ? '—' : `${a.avgConf}%` },
                      { v: a.avgRR > 0 ? `1:${a.avgRR}` : '—' },
                    ];
                    const bb = isSelected ? '1px solid rgba(0,245,212,0.2)' : '1px solid rgba(255,255,255,0.03)';
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
                      <td style={{padding:'10px',borderBottom:bb}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{width:3,height:20,borderRadius:2,background:a.color,opacity: isSelected ? 1 : 0.8,flexShrink:0}}/>
                          <span style={{fontSize:11,fontWeight:700,color:a.color,fontFamily:MONO}}>{a.name}</span>
                          {isSelected && <span style={{fontSize:8,color:'var(--cyan)'}}>●</span>}
                        </div>
                      </td>
                      <td style={{padding:'10px',borderBottom:bb,width:160}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{flex:1,height:4,background:'rgba(255,255,255,0.05)',borderRadius:2,overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${a.pct}%`,background:a.color,borderRadius:2,opacity:0.7,transition:'width .6s'}}/>
                          </div>
                          <span style={{fontSize:10,fontWeight:600,color:'var(--text-secondary)',fontFamily:MONO,minWidth:32,textAlign:'right'}}>{a.pct}%</span>
                        </div>
                      </td>
                      {cells.map((cell,j)=>(
                        <td key={j} style={{padding:'10px',textAlign:'center',fontSize:11,fontWeight:600,fontFamily:MONO,
                          color: cell.c || 'var(--text-primary)',
                          borderBottom: bb
                        }}>{cell.v}</td>
                      ))}
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Row 5: DoW + Rolling Win Rate ── */}
          {(data.byDow.length > 0 || data.rolling.length > 0) && (
            <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:12,alignItems:'stretch',...dim}}>

              {data.byDow.length > 0 && (
                <div className="panel" style={{padding:18,minWidth:340}}>
                  <div style={{fontSize:12,fontWeight:600,marginBottom:4,display:'flex',alignItems:'center',gap:7}}>
                    <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                    Win Rate / Jour
                  </div>
                  <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:MONO,marginBottom:12}}>Jour d'entrée (UTC) · t = nombre de trades clos</div>
                  <div style={{display:'flex',gap:6}}>
                    {data.byDow.map(d=>{
                      const intensity = d.total > 0 ? d.winRate / 100 : 0;
                      const thin = d.total > 0 && d.total < 5; // trop peu de trades
                      return (
                        <div key={d.day} style={{
                          flex:1,
                          background: d.total===0?'rgba(255,255,255,0.02)':`rgba(0,245,212,${0.04+intensity*0.2})`,
                          border: d.total===0?'1px solid rgba(255,255,255,0.04)':`1px solid rgba(0,245,212,${0.06+intensity*0.18})`,
                          borderRadius:7,
                          padding:'9px 4px',
                          textAlign:'center',
                          opacity: thin ? 0.6 : 1,
                        }}
                          title={thin ? 'Moins de 5 trades — peu fiable' : undefined}
                        >
                          <div style={{fontSize:8,letterSpacing:'.08em',color:'var(--text-muted)',fontFamily:MONO,textTransform:'uppercase',marginBottom:5}}>{d.day}</div>
                          {d.total > 0 ? (
                            <>
                              <div style={{fontSize:13,fontWeight:700,color:'var(--cyan)',fontFamily:MONO,lineHeight:1}}>{d.winRate}%</div>
                              <div style={{fontSize:8,color:'var(--text-muted)',fontFamily:MONO,marginTop:3}}>{d.total}t</div>
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

              {data.rolling.length > 0 && (
                <div className="panel" style={{padding:18}}>
                  <div style={{fontSize:12,fontWeight:600,marginBottom:4,display:'flex',alignItems:'center',gap:7}}>
                    <div style={{width:5,height:5,borderRadius:'50%',background:'var(--green)'}}/>
                    Win Rate Glissant (30 trades)
                  </div>
                  <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:MONO,marginBottom:12}}>Fenêtre mobile · seuil de rentabilité {BREAKEVEN_WR}% (R:R 1:2)</div>
                  {data.rolling.length < 3 ? (
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:130,gap:8}}>
                      <div style={{fontSize:22,fontWeight:800,fontFamily:MONO,color:wrColor(data.rolling[data.rolling.length-1]?.winRate)}}>
                        {data.rolling[data.rolling.length-1]?.winRate ?? 0}%
                      </div>
                      <div style={{fontSize:9,color:'var(--text-muted)',fontFamily:MONO,textAlign:'center',lineHeight:1.5}}>
                        Win rate actuel<br/>
                        <span style={{opacity:0.5}}>Graphique disponible avec plus de données</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={130}>
                        <LineChart data={data.rolling}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                          <XAxis dataKey="day" tick={{fontSize:7,fill:'#475569',fontFamily:MONO}} interval={Math.max(1,Math.floor(data.rolling.length/5))}/>
                          <YAxis hide domain={[0,100]}/>
                          <ReferenceLine y={BREAKEVEN_WR} stroke="rgba(248,113,113,0.35)" strokeDasharray="4 4" strokeWidth={1}/>
                          <ReferenceLine y={GOOD_WR} stroke="rgba(52,211,153,0.25)" strokeDasharray="4 4" strokeWidth={1}/>
                          <Tooltip {...tt} formatter={v=>[v+'%','Win Rate']}/>
                          <Line type="monotone" dataKey="winRate" stroke="var(--green)" strokeWidth={1.5} dot={data.rolling.length < 10} activeDot={{r:3,fill:'var(--green)'}}/>
                        </LineChart>
                      </ResponsiveContainer>
                      <div style={{display:'flex',gap:14,marginTop:6,fontSize:8,fontFamily:MONO,color:'var(--text-muted)'}}>
                        <span style={{display:'flex',alignItems:'center',gap:4}}>
                          <span style={{width:10,height:1,background:'rgba(248,113,113,0.5)',display:'inline-block'}}/>Breakeven {BREAKEVEN_WR}%
                        </span>
                        <span style={{display:'flex',alignItems:'center',gap:4}}>
                          <span style={{width:10,height:1,background:'rgba(52,211,153,0.4)',display:'inline-block'}}/>Bon {GOOD_WR}%
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Row 6: Win rate par tranche de confidence ── */}
          {data.confidenceBuckets.length > 0 && (() => {
            const rich = data.confidenceBuckets.filter(b => b.n >= 5);
            let verdict = 'Pas assez de trades par tranche (minimum 5) pour juger si la confidence IA est fiable.';
            if (rich.length >= 2) {
              const first = rich[0], last = rich[rich.length - 1];
              verdict = last.winRate > first.winRate + 5
                ? `Cohérent: le win rate monte avec la confidence (${first.range}: ${first.winRate}% → ${last.range}: ${last.winRate}%).`
                : last.winRate < first.winRate - 5
                  ? `Inversé: les signaux très confiants gagnent MOINS (${first.range}: ${first.winRate}% → ${last.range}: ${last.winRate}%). La confidence IA n'est pas fiable.`
                  : 'Plat: la confidence IA ne change pas le win rate — elle n\'apporte pas d\'information pour l\'instant.';
            }
            return (
              <div className="panel" style={{padding:18,...dim}}>
                <div style={{fontSize:12,fontWeight:600,marginBottom:4,display:'flex',alignItems:'center',gap:7}}>
                  <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                  Win Rate par Confidence
                  <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— la confidence IA est-elle fiable ? (trades clos)</span>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:8,marginTop:12}}>
                  {data.confidenceBuckets.map(b=>(
                    <div key={b.range} style={{display:'grid',gridTemplateColumns:'60px 1fr 70px 70px 70px',alignItems:'center',gap:12}}>
                      <span style={{fontSize:10,color:'var(--text-secondary)',fontFamily:MONO}}>{b.range}%</span>
                      <div style={{position:'relative',height:6,background:'rgba(255,255,255,0.05)',borderRadius:3,overflow:'hidden'}}>
                        {b.winRate != null && (
                          <div style={{height:'100%',width:`${Math.min(100,b.winRate)}%`,background:wrColor(b.winRate),opacity:b.n < 5 ? 0.35 : 0.85,borderRadius:3,transition:'width .6s'}}/>
                        )}
                        <div style={{position:'absolute',top:0,bottom:0,left:`${BREAKEVEN_WR}%`,width:1,background:'rgba(255,255,255,0.35)'}} title={`Breakeven ${BREAKEVEN_WR}%`}/>
                      </div>
                      <span style={{fontSize:11,fontWeight:700,color:wrColor(b.winRate),fontFamily:MONO,textAlign:'right'}}>{b.winRate == null ? '—' : `${b.winRate}%`}</span>
                      <span style={{fontSize:9,color:'var(--text-muted)',fontFamily:MONO,textAlign:'right'}}>n = {b.n}</span>
                      <span style={{fontSize:10,color:b.avgPnl == null ? 'var(--text-muted)' : b.avgPnl >= 0 ? 'var(--green)' : 'var(--red)',fontFamily:MONO,textAlign:'right'}}>
                        {b.avgPnl == null ? '—' : `${b.avgPnl >= 0 ? '+' : ''}${b.avgPnl}%`}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{display:'flex',justifyContent:'flex-end',gap:12,fontSize:8,color:'var(--text-muted)',fontFamily:MONO,marginTop:6}}>
                  <span>win rate</span><span>trades</span><span>gain moyen</span>
                </div>
                <div style={{marginTop:10,padding:'8px 12px',background:'rgba(0,245,212,0.04)',border:'1px solid rgba(0,245,212,0.1)',borderRadius:7,fontSize:10,color:'var(--text-secondary)',lineHeight:1.5}}>
                  {verdict}
                </div>
              </div>
            );
          })()}

          {/* ── Row 7: Métriques de performance ── */}
          {data.metrics.length > 0 && (
            <div className="panel" style={{padding:18,...dim}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--purple-bright)'}}/>
                Métriques de Performance
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400,marginLeft:4}}>— calculées sur les trades clos</span>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10}}>
                {data.metrics.map(m=>(
                  <div key={m.label} style={{background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:8,padding:'12px 14px'}}>
                    <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:6}}>{m.label}</div>
                    <div style={{fontSize:16,fontWeight:800,color:toneColor(m.tone),fontFamily:MONO,lineHeight:1}}>{m.value}</div>
                    {m.hint && <div style={{fontSize:8,color:'var(--text-muted)',fontFamily:MONO,marginTop:5,lineHeight:1.4}}>{m.hint}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </>
  );
}

// ── Page: 2 onglets ───────────────────────────────────────
//  - Signaux IA : qualité de la stratégie (global, tous les signaux)
//  - Mon P&L    : TES trades (paper_trades de l'utilisateur connecté)
export default function Analytics() {
  const [tab, setTab] = useState('signals');
  const tabs = [
    { id: 'signals', label: 'Signaux IA' },
    { id: 'mine',    label: 'Mon P&L' },
  ];
  return (
    <>
      <div style={{display:'flex',gap:4,marginBottom:4,borderBottom:'1px solid var(--border)'}}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:'8px 16px',border:'none',background:'transparent',cursor:'pointer',
            fontFamily:MONO,fontSize:11,letterSpacing:'.08em',
            color: tab === t.id ? 'var(--cyan)' : 'var(--text-secondary)',
            borderBottom: tab === t.id ? '2px solid var(--cyan)' : '2px solid transparent',
            marginBottom:-1,transition:'all .15s',
          }}>{t.label}</button>
        ))}
      </div>
      {tab === 'signals' ? <SignalsAnalytics /> : <MyPnL />}
    </>
  );
}