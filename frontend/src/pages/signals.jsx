import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SignalCard from '../components/SignalCard';
import { useSignals } from '../hooks/useSignals';
import api from '../services/api';
import SignalModal from '../components/SignalModal';

const INTERVALS = ['1h', '4h', '1d'];

const ASSET_CLASSES = [
  { key: 'Tous',      label: 'Tous',       color: 'var(--cyan)'          },
  { key: 'Crypto',    label: 'Crypto',     color: 'var(--cyan)'          },
  { key: 'Forex',     label: 'Forex',      color: 'var(--purple-bright)' },
  { key: 'Commodity', label: 'Commodités', color: 'var(--amber)'         },
  { key: 'Indices',   label: 'Indices',    color: 'var(--green)'         },
];

export default function Signals() {
  const { t } = useTranslation();

  const FILTERS = [
    { key: 'Tous', label: t('signals.filterAll') },
    { key: 'BUY',  label: t('signals.filterBuy') },
    { key: 'SELL', label: t('signals.filterSell') },
    { key: 'HOLD', label: t('signals.filterHold') },
  ];

  const [interval, setInterval]   = useState('4h');
  const [filterKey, setFilterKey] = useState('Tous');
  const [classKey, setClassKey]   = useState('Tous');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('confidence'); // 'confidence' | 'price' | 'recent'
  const [watchlisted, setWatchlisted] = useState(new Set());
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedSignal, setSelectedSignal] = useState(null);
  const { signals, loading, error, lastUpdate, refresh } = useSignals(interval);

  // ── Counts par classe (pour badges) ──
  const classCounts = useMemo(() => {
    const counts = { Tous: signals.length, Crypto: 0, Forex: 0, Commodity: 0, Indices: 0 };
    signals.forEach(s => {
      const cls = s.asset_class || 'Crypto';
      if (counts[cls] !== undefined) counts[cls]++;
    });
    return counts;
  }, [signals]);

  const ensureWatchlist = () => {
    if (watchlistLoaded) return;
    setWatchlistLoaded(true);
    api.get('/watchlist')
      .then(res => setWatchlisted(new Set((res.data.stocks || []).map(s => s.symbol))))
      .catch(() => {});
  };

  // ✅ Load watchlist once, as soon as the page mounts
  useEffect(() => { ensureWatchlist(); }, []);

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

  const filtered = useMemo(() => {
    let result = signals;
    if (classKey !== 'Tous')  result = result.filter(s => (s.asset_class || 'Crypto') === classKey);
    if (filterKey !== 'Tous') result = result.filter(s => s.signal === filterKey);
    if (searchQuery.trim())   result = result.filter(s => s.symbol.toLowerCase().includes(searchQuery.trim().toLowerCase()));

    result = [...result].sort((a, b) => {
      if (sortBy === 'confidence') return (b.confidence || 0) - (a.confidence || 0);
      if (sortBy === 'price')      return (b.price || 0) - (a.price || 0);
      if (sortBy === 'recent')     return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
      return 0;
    });

    return result;
  }, [signals, classKey, filterKey, searchQuery, sortBy]);

  const stats = {
    active:  filtered.length,
    buy:     filtered.filter(s => s.signal === 'BUY').length,
    sell:    filtered.filter(s => s.signal === 'SELL').length,
    avgConf: filtered.length
      ? Math.round(filtered.reduce((a, s) => a + s.confidence, 0) / filtered.length)
      : 0,
  };

  const kpis = [
    { label: t('signals.active'),  value: stats.active,          color: 'var(--cyan)'  },
    { label: t('signals.buy'),     value: stats.buy,             color: 'var(--green)' },
    { label: t('signals.sell'),    value: stats.sell,            color: 'var(--red)'   },
    { label: t('signals.avgConf'), value: stats.avgConf + '%',   color: 'var(--amber)' },
  ];

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{
            fontSize: 11, letterSpacing: '.2em', color: 'var(--text-muted)',
            textTransform: 'uppercase', fontFamily: 'JetBrains Mono,monospace', marginBottom: 4,
          }}>
            {t('signals.engine')}
          </div>

          {lastUpdate && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono,monospace' }}>
              {t('signals.updatedAt')} {lastUpdate.toLocaleTimeString()}
            </div>
          )}
        </div>

        <button
          onClick={refresh}
          disabled={loading}
          style={{
            padding: '9px 22px', borderRadius: 9, border: '1px solid var(--cyan-dim)',
            background: 'var(--cyan-glow)', color: 'var(--cyan)', fontSize: 13,
            fontWeight: 700, fontFamily: 'Syne,sans-serif', cursor: 'pointer',
            opacity: loading ? .7 : 1,
          }}
        >
          {loading ? t('signals.scanning') : t('signals.refresh')}
        </button>
      </div>

      {/* ── KPIs ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12 }}>
        {kpis.map(k => (
          <div key={k.label} style={{
            flex: 1, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: '18px 20px',
          }}>
            <div style={{
              fontSize: 10, letterSpacing: '.12em', color: 'var(--text-secondary)',
              textTransform: 'uppercase', fontFamily: 'JetBrains Mono,monospace', marginBottom: 8,
            }}>
              {k.label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* ── Asset Class Tabs ───────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 4, background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border)', borderRadius: 10, padding: 4,
      }}>
        {ASSET_CLASSES.map(c => {
          const active = classKey === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setClassKey(c.key)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontFamily: 'JetBrains Mono,monospace', fontSize: 12, transition: 'all .2s',
                background: active ? `${c.color}1a` : 'transparent',
                color:      active ? c.color : 'var(--text-secondary)',
                boxShadow:  active ? `inset 0 0 0 1px ${c.color}33` : 'none',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.color, opacity: active ? 1 : .4 }} />
              {c.label}
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 999,
                background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)',
              }}>
                {classCounts[c.key] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Signal Type Filters + Interval + Search + Sort ──────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{
          display: 'flex', gap: 4, background: 'rgba(255,255,255,0.02)',
          border: '1px solid var(--border)', borderRadius: 10, padding: 4,
        }}>
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilterKey(f.key)}
              style={{
                padding: '6px 16px', borderRadius: 7, border: 'none',
                fontFamily: 'JetBrains Mono,monospace', fontSize: 12, cursor: 'pointer',
                transition: 'all .2s',
                background:  filterKey === f.key ? 'rgba(0,245,212,0.1)' : 'transparent',
                color:       filterKey === f.key ? 'var(--cyan)' : 'var(--text-secondary)',
                boxShadow:   filterKey === f.key ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {INTERVALS.map(i => (
            <button
              key={i}
              onClick={() => setInterval(i)}
              style={{
                padding: '6px 14px', borderRadius: 8,
                border: `1px solid ${interval === i ? 'var(--cyan-dim)' : 'var(--border)'}`,
                fontFamily: 'JetBrains Mono,monospace', fontSize: 11, cursor: 'pointer',
                background: interval === i ? 'var(--cyan-glow)' : 'transparent',
                color:      interval === i ? 'var(--cyan)' : 'var(--text-secondary)',
              }}
            >
              {i}
            </button>
          ))}
        </div>

        <input
          placeholder="🔍 Search symbol..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            padding: '7px 12px', borderRadius: 8, width: 160,
            border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)',
            color: 'var(--text-primary)', fontFamily: 'JetBrains Mono,monospace',
            fontSize: 11, outline: 'none', boxSizing: 'border-box',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono,monospace' }}>
          Trier:
          {[['confidence','Confiance'],['price','Prix'],['recent','Récent']].map(([k,l]) => (
            <button key={k} onClick={() => setSortBy(k)} style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
              fontFamily: 'JetBrains Mono,monospace', fontSize: 11, cursor: 'pointer',
              background: sortBy === k ? 'var(--cyan-glow)' : 'transparent',
              color:      sortBy === k ? 'var(--cyan)' : 'var(--text-secondary)',
            }}>{l}</button>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--cyan)', fontFamily: 'JetBrains Mono,monospace' }}>
          {t('signals.count', { count: filtered.length })}
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ background:'rgba(248,113,113,0.08)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:10, padding:'14px 18px', fontSize:12, color:'var(--red)', fontFamily:'JetBrains Mono,monospace' }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Grid ───────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          {Array(6).fill(0).map((_, i) => (
            <div key={i} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 16, height: 280, animation: 'pulse 2s infinite',
            }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono,monospace', fontSize: 12,
        }}>
          {t('signals.noResults', 'Aucun signal pour ce filtre')}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          {filtered.map(s => (
            <SignalCard
              key={s.id}
              signal={s}
              onAddToWatchlist={addToWatchlist}
              isWatchlisted={watchlisted.has((s.symbol || '').toUpperCase())}
              onOpenDetail={() => setSelectedSignal(s)}
            />
          ))}
        </div>
      )}

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      {toast && (
        <div style={{ position:'fixed', top:80, right:28, zIndex:1000, background:'rgba(3,7,18,0.95)', border:'1px solid rgba(0,245,212,0.3)', borderRadius:8, padding:'10px 16px', fontFamily:'JetBrains Mono,monospace', fontSize:12, color:'var(--cyan)', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
          {toast}
        </div>
      )}
      {selectedSignal && (
        <SignalModal signal={selectedSignal} onClose={() => setSelectedSignal(null)} />
      )}
    </>
  );
}