import { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '../services/api';

// ── Design tokens ─────────────────────────────────────────
const mono = { fontFamily:"'JetBrains Mono','Fira Code',monospace" };
const T    = {
  cyan:'#00f5d4', purple:'#a78bfa', amber:'#f59e0b',
  red:'#f43f5e',  green:'#34d399',  slate:'#64748b', sky:'#38bdf8',
};

// Matches the ccxt-backed SUPPORTED map in exchanges.service.js — add an
// entry here + one line in that file's CCXT_IDS array to support a new
// exchange, no other code changes needed.
const EXCHANGES = [
  { id:'binance',   name:'Binance',   color:'#F3BA2F' },
  { id:'binanceus', name:'Binance.US',color:'#F3BA2F' },
  { id:'bybit',     name:'Bybit',     color:'#F7A600' },
  { id:'okx',       name:'OKX',       color:'#00D4AA' },
  { id:'kucoin',    name:'KuCoin',    color:'#23AF91' },
  { id:'kraken',    name:'Kraken',    color:'#5741D9' },
  { id:'coinbase',  name:'Coinbase',  color:'#0052FF' },
  { id:'mexc',      name:'MEXC',      color:'#00B4D8' },
  { id:'gate',      name:'Gate.io',   color:'#E85D04' },
  { id:'htx',       name:'HTX',       color:'#2196F3' },
  { id:'bitget',    name:'Bitget',    color:'#00CED1' },
  { id:'phemex',    name:'Phemex',    color:'#9B59B6' },
  { id:'bitmex',    name:'BitMEX',    color:'#FF4757' },
  { id:'bitfinex',  name:'Bitfinex',  color:'#16B157' },
  { id:'bitstamp',  name:'Bitstamp',  color:'#3CB54A' },
  { id:'bingx',     name:'BingX',     color:'#1677FF' },
  { id:'coinex',    name:'CoinEx',    color:'#1BC47D' },
  { id:'cryptocom', name:'Crypto.com',color:'#003CDA' },
  { id:'deribit',   name:'Deribit',   color:'#4B4B4B' },
  { id:'poloniex',  name:'Poloniex',  color:'#5E56E7' },
  { id:'upbit',     name:'Upbit',     color:'#093687' },
  { id:'whitebit',  name:'WhiteBIT',  color:'#F5C518' },
  { id:'woo',       name:'WOO X',     color:'#00E0FF' },
  { id:'ascendex',  name:'AscendEX',  color:'#3861FB' },
  { id:'bitrue',    name:'Bitrue',    color:'#1DA2B4' },
  { id:'probit',    name:'ProBit',    color:'#0091FF' },
  { id:'hitbtc',    name:'HitBTC',    color:'#1B458F' },
  { id:'latoken',   name:'LATOKEN',   color:'#1A73E8' },
  { id:'digifinex', name:'DigiFinex', color:'#2F80ED' },
  // OANDA — forex + metals/commodities broker, not a crypto exchange.
  { id:'oanda',     name:'OANDA',     color:'#0090D4' },
];

const ORDER_TYPES     = ['market','limit','stop_limit'];
const POPULAR_SYMBOLS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','LINK','UNI','MATIC'];
// OANDA forex instrument names (underscore format, e.g. "EUR_USD").
const FOREX_SYMBOLS     = ['EUR_USD','GBP_USD','USD_JPY','AUD_USD','USD_CAD','USD_CHF','NZD_USD','EUR_GBP'];
// OANDA commodity CFD instruments — kept separate from forex so the UI,
// symbol pills, and price decimals can treat them differently (gold at
// 5 decimals reads wrong; 2 decimals matches how it's actually quoted).
const COMMODITY_SYMBOLS = ['XAU_USD','XAG_USD','WTICO_USD','BCO_USD','NATGAS_USD','XPT_USD','XPD_USD','XCU_USD'];
const COMMODITY_LABELS  = {
  XAU_USD:'Gold', XAG_USD:'Silver', WTICO_USD:'WTI Crude', BCO_USD:'Brent Crude',
  NATGAS_USD:'Nat Gas', XPT_USD:'Platinum', XPD_USD:'Palladium', XCU_USD:'Copper',
};

// ── Style injection ───────────────────────────────────────
function injectStyles() {
  if (document.getElementById('aq-trading-v3')) return;
  const s = document.createElement('style');
  s.id = 'aq-trading-v3';
  s.textContent = `
    @keyframes aq-fadein  { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
    @keyframes aq-pulse   { 0%,100%{opacity:.35} 50%{opacity:.7} }
    @keyframes aq-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes aq-flash   { 0%{background:rgba(0,245,212,0.18)} 100%{background:transparent} }
    @keyframes aq-shake   { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
    @keyframes aq-slidein { from{opacity:0;transform:scale(.97)} to{opacity:1;transform:scale(1)} }
    .aq-t-row:hover { background: rgba(255,255,255,0.025) !important; }
    .aq-t-row td    { transition: background .15s; }
    .aq-t-input     { transition: border-color .15s; }
    .aq-t-input:focus { border-color: rgba(0,245,212,0.4) !important; outline:none; }
    .aq-sym-pill:hover { background:rgba(0,245,212,0.12)!important; border-color:rgba(0,245,212,0.3)!important; color:#00f5d4!important; }
    .aq-order-flash    { animation: aq-flash .8s ease; }
    .aq-ex-btn:hover   { opacity:.85; }
  `;
  document.head.appendChild(s);
}

// ── Helpers ───────────────────────────────────────────────
function Label({ children, style={} }) {
  return <div style={{ ...mono, fontSize:9, letterSpacing:'.18em', textTransform:'uppercase', color:T.slate, ...style }}>{children}</div>;
}
function Sk({ w='100%', h=14 }) {
  return <div style={{ width:w, height:h, borderRadius:4, background:'rgba(255,255,255,0.06)', animation:'aq-pulse 1.6s ease-in-out infinite' }}/>;
}
function Divider({ style={} }) {
  return <div style={{ height:1, background:'rgba(255,255,255,0.05)', ...style }}/>;
}

// ── Readonly Warning Banner ───────────────────────────────
function ReadonlyBanner({ exchangeName }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:14,
      background:'rgba(245,158,11,0.06)', border:'1px solid rgba(245,158,11,0.25)',
      borderRadius:12, padding:'12px 18px',
    }}>
      <span style={{ fontSize:18, flexShrink:0 }}>⚠</span>
      <div style={{ flex:1 }}>
        <div style={{ ...mono, fontSize:11, fontWeight:700, color:T.amber, marginBottom:2 }}>
          {exchangeName} is in Read-Only mode
        </div>
        <div style={{ ...mono, fontSize:10, color:T.slate }}>
          Switch to Paper or Live mode to place orders
        </div>
      </div>
      <a href="/exchanges" style={{
        ...mono, fontSize:10, padding:'6px 14px', borderRadius:7, textDecoration:'none',
        border:'1px solid rgba(245,158,11,0.35)', background:'rgba(245,158,11,0.1)',
        color:T.amber, flexShrink:0, transition:'all .15s',
      }}>
        Change Mode →
      </a>
    </div>
  );
}

// ── Order Confirmation Modal ──────────────────────────────
function ConfirmModal({ order, exchange, onConfirm, onCancel }) {
  const [loading, setLoading] = useState(false);
  const isLive = exchange?.mode === 'live';
  const side   = order.side;

  const handle = async () => {
    setLoading(true);
    await onConfirm();
    setLoading(false);
  };

  const priceDp = order.isCommodity ? 2 : order.isForex ? 5 : 2;

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', backdropFilter:'blur(16px)', zIndex:600, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{
        background:'#080f1e', borderRadius:20, padding:32, width:440,
        border:`1px solid ${isLive ? 'rgba(244,63,94,0.3)' : 'rgba(0,245,212,0.2)'}`,
        boxShadow:`0 0 60px ${isLive ? 'rgba(244,63,94,0.1)' : 'rgba(0,245,212,0.08)'}, 0 32px 64px rgba(0,0,0,0.7)`,
        animation:'aq-slidein .2s ease',
      }}>
        {/* Header */}
        <div style={{ textAlign:'center', marginBottom:24 }}>
          <div style={{ fontSize:28, marginBottom:10 }}>{isLive ? '⚡' : '◈'}</div>
          <div style={{ fontSize:16, fontWeight:800, color:'var(--text)', marginBottom:6 }}>
            Confirm {isLive ? 'Live' : 'Paper'} Order
          </div>
          {isLive && (
            <div style={{ ...mono, fontSize:10, color:T.red, background:'rgba(244,63,94,0.08)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:6, padding:'6px 12px', display:'inline-block' }}>
              ⚠ This will execute a REAL order with REAL funds
            </div>
          )}
        </div>

        {/* Order details */}
        <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:12, padding:18, marginBottom:14 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
            {[
              { label:'Exchange', value: exchange?.name },
              { label:'Mode',     value: exchange?.mode?.toUpperCase(), color: isLive ? T.red : T.cyan },
              { label:'Symbol',   value: order.symbol },
              { label:'Side',     value: side?.toUpperCase(), color: side==='buy' ? T.green : T.red },
              { label:'Type',     value: order.orderType?.replace('_',' ').toUpperCase() },
              { label: order.isForex || order.isCommodity ? 'Units' : 'Amount', value: `${parseFloat(order.quantity).toFixed(order.isForex || order.isCommodity ? 0 : 6)} ${order.baseSymbol}` },
              { label:'Price',    value: order.orderType === 'market' ? 'Market' : `${order.quoteCcy === 'USDT' ? '$' : ''}${parseFloat(order.price).toLocaleString()}${order.quoteCcy !== 'USDT' ? ` ${order.quoteCcy}` : ''}` },
              { label:'Total',    value: `≈ ${order.quoteCcy === 'USDT' ? '$' : ''}${order.total?.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}${order.quoteCcy !== 'USDT' ? ` ${order.quoteCcy}` : ''}`, color: side==='buy'?T.green:T.red },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ ...mono, fontSize:9, color:T.slate, textTransform:'uppercase', letterSpacing:'.12em', marginBottom:3 }}>{label}</div>
                <div style={{ ...mono, fontSize:12, fontWeight:700, color: color || 'var(--text)' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {(order.stopLoss || order.takeProfit) && (
          <div style={{ display:'flex', gap:10, marginBottom:20 }}>
            {order.stopLoss && (
              <div style={{ flex:1, background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:10, padding:'10px 14px' }}>
                <div style={{ ...mono, fontSize:9, color:T.red, textTransform:'uppercase', letterSpacing:'.1em', marginBottom:3 }}>🛑 Stop-Loss</div>
                <div style={{ ...mono, fontSize:13, fontWeight:800, color:T.red }}>{parseFloat(order.stopLoss).toFixed(priceDp)}</div>
              </div>
            )}
            {order.takeProfit && (
              <div style={{ flex:1, background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:10, padding:'10px 14px' }}>
                <div style={{ ...mono, fontSize:9, color:T.green, textTransform:'uppercase', letterSpacing:'.1em', marginBottom:3 }}>🎯 Take-Profit</div>
                <div style={{ ...mono, fontSize:13, fontWeight:800, color:T.green }}>{parseFloat(order.takeProfit).toFixed(priceDp)}</div>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={handle} disabled={loading} style={{
            flex:1, padding:13, borderRadius:10, cursor: loading ? 'not-allowed' : 'pointer',
            border:`1px solid ${side==='buy' ? 'rgba(52,211,153,0.4)' : 'rgba(244,63,94,0.4)'}`,
            background: side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)',
            color: side==='buy' ? T.green : T.red,
            fontFamily:'Syne,sans-serif', fontSize:14, fontWeight:800,
            opacity: loading ? 0.7 : 1, transition:'all .15s',
          }}>
            {loading ? '⟳ Placing...' : `${side==='buy'?'↑ Confirm Buy':'↓ Confirm Sell'}`}
          </button>
          <button onClick={onCancel} style={{ padding:'13px 20px', borderRadius:10, border:'1px solid var(--border)', background:'transparent', color:T.slate, fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Cancel Order Confirmation Modal ───────────────────────
function CancelConfirmModal({ order, onConfirm, onCancel }) {
  const [loading, setLoading] = useState(false);
  const isLive = order.mode === 'live';

  const handle = async () => {
    setLoading(true);
    await onConfirm();
    setLoading(false);
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(12px)', zIndex:650, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{
        background:'#080f1e', borderRadius:18, padding:26, width:340,
        border:'1px solid rgba(244,63,94,0.3)',
        boxShadow:'0 0 50px rgba(244,63,94,0.08), 0 28px 56px rgba(0,0,0,0.7)',
        animation:'aq-slidein .2s ease',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:15, fontWeight:800, color:'var(--text)', marginBottom:10, textAlign:'center' }}>
          Cancel this order?
        </div>
        <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:14, marginBottom:18, ...mono, fontSize:11, color:T.slate, textAlign:'center' }}>
          <span style={{ color: order.side==='buy'?T.green:T.red, fontWeight:700 }}>{(order.side||'').toUpperCase()}</span>
          {' '}{order.symbol} × {parseFloat(order.quantity).toFixed(6)}
          {isLive && <div style={{ color:T.red, marginTop:6 }}>⚡ Live order</div>}
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={handle} disabled={loading} style={{
            flex:1, padding:11, borderRadius:9, cursor: loading ? 'not-allowed' : 'pointer',
            border:'1px solid rgba(244,63,94,0.4)', background:'rgba(244,63,94,0.12)',
            color:T.red, fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:800,
            opacity: loading ? 0.7 : 1,
          }}>
            {loading ? '⟳ Cancelling...' : 'Yes, Cancel'}
          </button>
          <button onClick={onCancel} style={{ padding:'11px 18px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:T.slate, fontFamily:'Syne,sans-serif', fontSize:12, cursor:'pointer' }}>
            Keep Order
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Quick Price Alert Modal ───────────────────────────────
function QuickAlertModal({ symbol, currentPrice, priceDp, onClose }) {
  const [condition, setCondition] = useState('above');
  const [target,    setTarget]    = useState(currentPrice ? currentPrice.toFixed(priceDp) : '');
  const [loading,   setLoading]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [error,     setError]     = useState('');

  const submit = async () => {
    if (!target || parseFloat(target) <= 0) { setError('Enter a target price'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/alerts', {
        symbol, type: 'typePrice', condition, value: parseFloat(target), channels: ['email'],
      });
      setDone(true);
      setTimeout(onClose, 1200);
    } catch {
      setError('Could not create alert');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', backdropFilter:'blur(14px)', zIndex:620, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background:'#080f1e', borderRadius:18, padding:26, width:340,
        border:'1px solid rgba(0,245,212,0.25)',
        boxShadow:'0 0 50px rgba(0,245,212,0.08), 0 28px 56px rgba(0,0,0,0.7)',
        animation:'aq-slidein .2s ease',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:15, fontWeight:800, color:'var(--text)', marginBottom:4, textAlign:'center' }}>
          🔔 Alert on {symbol}
        </div>
        <div style={{ ...mono, fontSize:10, color:T.slate, textAlign:'center', marginBottom:18 }}>
          Current: {currentPrice ? currentPrice.toFixed(priceDp) : '—'}
        </div>

        {done ? (
          <div style={{ textAlign:'center', ...mono, fontSize:12, color:T.green, padding:'14px 0' }}>✓ Alert created</div>
        ) : (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:12 }}>
              {['above','below'].map(c => (
                <button key={c} onClick={() => setCondition(c)} style={{
                  padding:'9px 0', borderRadius:8, cursor:'pointer', ...mono, fontSize:11, fontWeight:700, textTransform:'uppercase',
                  border:`1px solid ${condition===c ? 'rgba(0,245,212,0.4)' : 'var(--border)'}`,
                  background: condition===c ? 'rgba(0,245,212,0.1)' : 'transparent',
                  color: condition===c ? T.cyan : T.slate,
                }}>
                  {c === 'above' ? '↑ Above' : '↓ Below'}
                </button>
              ))}
            </div>
            <input type="number" value={target} onChange={e => setTarget(e.target.value)}
              placeholder="Target price" style={{
                width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)',
                borderRadius:8, padding:'10px 14px', color:'var(--text)', ...mono, fontSize:13, marginBottom:14,
              }} />
            {error && <div style={{ ...mono, fontSize:10, color:T.red, marginBottom:12 }}>✕ {error}</div>}
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={submit} disabled={loading} style={{
                flex:1, padding:11, borderRadius:9, cursor: loading ? 'not-allowed' : 'pointer',
                border:'1px solid rgba(0,245,212,0.4)', background:'rgba(0,245,212,0.1)',
                color:T.cyan, fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:800,
              }}>
                {loading ? '⟳ Creating...' : 'Create Alert'}
              </button>
              <button onClick={onClose} style={{ padding:'11px 18px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:T.slate, fontFamily:'Syne,sans-serif', fontSize:12, cursor:'pointer' }}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── TradingView Chart Widget ──────────────────────────────
function TradingViewChart({ symbol, exchange, isForex, isCommodity }) {
  const containerRef = useRef(null);

  const TV_EXCHANGE_MAP = {
    binance:'BINANCE', binanceus:'BINANCEUS', bybit:'BYBIT', okx:'OKX', kucoin:'KUCOIN',
    kraken:'KRAKEN', coinbase:'COINBASE', mexc:'MEXC', gate:'GATEIO', htx:'HUOBI',
    bitget:'BITGET', phemex:'PHEMEX', bitmex:'BITMEX', bitfinex:'BITFINEX',
    bitstamp:'BITSTAMP', poloniex:'POLONIEX', upbit:'UPBIT',
  };
  // OANDA/TradingView symbols drop the underscore: "EUR_USD" → "OANDA:EURUSD"
  const tvSymbol = (isForex || isCommodity)
    ? `OANDA:${symbol.replace('_', '')}`
    : `${TV_EXCHANGE_MAP[exchange] || 'BINANCE'}:${symbol}USDT`;

  useEffect(() => {
    if (!containerRef.current) return;

    containerRef.current.innerHTML = '';

    const script = document.createElement('script');
    script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type  = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize:          true,
      symbol:            tvSymbol,
      interval:          '60',
      timezone:          'Etc/UTC',
      theme:             'dark',
      style:             '1',
      locale:            'en',
      toolbar_bg:        '#0a1020',
      enable_publishing: false,
      hide_top_toolbar:  false,
      hide_legend:       false,
      save_image:        false,
      backgroundColor:   'rgba(8,15,30,1)',
      gridColor:         'rgba(255,255,255,0.03)',
      container_id:      'tv_chart_container',
      studies:           ['RSI@tv-basicstudies','MACD@tv-basicstudies'],
      overrides: {
        'paneProperties.background':           '#080f1e',
        'paneProperties.backgroundType':       'solid',
        'scalesProperties.textColor':          '#64748b',
        'mainSeriesProperties.candleStyle.upColor':      '#34d399',
        'mainSeriesProperties.candleStyle.downColor':    '#f43f5e',
        'mainSeriesProperties.candleStyle.borderUpColor':'#34d399',
        'mainSeriesProperties.candleStyle.borderDownColor':'#f43f5e',
        'mainSeriesProperties.candleStyle.wickUpColor':  '#34d399',
        'mainSeriesProperties.candleStyle.wickDownColor':'#f43f5e',
      },
    });

    const container = document.createElement('div');
    container.className = 'tradingview-widget-container__widget';
    container.style.height = '100%';
    container.style.width  = '100%';
    containerRef.current.appendChild(container);
    containerRef.current.appendChild(script);

    return () => {
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [tvSymbol]);

  return (
    <div ref={containerRef} style={{ width:'100%', height:'100%' }}
      className="tradingview-widget-container" />
  );
}

// ── Fallback mini chart ────────────────────────────────────
function MiniChart({ candles, change24h }) {
  if (!candles?.length) return (
    <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>
      Loading chart...
    </div>
  );
  const color = change24h >= 0 ? T.green : T.red;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={candles} margin={{ top:4, right:0, left:0, bottom:0 }}>
        <defs>
          <linearGradient id="trd-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor={color} stopOpacity={0.2}/>
            <stop offset="100%" stopColor={color} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false}/>
        <XAxis dataKey="t" hide/>
        <YAxis hide domain={['auto','auto']}/>
        <Tooltip contentStyle={{ background:'rgba(3,7,18,0.97)', border:`1px solid ${color}30`, borderRadius:6, ...mono, fontSize:10 }}
          formatter={v => [`${parseFloat(v).toLocaleString(undefined,{maximumFractionDigits:5})}`, 'Price']} labelFormatter={() => ''}/>
        <Area type="monotone" dataKey="close" stroke={color} strokeWidth={1.5}
          fill="url(#trd-grad)" dot={false}
          activeDot={{ r:3, fill:color, stroke:'var(--surface)', strokeWidth:2 }}/>
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Price Ticker ──────────────────────────────────────────
function PriceTicker({ ticker, loading, isForex, isCommodity, onAlertClick }) {
  const up = ticker?.change24h >= 0;
  if (loading && !ticker) return (
    <div style={{ display:'flex', gap:20, alignItems:'center' }}>
      <Sk w={140} h={36}/><Sk w={80} h={20}/><Sk w={160} h={16}/>
    </div>
  );
  if (!ticker) return null;
  // Forex needs more decimal precision (e.g. 1.08432) than crypto's $/¢
  // display; commodities (gold, oil...) are quoted more like crypto — 2dp.
  const priceDecimals = isCommodity ? 2 : isForex ? 5 : (ticker.price > 1 ? 2 : 6);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:24, flexWrap:'wrap' }}>
      <div style={{ ...mono, fontSize:34, fontWeight:800, color:T.cyan, letterSpacing:'-1px' }}>
        {isForex ? '' : '$'}{ticker.price?.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:priceDecimals })}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
        <span style={{ ...mono, fontSize:13, fontWeight:700, color: up ? T.green : T.red }}>
          {up?'+':''}{ticker.change24h?.toFixed(2)}% 24h
        </span>
        {(ticker.high24h != null && ticker.low24h != null) && (
          <span style={{ ...mono, fontSize:10, color:T.slate }}>
            H: {isForex ? '' : '$'}{ticker.high24h?.toLocaleString(undefined,{maximumFractionDigits:priceDecimals})} · L: {isForex ? '' : '$'}{ticker.low24h?.toLocaleString(undefined,{maximumFractionDigits:priceDecimals})}
          </span>
        )}
      </div>
      {!isForex && !isCommodity && (
        <div style={{ display:'flex', gap:20, ...mono, fontSize:10, color:T.slate }}>
          <span>Vol: <span style={{ color:'var(--text)' }}>${(ticker.quoteVol/1e6)?.toFixed(1)}M</span></span>
          <span>Bid: <span style={{ color:T.green }}>${ticker.bid?.toLocaleString()}</span></span>
          <span>Ask: <span style={{ color:T.red  }}>${ticker.ask?.toLocaleString()}</span></span>
        </div>
      )}
      {(isForex || isCommodity) && ticker.bid != null && (
        <div style={{ display:'flex', gap:20, ...mono, fontSize:10, color:T.slate }}>
          <span>Bid: <span style={{ color:T.green }}>{ticker.bid?.toFixed(priceDecimals)}</span></span>
          <span>Ask: <span style={{ color:T.red  }}>{ticker.ask?.toFixed(priceDecimals)}</span></span>
        </div>
      )}
      <button onClick={onAlertClick} style={{
        marginLeft:'auto', ...mono, fontSize:10, padding:'6px 12px', borderRadius:7, cursor:'pointer',
        border:'1px solid rgba(0,245,212,0.25)', background:'rgba(0,245,212,0.06)', color:T.cyan,
      }}>
        🔔 Alert
      </button>
    </div>
  );
}

// ── Position Size Calculator ──────────────────────────────
// Risk-based sizing: given account balance, a risk % of that balance,
// and the distance to a stop-loss price, suggests how much quantity to
// trade so that hitting the stop only costs the chosen risk %.
function PositionCalculator({ curPrice, quoteBalance, quoteCcy, isForex, isCommodity, onApply }) {
  const [riskPct, setRiskPct] = useState('1');
  const [entry,   setEntry]   = useState('');
  const [stop,    setStop]    = useState('');

  useEffect(() => {
    if (curPrice) setEntry(prev => prev || curPrice.toString());
  }, [curPrice]);

  const dp = isCommodity ? 2 : isForex ? 5 : 2;
  const entryN = parseFloat(entry) || 0;
  const stopN  = parseFloat(stop)  || 0;
  const riskN  = parseFloat(riskPct) || 0;
  const dist   = Math.abs(entryN - stopN);

  const riskAmount   = quoteBalance * (riskN / 100);
  const suggestedQty = dist > 0 ? riskAmount / dist : 0;

  return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10, padding:14, display:'flex', flexDirection:'column', gap:10 }}>
      <Label>📐 Position Size Calculator</Label>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        <div>
          <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:4 }}>RISK %</div>
          <input type="number" value={riskPct} onChange={e => setRiskPct(e.target.value)}
            style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:6, padding:'6px 8px', color:'var(--text)', ...mono, fontSize:11 }} />
        </div>
        <div>
          <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:4 }}>ENTRY</div>
          <input type="number" value={entry} onChange={e => setEntry(e.target.value)}
            style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:6, padding:'6px 8px', color:'var(--text)', ...mono, fontSize:11 }} />
        </div>
        <div style={{ gridColumn:'1 / -1' }}>
          <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:4 }}>STOP-LOSS PRICE</div>
          <input type="number" value={stop} onChange={e => setStop(e.target.value)}
            placeholder={entryN ? (entryN * 0.98).toFixed(dp) : '0.00'}
            style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:6, padding:'6px 8px', color:'var(--text)', ...mono, fontSize:11 }} />
        </div>
      </div>

      {dist > 0 && riskAmount > 0 && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', background:'rgba(0,245,212,0.05)', border:'1px solid rgba(0,245,212,0.15)', borderRadius:8, padding:'8px 12px' }}>
          <div>
            <div style={{ ...mono, fontSize:8, color:T.slate }}>RISKING {quoteCcy} {riskAmount.toFixed(2)}</div>
            <div style={{ ...mono, fontSize:13, fontWeight:800, color:T.cyan }}>
              {suggestedQty.toFixed(isForex || isCommodity ? 0 : 6)} units
            </div>
          </div>
          <button onClick={() => onApply(suggestedQty, stop)} style={{
            ...mono, fontSize:9, padding:'6px 12px', borderRadius:6, cursor:'pointer',
            border:'1px solid rgba(0,245,212,0.35)', background:'rgba(0,245,212,0.1)', color:T.cyan,
          }}>
            Use size →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Order Form ────────────────────────────────────────────
function OrderForm({ exchange, symbol, ticker, balance, isForex, isCommodity, quoteCcy, onOrderPlaced }) {
  const [side,      setSide]      = useState('buy');
  const [orderType, setOrderType] = useState('market');
  const [quantity,  setQuantity]  = useState('');
  const [price,     setPrice]     = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [stopLoss,  setStopLoss]  = useState('');
  const [takeProfit,setTakeProfit]= useState('');
  const [showBracket, setShowBracket] = useState(false);
  const [showCalc,  setShowCalc]  = useState(false);

  // ── Read pre-fill from SignalModal "Trade this Signal" ──
  // Trading page stores ?side=&entry=&sl=&tp= in sessionStorage
  // so we can read it here after the form mounts.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('aq_prefill');
      if (!raw) return;
      const pf = JSON.parse(raw);
      sessionStorage.removeItem('aq_prefill'); // consume once
      if (pf.side  && ['buy','sell'].includes(pf.side)) setSide(pf.side);
      if (pf.sl)    { setStopLoss(pf.sl);    setShowBracket(true); }
      if (pf.tp)    { setTakeProfit(pf.tp);  setShowBracket(true); }
      // entry → use as limit price if not market
      if (pf.entry) setPrice(pf.entry);
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [pct,       setPct]       = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState('');
  const [confirm,   setConfirm]   = useState(null);

  const curPrice    = ticker?.price || 0;
  const qty         = parseFloat(quantity) || 0;
  const lim         = parseFloat(price) || curPrice;
  const total       = qty * (orderType === 'market' ? curPrice : lim);
  const isForexAcct = isForex || isCommodity;
  // Forex/Commodity/OANDA has no per-instrument spot balance — quick-%
  // buttons use the account's available balance/margin for both directions.
  const quoteBalance = balance?.find(b => b.symbol === quoteCcy)?.free || 0;
  const symBalance   = balance?.find(b => b.symbol === symbol)?.free || 0;
  const priceDp      = isCommodity ? 2 : isForex ? 5 : 2;

  const applyPct = (p) => {
    setPct(p);
    if (isForexAcct) {
      const amt = (quoteBalance * p / 100) / (lim || curPrice || 1);
      setQuantity(Math.max(Math.round(amt), 0).toString());
      return;
    }
    if (side === 'buy') {
      const amt = (quoteBalance * p / 100) / (lim || curPrice || 1);
      setQuantity(amt.toFixed(6));
    } else {
      setQuantity((symBalance * p / 100).toFixed(6));
    }
  };

  const applyCalcSize = (suggestedQty, stopVal) => {
    setQuantity(isForexAcct ? Math.round(suggestedQty).toString() : suggestedQty.toFixed(6));
    if (stopVal) { setStopLoss(stopVal); setShowBracket(true); }
    setPct(null);
    setShowCalc(false);
  };

  const handlePreSubmit = () => {
    setError('');
    if (!quantity || parseFloat(quantity) <= 0) { setError(isForexAcct ? 'Enter units' : 'Enter quantity'); return; }
    if (orderType !== 'market' && !price)        { setError('Enter limit price'); return; }
    if (orderType === 'stop_limit' && !stopPrice){ setError('Enter stop price'); return; }

    const refPrice = orderType === 'market' ? curPrice : parseFloat(price);
    if (stopLoss && refPrice) {
      const sl = parseFloat(stopLoss);
      if (side === 'buy'  && sl >= refPrice) { setError('Stop-loss must be below entry price'); return; }
      if (side === 'sell' && sl <= refPrice) { setError('Stop-loss must be above entry price'); return; }
    }
    if (takeProfit && refPrice) {
      const tp = parseFloat(takeProfit);
      if (side === 'buy'  && tp <= refPrice) { setError('Take-profit must be above entry price'); return; }
      if (side === 'sell' && tp >= refPrice) { setError('Take-profit must be below entry price'); return; }
    }

    setConfirm({
      exchangeId: exchange.id,
      symbol:     isForexAcct ? symbol : `${symbol}USDT`,
      baseSymbol: symbol,
      side, orderType,
      quantity:   parseFloat(quantity),
      price:      orderType !== 'market' ? parseFloat(price) : undefined,
      stopPrice:  orderType === 'stop_limit' ? parseFloat(stopPrice) : undefined,
      stopLoss:   stopLoss   ? parseFloat(stopLoss)   : undefined,
      takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
      total, isForex, isCommodity, quoteCcy,
    });
  };

  const handleConfirm = async () => {
    setLoading(true);
    try {
      const res = await api.post('/trading/order', confirm);
      if (res.data.success) {
        setResult({ mode: res.data.mode, order: res.data.order, warning: res.data.warning });
        setQuantity(''); setPrice(''); setStopPrice(''); setStopLoss(''); setTakeProfit(''); setPct(null);
        onOrderPlaced?.();
        setConfirm(null);
        setTimeout(() => setResult(null), 5000);
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Order failed');
      setConfirm(null);
    } finally { setLoading(false); }
  };

  const isReadonly = exchange?.mode === 'readonly';

  const inputStyle = {
    width:'100%', boxSizing:'border-box',
    background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)',
    borderRadius:8, padding:'10px 14px',
    color:'var(--text)', ...mono, fontSize:13,
  };

  return (
    <>
      {confirm && (
        <ConfirmModal
          order={confirm}
          exchange={exchange}
          onConfirm={handleConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

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

        <div style={{ display:'flex', background:'rgba(255,255,255,0.03)', borderRadius:8, padding:3, gap:2 }}>
          {ORDER_TYPES.map(t => (
            <button key={t} onClick={() => setOrderType(t)} style={{
              flex:1, padding:'6px 0', borderRadius:6, cursor:'pointer', border:'none',
              ...mono, fontSize:9, letterSpacing:'.06em', textTransform:'uppercase',
              background: orderType===t ? 'rgba(0,245,212,0.1)' : 'transparent',
              color: orderType===t ? T.cyan : T.slate, transition:'all .15s',
            }}>
              {t.replace('_',' ')}
            </button>
          ))}
        </div>

        {orderType === 'stop_limit' && (
          <div>
            <Label style={{ marginBottom:7 }}>Stop Price ({quoteCcy})</Label>
            <input className="aq-t-input" type="number" value={stopPrice}
              onChange={e => setStopPrice(e.target.value)}
              placeholder={curPrice ? (curPrice * 0.97).toFixed(priceDp) : '0.00'}
              style={inputStyle} />
          </div>
        )}

        {orderType !== 'market' && (
          <div>
            <Label style={{ marginBottom:7 }}>{orderType==='stop_limit'?'Limit Price':'Price'} ({quoteCcy})</Label>
            <input className="aq-t-input" type="number" value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder={curPrice?.toFixed(priceDp) || '0.00'}
              style={inputStyle} />
          </div>
        )}

        {orderType === 'market' && curPrice > 0 && (
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', background:'rgba(255,255,255,0.02)', borderRadius:8, padding:'8px 12px' }}>
            <Label>Market Price</Label>
            <span style={{ ...mono, fontSize:13, color:T.cyan, fontWeight:700 }}>
              {isForex ? '' : '$'}{curPrice.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits: priceDp })}
            </span>
          </div>
        )}

        <div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:7 }}>
            <Label>{isForexAcct ? `Units (${symbol})` : `Amount (${symbol})`}</Label>
            {!isForexAcct && side==='sell' && symBalance > 0 && (
              <span style={{ ...mono, fontSize:9, color:T.slate }}>
                Avail: <span style={{ color:'var(--text)', cursor:'pointer' }} onClick={() => applyPct(100)}>{symBalance.toFixed(6)} {symbol}</span>
              </span>
            )}
            {(isForexAcct || side==='buy') && quoteBalance > 0 && (
              <span style={{ ...mono, fontSize:9, color:T.slate }}>
                Avail: <span style={{ color:'var(--text)' }}>{quoteBalance.toLocaleString('en-US', { maximumFractionDigits:2 })} {quoteCcy}</span>
              </span>
            )}
          </div>
          <input className="aq-t-input" type="number" value={quantity}
            onChange={e => { setQuantity(e.target.value); setPct(null); }}
            placeholder={isForexAcct ? '1000' : '0.00000000'} style={inputStyle} />
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5 }}>
          {[25,50,75,100].map(p => (
            <button key={p} onClick={() => applyPct(p)} style={{
              padding:'5px 0', borderRadius:6, cursor:'pointer',
              ...mono, fontSize:9, fontWeight:700,
              border:`1px solid ${pct===p ? 'rgba(0,245,212,0.4)' : 'var(--border)'}`,
              background: pct===p ? 'rgba(0,245,212,0.1)' : 'transparent',
              color: pct===p ? T.cyan : T.slate, transition:'all .15s',
            }}>
              {p}%
            </button>
          ))}
        </div>

        {/* ── Stop-Loss / Take-Profit (bracket) ── */}
        <button onClick={() => setShowBracket(v => !v)} style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'transparent', border:'none', cursor:'pointer', padding:0,
          ...mono, fontSize:10, color: (stopLoss || takeProfit) ? T.cyan : T.slate,
        }}>
          <span>{showBracket ? '▾' : '▸'} Stop-Loss / Take-Profit {(stopLoss || takeProfit) ? '●' : ''}</span>
        </button>

        {showBracket && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <div>
              <div style={{ ...mono, fontSize:8, color:T.red, marginBottom:5 }}>STOP-LOSS</div>
              <input className="aq-t-input" type="number" value={stopLoss}
                onChange={e => setStopLoss(e.target.value)}
                placeholder={curPrice ? (curPrice * (side==='buy'?0.98:1.02)).toFixed(priceDp) : '0.00'}
                style={{ ...inputStyle, borderColor: stopLoss ? 'rgba(244,63,94,0.3)' : 'var(--border)' }} />
            </div>
            <div>
              <div style={{ ...mono, fontSize:8, color:T.green, marginBottom:5 }}>TAKE-PROFIT</div>
              <input className="aq-t-input" type="number" value={takeProfit}
                onChange={e => setTakeProfit(e.target.value)}
                placeholder={curPrice ? (curPrice * (side==='buy'?1.02:0.98)).toFixed(priceDp) : '0.00'}
                style={{ ...inputStyle, borderColor: takeProfit ? 'rgba(52,211,153,0.3)' : 'var(--border)' }} />
            </div>
          </div>
        )}

        {/* ── Position size calculator ── */}
        <button onClick={() => setShowCalc(v => !v)} style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'transparent', border:'none', cursor:'pointer', padding:0,
          ...mono, fontSize:10, color:T.slate,
        }}>
          <span>{showCalc ? '▾' : '▸'} 📐 Position Size Calculator</span>
        </button>
        {showCalc && (
          <PositionCalculator
            curPrice={curPrice} quoteBalance={quoteBalance} quoteCcy={quoteCcy}
            isForex={isForex} isCommodity={isCommodity} onApply={applyCalcSize}
          />
        )}

        {qty > 0 && (
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
            background: side==='buy' ? 'rgba(52,211,153,0.04)' : 'rgba(244,63,94,0.04)',
            border:`1px solid ${side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)'}`,
            borderRadius:8, padding:'10px 14px' }}>
            <Label>Total</Label>
            <span style={{ ...mono, fontSize:14, fontWeight:800, color: side==='buy'?T.green:T.red }}>
              {isForex ? '' : '$'}{total.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}{isForexAcct ? ` ${quoteCcy}` : ''}
            </span>
          </div>
        )}

        {error && (
          <div style={{ ...mono, fontSize:10, color:T.red, background:'rgba(244,63,94,0.06)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:8, padding:'9px 12px', animation:'aq-shake .3s ease' }}>
            ✕ {error}
          </div>
        )}

        {result && (
          <div className="aq-order-flash" style={{ display:'flex', flexDirection:'column', gap:4 }}>
            <div style={{ ...mono, fontSize:10, color:T.green, background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:8, padding:'9px 12px' }}>
              ✓ {result.mode === 'paper' ? '📄 Paper' : '⚡ Live'} order placed — {result.order?.symbol || symbol}
            </div>
            {result.warning && (
              <div style={{ ...mono, fontSize:9, color:T.amber, background:'rgba(245,158,11,0.06)', border:'1px solid rgba(245,158,11,0.2)', borderRadius:8, padding:'8px 12px' }}>
                ⚠ {result.warning}
              </div>
            )}
          </div>
        )}

        <button onClick={handlePreSubmit} disabled={loading || isReadonly} style={{
          width:'100%', padding:14, borderRadius:10,
          cursor: (loading || isReadonly) ? 'not-allowed' : 'pointer',
          border:`1px solid ${side==='buy' ? 'rgba(52,211,153,0.4)' : 'rgba(244,63,94,0.4)'}`,
          background: isReadonly ? 'rgba(100,116,139,0.1)' : side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)',
          color: isReadonly ? T.slate : side==='buy' ? T.green : T.red,
          fontFamily:'Syne,sans-serif', fontSize:14, fontWeight:800, letterSpacing:'.04em',
          opacity: loading ? 0.7 : 1, transition:'all .15s',
        }}
          onMouseEnter={e => { if (!loading && !isReadonly) e.currentTarget.style.background = side==='buy' ? 'rgba(52,211,153,0.2)' : 'rgba(244,63,94,0.2)'; }}
          onMouseLeave={e => { if (!isReadonly) e.currentTarget.style.background = side==='buy' ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.12)'; }}
        >
          {isReadonly ? '🔒 Read-Only Mode' : loading ? '⟳ Placing...' : `${side==='buy'?'↑ Buy':'↓ Sell'} ${symbol}`}
        </button>

        {exchange && (
          <div style={{ textAlign:'center', ...mono, fontSize:9, color:T.slate }}>
            {exchange.name} ·{' '}
            <span style={{ color: exchange.mode==='live' ? T.red : exchange.mode==='paper' ? T.cyan : T.slate, fontWeight:700 }}>
              {(exchange.mode || 'readonly').toUpperCase()}
            </span>
            {exchange.mode === 'paper' && <span style={{ color:T.slate }}> — Simulated{isForexAcct ? ' (OANDA practice)' : ''}</span>}
            {exchange.mode === 'live'  && <span style={{ color:T.red   }}> — Real funds</span>}
          </div>
        )}
      </div>
    </>
  );
}

// ── Orders Panel ──────────────────────────────────────────

// ── Live P&L calculator ───────────────────────────────────
// Called per open paper trade — fetches current price once per symbol
// using the already-polling ticker state passed down from the parent,
// so no extra API calls are needed.
function useLivePnl(orders, prices) {
  return orders.map(o => {
    if (o.mode !== 'paper' || o.status !== 'open') return o;
    const cur = prices[o.symbol] ?? prices[o.symbol?.replace('USDT','')]
              ?? prices[(o.symbol||'').replace(/USDT$/,'')];
    if (!cur || !o.price) return { ...o, livePnl: null, livePnlPct: null };
    const entry = parseFloat(o.price);
    const qty   = parseFloat(o.quantity);
    const pnl   = o.side === 'buy' ? (cur - entry) * qty : (entry - cur) * qty;
    const pct   = (pnl / (entry * qty)) * 100;
    return { ...o, livePnl: pnl, livePnlPct: pct, currentPrice: cur };
  });
}

// ── Journal Stats ─────────────────────────────────────────
function JournalStats({ orders }) {
  const closed = orders.filter(o => o.status === 'closed' && o.pnl != null);
  if (!closed.length) return null;

  const wins    = closed.filter(o => parseFloat(o.pnl) > 0);
  const losses  = closed.filter(o => parseFloat(o.pnl) < 0);
  const totalPnl = closed.reduce((s, o) => s + parseFloat(o.pnl), 0);
  const winRate  = Math.round((wins.length / closed.length) * 100);
  const avgWin   = wins.length   ? wins.reduce((s,o) => s + parseFloat(o.pnl), 0) / wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s,o) => s + parseFloat(o.pnl), 0) / losses.length : 0;
  const bestTrade = closed.reduce((best, o) => parseFloat(o.pnl) > parseFloat(best?.pnl ?? -Infinity) ? o : best, null);
  const profitFactor = losses.length && avgLoss !== 0 ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length)) : null;

  const stats = [
    { label: 'Total P&L',      value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,      color: totalPnl >= 0 ? T.green : T.red },
    { label: 'Win Rate',       value: `${winRate}%`,                                               color: winRate >= 50 ? T.green : T.red },
    { label: 'Trades',         value: closed.length,                                               color: 'var(--text)' },
    { label: 'Avg Win',        value: `+$${avgWin.toFixed(2)}`,                                   color: T.green },
    { label: 'Avg Loss',       value: `$${avgLoss.toFixed(2)}`,                                   color: T.red },
    { label: 'Profit Factor',  value: profitFactor != null ? profitFactor.toFixed(2) : '—',       color: profitFactor >= 1.5 ? T.green : profitFactor < 1 ? T.red : T.amber },
  ];

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
        {stats.map(({ label, value, color }) => (
          <div key={label} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>
            <div style={{ ...mono, fontSize:8, color:T.slate, marginBottom:3, textTransform:'uppercase', letterSpacing:'.1em' }}>{label}</div>
            <div style={{ ...mono, fontSize:12, fontWeight:800, color }}>{value}</div>
          </div>
        ))}
      </div>
      {bestTrade && (
        <div style={{ background:'rgba(52,211,153,0.04)', border:'1px solid rgba(52,211,153,0.15)', borderRadius:8, padding:'8px 12px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ ...mono, fontSize:9, color:T.slate }}>🏆 Best trade</span>
          <span style={{ ...mono, fontSize:10, fontWeight:800, color:T.green }}>
            {bestTrade.symbol} +${parseFloat(bestTrade.pnl).toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Signal Badge (for OrderForm header) ──────────────────
// Fetches the latest signal for the currently selected symbol from
// /api/signals and shows it as a badge above the order form.
// Only fetches when symbol changes — not on every tick.
function useSymbolSignal(symbol, isOandaAccount) {
  const [signal, setSignal] = useState(null);

  useEffect(() => {
    if (!symbol) return;
    setSignal(null);
    // Map trading symbol to signals table format
    const sigSym = isOandaAccount
      ? symbol.replace('_', '/')          // EUR_USD → EUR/USD
      : symbol.replace(/USDT$/, '') + '/USDT'; // BTC → BTC/USDT (or raw BTC)
    // Try both formats
    api.get(`/api/signals?symbol=${encodeURIComponent(sigSym)}&limit=1`)
      .then(res => {
        const s = res.data?.signals?.[0] || res.data?.[0];
        if (s && s.signal !== 'HOLD') setSignal(s);
      })
      .catch(() => {
        // Try raw symbol (crypto without /USDT)
        api.get(`/api/signals?symbol=${encodeURIComponent(symbol)}&limit=1`)
          .then(res => {
            const s = res.data?.signals?.[0] || res.data?.[0];
            if (s && s.signal !== 'HOLD') setSignal(s);
          }).catch(() => {});
      });
  }, [symbol, isOandaAccount]);

  return signal;
}

function SignalBadge({ signal }) {
  if (!signal) return null;
  const isBuy  = signal.signal === 'BUY';
  const color  = isBuy ? T.green : T.red;
  const bg     = isBuy ? 'rgba(52,211,153,0.08)' : 'rgba(244,63,94,0.08)';
  const border = isBuy ? 'rgba(52,211,153,0.25)' : 'rgba(244,63,94,0.25)';

  return (
    <div style={{
      display:'flex', alignItems:'center', gap:8,
      background: bg, border:`1px solid ${border}`,
      borderRadius:8, padding:'8px 12px',
    }}>
      <span style={{ fontSize:13 }}>{isBuy ? '⚡' : '⚡'}</span>
      <div style={{ flex:1 }}>
        <div style={{ ...mono, fontSize:10, fontWeight:800, color }}>
          {signal.signal} Signal — {signal.confidence}% confidence
        </div>
        {signal.entry && (
          <div style={{ ...mono, fontSize:9, color:T.slate, marginTop:2 }}>
            Entry: {parseFloat(signal.entry).toLocaleString()}
            {signal.stop_loss   && ` · SL: ${parseFloat(signal.stop_loss).toLocaleString()}`}
            {signal.take_profit && ` · TP: ${parseFloat(signal.take_profit).toLocaleString()}`}
          </div>
        )}
      </div>
      <span style={{ ...mono, fontSize:8, color:T.slate }}>
        {signal.created_at ? new Date(signal.created_at).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : ''}
      </span>
    </div>
  );
}

// ── Orders Panel (with Live P&L + Journal) ────────────────
function OrdersPanel({ exchangeId, refresh, prices }) {
  const [orders,        setOrders]        = useState([]);
  const [tab,           setTab]           = useState('open');
  const [loading,       setLoading]       = useState(true);
  const [pendingCancel, setPendingCancel] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!exchangeId) return;
    if (!silent) setLoading(true);
    try {
      const res = await api.get(`/trading/orders?exchangeId=${exchangeId}&status=${tab === 'journal' ? 'closed' : tab}`);
      if (res.data.success) setOrders(res.data.orders || []);
    } catch {} finally { if (!silent) setLoading(false); }
  }, [exchangeId, tab]);

  useEffect(() => { load(); }, [load, refresh]);

  // Poll open orders every 10s for Live P&L refresh
  useEffect(() => {
    if (tab !== 'open') return;
    const iv = setInterval(() => {
      if (!document.hidden) load(true);
    }, 10000);
    return () => clearInterval(iv);
  }, [tab, load]);

  const requestCancel = (order) => setPendingCancel(order);

  const confirmCancel = async () => {
    const order = pendingCancel;
    if (!order) return;
    try {
      const symQs = order.symbol ? `&symbol=${encodeURIComponent(order.symbol)}` : '';
      await api.delete(`/trading/orders/${order.id || order.exchange_order_id}?exchangeId=${exchangeId}&mode=${order.mode}${symQs}`);
      load();
    } catch {} finally { setPendingCancel(null); }
  };

  const enrichedOrders = useLivePnl(orders, prices || {});
  const sideColor = s => s === 'buy' ? T.green : T.red;

  const TABS = ['open', 'closed', 'journal'];

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
      {pendingCancel && (
        <CancelConfirmModal
          order={pendingCancel}
          onConfirm={confirmCancel}
          onCancel={() => setPendingCancel(null)}
        />
      )}

      {/* Tab bar */}
      <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.05)', marginBottom:14 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...mono, fontSize:9, letterSpacing:'.12em', textTransform:'uppercase',
            background:'none', border:'none', cursor:'pointer', padding:'8px 14px 8px 0',
            color: tab===t ? 'var(--text)' : T.slate,
            borderBottom: tab===t ? `2px solid ${T.cyan}` : '2px solid transparent',
            marginBottom:-1, fontWeight: tab===t ? 700 : 400,
          }}>{t === 'journal' ? '📒 Journal' : t}</button>
        ))}
        {tab === 'open' && (
          <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:5, ...mono, fontSize:8, color:T.slate, opacity:.6 }}>
            <span style={{ width:5, height:5, borderRadius:'50%', background:T.green, animation:'aq-pulse 1.6s infinite' }} />
            live
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[1,2,3].map(i => <Sk key={i} h={48}/>)}
        </div>
      ) : (

        /* ── Journal tab ── */
        tab === 'journal' ? (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            <JournalStats orders={orders} />
            {orders.filter(o => o.pnl != null).length === 0 ? (
              <div style={{ textAlign:'center', padding:'24px 0', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>
                No closed trades yet
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:5, maxHeight:380, overflowY:'auto' }}>
                {orders.filter(o => o.pnl != null).map((o, i) => {
                  const pnl    = parseFloat(o.pnl);
                  const pnlPct = parseFloat(o.pnl_pct || 0);
                  const isWin  = pnl > 0;
                  return (
                    <div key={i} className="aq-t-row" style={{
                      display:'flex', flexDirection:'column', gap:4, padding:'10px 8px',
                      borderRadius:8, background:'rgba(255,255,255,0.01)',
                      borderLeft: `2px solid ${isWin ? T.green : T.red}`,
                    }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ ...mono, fontSize:9, fontWeight:800, color:sideColor(o.side) }}>
                          {(o.side||'').toUpperCase()}
                        </span>
                        <span style={{ ...mono, fontSize:11, fontWeight:700, color:'var(--text)' }}>{o.symbol}</span>
                        <span style={{ ...mono, fontSize:9, color:T.slate }}>× {parseFloat(o.quantity).toFixed(4)}</span>
                        <span style={{ ...mono, fontSize:11, fontWeight:800, color: isWin ? T.green : T.red, marginLeft:'auto' }}>
                          {isWin ? '+' : ''}${pnl.toFixed(2)}
                          <span style={{ fontSize:9, fontWeight:400, marginLeft:4, color: isWin ? T.green : T.red, opacity:.8 }}>
                            ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                          </span>
                        </span>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                        <span style={{ ...mono, fontSize:8, color:T.slate }}>
                          Entry: ${parseFloat(o.price).toLocaleString()}
                        </span>
                        <span style={{ ...mono, fontSize:8, color:T.slate }}>
                          {o.close_reason === 'stop_loss' ? '🛑 SL hit' : o.close_reason === 'take_profit' ? '🎯 TP hit' : '✋ Manual'}
                          {' · '}{o.closed_at ? new Date(o.closed_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) : ''}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        ) : orders.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px 0', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>
            No {tab} orders
          </div>
        ) : (

          /* ── Open / Closed tabs ── */
          <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:420, overflowY:'auto' }}>
            {enrichedOrders.map((o, i) => (
              <div key={i} className="aq-t-row" style={{ display:'flex', flexDirection:'column', gap:6, padding:'10px 8px', borderRadius:8, background:'rgba(255,255,255,0.01)', cursor:'default' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ ...mono, fontSize:9, fontWeight:800, padding:'2px 8px', borderRadius:4,
                    color:sideColor(o.side), background:`${sideColor(o.side)}15`, border:`1px solid ${sideColor(o.side)}30` }}>
                    {(o.side||'').toUpperCase()}
                  </span>
                  <span style={{ ...mono, fontSize:11, fontWeight:700, color:'var(--text)' }}>{o.symbol}</span>
                  <span style={{ ...mono, fontSize:9, color:T.slate }}>× {parseFloat(o.quantity).toFixed(4)}</span>
                  <span style={{ ...mono, fontSize:8, marginLeft:'auto', color: o.mode==='paper' ? T.cyan : T.red }}>
                    {o.mode==='paper' ? '📄' : '⚡'} {o.mode}
                  </span>
                </div>

                {/* Live P&L row — only for open paper trades */}
                {tab === 'open' && o.livePnl != null && (
                  <div style={{
                    display:'flex', alignItems:'center', justifyContent:'space-between',
                    background: o.livePnl >= 0 ? 'rgba(52,211,153,0.05)' : 'rgba(244,63,94,0.05)',
                    border:`1px solid ${o.livePnl >= 0 ? 'rgba(52,211,153,0.15)' : 'rgba(244,63,94,0.15)'}`,
                    borderRadius:6, padding:'5px 10px',
                  }}>
                    <span style={{ ...mono, fontSize:9, color:T.slate }}>
                      Live P&L @ {parseFloat(o.currentPrice).toLocaleString('en-US', { maximumFractionDigits:4 })}
                    </span>
                    <span style={{ ...mono, fontSize:11, fontWeight:800, color: o.livePnl >= 0 ? T.green : T.red }}>
                      {o.livePnl >= 0 ? '+' : ''}${o.livePnl.toFixed(2)}
                      <span style={{ fontSize:9, fontWeight:400, marginLeft:4 }}>
                        ({o.livePnlPct >= 0 ? '+' : ''}{o.livePnlPct.toFixed(2)}%)
                      </span>
                    </span>
                  </div>
                )}

                {(o.stop_loss || o.take_profit) && (
                  <div style={{ display:'flex', gap:8, ...mono, fontSize:8 }}>
                    {o.stop_loss   && <span style={{ color:T.red   }}>🛑 SL {parseFloat(o.stop_loss).toLocaleString()}</span>}
                    {o.take_profit && <span style={{ color:T.green }}>🎯 TP {parseFloat(o.take_profit).toLocaleString()}</span>}
                  </div>
                )}

                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ ...mono, fontSize:9, color:T.slate }}>
                    {(o.order_type||'').replace('_',' ')}
                    {o.price ? ` · $${parseFloat(o.price).toLocaleString()}` : ' · Market'}
                  </span>
                  {tab === 'open' ? (
                    <button onClick={() => requestCancel(o)} style={{ ...mono, fontSize:9, padding:'3px 10px', borderRadius:5, cursor:'pointer', border:'1px solid rgba(244,63,94,0.2)', background:'rgba(244,63,94,0.06)', color:T.red }}>
                      Cancel
                    </button>
                  ) : (
                    <span style={{ ...mono, fontSize:10, fontWeight:700, color: o.pnl != null ? (parseFloat(o.pnl)>=0?T.green:T.red) : T.slate }}>
                      {o.pnl != null ? `${parseFloat(o.pnl)>=0?'+':''}$${parseFloat(o.pnl).toFixed(2)}` : o.status}
                      {o.close_reason && o.close_reason !== 'manual' && (
                        <span style={{ marginLeft:6, color:T.slate, fontWeight:400 }}>
                          ({o.close_reason === 'stop_loss' ? '🛑 SL' : o.close_reason === 'take_profit' ? '🎯 TP' : o.close_reason})
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ── Main Trading Page ─────────────────────────────────────
export default function Trading() {
  const [connections,   setConnections]   = useState({});
  const [selectedExId,  setSelectedExId]  = useState('');
  const [instrumentTab, setInstrumentTab] = useState('forex');
  const [symbol,        setSymbol]        = useState('BTC');
  const [symbolInput,   setSymbolInput]   = useState('BTC');
  const [ticker,        setTicker]        = useState(null);
  const [candles,       setCandles]       = useState([]);
  const [balance,       setBalance]       = useState([]);
  const [tickerLoading, setTickerLoading] = useState(false);
  const [ordersRefresh, setOrdersRefresh] = useState(0);
  const [chartMode,     setChartMode]     = useState('tradingview');
  const [showAlert,     setShowAlert]     = useState(false);
  // prices map: { 'BTC': 62000, 'BTCUSDT': 62000, 'ETH': 1700, ... }
  // fed into OrdersPanel for Live P&L computation without extra fetches.
  const [prices,        setPrices]        = useState({});

  const isOandaAccount = selectedExId === 'oanda';
  const isCommodity     = isOandaAccount && COMMODITY_SYMBOLS.includes(symbol);
  const isForex         = isOandaAccount && !isCommodity;
  const quoteCcy        = isOandaAccount ? (balance?.[0]?.symbol || 'USD') : 'USDT';
  const priceDp         = isCommodity ? 2 : isForex ? 5 : (ticker?.price > 1 ? 2 : 6);

  // Signal badge for the current symbol
  const symbolSignal = useSymbolSignal(symbol, isOandaAccount);

  useEffect(() => { injectStyles(); }, []);

  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const prefill = params.get('symbol');
    if (prefill) {
      const clean = prefill.toUpperCase().replace('/','').replace(/USDT$/,'').replace(/[^A-Z0-9]/g,'');
      if (clean) { setSymbol(clean); setSymbolInput(clean); }
    }
    // Pre-fill from SignalModal "Trade this Signal":
    // ?side=buy&entry=1.416&sl=1.41&tp=1.425
    // Stored in sessionStorage so OrderForm reads after mount.
    const side  = params.get('side');
    const entry = params.get('entry');
    const sl    = params.get('sl');
    const tp    = params.get('tp');
    if (side || entry || sl || tp) {
      sessionStorage.setItem('aq_prefill', JSON.stringify({ side, entry, sl, tp }));
    }
  }, []);

  useEffect(() => {
    if (!selectedExId) return;
    const symbolLooksOanda = symbol.includes('_');
    if (isOandaAccount && !symbolLooksOanda) {
      setInstrumentTab('forex');
      setSymbol('EUR_USD'); setSymbolInput('EUR_USD');
    } else if (!isOandaAccount && symbolLooksOanda) {
      setSymbol('BTC'); setSymbolInput('BTC');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExId]);

  const switchInstrumentTab = (tab) => {
    setInstrumentTab(tab);
    const first = tab === 'forex' ? FOREX_SYMBOLS[0] : COMMODITY_SYMBOLS[0];
    setSymbol(first); setSymbolInput(first);
  };

  useEffect(() => {
    api.get('/exchanges/connections')
      .then(res => {
        const conns = res.data || {};
        setConnections(conns);
        const first = Object.keys(conns)[0];
        if (first) setSelectedExId(first);
      }).catch(() => {});
  }, []);

  const fetchTicker = useCallback(async (sym, exId) => {
    if (!sym) return;
    setTickerLoading(true);
    try {
      const qs  = exId === 'oanda' ? '?exchangeId=oanda' : '';
      const res = await api.get(`/trading/ticker/${sym}${qs}`);
      if (res.data.success) {
        setTicker(res.data.ticker);
        setCandles(res.data.candles || []);
        // Update prices map so Live P&L stays current without extra calls
        const p = res.data.ticker?.price;
        if (p) {
          setPrices(prev => ({
            ...prev,
            [sym]: p,
            [`${sym}USDT`]: p,
            [sym.replace('_','/')]: p,
          }));
        }
      }
    } catch { setTicker(null); }
    finally { setTickerLoading(false); }
  }, []);

  useEffect(() => {
    fetchTicker(symbol, selectedExId);
    const iv = setInterval(() => fetchTicker(symbol, selectedExId), 15000);
    return () => clearInterval(iv);
  }, [symbol, selectedExId, fetchTicker]);

  useEffect(() => {
    if (!selectedExId) return;
    api.get(`/trading/balance?exchangeId=${selectedExId}`)
      .then(res => { if (res.data.success) setBalance(res.data.balances || []); })
      .catch(() => {});
  }, [selectedExId, ordersRefresh]);

  const connectedExchanges = EXCHANGES.filter(e => connections[e.id]);
  const selectedEx = selectedExId ? {
    ...EXCHANGES.find(e => e.id === selectedExId),
    mode: connections[selectedExId]?.mode,
  } : null;

  const isReadonly = selectedEx?.mode === 'readonly';

  const panel = {
    background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16,
  };

  if (Object.keys(connections).length === 0) return (
    <div style={{ ...panel, padding:64, textAlign:'center', animation:'aq-fadein .4s ease' }}>
      <div style={{ fontSize:36, marginBottom:16, opacity:.3 }}>◈</div>
      <div style={{ fontSize:16, fontWeight:700, color:'var(--text)', marginBottom:8 }}>No exchanges connected</div>
      <div style={{ ...mono, fontSize:11, color:T.slate, marginBottom:24 }}>Connect a crypto exchange or OANDA (forex/commodities) to start trading</div>
      <a href="/exchanges" style={{ ...mono, fontSize:11, padding:'8px 20px', borderRadius:8, border:'1px solid rgba(0,245,212,0.3)', background:'rgba(0,245,212,0.06)', color:T.cyan, textDecoration:'none' }}>
        Go to Exchanges →
      </a>
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14, animation:'aq-fadein .35s ease' }}>

      {showAlert && (
        <QuickAlertModal
          symbol={symbol} currentPrice={ticker?.price} priceDp={priceDp}
          onClose={() => setShowAlert(false)}
        />
      )}

      {isReadonly && <ReadonlyBanner exchangeName={selectedEx?.name} />}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ ...mono, fontSize:10, letterSpacing:'.2em', textTransform:'uppercase', color:T.slate, marginBottom:4 }}>// Live Trading</div>
          <div style={{ ...mono, fontSize:11, color:'var(--text)' }}>
            {connectedExchanges.length} exchange{connectedExchanges.length!==1?'s':''} connected
          </div>
        </div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          {connectedExchanges.map(ex => {
            const isSelected = selectedExId === ex.id;
            const mode       = connections[ex.id]?.mode;
            return (
              <button key={ex.id} className="aq-ex-btn" onClick={() => setSelectedExId(ex.id)} style={{
                display:'flex', alignItems:'center', gap:7, padding:'7px 14px',
                borderRadius:9, cursor:'pointer', transition:'all .15s',
                border:`1px solid ${isSelected ? ex.color+'50' : 'var(--border)'}`,
                background: isSelected ? `${ex.color}12` : 'transparent',
              }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:ex.color, boxShadow: isSelected ? `0 0 6px ${ex.color}` : 'none' }}/>
                <span style={{ ...mono, fontSize:10, fontWeight: isSelected?700:400, color: isSelected?ex.color:T.slate }}>{ex.name}</span>
                <span style={{ ...mono, fontSize:8, color: mode==='live'?T.red : mode==='paper'?T.cyan : T.slate }}>
                  {mode?.toUpperCase()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'300px 1fr 270px', gap:14, alignItems:'start' }}>

        {/* ── Left: Symbol picker + Order form ── */}
        <div style={{ ...panel, padding:22, display:'flex', flexDirection:'column', gap:14 }}>

          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
              <Label>{isCommodity ? 'Commodity' : isForex ? 'Instrument' : 'Symbol'}</Label>
              {isOandaAccount && (
                <div style={{ display:'flex', gap:4 }}>
                  {['forex','commodity'].map(t => (
                    <button key={t} onClick={() => switchInstrumentTab(t)} style={{
                      ...mono, fontSize:8, padding:'3px 8px', borderRadius:5, cursor:'pointer',
                      border:`1px solid ${instrumentTab===t ? 'rgba(0,245,212,0.35)' : 'var(--border)'}`,
                      background: instrumentTab===t ? 'rgba(0,245,212,0.1)' : 'transparent',
                      color: instrumentTab===t ? T.cyan : T.slate, textTransform:'uppercase',
                    }}>
                      {t === 'forex' ? 'Forex' : 'Commodities'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ position:'relative' }}>
              <input className="aq-t-input" value={symbolInput}
                onChange={e => setSymbolInput(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key==='Enter') { const s = isOandaAccount ? symbolInput.toUpperCase().replace(/[^A-Z0-9_]/g,'') : symbolInput.toUpperCase().replace(/[^A-Z0-9]/g,''); if(s){setSymbol(s);} }}}
                placeholder={isCommodity ? 'XAU_USD, XAG_USD...' : isForex ? 'EUR_USD, GBP_USD...' : 'BTC, ETH, SOL...'}
                style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:8, padding:'9px 50px 9px 36px', color:'var(--text)', ...mono, fontSize:13 }}
              />
              <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', ...mono, fontSize:12, color:T.slate }}>⌕</span>
              <button onClick={() => { const s = isOandaAccount ? symbolInput.toUpperCase().replace(/[^A-Z0-9_]/g,'') : symbolInput.toUpperCase().replace(/[^A-Z0-9]/g,''); if(s) setSymbol(s); }}
                style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', ...mono, fontSize:9, padding:'3px 8px', borderRadius:5, border:'1px solid rgba(0,245,212,0.2)', background:'rgba(0,245,212,0.06)', color:T.cyan, cursor:'pointer' }}>
                GO
              </button>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginTop:8 }}>
              {(isOandaAccount ? (instrumentTab === 'forex' ? FOREX_SYMBOLS : COMMODITY_SYMBOLS) : POPULAR_SYMBOLS).slice(0,10).map(s => (
                <button key={s} className="aq-sym-pill" onClick={() => { setSymbol(s); setSymbolInput(s); }}
                  title={COMMODITY_LABELS[s] || ''}
                  style={{ ...mono, fontSize:9, padding:'2px 8px', borderRadius:4, cursor:'pointer', transition:'all .15s',
                    border:`1px solid ${symbol===s?'rgba(0,245,212,0.35)':'var(--border)'}`,
                    background: symbol===s?'rgba(0,245,212,0.1)':'transparent',
                    color: symbol===s?T.cyan:T.slate }}>
                  {isCommodity && COMMODITY_LABELS[s] ? COMMODITY_LABELS[s] : s.replace('_','/')}
                </button>
              ))}
            </div>
          </div>

          {/* Signal badge — shows above the form only when a BUY/SELL signal exists */}
          {symbolSignal && <SignalBadge signal={symbolSignal} />}

          <Divider/>

          {selectedEx ? (
            <OrderForm
              exchange={selectedEx}
              symbol={symbol}
              ticker={ticker}
              balance={balance}
              isForex={isForex}
              isCommodity={isCommodity}
              quoteCcy={quoteCcy}
              onOrderPlaced={() => setOrdersRefresh(r => r+1)}
            />
          ) : (
            <div style={{ textAlign:'center', padding:'24px 0', ...mono, fontSize:11, color:T.slate }}>Select an exchange</div>
          )}
        </div>

        {/* ── Center: Ticker + Chart + Balance ── */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          <div style={{ ...panel, padding:'18px 22px' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ ...mono, fontSize:22, fontWeight:800, color:'var(--text)' }}>
                  {isOandaAccount ? symbol.replace('_','/') : symbol}
                </div>
                {!isOandaAccount && <div style={{ ...mono, fontSize:11, color:T.slate }}>/USDT</div>}
                {isCommodity && <div style={{ ...mono, fontSize:11, color:T.slate }}>{COMMODITY_LABELS[symbol]}</div>}
              </div>
              <div style={{ display:'flex', gap:6 }}>
                {['tradingview','simple'].map(m => (
                  <button key={m} onClick={() => setChartMode(m)} style={{
                    ...mono, fontSize:9, padding:'4px 10px', borderRadius:6, cursor:'pointer',
                    border:`1px solid ${chartMode===m?'rgba(0,245,212,0.3)':'var(--border)'}`,
                    background: chartMode===m?'rgba(0,245,212,0.08)':'transparent',
                    color: chartMode===m?T.cyan:T.slate,
                  }}>
                    {m === 'tradingview' ? 'TradingView' : 'Simple'}
                  </button>
                ))}
              </div>
            </div>
            <PriceTicker ticker={ticker} loading={tickerLoading && !ticker} isForex={isForex} isCommodity={isCommodity}
              onAlertClick={() => setShowAlert(true)} />
          </div>

          <div style={{ ...panel, padding: chartMode==='tradingview' ? 0 : '18px 22px', overflow:'hidden', height: chartMode==='tradingview' ? 520 : 280 }}>
            {chartMode === 'tradingview' ? (
              <TradingViewChart symbol={symbol} exchange={selectedExId} isForex={isForex} isCommodity={isCommodity} />
            ) : (
              <>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                  <Label>Price Chart (1h · 24 candles)</Label>
                  <button onClick={() => fetchTicker(symbol, selectedExId)} style={{ ...mono, fontSize:9, padding:'3px 10px', borderRadius:5, border:'1px solid var(--border)', background:'transparent', color:T.slate, cursor:'pointer' }}>
                    ↻ Refresh
                  </button>
                </div>
                <div style={{ height:220 }}>
                  <MiniChart candles={candles} change24h={ticker?.change24h}/>
                </div>
              </>
            )}
          </div>

          {balance.filter(b => b.total > 0).length > 0 && (
            <div style={{ ...panel, padding:'16px 22px' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                <Label>Balance — {selectedEx?.name}</Label>
                {selectedEx?.mode === 'paper' && (
                  <span style={{ ...mono, fontSize:9, color:T.cyan, background:'rgba(0,245,212,0.08)', border:'1px solid rgba(0,245,212,0.15)', padding:'2px 8px', borderRadius:4 }}>
                    📄 Simulated{isOandaAccount ? ' (OANDA practice)' : ''}
                  </span>
                )}
              </div>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                {balance.filter(b => b.total > 0).slice(0,8).map((b, i) => (
                  <div key={i} style={{ background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', minWidth:90 }}>
                    <div style={{ ...mono, fontSize:9, color:T.slate, marginBottom:4 }}>{b.symbol}</div>
                    <div style={{ ...mono, fontSize:14, fontWeight:700, color:'var(--text)' }}>
                      {b.total >= 1000
                        ? b.total.toLocaleString('en-US', { maximumFractionDigits:2 })
                        : b.total.toFixed(b.total < 0.001 ? 6 : 4)}
                    </div>
                    {b.locked > 0 && <div style={{ ...mono, fontSize:9, color:T.slate }}>🔒 {b.locked.toFixed(4)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: Orders Panel ── */}
        <div style={{ ...panel, padding:'18px 20px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
            <Label>Orders & Journal</Label>
            <button onClick={() => setOrdersRefresh(r => r+1)} style={{ ...mono, fontSize:9, padding:'3px 8px', borderRadius:5, border:'1px solid var(--border)', background:'transparent', color:T.slate, cursor:'pointer' }}>
              ↻
            </button>
          </div>
          {selectedExId ? (
            <OrdersPanel exchangeId={selectedExId} refresh={ordersRefresh} prices={prices} />
          ) : (
            <div style={{ textAlign:'center', padding:'24px 0', ...mono, fontSize:11, color:T.slate, opacity:.5 }}>Select exchange</div>
          )}
        </div>
      </div>
    </div>
  );
}