import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
         ResponsiveContainer, CartesianGrid, ReferenceLine, Cell } from 'recharts';
import api from '../services/api';

// "Mon P&L": performance RÉELLE de l'utilisateur (paper_trades), en argent.
// Même charte graphique que l'onglet "Signaux IA".

const PERIODS    = ['1M','3M','6M','1Y','All'];
const REFRESH_MS = 60_000;
const PAGE_SIZE  = 10;
const MONO = 'JetBrains Mono,monospace';

const EMPTY = {
  kpis:[], equity:[], monthly:[], trades:[], openPositions:[],
  breakdowns:{ bySource:[], bySymbol:[], byExchange:[] },
  metrics:[], breakevenWR:null, signalLink:null, live:null,
  sample:{ closed:0, open:0, min:30, low:true },
};

const MODES = [
  { id: 'paper', label: 'Paper' },
  { id: 'live',  label: 'Live'  },
  { id: 'all',   label: 'Tout'  },
];

const tt = {
  contentStyle:{
    background:'rgba(3,7,18,0.97)',
    border:'1px solid rgba(0,245,212,0.25)',
    borderRadius:8,
    fontFamily:MONO,
    fontSize:11,
    boxShadow:'0 8px 32px rgba(0,0,0,0.4)',
  }
};

const toneColor = tone => tone === 'pos' ? 'var(--green)' : tone === 'neg' ? 'var(--red)' : 'var(--text-primary)';
const moneyColor = n => n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text-muted)';
const fmtMoney = n => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)} $`;

// Win rate: vert s'il dépasse le breakeven RÉEL de l'utilisateur (calculé
// depuis ses gains/pertes moyens), sinon rouge.
const wrColor = (wr, be) =>
  wr == null ? 'var(--text-muted)'
  : be == null ? 'var(--text-primary)'
  : wr >= be ? 'var(--green)' : 'var(--red)';

function BreakdownTable({ title, rows, breakevenWR }) {
  return (
    <div className="panel" style={{padding:18}}>
      <div style={{fontSize:12,fontWeight:600,marginBottom:12,display:'flex',alignItems:'center',gap:7}}>
        <div style={{width:5,height:5,borderRadius:'50%',background:'var(--amber)'}}/>
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{fontSize:10,color:'var(--text-muted)',fontFamily:MONO}}>Aucune donnée</div>
      ) : (
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead>
            <tr>{['', 'Trades', 'Win Rate', 'P&L'].map((h,i)=>(
              <th key={i} style={{textAlign:i===0?'left':'right',padding:'4px 6px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,fontWeight:400,borderBottom:'1px solid var(--border)'}}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map(r=>(
              <tr key={r.key}>
                <td style={{padding:'7px 6px',fontSize:10,fontWeight:700,color:'var(--cyan)',fontFamily:MONO,borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{r.key}</td>
                <td style={{padding:'7px 6px',fontSize:10,color:'var(--text-secondary)',fontFamily:MONO,textAlign:'right',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{r.n}</td>
                <td style={{padding:'7px 6px',fontSize:10,fontWeight:600,color:wrColor(r.winRate,breakevenWR),fontFamily:MONO,textAlign:'right',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{r.winRate == null ? '—' : `${r.winRate}%`}</td>
                <td style={{padding:'7px 6px',fontSize:10,fontWeight:700,color:moneyColor(r.pnl),fontFamily:MONO,textAlign:'right',borderBottom:'1px solid rgba(255,255,255,0.03)'}}>{fmtMoney(r.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function MyPnL() {
  const [period, setPeriod] = useState('1M');
  const [mode, setMode] = useState('paper');   // paper | live | all
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState(0);
  const firstLoad = useRef(true);
  const silentRef = useRef(false);

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

    const params = { mode };
    if (period !== 'All') params.period = period;
    api.get('/signals/analytics/mine', { params })
      .then(res => {
        if (cancelled) return;
        const d = res.data;
        setData({
          kpis:          Array.isArray(d.kpis) ? d.kpis : [],
          equity:        Array.isArray(d.equity) ? d.equity : [],
          monthly:       Array.isArray(d.monthly) ? d.monthly : [],
          trades:        Array.isArray(d.trades) ? d.trades : [],
          openPositions: Array.isArray(d.openPositions) ? d.openPositions : [],
          breakdowns:    d.breakdowns || EMPTY.breakdowns,
          metrics:       Array.isArray(d.metrics) ? d.metrics : [],
          breakevenWR:   typeof d.breakevenWR === 'number' ? d.breakevenWR : null,
          sample:        d.sample || EMPTY.sample,
          signalLink:    d.signalLink || null,
          live:          d.live || null,
        });
        setError(null);
        setLoadedOnce(true);
        setLastUpdated(new Date());
      })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || 'Erreur analytics'); })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
        firstLoad.current = false;
      });
    return () => { cancelled = true; };
  }, [period, mode, tick]);

  const changePeriod = p => { setPage(0); setPeriod(p); };
  const manualRefresh = () => { silentRef.current = false; setTick(t => t + 1); };

  if (loading) return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      <div style={{fontSize:11,letterSpacing:'.2em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO}}>// Loading mon P&L...</div>
    </div>
  );

  if (error && !loadedOnce) return (
    <div style={{background:'var(--surface)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:10,padding:'20px',textAlign:'center',fontFamily:MONO,fontSize:12,color:'var(--red)'}}>
      {error}
      <div style={{marginTop:12}}>
        <button onClick={manualRefresh} style={{background:'transparent',border:'1px solid rgba(248,113,113,0.4)',color:'var(--red)',borderRadius:6,padding:'4px 12px',fontFamily:MONO,fontSize:11,cursor:'pointer'}}>Réessayer</button>
      </div>
    </div>
  );

  const pages    = Math.max(1, Math.ceil(data.trades.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages - 1);
  const shown    = data.trades.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);
  const dim = { opacity: refreshing ? 0.6 : 1, transition:'opacity .15s' };
  const be  = data.breakevenWR;

  return (
    <>
      {/* ── Header ── */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
        <div>
          <div style={{fontSize:10,letterSpacing:'.18em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:2}}>// Mon P&L</div>
          <div style={{fontSize:10,color:'var(--text-secondary)',fontFamily:MONO,display:'flex',alignItems:'center',gap:8}}>
            Paper trading · manuel + AutoTrader
            {refreshing && <span style={{color:'var(--text-muted)',fontSize:9}}>actualisation…</span>}
            {lastUpdated && !refreshing && (
              <span style={{color:'var(--text-muted)',fontSize:9}}>MAJ {lastUpdated.toLocaleTimeString('fr-FR')} · auto 60s</span>
            )}
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div style={{display:'flex',gap:3,background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:9,padding:3}}>
            {MODES.map(m=>(
              <button key={m.id} onClick={()=>{ setPage(0); setMode(m.id); }} style={{
                padding:'5px 12px',borderRadius:6,border:'none',fontFamily:MONO,fontSize:11,cursor:'pointer',
                background: mode===m.id?'rgba(167,139,250,0.14)':'transparent',
                color:      mode===m.id?'var(--purple-bright)':'var(--text-secondary)',
                boxShadow:  mode===m.id?'inset 0 0 0 1px rgba(167,139,250,0.3)':'none',
                transition:'all .15s',
              }}>{m.label}</button>
            ))}
          </div>
          <button onClick={manualRefresh} title="Actualiser maintenant" style={{
            width:30,height:30,borderRadius:8,border:'1px solid var(--border)',
            background:'rgba(255,255,255,0.02)',color:'var(--text-secondary)',cursor:'pointer',fontSize:14,lineHeight:1,
          }}>↻</button>
          <div style={{display:'flex',gap:3,background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:9,padding:3}}>
            {PERIODS.map(p=>(
              <button key={p} onClick={()=>changePeriod(p)} style={{
                padding:'5px 14px',borderRadius:6,border:'none',fontFamily:MONO,fontSize:11,cursor:'pointer',
                background: period===p?'rgba(0,245,212,0.1)':'transparent',
                color:      period===p?'var(--cyan)':'var(--text-secondary)',
                boxShadow:  period===p?'inset 0 0 0 1px rgba(0,245,212,0.2)':'none',
                transition:'all .15s',
              }}>{p}</button>
            ))}
          </div>
        </div>
      </div>

      {error && loadedOnce && (
        <div style={{background:'rgba(248,113,113,0.06)',border:'1px solid rgba(248,113,113,0.25)',borderRadius:8,padding:'8px 12px',fontSize:10,color:'var(--red)',fontFamily:MONO}}>
          Actualisation impossible ({error}). Données affichées: {lastUpdated ? lastUpdated.toLocaleTimeString('fr-FR') : '—'}.
        </div>
      )}

      {data.live && (data.live.pending > 0 || data.live.unmatchedQty > 0 || data.live.feeUnknown > 0) && (
        <div style={{background:'rgba(96,165,250,0.06)',border:'1px solid rgba(96,165,250,0.25)',borderRadius:8,padding:'8px 12px',fontSize:10,color:'var(--text-secondary)',fontFamily:MONO,lineHeight:1.6}}>
          {data.live.pending > 0 && <div>⏳ {data.live.pending} ordre(s) live en attente de réconciliation avec l'exchange (mise à jour toutes les 15 min).</div>}
          {data.live.unmatchedQty > 0 && <div>ℹ Des ventes sans achat connu dans l'app ({data.live.unmatchedQty} unités) sont ignorées: leur coût d'entrée est inconnu.</div>}
          {data.live.feeUnknown > 0 && <div>ℹ {data.live.feeUnknown} ordre(s) avec frais payés dans une autre monnaie (ex: BNB): non comptés dans le P&L.</div>}
        </div>
      )}

      {data.kpis.length === 0 ? (
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'32px',textAlign:'center',fontFamily:MONO,fontSize:12,color:'var(--text-muted)',lineHeight:1.7}}>
          Aucun paper trade pour l'instant.<br/>
          Ouvre une position (Paper Trading) ou active l'AutoTrader: tes résultats apparaîtront ici.
        </div>
      ) : (
        <>
          {data.sample.low && (
            <div style={{background:'rgba(251,191,36,0.06)',border:'1px solid rgba(251,191,36,0.25)',borderRadius:8,padding:'8px 12px',fontSize:10,color:'var(--amber)',fontFamily:MONO,lineHeight:1.5}}>
              ⚠ Échantillon faible: {data.sample.closed} trade(s) clos sur {data.sample.min} minimum. Ces chiffres sont indicatifs.
            </div>
          )}

          {/* KPIs */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,...dim}}>
            {data.kpis.map(k=>(
              <div key={k.label} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'14px 16px',position:'relative',overflow:'hidden'}}>
                <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:k.color,opacity:0.35,borderRadius:'10px 10px 0 0'}}/>
                <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:7}}>{k.label}</div>
                <div style={{fontSize:20,fontWeight:800,color:k.color,marginBottom:3,letterSpacing:'-.02em',lineHeight:1}}>{k.v}</div>
                <div style={{fontSize:9,fontFamily:MONO,color:'var(--text-secondary)',marginTop:6,lineHeight:1.4}}>{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Equity + Monthly */}
          <div style={{display:'grid',gridTemplateColumns:'1.3fr 1fr',gap:12,...dim}}>
            <div className="panel" style={{padding:18}}>
              <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7,marginBottom:14}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--cyan)'}}/>
                P&L Cumulé
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— en $, trades clos</span>
              </div>
              {data.equity.length === 0 ? (
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:160,fontSize:10,color:'var(--text-muted)',fontFamily:MONO,textAlign:'center',lineHeight:1.6}}>
                  Aucun trade clos pour l'instant.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={data.equity}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                    <XAxis dataKey="day" tick={{fontSize:7,fill:'#475569',fontFamily:MONO}} interval={Math.max(1,Math.floor(data.equity.length/6))}/>
                    <YAxis hide domain={['auto','auto']}/>
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1}/>
                    <Tooltip {...tt} formatter={(v,n,props)=>[
                      `${fmtMoney(v)} (trade: ${fmtMoney(props.payload?.pnl ?? 0)})`, 'Cumul',
                    ]}/>
                    <Line type="monotone" dataKey="cumul" stroke="var(--cyan)" strokeWidth={1.5} dot={data.equity.length < 20}/>
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="panel" style={{padding:18}}>
              <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7,marginBottom:14}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--amber)'}}/>
                P&L Mensuel
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— en $</span>
              </div>
              {data.monthly.length === 0 ? (
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:160,fontSize:10,color:'var(--text-muted)',fontFamily:MONO}}>Aucun trade clos</div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={data.monthly} barCategoryGap="30%" barSize={28}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                    <XAxis dataKey="month" tick={{fontSize:7,fill:'#475569',fontFamily:MONO}}/>
                    <YAxis hide domain={['auto','auto']}/>
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1}/>
                    <Tooltip {...tt}
                      formatter={v=>[fmtMoney(v),'P&L']}
                      labelFormatter={(l,payload)=>{
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
              )}
            </div>
          </div>

          {/* Positions ouvertes */}
          {data.openPositions.length > 0 && (
            <div className="panel" style={{padding:18,...dim}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:12,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--green)'}}/>
                Positions ouvertes
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— {data.openPositions.length}</span>
              </div>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead>
                    <tr>{['Symbol','Exchange','Source','Direction','Qté','Entrée','SL','TP','Ouvert'].map(h=>(
                      <th key={h} style={{textAlign:'left',padding:'6px 8px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,borderBottom:'1px solid var(--border)',fontWeight:400}}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {data.openPositions.map((p,i)=>{
                      const c = { padding:'8px', borderBottom:'1px solid rgba(255,255,255,0.03)', fontSize:10, fontFamily:MONO, color:'var(--text-secondary)' };
                      return (
                        <tr key={i}>
                          <td style={{...c,color:'var(--cyan)',fontWeight:700}}>{p.sym}</td>
                          <td style={c}>{p.exchange}</td>
                          <td style={c}>{p.mode === 'live' ? 'Live · ' : ''}{p.source}</td>
                          <td style={{...c,color:p.side==='Long'?'var(--green)':'var(--red)',fontWeight:600}}>{p.side}</td>
                          <td style={c}>{p.qty}</td>
                          <td style={c}>{p.entry}</td>
                          <td style={{...c,color:'var(--red)'}}>{p.sl}</td>
                          <td style={{...c,color:'var(--green)'}}>{p.tp}</td>
                          <td style={c}>{p.openedAt}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Journal */}
          <div className="panel" style={{padding:18,...dim}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
              <div style={{fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--green)'}}/>
                Journal de mes Trades
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— trades clos</span>
              </div>
              {data.trades.length > PAGE_SIZE && (
                <div style={{display:'flex',alignItems:'center',gap:8,fontSize:10,fontFamily:MONO,color:'var(--text-secondary)'}}>
                  <button onClick={()=>setPage(Math.max(0,pageSafe-1))} disabled={pageSafe===0}
                    style={{background:'transparent',border:'1px solid var(--border)',color:'var(--text-secondary)',borderRadius:5,padding:'1px 8px',cursor:pageSafe===0?'default':'pointer',opacity:pageSafe===0?0.4:1}}>‹</button>
                  <span>{pageSafe+1} / {pages}</span>
                  <button onClick={()=>setPage(Math.min(pages-1,pageSafe+1))} disabled={pageSafe>=pages-1}
                    style={{background:'transparent',border:'1px solid var(--border)',color:'var(--text-secondary)',borderRadius:5,padding:'1px 8px',cursor:pageSafe>=pages-1?'default':'pointer',opacity:pageSafe>=pages-1?0.4:1}}>›</button>
                </div>
              )}
            </div>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr>{['Date','Symbol','Source','Direction','Entrée','Sortie','P&L','%','Durée','Raison','Signal'].map(h=>(
                    <th key={h} style={{textAlign:'left',padding:'6px 8px',fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,borderBottom:'1px solid var(--border)',fontWeight:400}}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={11} style={{padding:'24px 8px',textAlign:'center',fontSize:10,color:'var(--text-muted)',fontFamily:MONO}}>Aucun trade clos sur cette période</td></tr>
                  )}
                  {shown.map((t,i)=>{
                    const c = { padding:'8px', borderBottom:'1px solid rgba(255,255,255,0.03)', fontSize:10, fontFamily:MONO, color:'var(--text-secondary)' };
                    return (
                      <tr key={`${pageSafe}-${i}`}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.02)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        <td style={c}>{t.date}</td>
                        <td style={{...c,color:'var(--cyan)',fontWeight:700}}>{t.sym}</td>
                        <td style={c}>{t.mode === 'live' ? 'Live · ' : ''}{t.source}</td>
                        <td style={{...c,color:t.side==='Long'?'var(--green)':'var(--red)',fontWeight:600}}>{t.side}</td>
                        <td style={c}>{t.entry}</td>
                        <td style={c}>{t.exit}</td>
                        <td style={{...c,color:moneyColor(t.pnlRaw),fontWeight:700}}>{t.pnl}</td>
                        <td style={{...c,color:moneyColor(t.pnlRaw)}}>{t.pnlPct}</td>
                        <td style={c}>{t.duration}</td>
                        <td style={c}>{t.reason}</td>
                        <td style={{...c,color:t.signal==='—'?'var(--text-muted)':'var(--purple-bright)'}}>{t.signal}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Moi vs IA: mes trades liés à un signal vs le résultat du signal */}
          {data.signalLink && (
            <div className="panel" style={{padding:18,...dim}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:4,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--purple-bright)'}}/>
                Moi vs IA
                <span style={{fontSize:9,color:'var(--text-muted)',fontWeight:400}}>— mes trades comparés au résultat du signal (TP/SL)</span>
              </div>
              {data.signalLink.linked === 0 ? (
                <div style={{marginTop:10,padding:'10px 12px',background:'rgba(167,139,250,0.05)',border:'1px solid rgba(167,139,250,0.15)',borderRadius:7,fontSize:10,color:'var(--text-secondary)',fontFamily:MONO,lineHeight:1.6}}>
                  Aucun trade lié à un signal pour l'instant ({data.signalLink.unlinked} sans signal).
                  Les trades ouverts par l'AutoTrader, ou depuis un signal, seront comparés ici dès qu'ils se clôturent.
                </div>
              ) : (
                <>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginTop:12}}>
                    {[
                      { l:'Trades liés', v:`${data.signalLink.linked} / ${data.signalLink.linked + data.signalLink.unlinked}`, hint:`${data.signalLink.comparable} comparables (signal clos)` },
                      { l:'Win rate IA', v:data.signalLink.aiWinRate == null ? '—' : `${data.signalLink.aiWinRate}%`, hint:'résultat des signaux' },
                      { l:'Mon win rate', v:data.signalLink.myWinRate == null ? '—' : `${data.signalLink.myWinRate}%`, hint:'sur ces mêmes trades' },
                      { l:'Écart de rendement', v:data.signalLink.gap == null ? '—' : `${data.signalLink.gap >= 0 ? '+' : ''}${data.signalLink.gap}%`,
                        hint:'mon rendement moyen − celui du signal', color:data.signalLink.gap == null ? undefined : data.signalLink.gap >= 0 ? 'var(--green)' : 'var(--red)' },
                    ].map(c=>(
                      <div key={c.l} style={{background:'rgba(255,255,255,0.02)',border:'1px solid var(--border)',borderRadius:8,padding:'12px 14px'}}>
                        <div style={{fontSize:8,letterSpacing:'.12em',color:'var(--text-muted)',textTransform:'uppercase',fontFamily:MONO,marginBottom:6}}>{c.l}</div>
                        <div style={{fontSize:16,fontWeight:800,color:c.color || 'var(--text-primary)',fontFamily:MONO,lineHeight:1}}>{c.v}</div>
                        <div style={{fontSize:8,color:'var(--text-muted)',fontFamily:MONO,marginTop:5,lineHeight:1.4}}>{c.hint}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:12}}>
                    <BreakdownTable title="Avec / sans signal" rows={data.signalLink.byGroup} breakevenWR={be}/>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Breakdowns */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,...dim}}>
            <BreakdownTable title="Par source" rows={data.breakdowns.bySource} breakevenWR={be}/>
            <BreakdownTable title="Par symbole (top 10)" rows={data.breakdowns.bySymbol} breakevenWR={be}/>
            <BreakdownTable title="Par exchange" rows={data.breakdowns.byExchange} breakevenWR={be}/>
          </div>

          {/* Métriques */}
          {data.metrics.length > 0 && (
            <div className="panel" style={{padding:18,...dim}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:14,display:'flex',alignItems:'center',gap:7}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'var(--purple-bright)'}}/>
                Métriques de Performance
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
    </>
  );
}