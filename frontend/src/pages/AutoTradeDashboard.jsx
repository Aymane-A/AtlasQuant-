// frontend/src/pages/AutoTradeDashboard.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';

/**
 * "Proof floor" page — shows the user, in one place, whether auto-trading
 * is doing what it claims: which configs are gated/on probation/live, and
 * the actual paper trade log backing those numbers. Every figure here is
 * either returned directly by the API or summed from the raw trade rows
 * in front of the user — nothing invented client-side.
 *
 * Data sources (existing endpoints, no backend changes needed):
 *   GET /auto-trade/configs
 *   GET /trading/orders?mode=paper&status=open
 *   GET /trading/orders?mode=paper&status=closed
 */

const STATUS_META = {
  backtest_required: { label: 'Needs a backtest', color: 'var(--text-secondary)', bg: 'rgba(100,116,139,0.12)' },
  backtest_expired:  { label: 'Backtest expired',  color: 'var(--amber)',          bg: 'rgba(251,191,36,0.12)' },
  backtest_rejected: { label: 'Backtest rejected',  color: 'var(--red)',           bg: 'rgba(248,113,113,0.12)' },
  probation:         { label: 'On probation',       color: 'var(--purple-bright)', bg: 'rgba(167,139,250,0.12)' },
  live:              { label: 'Live',                color: 'var(--cyan)',         bg: 'var(--cyan-glow)' },
  blocked:           { label: 'Blocked',             color: 'var(--red)',          bg: 'rgba(248,113,113,0.12)' },
  disabled:          { label: 'Disabled',            color: 'var(--text-muted)',   bg: 'rgba(100,116,139,0.08)' },
};

const mono = { fontFamily: 'JetBrains Mono,monospace' };

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(openedAt, closedAt) {
  if (!openedAt) return '—';
  const ms = (closedAt ? new Date(closedAt) : new Date()) - new Date(openedAt);
  const h  = ms / 3_600_000;
  if (h < 1)  return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default function AutoTradeDashboard() {
  const [configs, setConfigs]           = useState([]);
  const [openTrades, setOpenTrades]     = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [refreshedAt, setRefreshedAt]   = useState(null);
  const [tab, setTab]                   = useState('open');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cfgRes, openRes, closedRes] = await Promise.all([
        api.get('/auto-trade/configs'),
        api.get('/trading/orders', { params: { mode: 'paper', status: 'open' } }),
        api.get('/trading/orders', { params: { mode: 'paper', status: 'closed' } }),
      ]);
      setConfigs(cfgRes.data.configs || []);
      setOpenTrades((openRes.data.orders || []).filter(o => o.mode === 'paper'));
      setClosedTrades((closedRes.data.orders || []).filter(o => o.mode === 'paper'));
      setRefreshedAt(new Date());
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const liveCount      = configs.filter(c => c.status === 'live').length;
  const probationCount = configs.filter(c => c.status === 'probation').length;
  const closedPnls     = closedTrades.map(t => Number(t.pnl)).filter(Number.isFinite);
  const totalPnl        = closedPnls.reduce((s, v) => s + v, 0);
  const wins             = closedPnls.filter(v => v > 0).length;
  const winRate           = closedPnls.length ? (wins / closedPnls.length) * 100 : null;

  if (loading) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-secondary)', ...mono, fontSize: 12 }}>
        ⟳ Loading paper trading data…
      </div>
    );
  }

  return (
    <>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 4px', color: 'var(--text-primary)' }}>
            Paper Trading &amp; Auto-Trade
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', maxWidth: '60ch' }}>
            Everything below is simulated — no real money moves. Watch it work before you connect a live exchange.
          </p>
        </div>
        <button
          onClick={load}
          style={{
            background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)',
            padding: '8px 14px', borderRadius: 8, fontSize: 12, ...mono, cursor: 'pointer',
          }}
        >
          Refresh{refreshedAt ? ` · ${refreshedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </button>
      </div>

      {error && (
        <div style={{
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
          color: 'var(--red)', padding: '12px 16px', borderRadius: 10, fontSize: 13,
        }}>
          Couldn't load the latest data: {error}
        </div>
      )}

      {/* ── Summary cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <SummaryCard label="Configs live" value={liveCount} sub={`${probationCount} on probation`} />
        <SummaryCard label="Open paper trades" value={openTrades.length} />
        <SummaryCard
          label="Closed trade P&L"
          value={closedPnls.length ? fmtMoney(totalPnl) : '—'}
          color={totalPnl > 0 ? 'var(--green)' : totalPnl < 0 ? 'var(--red)' : 'var(--text-primary)'}
          sub={`${closedPnls.length} closed trade${closedPnls.length === 1 ? '' : 's'}`}
        />
        <SummaryCard
          label="Win rate"
          value={winRate === null ? '—' : `${winRate.toFixed(0)}%`}
          sub={winRate === null ? 'No closed trades yet' : `${wins}/${closedPnls.length} wins`}
        />
      </div>

      {/* ── Auto-trade configs ── */}
      <div>
        <h2 style={sectionTitle}>Auto-trade configs</h2>
        {configs.length === 0 ? (
          <EmptyState
            title="No auto-trade configs yet"
            body="Run a backtest on a symbol in your watchlist, then enable auto-trade from the results — it'll show up here."
          />
        ) : (
          <Panel>
            <Table
              cols={['Symbol', 'Strategy', 'Status', 'Probation', 'Backtest', 'Last evaluated']}
              rows={configs.map(c => [
                <span style={mono}>{c.symbol}</span>,
                c.strategy_id,
                <StatusPill status={c.status} />,
                c.status === 'probation'
                  ? <ProgressCell done={c.probation_trades_completed} total={c.probation_trades_required} />
                  : <span style={{ color: 'var(--text-muted)' }}>—</span>,
                c.backtest_expectancy != null
                  ? <span style={mono}>exp. {Number(c.backtest_expectancy).toFixed(2)} · {c.backtest_total_trades} trades</span>
                  : <span style={{ color: 'var(--text-muted)' }}>unlinked</span>,
                <span style={{ color: 'var(--text-secondary)' }}>{fmtDate(c.last_evaluated_at)}</span>,
              ])}
            />
          </Panel>
        )}
      </div>

      {/* ── Trade log ── */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ ...sectionTitle, marginBottom: 0 }}>Paper trade log</h2>
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
            {['open', 'closed'].map(key => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  background: tab === key ? 'var(--cyan-glow)' : 'transparent',
                  color: tab === key ? 'var(--cyan)' : 'var(--text-secondary)',
                  border: 'none', fontSize: 12, ...mono, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {key} ({key === 'open' ? openTrades.length : closedTrades.length})
              </button>
            ))}
          </div>
        </div>

        {tab === 'open' ? (
          openTrades.length === 0 ? (
            <EmptyState title="No open paper trades" body="Once auto-trade opens a position, it'll appear here in real time." />
          ) : (
            <Panel>
              <Table
                cols={['Symbol', 'Side', 'Entry', 'Stop / Target', 'Opened', 'Open for']}
                rows={openTrades.map(t => [
                  <span style={mono}>{t.symbol}</span>,
                  <SidePill side={t.side} />,
                  <span style={mono}>${Number(t.price).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>,
                  <span style={{ ...mono, color: 'var(--text-secondary)' }}>
                    {t.stop_loss ? `SL ${Number(t.stop_loss).toFixed(2)}` : '—'}
                    {t.take_profit ? ` · TP ${Number(t.take_profit).toFixed(2)}` : ''}
                  </span>,
                  <span style={{ color: 'var(--text-secondary)' }}>{fmtDate(t.opened_at)}</span>,
                  <span style={{ color: 'var(--text-secondary)' }}>{fmtDuration(t.opened_at)}</span>,
                ])}
              />
            </Panel>
          )
        ) : (
          closedTrades.length === 0 ? (
            <EmptyState title="No closed paper trades yet" body="Results from finished paper trades land here, most recent first." />
          ) : (
            <Panel>
              <Table
                cols={['Symbol', 'Side', 'Entry', 'Exit', 'P&L', 'Duration', 'Reason']}
                rows={closedTrades.map(t => {
                  const pnl = Number(t.pnl);
                  const pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--text-primary)';
                  return [
                    <span style={mono}>{t.symbol}</span>,
                    <SidePill side={t.side} />,
                    <span style={mono}>${Number(t.price).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>,
                    <span style={mono}>{t.exit_price ? `$${Number(t.exit_price).toLocaleString('en-US', { maximumFractionDigits: 4 })}` : '—'}</span>,
                    <span style={{ ...mono, color: pnlColor }}>
                      {Number.isFinite(pnl) ? fmtMoney(pnl) : '—'}
                      {t.pnl_pct != null && <span style={{ color: 'var(--text-muted)' }}> ({fmtPct(t.pnl_pct)})</span>}
                    </span>,
                    <span style={{ color: 'var(--text-secondary)' }}>{fmtDuration(t.opened_at, t.closed_at)}</span>,
                    <span style={{ color: 'var(--text-secondary)' }}>{t.close_reason || '—'}</span>,
                  ];
                })}
              />
            </Panel>
          )
        )}
      </div>
    </>
  );
}

// ── shared pieces ──────────────────────────────────────────
const sectionTitle = { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 14px' };

function Panel({ children }) {
  return (
    <div className="glass-panel" style={{ borderRadius: 14, overflow: 'auto' }}>
      {children}
    </div>
  );
}

function Table({ cols, rows }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 }}>
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c} style={{
              textAlign: 'left', fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600,
              padding: '12px 16px', borderBottom: '1px solid var(--border)', ...mono,
            }}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SummaryCard({ label, value, sub, color = 'var(--text-primary)' }) {
  return (
    <div className="glass-panel" style={{ borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, ...mono }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, ...mono }}>{sub}</div>}
    </div>
  );
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status, color: 'var(--text-secondary)', bg: 'rgba(100,116,139,0.1)' };
  return (
    <span style={{
      display: 'inline-block', padding: '4px 10px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg, ...mono,
    }}>
      {meta.label}
    </span>
  );
}

function SidePill({ side }) {
  const isBuy = side === 'buy';
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
      color: isBuy ? 'var(--green)' : 'var(--red)',
      background: isBuy ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
      ...mono,
    }}>
      {side}
    </span>
  );
}

function ProgressCell({ done = 0, total = 1 }) {
  const pct = Math.min(100, (done / Math.max(1, total)) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 110 }}>
      <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--cyan)', borderRadius: 3 }} />
      </div>
      <span style={{ ...mono, color: 'var(--text-secondary)', fontSize: 11 }}>{done}/{total}</span>
    </div>
  );
}

function EmptyState({ title, body }) {
  return (
    <div style={{
      border: '1px dashed var(--border)', borderRadius: 14, padding: '40px 24px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: '42ch', margin: '0 auto' }}>{body}</div>
    </div>
  );
}