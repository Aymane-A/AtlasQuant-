import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { screenerAPI } from '../services/api';

const FILTERS = ['All','BUY','SELL','HOLD'];
const ASSET_TABS = [
  { key:'All',       label:'All' },
  { key:'Crypto',    label:'Crypto' },
  { key:'Forex',     label:'Forex' },
  { key:'Commodity', label:'Commodities' },
  { key:'Indices',   label:'Indices' },
];

const DEFAULT_FILTERS = {
  rsiMin: '', rsiMax: '',
  priceMin: '', priceMax: '',
  confMin: '',
};

const inp = {
  width:'100%', padding:'7px 10px', borderRadius:6,
  border:'1px solid var(--border)', background:'rgba(255,255,255,0.03)',
  color:'var(--text-primary)', fontFamily:'JetBrains Mono,monospace',
  fontSize:11, outline:'none', boxSizing:'border-box',
};
const label9 = { fontSize:9, letterSpacing:'.1em', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', marginBottom:5, display:'block' };

const inRange = (val, min, max) => {
  if (val === null || val === undefined || isNaN(val)) return true;
  if (min !== '' && val < parseFloat(min)) return false;
  if (max !== '' && val > parseFloat(max)) return false;
  return true;
};

const getRsi = (r) => {
  const v = r.indicators?.rsi;
  if (v === null || v === undefined) return null;
  return typeof v === 'object' ? parseFloat(v.value ?? v.rsi ?? null) : parseFloat(v);
};

const toCsv = (rows) => {
  const headers = ['Symbol','AssetClass','Price','Signal','Confidence','RSI','R:R'];
  const lines = [headers.join(',')];
  rows.forEach(r => {
    lines.push([r.symbol, r.asset_class, r.price, r.signal, r.confidence, getRsi(r) ?? '', r.risk_reward ?? ''].join(','));
  });
  return lines.join('\n');
};

const downloadCsv = (csv, filename) => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
};

function WatchlistStar({ symbol, onAdd, added }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onAdd(symbol); }}
      title={added ? 'In watchlist' : 'Add to watchlist'}
      style={{ background:'transparent', border:'none', cursor:'pointer', color: added ? 'var(--amber)' : 'var(--text-muted)', fontSize:13, padding:2, lineHeight:1 }}
    >
      {added ? '★' : '☆'}
    </button>
  );
}

export default function Screener() {
  const navigate = useNavigate();

  const [allResults, setAllResults] = useState([]); // raw, unfiltered — fetched once
  const [assetTab,   setAssetTab]   = useState('All');
  const [scanning,   setScanning]   = useState(false);
  const [filter,     setFilter]     = useState('All');
  const [sortBy,     setSortBy]     = useState('confidence');
  const [scannedAt,  setScannedAt]  = useState(null);
  const [error,      setError]      = useState(null);

  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const [watchlisted, setWatchlisted] = useState(new Set());
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [toast, setToast] = useState(null);

  const [presets, setPresets] = useState([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [showPresetInput, setShowPresetInput] = useState(false);

  const ensureWatchlist = useCallback(() => {
    if (watchlistLoaded) return;
    setWatchlistLoaded(true);
    api.get('/watchlist')
      .then(res => setWatchlisted(new Set((res.data.stocks || []).map(s => s.symbol))))
      .catch(() => {});
  }, [watchlistLoaded]);

  const ensurePresets = useCallback(() => {
    if (presetsLoaded) return;
    setPresetsLoaded(true);
    screenerAPI.presets()
      .then(res => setPresets(res.data.presets || []))
      .catch(() => {});
  }, [presetsLoaded]);

  const addToWatchlist = async (symbol) => {
    const clean = symbol.toUpperCase().trim();
    try {
      await api.post('/watchlist', { symbol: clean });
      setWatchlisted(prev => new Set(prev).add(clean));
      setToast(`${clean} added to watchlist`);
    } catch {
      setToast(`Could not add ${clean}`);
    } finally {
      setTimeout(() => setToast(null), 2000);
    }
  };

  // ── ONE fetch only — populates ALL asset classes at once ──
  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    ensureWatchlist();
    ensurePresets();
    try {
      const res = await api.get('/signals?interval=4h&refresh=true', { timeout: 160000 });
      const data = res.data;
      if (!data.signals) { setError('No signals returned from backend.'); return; }
      setAllResults(data.signals);
      setScannedAt(new Date());
    } catch (err) {
      setError(err?.error || err?.response?.data?.error || 'Scan failed. Is the backend running?');
    } finally {
      setScanning(false);
    }
  }, [ensureWatchlist, ensurePresets]);

  const goToBacktest = (symbol) => navigate('/backtester', { state: { prefillSymbol: symbol } });

  // ── Client-side filtering — switching tabs never re-triggers a scan ──
  const filtered = useMemo(() => {
    return allResults
      .filter(r => assetTab === 'All' || r.asset_class === assetTab)
      .filter(r => filter === 'All' || r.signal === filter)
      .filter(r => inRange(getRsi(r), filters.rsiMin, filters.rsiMax))
      .filter(r => inRange(r.price,   filters.priceMin, filters.priceMax))
      .filter(r => r.confidence === null || filters.confMin === '' || (r.confidence||0) >= parseFloat(filters.confMin))
      .sort((a, b) => {
        if (sortBy === 'confidence') return (b.confidence||0) - (a.confidence||0);
        if (sortBy === 'price')      return (b.price||0) - (a.price||0);
        if (sortBy === 'rr')         return (parseFloat(b.risk_reward)||0) - (parseFloat(a.risk_reward)||0);
        return 0;
      });
  }, [allResults, assetTab, filter, filters, sortBy]);

  const tabCounts = useMemo(() => {
    const counts = { All: allResults.length };
    ASSET_TABS.forEach(t => {
      if (t.key !== 'All') counts[t.key] = allResults.filter(r => r.asset_class === t.key).length;
    });
    return counts;
  }, [allResults]);

  const stats = {
    total: filtered.length,
    buy:   filtered.filter(r => r.signal === 'BUY').length,
    sell:  filtered.filter(r => r.signal === 'SELL').length,
    hold:  filtered.filter(r => r.signal === 'HOLD').length,
    avgConf: filtered.length
      ? Math.round(filtered.reduce((a, r) => a + (r.confidence || 0), 0) / filtered.length)
      : 0,
  };

  const activeFilterCount = Object.entries(filters).filter(([, v]) => v !== '').length;
  const resetFilters = () => setFilters(DEFAULT_FILTERS);

  const savePreset = async () => {
    if (!presetName.trim()) return;
    try {
      const res = await screenerAPI.savePreset({ name: presetName.trim(), assetType: assetTab, filters });
      setPresets(p => [res.data.preset, ...p]);
      setPresetName('');
      setShowPresetInput(false);
      setToast('Preset saved');
    } catch {
      setToast('Failed to save preset');
    } finally {
      setTimeout(() => setToast(null), 2000);
    }
  };

  const loadPreset = (preset) => {
    setAssetTab(preset.asset_type);
    setFilters({ ...DEFAULT_FILTERS, ...preset.filters });
    setShowFilters(true);
  };

  const deletePreset = async (id) => {
    try {
      await screenerAPI.deletePreset(id);
      setPresets(p => p.filter(x => x.id !== id));
    } catch {}
  };

  const exportCsv = () => {
    if (filtered.length === 0) return;
    downloadCsv(toCsv(filtered), `screener_${assetTab}_${Date.now()}.csv`);
  };

  return (
    <>
      {toast && (
        <div style={{ position:'fixed', top:80, right:28, zIndex:1000, background:'rgba(3,7,18,0.95)', border:'1px solid rgba(0,245,212,0.3)', borderRadius:8, padding:'10px 16px', fontFamily:'JetBrains Mono,monospace', fontSize:12, color:'var(--cyan)', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
          {toast}
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
            // Market Screener
          </div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {scannedAt
              ? `Dernière analyse : ${scannedAt.toLocaleTimeString()} — ${allResults.length} actifs scannés (crypto + forex + commodities + indices)`
              : 'Lancez un scan pour analyser le marché en temps réel — peut prendre ~25s'}
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          style={{
            display:'flex', alignItems:'center', gap:8,
            padding:'10px 24px', borderRadius:9,
            border:'1px solid var(--cyan-dim)',
            background: scanning ? 'rgba(0,245,212,0.05)' : 'var(--cyan-glow)',
            color:'var(--cyan)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor: scanning ? 'not-allowed' : 'pointer',
            opacity: scanning ? 0.7 : 1,
          }}
        >
          {scanning ? (
            <>
              <span style={{ display:'inline-block', width:12, height:12, border:'2px solid var(--cyan)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
              Scanning... (~25s)
            </>
          ) : (
            <>▶ Run Screener</>
          )}
        </button>
      </div>

      {/* ── Asset Type Tabs — client-side filter, NO re-scan ── */}
      {allResults.length > 0 && (
        <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:4, width:'fit-content' }}>
          {ASSET_TABS.map(t => (
            <button key={t.key} onClick={() => setAssetTab(t.key)} style={{
              padding:'7px 16px', borderRadius:7, border:'none',
              fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600, cursor:'pointer',
              background: assetTab===t.key ? 'rgba(0,245,212,0.1)' : 'transparent',
              color:      assetTab===t.key ? 'var(--cyan)' : 'var(--text-secondary)',
              boxShadow:  assetTab===t.key ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
            }}>{t.label} <span style={{ opacity:0.5 }}>({tabCounts[t.key] ?? 0})</span></button>
          ))}
        </div>
      )}

      {/* ── KPI Cards ── */}
      {allResults.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12 }}>
          {[
            { label:'Scannés',      v: stats.total,       color:'var(--cyan)'  },
            { label:'BUY',         v: stats.buy,          color:'var(--green)' },
            { label:'SELL',        v: stats.sell,         color:'var(--red)'   },
            { label:'HOLD',        v: stats.hold,         color:'var(--amber)' },
            { label:'Avg Confiance',v: stats.avgConf+'%', color:'var(--cyan)'  },
          ].map(k => (
            <div key={k.label} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'16px 20px' }}>
              <div style={{ fontSize:10, letterSpacing:'.12em', color:'var(--text-secondary)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:8 }}>{k.label}</div>
              <div style={{ fontSize:26, fontWeight:700, color:k.color }}>{k.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters & Sort ── */}
      {allResults.length > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:4 }}>
            {FILTERS.map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding:'6px 16px', borderRadius:7, border:'none',
                fontFamily:'JetBrains Mono,monospace', fontSize:12, cursor:'pointer',
                background: filter===f ? 'rgba(0,245,212,0.1)' : 'transparent',
                color:      filter===f ? 'var(--cyan)' : 'var(--text-secondary)',
                boxShadow:  filter===f ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
              }}>{f}</button>
            ))}
          </div>

          <button onClick={() => setShowFilters(v => !v)} style={{
            display:'flex', alignItems:'center', gap:6,
            padding:'7px 14px', borderRadius:8, cursor:'pointer',
            border:`1px solid ${activeFilterCount>0 ? 'var(--cyan-dim)' : 'var(--border)'}`,
            background: activeFilterCount>0 ? 'var(--cyan-glow)' : 'transparent',
            color: activeFilterCount>0 ? 'var(--cyan)' : 'var(--text-secondary)',
            fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600,
          }}>
            ⚙ Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
          </button>

          <button onClick={exportCsv} disabled={filtered.length===0} style={{
            padding:'7px 14px', borderRadius:8, border:'1px solid var(--border)',
            background:'transparent', color:'var(--text-secondary)',
            fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor: filtered.length===0 ? 'not-allowed' : 'pointer',
            opacity: filtered.length===0 ? 0.4 : 1,
          }}>
            ⬇ Export CSV
          </button>

          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8, fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            Trier par:
            {[['confidence','Confiance'],['price','Prix'],['rr','R:R']].map(([k,l]) => (
              <button key={k} onClick={() => setSortBy(k)} style={{
                padding:'4px 12px', borderRadius:6, border:'1px solid var(--border)',
                fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer',
                background: sortBy===k ? 'var(--cyan-glow)' : 'transparent',
                color:      sortBy===k ? 'var(--cyan)' : 'var(--text-secondary)',
              }}>{l}</button>
            ))}
            <span style={{ color:'var(--cyan)', marginLeft:8 }}>{filtered.length} résultats</span>
          </div>
        </div>
      )}

      {/* ── Custom Filter Panel ── */}
      {showFilters && (
        <div className="panel" style={{ padding:20 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>Custom Filter Criteria</div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={resetFilters} style={{ fontSize:10, color:'var(--text-muted)', background:'none', border:'none', cursor:'pointer', fontFamily:'JetBrains Mono,monospace' }}>Reset</button>
              <button onClick={() => setShowPresetInput(v => !v)} style={{ fontSize:10, color:'var(--cyan)', background:'none', border:'none', cursor:'pointer', fontFamily:'JetBrains Mono,monospace' }}>+ Save as Preset</button>
            </div>
          </div>

          {showPresetInput && (
            <div style={{ display:'flex', gap:8, marginBottom:16 }}>
              <input style={inp} placeholder="Preset name..." value={presetName} onChange={e => setPresetName(e.target.value)} />
              <button onClick={savePreset} style={{ padding:'7px 16px', borderRadius:6, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer', whiteSpace:'nowrap' }}>Save</button>
            </div>
          )}

          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14 }}>
            <div>
              <label style={label9}>RSI Range</label>
              <div style={{ display:'flex', gap:6 }}>
                <input style={inp} type="number" placeholder="Min" value={filters.rsiMin} onChange={e => setFilters(f => ({...f, rsiMin: e.target.value}))} />
                <input style={inp} type="number" placeholder="Max" value={filters.rsiMax} onChange={e => setFilters(f => ({...f, rsiMax: e.target.value}))} />
              </div>
            </div>
            <div>
              <label style={label9}>Price Range</label>
              <div style={{ display:'flex', gap:6 }}>
                <input style={inp} type="number" placeholder="Min" value={filters.priceMin} onChange={e => setFilters(f => ({...f, priceMin: e.target.value}))} />
                <input style={inp} type="number" placeholder="Max" value={filters.priceMax} onChange={e => setFilters(f => ({...f, priceMax: e.target.value}))} />
              </div>
            </div>
            <div>
              <label style={label9}>Min Confidence %</label>
              <input style={inp} type="number" placeholder="e.g. 70" value={filters.confMin} onChange={e => setFilters(f => ({...f, confMin: e.target.value}))} />
            </div>
          </div>

          {presets.length > 0 && (
            <div style={{ marginTop:18, paddingTop:16, borderTop:'1px solid var(--border)' }}>
              <div style={label9}>Saved Presets</div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {presets.map(p => (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 10px', borderRadius:6, border:'1px solid var(--border)', background:'rgba(255,255,255,0.02)' }}>
                    <button onClick={() => loadPreset(p)} style={{ background:'none', border:'none', color:'var(--cyan)', fontSize:11, fontFamily:'JetBrains Mono,monospace', cursor:'pointer' }}>
                      {p.name}
                    </button>
                    <button onClick={() => deletePreset(p.id)} style={{ background:'none', border:'none', color:'var(--text-muted)', fontSize:11, cursor:'pointer' }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{ background:'rgba(248,113,113,0.08)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:10, padding:'14px 18px', fontSize:12, color:'var(--red)', fontFamily:'JetBrains Mono,monospace' }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Empty State ── */}
      {!scanning && allResults.length === 0 && !error && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'80px 0', gap:16 }}>
          <div style={{ fontSize:40, opacity:0.15 }}>◈</div>
          <div style={{ fontSize:13, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', textAlign:'center', lineHeight:1.8 }}>
            Aucune donnée — lancez un scan pour analyser<br/>
            crypto, forex, commodities & indices en temps réel via l'IA
          </div>
          <button onClick={runScan} style={{
            marginTop:8, padding:'10px 28px', borderRadius:9,
            border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)',
            color:'var(--cyan)', fontSize:13, fontWeight:700,
            fontFamily:'Syne,sans-serif', cursor:'pointer',
          }}>
            ▶ Lancer le premier scan
          </button>
        </div>
      )}

      {/* ── Scanning skeleton ── */}
      {scanning && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          {Array(6).fill(0).map((_,i) => (
            <div key={i} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:20, height:160, animation:'pulse 2s infinite' }} />
          ))}
        </div>
      )}

      {/* ── Results Table ── */}
      {!scanning && filtered.length > 0 && (
        <div className="panel" style={{ padding:0, overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                {['','Symbole','Classe','Prix','Signal','Confiance','R:R','Tendance'].map((h,i) => (
                  <th key={i} style={{ textAlign:'left', padding:'14px 18px', fontSize:10, letterSpacing:'.15em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', borderBottom:'1px solid var(--border)', fontWeight:400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const isBuy  = r.signal === 'BUY';
                const isSell = r.signal === 'SELL';
                const conf   = r.confidence || 0;
                const rr     = parseFloat(r.risk_reward) || 0;
                return (
                  <tr key={r.id || r.symbol || i} style={{ borderBottom:'1px solid rgba(255,255,255,0.03)', transition:'background .15s', cursor:'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}
                    onClick={() => goToBacktest(r.symbol)}
                  >
                    <td style={{ padding:'14px 8px 14px 18px', width:20 }} onClick={e => e.stopPropagation()}>
                      <WatchlistStar symbol={r.symbol} onAdd={addToWatchlist} added={watchlisted.has(r.symbol.toUpperCase())} />
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:8, height:8, borderRadius:'50%', background: isBuy?'var(--green)':isSell?'var(--red)':'var(--amber)', boxShadow: isBuy?'0 0 8px var(--green)':isSell?'0 0 8px var(--red)':'0 0 8px var(--amber)' }} />
                        <span style={{ fontSize:13, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>
                          {r.symbol}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <span style={{ fontSize:9, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', textTransform:'uppercase', padding:'2px 7px', borderRadius:4, background:'rgba(255,255,255,0.04)' }}>
                        {r.asset_class}
                      </span>
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:13, fontFamily:'JetBrains Mono,monospace', color:'var(--text-primary)' }}>
                      ${r.price?.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 }) || '—'}
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <span style={{
                        padding:'4px 12px', borderRadius:6, fontSize:11, fontWeight:700, fontFamily:'JetBrains Mono,monospace',
                        background: isBuy?'rgba(52,211,153,0.12)':isSell?'rgba(248,113,113,0.12)':'rgba(251,191,36,0.12)',
                        color:      isBuy?'var(--green)':isSell?'var(--red)':'var(--amber)',
                        border:     `1px solid ${isBuy?'rgba(52,211,153,0.2)':isSell?'rgba(248,113,113,0.2)':'rgba(251,191,36,0.2)'}`,
                      }}>
                        {r.signal}
                      </span>
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:80, height:5, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden' }}>
                          <div style={{ width:`${conf}%`, height:'100%', borderRadius:3, background: conf>=75?'var(--green)':conf>=50?'var(--amber)':'var(--red)' }} />
                        </div>
                        <span style={{ fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>{conf}%</span>
                      </div>
                    </td>
                    <td style={{ padding:'14px 18px', fontSize:12, fontFamily:'JetBrains Mono,monospace', color: rr>=1.5?'var(--green)':rr>=1?'var(--amber)':'var(--red)' }}>
                      {rr > 0 ? rr.toFixed(2) : '—'}
                    </td>
                    <td style={{ padding:'14px 18px' }}>
                      <div style={{ display:'flex', gap:6, alignItems:'center', fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' }}>
                        <span style={{ color:'var(--green)' }}>▲{r.score?.bullish ?? '—'}</span>
                        <span>/</span>
                        <span style={{ color:'var(--red)' }}>▼{r.score?.bearish ?? '—'}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </>
  );
}