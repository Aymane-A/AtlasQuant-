import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, YAxis } from 'recharts';
import api from '../services/api';
import { useLivePrices } from '../hooks/useLivePrices';

// ── Helpers ──────────────────────────────────────────────────
const tt = { contentStyle: { background: 'rgba(3,7,18,0.95)', border: '1px solid rgba(0,245,212,0.3)', borderRadius: 8, fontFamily: 'JetBrains Mono,monospace', fontSize: 11 } };
const monoSm = { fontFamily: 'JetBrains Mono,monospace', fontSize: 11 };
const label10 = { fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase', fontFamily: 'JetBrains Mono,monospace', color: 'var(--text-muted)' };
const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22 };

function fmtPrice(sym, price) {
  if (typeof price === 'string') return price;
  if (sym === 'BTC' || sym === 'ETH') return price >= 1000 ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

export default function Portfolio() {
  const [sideFilter, setSideFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  
  // ── Data State ──
  const [hero, setHero] = useState({ totalValue: 0, todayPnL: '$0', dayReturn: '0%', totalPnL: '$0', totalReturn: '0%', openPositions: 0, availableCash: '$0' });
  const [allocations, setAllocations] = useState([]);
  const [holdingsData, setHoldingsData] = useState([]);
  const [allPositionsData, setAllPositionsData] = useState([]);
  const [risks, setRisks] = useState([]);
  const [sectorData, setSectorData] = useState([]);
  const [equityCurve, setEquityCurve] = useState([]);

  // ── 1. Fetching Data mn l-Backend (axios instance b token attaché) ──
  const fetchPortfolioData = async () => {
    try {
      const res = await api.get('/portfolio/data');
      const data = res.data;
      if (data.success) {
        setHero(data.hero);
        setAllocations(data.allocations);
        setHoldingsData(data.holdings);
        setAllPositionsData(data.allPositions);
        setRisks(data.risks);
        setSectorData(data.sectors);
        setEquityCurve(data.equityCurve);
      }
    } catch (err) { console.error("API Error:", err); } 
    finally { setLoading(false); }
  };

  useEffect(() => {
    fetchPortfolioData();
    const interval = setInterval(fetchPortfolioData, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── 2. Live Prices Integration ──
  const liveP = useLivePrices();
  const applyLive = (h) => {
    const live = liveP[h.sym];
    if (!live) return h;
    return { ...h, price: fmtPrice(h.sym, live.price), ch: `${live.change >= 0 ? '+' : ''}${live.change.toFixed(2)}%`, up: live.up };
  };

  const holdings = holdingsData.map(applyLive);
  const filtered = sideFilter === 'all' ? allPositionsData.map(applyLive) : allPositionsData.map(applyLive).filter(p => p.side === sideFilter);

  return (
    <>
      {/* ── Hero Metrics ── */}
      <div style={{ background: 'linear-gradient(135deg,rgba(0,245,212,0.06),rgba(167,139,250,0.04))', border: '1px solid var(--border-accent)', borderRadius: 16, padding: 32 }}>
        <div style={{ ...label10 }}>Total Portfolio Value</div>
        <div style={{ fontSize: 48, fontWeight: 800, color: 'var(--cyan)' }}>${hero.totalValue.toLocaleString()}</div>
        {/* ... (Reste du layout Hero) */}
      </div>

      {/* ── Charts ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div style={panel}>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={allocations} dataKey="pct" innerRadius={55} outerRadius={75}>
                {allocations.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip {...tt} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div style={panel}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={equityCurve}>
              <Line type="monotone" dataKey="v" stroke="#a78bfa" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Table Positions ── */}
      <div style={{ ...panel, marginTop: 16 }}>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>{['Ticker', 'Price', 'P&L', 'Return'].map(h => <th key={h} style={label10}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => (
              <tr key={i}>
                <td>{p.sym}</td>
                <td style={{ color: p.up ? 'var(--green)' : 'var(--red)' }}>{p.price}</td>
                <td>{p.pnl}</td>
                <td>{p.ret}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}