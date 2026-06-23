import { useState, useEffect } from 'react';
import api from '../services/api';
import { useTranslation } from 'react-i18next';

const PIPELINE = ['Ingest', 'Features', 'XGBoost', 'LSTM', 'Transformer', 'Ensemble', 'Filter', 'Signal'];

const label10 = { fontSize:10, letterSpacing:'.15em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' };
const monoSm  = { fontFamily:'JetBrains Mono,monospace', fontSize:11 };
const panel   = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:22 };

function SectionTitle({ color = 'var(--cyan)', children }) {
  return (
    <div style={{ fontSize:13, fontWeight:600, marginBottom:18, display:'flex', alignItems:'center', gap:8 }}>
      <div style={{ width:6, height:6, borderRadius:'50%', background:color }} />
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, color }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'16px 18px' }}>
      <div style={{ ...label10, fontSize:9, marginBottom:8 }}>{label}</div>
      <div style={{ fontSize:26, fontWeight:700, color }}>{value}</div>
      <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:4 }}>{sub}</div>
    </div>
  );
}

export default function AlphaEngine() {
  const { t } = useTranslation();

  const [models,      setModels]      = useState([]);
  const [factors,     setFactors]     = useState([]);
  const [scores,      setScores]      = useState([]);
  const [feed,        setFeed]        = useState([]);
  const [accuracy,    setAccuracy]    = useState([]);
  const [running,     setRunning]     = useState(true);
  const [selectedMdl, setSelectedMdl] = useState(0);
  const [confThresh,  setConfThresh]  = useState(65);
  const [scanCount,   setScanCount]   = useState(42);

  useEffect(() => {
    api.get('/signals/alpha/engine-data')
      .then(res => {
        const data = res.data;
        setModels(data.models     || []);
        setFactors(data.factors   || []);
        setScores(data.scores     || []);
        setFeed(data.feed         || []);
        setAccuracy(data.accuracy || []);
      })
      .catch(err => console.error('AlphaEngine fetch error:', err));
  }, []);

  const updateFactor = (label, value) =>
    setFactors(prev => prev.map(f => f.label === label ? { ...f, value: Number(value) } : f));

  return (
    <>
      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={label10}>{t('alphaEngine.engine')}</div>
          <div style={{ fontSize:12, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:5 }}>
            {t('alphaEngine.subtitle')}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'6px 14px', borderRadius:20, border:`1px solid ${running?'rgba(52,211,153,0.3)':'rgba(251,191,36,0.3)'}`, background: running?'rgba(52,211,153,0.08)':'rgba(251,191,36,0.08)', ...monoSm, color: running?'var(--green)':'var(--amber)' }}>
            <div style={{ width:7, height:7, borderRadius:'50%', background: running?'var(--green)':'var(--amber)' }} />
            {running ? t('alphaEngine.statusRunning') : t('alphaEngine.statusPaused')} - v3.4.1
          </div>
          <button type="button" onClick={() => setRunning(prev => !prev)} style={{ padding:'9px 20px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontSize:12, fontFamily:'Syne,sans-serif', cursor:'pointer' }}>
            {running ? t('alphaEngine.pause') : t('alphaEngine.resume')}
          </button>
          <button type="button" onClick={() => { setRunning(true); setScanCount(prev => prev + 3); }} style={{ padding:'9px 22px', borderRadius:9, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontSize:13, fontWeight:700, fontFamily:'Syne,sans-serif', cursor:'pointer' }}>
            {t('alphaEngine.runFullScan')}
          </button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12 }}>
        <Kpi label={t('alphaEngine.signalsFired')} value={scanCount}               sub={t('alphaEngine.vsYesterday')}    color="var(--cyan)"          />
        <Kpi label={t('alphaEngine.modelConf')}    value={`${confThresh + 16.4}%`} sub={t('alphaEngine.highConf')}       color="var(--green)"         />
        <Kpi label={t('alphaEngine.accuracy30d')}  value="74.2%"                   sub={t('alphaEngine.accuracyGain')}   color="var(--green)"         />
        <Kpi label={t('alphaEngine.features')}     value="284"                     sub={t('alphaEngine.featuresGroups')} color="var(--purple-bright)" />
        <Kpi label={t('alphaEngine.nextRetrain')}  value="14h 22m"                 sub={t('alphaEngine.retrainSub')}     color="var(--amber)"         />
      </div>

      {/* ── Pipeline ── */}
      <div style={panel}>
        <SectionTitle>{t('alphaEngine.pipeline')}</SectionTitle>
        <div style={{ display:'flex', alignItems:'center', overflowX:'auto', padding:'4px 0' }}>
          {PIPELINE.map((step, i) => (
            <div key={step} style={{ display:'flex', alignItems:'center', flexShrink:0 }}>
              <div style={{ width:112, padding:'12px 14px', textAlign:'center', borderRadius:10, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)' }}>
                <div style={{ fontSize:11, fontWeight:700 }}>{step}</div>
                <div style={{ ...monoSm, fontSize:9, color:'var(--text-secondary)', marginTop:4 }}>{t('alphaEngine.pipelineActive')}</div>
              </div>
              {i < PIPELINE.length - 1 && (
                <div style={{ width:28, height:2, background:'linear-gradient(90deg, rgba(0,245,212,0.25), rgba(0,245,212,0.65))' }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Model Config + Factor Weights ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.4fr', gap:16 }}>

        {/* Model Config */}
        <div style={panel}>
          <SectionTitle color="var(--purple-bright)">{t('alphaEngine.modelConfig')}</SectionTitle>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {models.map((m, i) => (
              <button type="button" key={m.label} onClick={() => setSelectedMdl(i)} style={{ width:'100%', textAlign:'left', background: selectedMdl===i?'var(--cyan-glow)':'rgba(255,255,255,0.02)', border: selectedMdl===i?'1px solid var(--cyan)':'1px solid var(--border)', borderRadius:10, padding:'14px 16px', display:'flex', alignItems:'center', gap:12, cursor:'pointer', color:'var(--text-primary)' }}>
                <div style={{ width:16, height:16, borderRadius:'50%', border:`2px solid ${selectedMdl===i?'var(--cyan)':'var(--border)'}`, background: selectedMdl===i?'var(--cyan)':'transparent', flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600 }}>{m.label}</div>
                  <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:2 }}>{m.sub}</div>
                </div>
                {selectedMdl === i && (
                  <span style={{ fontSize:10, padding:'2px 7px', borderRadius:4, background:'rgba(52,211,153,0.12)', color:'var(--green)', fontFamily:'JetBrains Mono,monospace' }}>
                    {t('alphaEngine.activeLabel')}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div style={{ marginTop:14, paddingTop:14, borderTop:'1px solid var(--border)' }}>
            <div style={{ ...label10, marginBottom:10 }}>{t('alphaEngine.confThreshold')}</div>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <input type="range" min={50} max={95} value={confThresh} onChange={e => setConfThresh(Number(e.target.value))} style={{ flex:1, accentColor:'var(--cyan)' }} />
              <span style={{ fontSize:13, fontWeight:600, fontFamily:'JetBrains Mono,monospace', color:'var(--cyan)', width:40, textAlign:'right' }}>{confThresh}%</span>
            </div>
          </div>
        </div>

        {/* Factor Weights */}
        <div style={panel}>
          <SectionTitle color="var(--amber)">{t('alphaEngine.factorWeights')}</SectionTitle>
          {factors.map(f => {
            const color = f.value >= 80 ? 'var(--green)' : f.value >= 60 ? 'var(--cyan)' : 'var(--amber)';
            return (
              <div key={f.label} style={{ padding:'12px 0', borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                  <span style={{ ...monoSm, fontSize:12, color:'var(--text-secondary)' }}>{f.label}</span>
                  <span style={{ ...monoSm, fontSize:12, fontWeight:700, color }}>{f.value}</span>
                </div>
                <div style={{ position:'relative', height:6, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                  <div style={{
                    position:'absolute', left:0, top:0, height:'100%',
                    width:`${f.value}%`, borderRadius:3,
                    background: f.value >= 80
                      ? 'linear-gradient(90deg, rgba(52,211,153,0.6), var(--green))'
                      : f.value >= 60
                      ? 'linear-gradient(90deg, rgba(0,245,212,0.6), var(--cyan))'
                      : 'linear-gradient(90deg, rgba(251,191,36,0.6), var(--amber))',
                    transition:'width .3s',
                  }} />
                </div>
                <input
                  type="range" min={0} max={100} value={f.value}
                  onChange={e => updateFactor(f.label, e.target.value)}
                  style={{ width:'100%', marginTop:6, accentColor: f.value >= 80 ? '#34d399' : f.value >= 60 ? '#00f5d4' : '#fbbf24', cursor:'pointer' }}
                />
              </div>
            );
          })}
        </div>

      </div>{/* end Model Config + Factor Weights grid */}

      {/* ── Alpha Scores + Accuracy Chart ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1.2fr 1fr', gap:16 }}>

        {/* Alpha Scores */}
        <div style={panel}>
          <SectionTitle color="var(--green)">{t('alphaEngine.alphaScores')}</SectionTitle>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {scores.map(s => {
              const buy  = s.side === 'BUY';
              const hold = s.side === 'HOLD';
              const scoreColor = buy ? 'var(--green)' : hold ? 'var(--amber)' : 'var(--red)';
              return (
                <div key={s.sym} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                    <div>
                      <div style={{ fontSize:14, fontWeight:700 }}>{s.sym}</div>
                      <div style={{ ...monoSm, color:'var(--text-secondary)', marginTop:2 }}>{s.name}</div>
                    </div>
                    <span style={{ padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:700, fontFamily:'JetBrains Mono,monospace', background: buy?'rgba(52,211,153,0.12)':hold?'rgba(251,191,36,0.12)':'rgba(248,113,113,0.12)', color: scoreColor }}>
                      {s.side}
                    </span>
                  </div>
                  <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                    <div style={{ fontSize:28, fontWeight:700, color: scoreColor }}>{s.score}</div>
                    <div style={{ ...monoSm, color:'var(--text-muted)' }}>{t('alphaEngine.conf')} {s.conf}</div>
                  </div>
                  <div style={{ height:4, background:'rgba(255,255,255,0.06)', borderRadius:2, margin:'10px 0 8px' }}>
                    <div style={{ height:'100%', width:`${s.score}%`, borderRadius:2, background: scoreColor }} />
                  </div>
                  <div style={{ ...monoSm, color:'var(--text-secondary)', lineHeight:1.5 }}>{s.note}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Accuracy Chart */}
        <div style={panel}>
          <SectionTitle>{t('alphaEngine.modelAccuracy')}</SectionTitle>
          <div style={{ height:180, display:'flex', alignItems:'end', gap:5, borderBottom:'1px solid rgba(255,255,255,0.05)', paddingTop:10 }}>
            {accuracy.map((v, i) => (
              <div key={i} style={{ flex:1, height:`${v}%`, borderRadius:'4px 4px 0 0', background:'linear-gradient(180deg, rgba(52,211,153,0.75), rgba(52,211,153,0.12))', border:'1px solid rgba(52,211,153,0.12)' }} />
            ))}
          </div>
        </div>

      </div>{/* end Alpha Scores + Accuracy grid */}

      {/* ── Live Signal Feed ── */}
      <div style={panel}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <SectionTitle>{t('alphaEngine.liveFeed')}</SectionTitle>
          <div style={{ ...monoSm, color:'var(--text-secondary)' }}>{t('alphaEngine.autoRefresh')}</div>
        </div>
        {feed.map(item => {
          const color = item.type === 'BUY' ? 'var(--green)' : item.type === 'SELL' ? 'var(--red)' : 'var(--amber)';
          return (
            <div key={item.time + item.sym} style={{ display:'grid', gridTemplateColumns:'70px 70px 1fr 80px', alignItems:'center', gap:12, padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
              <span style={{ ...monoSm, color:'var(--cyan)', fontWeight:700 }}>{item.sym}</span>
              <span style={{ ...monoSm, color, fontWeight:700 }}>{item.type}</span>
              <span style={{ ...monoSm, color:'var(--text-secondary)' }}>{item.msg}</span>
              <span style={{ ...monoSm, color:'var(--text-muted)', textAlign:'right' }}>{item.time}</span>
            </div>
          );
        })}
      </div>

    </>
  );
}