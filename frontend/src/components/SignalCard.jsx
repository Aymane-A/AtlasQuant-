const COLOR = { BUY:'var(--green)', SELL:'var(--red)', HOLD:'var(--amber)' };
const BG    = { BUY:'rgba(52,211,153,0.12)', SELL:'rgba(248,113,113,0.12)', HOLD:'rgba(251,191,36,0.1)' };

const CLASS_COLOR = {
  Crypto:    'var(--cyan)',
  Forex:     'var(--purple-bright)',
  Commodity: 'var(--amber)',
  Indices:   'var(--green)',
};
const CLASS_LABEL = {
  Crypto:    'CRYPTO',
  Forex:     'FOREX',
  Commodity: 'COMMO',
  Indices:   'INDEX',
};

// ── Smart price formatter — handles PEPE, SHIB, BTC, XAU ─
const smartPrice = (p) => {
  const n = parseFloat(p);
  if (!n || isNaN(n)) return '—';
  if (n >= 10000)   return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000)    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)       return '$' + n.toFixed(2);
  if (n >= 0.01)    return '$' + n.toFixed(4);
  if (n >= 0.0001)  return '$' + n.toFixed(6);
  if (n >= 0.00001) return '$' + n.toFixed(8);
  return '$' + n.toFixed(10);
};

export default function SignalCard({ signal: s, onAddToWatchlist, isWatchlisted, onOpenDetail }) {
  if (!s) return null;
  const color = COLOR[s.signal] || 'var(--text-secondary)';

  // ── Normalize field names (backend sends snake_case) ─────
  const price       = s.price;
  const entry       = s.entry      || s.price;
  const stopLoss    = s.stop_loss  ?? s.stopLoss;
  const takeProfit  = s.take_profit ?? s.takeProfit;
  const riskReward  = s.risk_reward ?? s.riskReward;
  const timeframe   = s.interval   ?? s.timeframe ?? '4h';
  const rsiValue    = s.indicators?.rsi?.value ?? s.indicators?.rsi;
  const assetClass  = s.asset_class || 'Crypto';
  const classColor  = CLASS_COLOR[assetClass] || 'var(--text-secondary)';
  const classLabel  = CLASS_LABEL[assetClass] || assetClass.toUpperCase();

  return (
    <div
      onClick={() => onOpenDetail && onOpenDetail()}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 16, transition: 'all .25s',
        position: 'relative', overflow: 'hidden',
        borderTop: `2px solid ${color}`,
        cursor: onOpenDetail ? 'pointer' : 'default',
      }}
    >
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:16, fontWeight:700, letterSpacing:'.05em' }}>{s.symbol}</span>
          {onAddToWatchlist && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToWatchlist(s.symbol); }}
              title={isWatchlisted ? 'In watchlist' : 'Add to watchlist'}
              style={{
                background:'transparent', border:'none', cursor:'pointer',
                color: isWatchlisted ? 'var(--amber)' : 'var(--text-muted)',
                fontSize:14, padding:2, lineHeight:1,
              }}
            >
              {isWatchlisted ? '★' : '☆'}
            </button>
          )}
        </div>
        <span style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'3px 8px', borderRadius:4, fontWeight:600, letterSpacing:'.1em', background: BG[s.signal], color }}>
          {s.signal}
        </span>
      </div>

      {/* Asset class tag */}
      <div style={{ marginBottom:12 }}>
        <span style={{
          fontSize:9, fontFamily:'JetBrains Mono,monospace', fontWeight:600,
          letterSpacing:'.12em', padding:'2px 7px', borderRadius:4,
          background:`${classColor}1a`, color: classColor,
          border:`1px solid ${classColor}33`,
        }}>
          {classLabel}
        </span>
      </div>

      {/* Price */}
      <div style={{ fontSize:24, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color, marginBottom:4 }}>
        {smartPrice(price)}
      </div>

      {/* Target / Stop */}
      <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginBottom:12 }}>
        Target: {takeProfit ? smartPrice(takeProfit) : '—'}
        {' · '}
        Stop: {stopLoss ? smartPrice(stopLoss) : '—'}
      </div>

      {/* Confidence bar */}
      <div style={{ height:3, background:'rgba(255,255,255,0.06)', borderRadius:2, marginBottom:12 }}>
        <div style={{ height:'100%', width:`${s.confidence}%`, background:color, borderRadius:2, transition:'width 1s ease' }} />
      </div>

      {/* Meta */}
      <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
        {[
          ['Confidence', `${s.confidence}/100`,                      color                    ],
          ['R:R Ratio',  riskReward  || '—',                         'var(--text-secondary)'  ],
          ['Timeframe',  timeframe,                                   'var(--text-secondary)'  ],
          ['RSI',        rsiValue != null ? parseFloat(rsiValue).toFixed(2) : '—', 'var(--text-secondary)'],
        ].map(([k, v, c]) => (
          <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
            <span style={{ color:'var(--text-muted)' }}>{k}</span>
            <span style={{ color: c }}>{v}</span>
          </div>
        ))}
      </div>

      {/* AI Reasoning */}
      {s.reasoning && (
        <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:10, paddingTop:10, borderTop:'1px solid var(--border)', lineHeight:1.5 }}>
          {s.reasoning}
        </div>
      )}
    </div>
  );
}