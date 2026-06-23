import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SignalCard from '../components/SignalCard';
import { useSignals } from '../hooks/useSignals';

const INTERVALS = ['1h', '4h', '1d'];

export default function Signals() {
  const { t } = useTranslation();

  const FILTERS = [
    { key: 'Tous', label: t('signals.filterAll') },
    { key: 'BUY',  label: t('signals.filterBuy') },
    { key: 'SELL', label: t('signals.filterSell') },
    { key: 'HOLD', label: t('signals.filterHold') },
  ];

  const [interval, setInterval] = useState('4h');
  const [filterKey, setFilterKey] = useState('Tous');
  const { signals, loading, error, lastUpdate, refresh } = useSignals(interval);

  const filtered =
    filterKey === 'Tous' ? signals : signals.filter(s => s.signal === filterKey);

  const stats = {
    active:  signals.length,
    buy:     signals.filter(s => s.signal === 'BUY').length,
    sell:    signals.filter(s => s.signal === 'SELL').length,
    avgConf: signals.length
      ? Math.round(signals.reduce((a, s) => a + s.confidence, 0) / signals.length)
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

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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

        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--cyan)', fontFamily: 'JetBrains Mono,monospace' }}>
          {t('signals.count', { count: filtered.length })}
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && console.error('[Signals]', error)}

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
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          {filtered.map(s => <SignalCard key={s.id} signal={s} />)}
        </div>
      )}
    </>
  );
}