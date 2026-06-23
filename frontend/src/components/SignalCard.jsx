const COLOR = { BUY:'var(--green)', SELL:'var(--red)', HOLD:'var(--amber)' };
const BG    = { BUY:'rgba(52,211,153,0.12)', SELL:'rgba(248,113,113,0.12)', HOLD:'rgba(251,191,36,0.1)' };

export default function SignalCard({ signal: s }) {
  if (!s) return null;
  const color = COLOR[s.signal] || 'var(--text-secondary)';

  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid var(--border)`,
      borderRadius: 12, padding: 16, transition: 'all .25s', position: 'relative', overflow: 'hidden',
      borderTop: `2px solid ${color}`,
    }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <span style={{ fontSize:16, fontWeight:700, letterSpacing:'.05em' }}>{s.symbol}</span>
        <span style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'3px 8px', borderRadius:4, fontWeight:600, letterSpacing:'.1em', background: BG[s.signal], color }}>
          {s.signal}
        </span>
      </div>

      {/* Price */}
      <div style={{ fontSize:24, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color, marginBottom:4 }}>
        ${s.price?.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}
      </div>

      {/* Target / Stop */}
      <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginBottom:12 }}>
        Target: ${s.takeProfit?.toFixed(2)} · Stop: ${s.stopLoss?.toFixed(2)}
      </div>

      {/* Confidence bar */}
      <div style={{ height:3, background:'rgba(255,255,255,0.06)', borderRadius:2, marginBottom:12 }}>
        <div style={{ height:'100%', width:`${s.confidence}%`, background:color, borderRadius:2, transition:'width 1s ease' }} />
      </div>

      {/* Meta */}
      <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
        {[
          ['Confidence', `${s.confidence}/100`, color],
          ['R:R Ratio',  s.riskReward,           'var(--text-secondary)'],
          ['Timeframe',  s.timeframe,             'var(--text-secondary)'],
          ['RSI',        s.indicators?.rsi?.value,'var(--text-secondary)'],
        ].map(([k, v, c]) => (
          <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
            <span style={{ color:'var(--text-muted)' }}>{k}</span>
            <span style={{ color: c }}>{v}</span>
          </div>
        ))}
      </div>

      {/* AI Reasoning */}
      <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:10, paddingTop:10, borderTop:'1px solid var(--border)', lineHeight:1.5 }}>
        {s.reasoning}
      </div>
    </div>
  );
}