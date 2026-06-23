// frontend/src/components/Chart.jsx
import { useState, useEffect } from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import { marketAPI } from '../services/api';

// ── RSI calculation (mirrors backend calculateRSI.js) ────
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => null);

  const results = new Array(period).fill(null);
  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains  += d;
    else       losses -= d;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  results.push(parseFloat((100 - 100 / (1 + avgGain / (avgLoss || 1e-10))).toFixed(2)));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    results.push(parseFloat((100 - 100 / (1 + avgGain / (avgLoss || 1e-10))).toFixed(2)));
  }

  return results;
}

// ── Fibonacci levels from candle range ───────────────────
function computeFib(highs, lows) {
  const hi  = Math.max(...highs);
  const lo  = Math.min(...lows);
  const rng = hi - lo;
  return {
    fib236: parseFloat((hi - rng * 0.236).toFixed(4)),
    fib382: parseFloat((hi - rng * 0.382).toFixed(4)),
    fib500: parseFloat((hi - rng * 0.500).toFixed(4)),
    fib618: parseFloat((hi - rng * 0.618).toFixed(4)),
  };
}

const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'rgba(3,7,18,0.97)',
    border: '1px solid rgba(0,245,212,0.3)',
    borderRadius: 8,
    fontFamily: 'JetBrains Mono,monospace',
    fontSize: 11,
  },
};

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];

export default function Chart({ symbol = 'BTCUSDT', initialInterval = '4h' }) {
  const [candles,   setCandles]   = useState([]);
  const [interval,  setInterval]  = useState(initialInterval);
  const [showRSI,   setShowRSI]   = useState(true);
  const [showFib,   setShowFib]   = useState(true);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    marketAPI.candles(symbol, interval, 120)
      .then(res => {
        const raw = res.data.candles || [];
        if (!raw.length) { setCandles([]); return; }

        const closes = raw.map(c => c.close);
        const highs  = raw.map(c => c.high);
        const lows   = raw.map(c => c.low);
        const rsis   = computeRSI(closes);
        const fib    = computeFib(highs, lows);

        const data = raw.map((c, i) => ({
          time:    new Date(c.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          open:    c.open,
          high:    c.high,
          low:     c.low,
          close:   c.close,
          volume:  parseFloat((c.volume / 1e6).toFixed(2)),
          rsi:     rsis[i],
          ...fib,
          change:  i > 0 ? parseFloat(((c.close - raw[i-1].close) / raw[i-1].close * 100).toFixed(2)) : 0,
        }));

        setCandles(data);
      })
      .catch(err => setError(err.error || 'Failed to load chart data'))
      .finally(() => setLoading(false));
  }, [symbol, interval]);

  const last    = candles[candles.length - 1];
  const isUp    = last ? last.close >= last.open : true;
  const lineClr = isUp ? '#34d399' : '#f87171';
  const fib     = last ? { fib236: last.fib236, fib382: last.fib382, fib500: last.fib500, fib618: last.fib618 } : null;

  if (loading) return (
    <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono,monospace', fontSize: 12 }}>
      ⟳ Loading {symbol}…
    </div>
  );

  if (error) return (
    <div style={{ padding: 20, background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)',
      borderRadius: 12, color: 'var(--red)', fontFamily: 'JetBrains Mono,monospace', fontSize: 12 }}>
      ⚠ {error}
    </div>
  );

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: lineClr }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{symbol.replace('USDT', '/USDT')}</span>
          {last && (
            <span style={{ fontFamily: 'JetBrains Mono,monospace', fontSize: 14, fontWeight: 700, color: lineClr }}>
              ${last.close.toLocaleString()}
            </span>
          )}
          {last && (
            <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono,monospace', color: last.change >= 0 ? 'var(--green)' : 'var(--red)',
              padding: '2px 7px', borderRadius: 4, background: last.change >= 0 ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)' }}>
              {last.change >= 0 ? '+' : ''}{last.change}%
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Timeframe buttons */}
          {TIMEFRAMES.map(tf => (
            <button key={tf} onClick={() => setInterval(tf)}
              style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${interval === tf ? 'var(--cyan-dim)' : 'var(--border)'}`,
                background: interval === tf ? 'var(--cyan-glow)' : 'transparent',
                color: interval === tf ? 'var(--cyan)' : 'var(--text-secondary)',
                fontSize: 11, fontFamily: 'JetBrains Mono,monospace', cursor: 'pointer' }}>
              {tf}
            </button>
          ))}

          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />

          {/* Toggle RSI */}
          <button onClick={() => setShowRSI(v => !v)}
            style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${showRSI ? 'rgba(167,139,250,0.3)' : 'var(--border)'}`,
              background: showRSI ? 'rgba(167,139,250,0.1)' : 'transparent',
              color: showRSI ? 'var(--purple-bright)' : 'var(--text-secondary)',
              fontSize: 11, fontFamily: 'JetBrains Mono,monospace', cursor: 'pointer' }}>
            RSI
          </button>

          {/* Toggle Fibonacci */}
          <button onClick={() => setShowFib(v => !v)}
            style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${showFib ? 'rgba(251,191,36,0.3)' : 'var(--border)'}`,
              background: showFib ? 'rgba(251,191,36,0.08)' : 'transparent',
              color: showFib ? 'var(--amber)' : 'var(--text-secondary)',
              fontSize: 11, fontFamily: 'JetBrains Mono,monospace', cursor: 'pointer' }}>
            Fib
          </button>
        </div>
      </div>

      {/* ── Price chart ── */}
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={candles} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
          <XAxis dataKey="time" hide tick={{ fontSize: 9, fill: '#64748b', fontFamily: 'JetBrains Mono,monospace' }} interval={Math.floor(candles.length / 8)} />
          <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#64748b', fontFamily: 'JetBrains Mono,monospace' }}
            tickFormatter={v => `$${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}`} width={56} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v, n) => [`$${v.toLocaleString()}`, n]} />

          {/* Fibonacci reference lines */}
          {showFib && fib && <>
            <ReferenceLine y={fib.fib236} stroke="rgba(251,191,36,0.35)" strokeDasharray="4 3" label={{ value: '23.6%', position: 'right', fontSize: 9, fill: 'rgba(251,191,36,0.7)', fontFamily: 'JetBrains Mono,monospace' }} />
            <ReferenceLine y={fib.fib382} stroke="rgba(251,191,36,0.5)"  strokeDasharray="4 3" label={{ value: '38.2%', position: 'right', fontSize: 9, fill: 'rgba(251,191,36,0.8)', fontFamily: 'JetBrains Mono,monospace' }} />
            <ReferenceLine y={fib.fib500} stroke="rgba(0,245,212,0.5)"   strokeDasharray="4 3" label={{ value: '50%',   position: 'right', fontSize: 9, fill: 'rgba(0,245,212,0.8)',  fontFamily: 'JetBrains Mono,monospace' }} />
            <ReferenceLine y={fib.fib618} stroke="rgba(167,139,250,0.6)" strokeDasharray="4 3" label={{ value: '61.8%', position: 'right', fontSize: 9, fill: 'rgba(167,139,250,0.9)', fontFamily: 'JetBrains Mono,monospace' }} />
          </>}

          <Line type="monotone" dataKey="close" stroke={lineClr} strokeWidth={1.5} dot={false} name="Price" />
          <Bar dataKey="volume" fill="rgba(100,116,139,0.15)" name="Vol (M)" yAxisId={1} />
          <YAxis yAxisId={1} orientation="right" hide />
        </ComposedChart>
      </ResponsiveContainer>

      {/* ── RSI chart ── */}
      {showRSI && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono,monospace',
            letterSpacing: '.1em', marginBottom: 4, paddingLeft: 4 }}>
            RSI (14) — {last?.rsi ?? '—'}
            {last?.rsi >= 70 && <span style={{ color: 'var(--red)',   marginLeft: 8 }}>⚑ Overbought</span>}
            {last?.rsi <= 30 && <span style={{ color: 'var(--green)', marginLeft: 8 }}>⚑ Oversold</span>}
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <ComposedChart data={candles} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#64748b', fontFamily: 'JetBrains Mono,monospace' }} width={56} tickCount={3} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [v, 'RSI']} />
              <ReferenceLine y={70} stroke="rgba(248,113,113,0.4)" strokeDasharray="3 3" />
              <ReferenceLine y={30} stroke="rgba(52,211,153,0.4)"  strokeDasharray="3 3" />
              <ReferenceLine y={50} stroke="rgba(255,255,255,0.06)" />
              <Line type="monotone" dataKey="rsi" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="RSI" connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}