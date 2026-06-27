import { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '../services/api';

// ── Design tokens ─────────────────────────────────────────
const mono  = { fontFamily:"'JetBrains Mono','Fira Code',monospace" };
const T     = {
  cyan:'#00f5d4', purple:'#a78bfa', amber:'#f59e0b',
  red:'#f43f5e',  green:'#34d399',  slate:'#64748b',
  sky:'#38bdf8',
};

const EXCHANGES = [
  { id:'binance', name:'Binance', color:'#F3BA2F' },
  { id:'bybit',   name:'Bybit',   color:'#F7A600' },
  { id:'okx',     name:'OKX',     color:'#00D4AA' },
  { id:'kucoin',  name:'KuCoin',  color:'#23AF91' },
  { id:'kraken',  name:'Kraken',  color:'#5741D9' },
  { id:'mexc',    name:'MEXC',    color:'#00B4D8' },
  { id:'gate',    name:'Gate.io', color:'#E85D04' },
  { id:'htx',     name:'HTX',     color:'#2196F3' },
  { id:'bitget',  name:'Bitget',  color:'#00CED1' },
  { id:'phemex',  name:'Phemex',  color:'#9B59B6' },
  { id:'bitmex',  name:'BitMEX',  color:'#FF4757' },
];

const ORDER_TYPES = ['market','limit','stop_limit'];
const POPULAR_SYMBOLS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','LINK','UNI','MATIC'];

function injectStyles() {
  if (document.getElementById('aq-trading-style')) return;
  const s = document.createElement('style');
  s.id = 'aq-trading-style';
  s.textContent = `
    @keyframes aq-fadein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
    @keyframes aq-pulse  { 0%,100%{opacity:.35} 50%{opacity:.7} }
    @keyframes aq-blink  { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes aq-flash  { 0%{background:rgba(0,245,212,0.15)} 100%{background:transparent} }
    .aq-t-row:hover { background: rgba(255,255,255,0.02) !important; }
    .aq-t-input { transition: border-color .15s; }
    .aq-t-input:focus { border-color: rgba(0,245,212,0.4) !important; outline:none; }
    .aq-sym-pill:hover { background: rgba(0,245,212,0.12) !important; border-color: rgba(0,245,212,0.3) !important; color: #00f5d4 !important; }
    .aq-order-flash { animation: aq-flash .6s ease; }
  `;
  document.head.appendChild(s);
}

// ── Sub-components ────────────────────────────────────────
function Label({ children, style={} }) {
  return <div style={{ ...mono, fontSize:9, letterSpacing:'.18em', textTransform:'uppercase', color:T.slate, ...style }}>{children}</div>;
}
function Sk({ w='100%', h=14 }) {
  return <div style={{ width:w, height:h, borderRadius:4, background:'rgba(255,255,255,0.06)', animation:'aq-pulse 1.6s ease-in-out infinite' }}/>;
}

function PriceTicker({ ticker, loading }) {
  const up = ticker?.change24h >= 0;
  if (loading) return (
    <div style={{ display:'flex', gap:20, alignItems:'center' }}>
      <Sk w={120} h={32}/><Sk w={80} h={20}/><Sk w={60} h={16}/>
    </div>
  );
  if (!ticker) return null;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:24, flexWrap:'wrap' }}>
      <div style={{ ...mono, fontSize:32, fontWeight:800, color:T.cyan, letterSpacing:'-1px' }}>
        ${ticker.price?.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:6 })}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
        <span style={{ ...mono, fontSize:13, fontWeight:700, color: up ? T.green : T.red }}>
          {up?'+':''}{ticker.change24h?.toFixed(2)}% 24h
        </span>
        <span style={{ ...mono, fontSize:10, color:T.slate }}>
          H: ${ticker.high24h?.toLocaleString()} · L: ${ticker.low24h?.toLocaleString()}
        </span>
      </div>
      <div style={{ display:'flex', gap:16, ...mono, fontSize:10, color:T.slate }}>
        <span>Vol: <span style={{ color:'var(--text)' }}>${(ticker.quoteVol/1e6)?.toFixed(1)}M</span></span>
        <span>Bid: <span style={{ color:T.green }}>${ticker.bid?.toLocaleString()}</span></span>
        <span>Ask: <span style={{ color:T.red }}>${ticker.ask?.toLocaleString()}</span></span>
      </div>
    </div>
  );
}

function MiniChart({ candles, change24h }) {
  if (!candles?.length) return (
    <div style={{ height:160, display:'flex', alignItems:'center', justifyContent:'center', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>
      Loading chart...
    </div>
  );
  const up = change24h >= 0;
  const color = up ? T.green : T.red;
  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={candles} margin={{ top:4, right:0, left:0, bottom:0 }}>
        <defs>
          <linearGradient id="trd-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={0.2}/>
            <stop offset="100%" stopColor={color} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false}/>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={['auto','auto']}/>
        <Tooltip
          contentStyle={{ background:'rgba(3,7,18,0.97)', border:`1px solid ${color}30`, borderRadius:6, ...mono, fontSize:10 }}
          formatter={v => [`$${parseFloat(v).toLocaleString()}`, 'Price']}
          labelFormatter={() => ''}
        />
        <Area type="monotone" dataKey="close" stroke={color} strokeWidth={1.5}
          fill="url(#trd-grad)" dot={false}
          activeDot={{ r:3, fill:color, stroke:'var(--surface)', strokeWidth:2 }}/>
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Order Form ────────────────────────────────────────────
function OrderForm({ exchange, symbol, ticker, balance, onOrderPlaced }) {
  const [side,       setSide]       = useState('buy');
  const [orderType,  setOrderType]  = useState('market');
  const [quantity,   setQuantity]   = useState('');
  const [price,      setPrice]      = useState('');
  const [stopPrice,  setStopPrice]  = useState('');
  const [pct,        setPct]        = useState(null); // 25/50/75/100
  const [loading,    setLoading]    = useState(false);
  const [result,     setResult]     = useState(null);
  const [error,      setError]      = useState('');

  const curPrice   = ticker?.price || 0;
  const qty        = parseFloat(quantity) || 0;
  const lim        = parseFloat(price) || curPrice;
  const total      = qty * (orderType === 'market' ? curPrice : lim);

  // Quick % buttons
  const usdtBalance = balance?.find(b => b.symbol === 'USDT')?.free || 0;
  const symBalance  = balance?.find(b => b.symbol === symbol)?.free || 0;

  const applyPct = (p) => {
    setPct(p);
    if (side === 'buy') {
      const amt = (usdtBalance * p / 100) / (lim || curPrice || 1);
      setQuantity(amt.toFixed(6));
    } else {
      setQuantity((symBalance * p / 100).toFixed(6));
    }
  };

  const handleSubmit = async () => {
    if (!quantity || parseFloat(quantity) <= 0) { setError('Enter quantity'); return; }
    if (orderType !== 'market' && !price)        { setError('Enter limit price'); return; }
    if (orderType === 'stop_limit' && !stopPrice){ setError('Enter stop price'); return; }

    setLoading(true); setError(''); setResult(null);
    try {
      const res = await api.post('/trading/order', {
        exchangeId: exchange.id,
        symbol:     `${symbol}USDT`,
        side, orderType, quantity: parseFloat(quantity),
        price:      orderType !== 'market' ? parseFloat(price) : undefined,
        stopPrice:  orderType === 'stop_limit' ? parseFloat(stopPrice) : undefined,
      });
      if (res.data.success) {
        setResult({ mode: res.data.mode, order: res.data.order });
        setQuantity(''); setPrice(''); setStopPrice(''); setPct(null);
        onOrderPlaced?.();
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Order failed');
    } finally { setLoading(false); }
  };

  const inputStyle = {
    width:'100%', boxSizing:'border-box',
    background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)',
    borderRadius:8, padding:'10px 14px',
    color:'var(--text)', ...mono, fontSize:13,
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

      {/* Buy / Sell toggle */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        {['buy','sell'].map(s => (
          <button key={s} onClick={() => { setSide(s); setPct(null); setQuantity(''); }} style={{
            padding:'11px 0', borderRadius:9, cursor:'pointer',
            ...mono, fontSize:12, fontWeight:800, textTransform:'uppercase', letterSpacing:'.08em',
            border:`1px solid ${side===s ? (s==='buy'?'rgba(52,211,153,0.5)':'rgba(244,63,94,0.5)') : 'var(--border)'}`,
            background: side===s ? (s==='buy'?'rgba(52,211,153,0.12)':'rgba(244,63,94,0.12)') : 'transparent',
            color: side===s ? (s==='buy'?T.green:T.red) : T.slate,
            transition:'all .15s',
          }}>
            {s === 'buy' ? '↑ Buy' : '↓ Sell'}
          </button>
        ))}
      </div>

      {/* Order type tabs */}
      <div style={{ display:'flex', background:'rgba(255,255,255,0.03)', borderRadius:8, padding:3, gap:2 }}>
        {ORDER_TYPES.map(t => (
          <button key={t} onClick={() => setOrderType(t)} style={{
            flex:1, padding:'6px 0', borderRadius:6, cursor:'pointer', border:'none',
            ...mono, fontSize:9, letterSpacing:'.06em', textTransform:'uppercase',
            background: orderType===t ? 'rgba(0,245,212,0.1)' : 'transparent',
            color: orderType===t ? T.cyan : T.slate,
            transition:'all .15s',
          }}>
            {t.replace('_',' ')}
          </button>
        ))}
      </div>

      {/* Stop price (stop_limit only) */}
      {orderType === 'stop_limit' && (
        <div>
          <Label style={{ marginBottom:7 }}>Stop Price (USDT)</Label>
          <input className="aq-t-input" type="number" value={stopPrice}
            onChange={e => setStopPrice(e.target.value)}
            placeholder={curPrice ? (curPrice * 0.97).toFixed(2) : '0.00'}
            style={inputStyle} />
        </div>
      )}

      {/* Limit price */}
      {orderType !== 'market' && (
        <div>
          <Label style={{ marginBottom:7 }}>
            {orderType === 'stop_limit' ? 'Limit Price' : 'Price'} (USDT)
          </Label>
          <input className="aq-t-input" type="number" value={price}
            onChange={e => setPrice(e.target.value)}
            placeholder={curPrice?.toFixed(2) || '0.00'}
            style={inputStyle} />
        </div>
      )}

      {/* Market price display */}
      {orderType === 'market' && curPrice > 0 && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
          background:'rgba(255,255,255,0.02)', borderRadius:8, padding:'8px 12px' }}>
          <Label>Market Price</Label>
          <span style={{ ...mono, fontSize:13, color:T.cyan, fontWeight:700 }}>
            ${curPrice.toLocaleString('en-US', { minimumFractionDigits:2 })}
          </span>
        </div>
      )}

      {/* Quantity */}
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:7 }}>
          <Label>Amount ({symbol})</Label>
          {side === 'sell' && symBalance > 0 && (
            <span style={{ ...mono, fontSize:9, color:T.slate }}>
              Avail: <span style={{ color:'var(--text)' }}>{symBalance.toFixed(6)} {symbol}</span>
            </span>
          )}
          {side === 'buy' && usdtBalance > 0 && (
            <span style={{ ...mono, fontSize:9, color:T.slate }}>
              Avail: <span style={{ color:'var(--text)' }}>${usdtBalance.toLocaleString('en-US', { maximumFractionDigits:2 })}</span>
            </span>
          )}
        </div>
        <input className="aq-t-input" type="number" value={quantity}
          onChange={e => { setQuantity(e.target.value); setPct(null); }}
          placeholder="0.00000000" style={inputStyle} />
      </div>

      {/* % quick buttons */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5 }}>
        {[25,50,75,100].map(p => (
          <button key={p} onClick={() => applyPct(p)} style={{
            padding:'5px 0', borderRadius:6, cursor:'pointer',
            ...mono, fontSize:9, fontWeight:700,
            border:`1px solid ${pct===p ? 'rgba(0,245,212,0.4)' : 'var(--border)'}`,
            background: pct===p ? 'rgba(0,245,212,0.1)' : 'transparent',
            color: pct===p ? T.cyan : T.slate,
            transition:'all .15s',
          }}>
            {p}%
          </button>
        ))}
      </div>

      {/* Order total */}
      {qty > 0 && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
          background: side==='buy' ? 'rgba(52,211,153,0.04)' : 'rgba(244,63,94,0.04)',
          border:`1px solid ${side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)'}`,
          borderRadius:8, padding:'10px 14px' }}>
          <Label>Total</Label>
          <span style={{ ...mono, fontSize:14, fontWeight:800, color: side==='buy' ? T.green : T.red }}>
            ${total.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ ...mono, fontSize:10, color:T.red, background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:8, padding:'9px 12px' }}>
          ✕ {error}
        </div>
      )}

      {/* Success */}
      {result && (
        <div className="aq-order-flash" style={{ ...mono, fontSize:10, color:T.green, background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:8, padding:'9px 12px' }}>
          ✓ {result.mode === 'paper' ? 'Paper' : 'Live'} order placed — {result.order?.symbol || symbol}
        </div>
      )}

      {/* Submit */}
      <button onClick={handleSubmit} disabled={loading} style={{
        width:'100%', padding:14, borderRadius:10, cursor: loading ? 'not-allowed' : 'pointer',
        border:`1px solid ${side==='buy' ? 'rgba(52,211,153,0.4)' : 'rgba(244,63,94,0.4)'}`,
        background: side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)',
        color: side==='buy' ? T.green : T.red,
        fontFamily:'Syne,sans-serif', fontSize:14, fontWeight:800,
        letterSpacing:'.04em', opacity: loading ? 0.7 : 1, transition:'all .15s',
      }}
        onMouseEnter={e => { if (!loading) e.currentTarget.style.background = side==='buy' ? 'rgba(52,211,153,0.2)' : 'rgba(244,63,94,0.2)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)'; }}
      >
        {loading ? '⟳ Placing...' : `${side==='buy'?'↑ Buy':'↓ Sell'} ${symbol}`}
      </button>

      {/* Mode badge */}
      {exchange && (
        <div style={{ textAlign:'center', ...mono, fontSize:9, color:T.slate }}>
          {exchange.name} ·{' '}
          <span style={{ color: exchange.mode==='live' ? T.red : exchange.mode==='paper' ? T.cyan : T.slate }}>
            {(exchange.mode || 'readonly').toUpperCase()}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Orders Panel ──────────────────────────────────────────
function OrdersPanel({ exchangeId, refresh }) {
  const [orders,  setOrders]  = useState([]);
  const [tab,     setTab]     = useState('open');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/trading/orders?exchangeId=${exchangeId}&status=${tab}`);
      if (res.data.success) setOrders(res.data.orders || []);
    } catch {} finally { setLoading(false); }
  }, [exchangeId, tab]);

  useEffect(() => { load(); }, [load, refresh]);

  const cancel = async (order) => {
    try {
      await api.delete(`/trading/orders/${order.id || order.exchange_order_id}?exchangeId=${exchangeId}&mode=${order.mode}`);
      load();
    } catch (err) { console.error(err); }
  };

  const sideColor = (side) => side === 'buy' ? T.green : T.red;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
      {/* Tabs */}
      <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.05)', marginBottom:14 }}>
        {['open','closed'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...mono, fontSize:9, letterSpacing:'.12em', textTransform:'uppercase',
            background:'none', border:'none', cursor:'pointer', padding:'8px 16px 8px 0',
            color: tab===t ? 'var(--text)' : T.slate,
            borderBottom: tab===t ? `2px solid ${T.cyan}` : '2px solid transparent',
            marginBottom:-1, fontWeight: tab===t ? 700 : 400,
          }}>{t} Orders</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[1,2,3].map(i => <Sk key={i} h={40}/>)}
        </div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign:'center', padding:'32px 0', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>
          No {tab} orders
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:320, overflowY:'auto' }}>
          {orders.map((o, i) => (
            <div key={i} className="aq-t-row" style={{
              display:'grid', gridTemplateColumns:'auto 1fr auto auto',
              alignItems:'center', gap:10, padding:'10px 8px', borderRadius:8,
              background:'rgba(255,255,255,0.01)',
            }}>
              {/* Side */}
              <span style={{ ...mono, fontSize:9, fontWeight:800, letterSpacing:'.08em', padding:'2px 8px', borderRadius:4,
                color: sideColor(o.side), background:`${sideColor(o.side)}15`, border:`1px solid ${sideColor(o.side)}30` }}>
                {(o.side||'').toUpperCase()}
              </span>
              {/* Symbol + details */}
              <div>
                <div style={{ ...mono, fontSize:11, fontWeight:700, color:'var(--text)' }}>
                  {o.symbol} <span style={{ color:T.slate, fontWeight:400 }}>× {parseFloat(o.quantity).toFixed(4)}</span>
                </div>
                <div style={{ ...mono, fontSize:9, color:T.slate }}>
                  {o.order_type?.replace('_',' ')} · {o.mode === 'paper' ? '📄 Paper' : '⚡ Live'}
                  {o.price && ` · $${parseFloat(o.price).toLocaleString()}`}
                </div>
              </div>
              {/* PnL for closed */}
              {tab === 'closed' && o.pnl != null && (
                <span style={{ ...mono, fontSize:11, fontWeight:700, color: parseFloat(o.pnl) >= 0 ? T.green : T.red }}>
                  {parseFloat(o.pnl) >= 0 ? '+' : ''}${parseFloat(o.pnl).toFixed(2)}
                </span>
              )}
              {/* Status / Cancel */}
              {tab === 'open' ? (
                <button onClick={() => cancel(o)} style={{ ...mono, fontSize:9, padding:'3px 10px', borderRadius:5, cursor:'pointer', border:'1px solid rgba(244,63,94,0.2)', background:'rgba(244,63,94,0.06)', color:T.red }}>
                  Cancel
                </button>
              ) : (
                <span style={{ ...mono, fontSize:9, color:T.slate }}>{o.status}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Trading Page ─────────────────────────────────────
export default function Trading() {
  const [connections,    setConnections]    = useState({});
  const [selectedExId,   setSelectedExId]  = useState('');
  const [symbol,         setSymbol]        = useState('BTC');
  const [symbolInput,    setSymbolInput]   = useState('BTC');
  const [ticker,         setTicker]        = useState(null);
  const [candles,        setCandles]       = useState([]);
  const [balance,        setBalance]       = useState([]);
  const [tickerLoading,  setTickerLoading] = useState(false);
  const [ordersRefresh,  setOrdersRefresh] = useState(0);
  const tickerRef = useRef(null);

  useEffect(() => { injectStyles(); }, []);

  // Load connected exchanges
  useEffect(() => {
    api.get('/exchanges/connections')
      .then(res => {
        const conns = res.data || {};
        setConnections(conns);
        // Auto-select first connected exchange
        const first = Object.keys(conns)[0];
        if (first) setSelectedExId(first);
      })
      .catch(() => {});
  }, []);

  // Fetch ticker + candles
  const fetchTicker = useCallback(async (sym) => {
    if (!sym) return;
    setTickerLoading(true);
    try {
      const res = await api.get(`/trading/ticker/${sym}`);
      if (res.data.success) {
        setTicker(res.data.ticker);
        setCandles(res.data.candles || []);
      }
    } catch (err) {
      setTicker(null);
    } finally { setTickerLoading(false); }
  }, []);

  useEffect(() => {
    fetchTicker(symbol);
    // Poll ticker every 10s
    const iv = setInterval(() => fetchTicker(symbol), 10000);
    return () => clearInterval(iv);
  }, [symbol, fetchTicker]);

  // Fetch balance when exchange changes
  useEffect(() => {
    if (!selectedExId) return;
    api.get(`/trading/balance?exchangeId=${selectedExId}`)
      .then(res => { if (res.data.success) setBalance(res.data.balances || []); })
      .catch(() => {});
  }, [selectedExId]);

  const handleSymbolSearch = (e) => {
    if (e.key === 'Enter') {
      const s = symbolInput.toUpperCase().replace(/[^A-Z0-9]/g,'');
      if (s) setSymbol(s);
    }
  };

  const selectedEx = selectedExId ? {
    ...EXCHANGES.find(e => e.id === selectedExId),
    mode: connections[selectedExId]?.mode,
  } : null;

  const connectedExchanges = EXCHANGES.filter(e => connections[e.id]);

  // Panel style
  const panel = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16 };

  if (connectedExchanges.length === 0) return (
    <div style={{ ...panel, padding:64, textAlign:'center', animation:'aq-fadein .4s ease' }}>
      <div style={{ fontSize:36, marginBottom:16, opacity:.3 }}>◈</div>
      <div style={{ fontSize:16, fontWeight:700, color:'var(--text)', marginBottom:8 }}>No exchanges connected</div>
      <div style={{ ...mono, fontSize:11, color:T.slate, marginBottom:24 }}>
        Connect an exchange in the Exchanges page to start trading
      </div>
      <a href="/exchanges" style={{ ...mono, fontSize:11, padding:'8px 20px', borderRadius:8, border:'1px solid rgba(0,245,212,0.3)', background:'rgba(0,245,212,0.06)', color:T.cyan, textDecoration:'none' }}>
        Go to Exchanges →
      </a>
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14, animation:'aq-fadein .35s ease' }}>

      {/* ── Header bar ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ ...mono, fontSize:10, letterSpacing:'.2em', textTransform:'uppercase', color:T.slate, marginBottom:4 }}>
            // Live Trading
          </div>
          <div style={{ ...mono, fontSize:11, color:'var(--text)' }}>
            {connectedExchanges.length} exchange{connectedExchanges.length !== 1 ? 's' : ''} connected
          </div>
        </div>

        {/* Exchange selector */}
        <div style={{ display:'flex', gap:6 }}>
          {connectedExchanges.map(ex => {
            const isSelected = selectedExId === ex.id;
            const mode = connections[ex.id]?.mode;
            return (
              <button key={ex.id} onClick={() => setSelectedExId(ex.id)} style={{
                display:'flex', alignItems:'center', gap:7, padding:'7px 14px',
                borderRadius:9, cursor:'pointer', transition:'all .15s',
                border:`1px solid ${isSelected ? ex.color + '50' : 'var(--border)'}`,
                background: isSelected ? `${ex.color}12` : 'transparent',
              }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background: ex.color, boxShadow: isSelected ? `0 0 6px ${ex.color}` : 'none' }}/>
                <span style={{ ...mono, fontSize:10, fontWeight: isSelected ? 700 : 400, color: isSelected ? ex.color : T.slate }}>
                  {ex.name}
                </span>
                <span style={{ ...mono, fontSize:8, color: mode==='live' ? T.red : mode==='paper' ? T.cyan : T.slate }}>
                  {mode?.toUpperCase()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Main 3-col layout ── */}
      <div style={{ display:'grid', gridTemplateColumns:'320px 1fr 280px', gap:14, alignItems:'start' }}>

        {/* ══ LEFT: Order Form ══ */}
        <div style={{ ...panel, padding:22, display:'flex', flexDirection:'column', gap:16 }}>
          {/* Symbol search */}
          <div>
            <Label style={{ marginBottom:8 }}>Symbol</Label>
            <div style={{ position:'relative' }}>
              <input className="aq-t-input" value={symbolInput}
                onChange={e => setSymbolInput(e.target.value.toUpperCase())}
                onKeyDown={handleSymbolSearch}
                placeholder="BTC, ETH, SOL..."
                style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:8, padding:'9px 14px 9px 36px', color:'var(--text)', ...mono, fontSize:13 }}
              />
              <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', ...mono, fontSize:12, color:T.slate }}>⌕</span>
              <button onClick={() => { const s = symbolInput.toUpperCase().replace(/[^A-Z0-9]/g,''); if(s) setSymbol(s); }}
                style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', ...mono, fontSize:9, padding:'3px 8px', borderRadius:5, border:'1px solid rgba(0,245,212,0.2)', background:'rgba(0,245,212,0.06)', color:T.cyan, cursor:'pointer' }}>
                GO
              </button>
            </div>
            {/* Popular symbols */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginTop:8 }}>
              {POPULAR_SYMBOLS.slice(0,8).map(s => (
                <button key={s} className="aq-sym-pill" onClick={() => { setSymbol(s); setSymbolInput(s); }}
                  style={{ ...mono, fontSize:9, padding:'2px 8px', borderRadius:4, cursor:'pointer', transition:'all .15s',
                    border:`1px solid ${symbol===s ? 'rgba(0,245,212,0.35)' : 'var(--border)'}`,
                    background: symbol===s ? 'rgba(0,245,212,0.1)' : 'transparent',
                    color: symbol===s ? T.cyan : T.slate }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div style={{ height:1, background:'rgba(255,255,255,0.05)' }}/>

          {selectedEx ? (
            <OrderForm
              exchange={selectedEx}
              symbol={symbol}
              ticker={ticker}
              balance={balance}
              onOrderPlaced={() => setOrdersRefresh(r => r+1)}
            />
          ) : (
            <div style={{ textAlign:'center', padding:'24px 0', ...mono, fontSize:11, color:T.slate }}>
              Select an exchange to trade
            </div>
          )}
        </div>

        {/* ══ CENTER: Chart + Ticker ══ */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* Ticker header */}
          <div style={{ ...panel, padding:'18px 22px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:14 }}>
              <div style={{ ...mono, fontSize:22, fontWeight:800, color:'var(--text)' }}>{symbol}</div>
              <div style={{ ...mono, fontSize:11, color:T.slate }}>/USDT</div>
              {tickerLoading && <span style={{ ...mono, fontSize:9, color:T.slate, animation:'aq-pulse 1s infinite' }}>Loading...</span>}
            </div>
            <PriceTicker ticker={ticker} loading={tickerLoading && !ticker} />
          </div>

          {/* Chart */}
          <div style={{ ...panel, padding:'18px 22px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <Label>Price Chart (1h)</Label>
              <button onClick={() => fetchTicker(symbol)} style={{ ...mono, fontSize:9, padding:'3px 10px', borderRadius:5, border:'1px solid var(--border)', background:'transparent', color:T.slate, cursor:'pointer' }}>
                ↻ Refresh
              </button>
            </div>
            <MiniChart candles={candles} change24h={ticker?.change24h} />
          </div>

          {/* Balance */}
          {balance.length > 0 && (
            <div style={{ ...panel, padding:'16px 22px' }}>
              <Label style={{ marginBottom:12 }}>Balance — {selectedEx?.name}</Label>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                {balance.filter(b => b.total > 0).slice(0,6).map((b, i) => (
                  <div key={i} style={{ background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', minWidth:100 }}>
                    <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:4 }}>{b.symbol}</div>
                    <div style={{ ...mono, fontSize:14, fontWeight:700, color:'var(--text)' }}>
                      {b.total >= 1000
                        ? b.total.toLocaleString('en-US', { maximumFractionDigits:2 })
                        : b.total.toFixed(b.total < 0.001 ? 6 : 4)}
                    </div>
                    {b.locked > 0 && (
                      <div style={{ ...mono, fontSize:9, color:T.slate }}>🔒 {b.locked.toFixed(4)}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ══ RIGHT: Orders Panel ══ */}
        <div style={{ ...panel, padding:'18px 20px' }}>
          <Label style={{ marginBottom:14 }}>Orders</Label>
          {selectedExId ? (
            <OrdersPanel exchangeId={selectedExId} refresh={ordersRefresh} />
          ) : (
            <div style={{ textAlign:'center', padding:'24px 0', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>
              Select exchange
            </div>
          )}
        </div>
      </div>
    </div>
  );
}