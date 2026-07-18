import { useState, useEffect } from 'react';
import api from '../services/api';

const mono = { fontFamily: 'JetBrains Mono,monospace' };

const EXCHANGES = [
  { id:'binance',  name:'Binance',           type:'CEX', region:'Global', logo:'◈', color:'#F3BA2F', desc:"World's largest crypto exchange by volume",      features:['Spot','Futures','Margin','WebSocket'], fields:[{key:'apiKey',label:'API Key',placeholder:'Binance API key...'},{key:'apiSecret',label:'Secret Key',placeholder:'Binance secret key...',secret:true}] },
  { id:'bybit',    name:'Bybit',             type:'CEX', region:'Global', logo:'⬡', color:'#F7A600', desc:'Derivatives & spot trading platform',             features:['Spot','Perpetuals','Options','WebSocket'], fields:[{key:'apiKey',label:'API Key',placeholder:'Bybit API key...'},{key:'apiSecret',label:'API Secret',placeholder:'Bybit secret key...',secret:true}] },
  { id:'okx',      name:'OKX',               type:'CEX', region:'Global', logo:'◆', color:'#00D4AA', desc:'Multi-asset: spot, futures, DeFi',                features:['Spot','Futures','Options','DeFi'], fields:[{key:'apiKey',label:'API Key',placeholder:'OKX API key...'},{key:'apiSecret',label:'Secret Key',placeholder:'OKX secret key...',secret:true},{key:'passphrase',label:'Passphrase',placeholder:'OKX passphrase...',secret:true}] },
  { id:'kucoin',   name:'KuCoin',            type:'CEX', region:'Global', logo:'◍', color:'#23AF91', desc:"The People's Exchange — 700+ assets",             features:['Spot','Margin','Futures','Lending'], fields:[{key:'apiKey',label:'API Key',placeholder:'KuCoin API key...'},{key:'apiSecret',label:'API Secret',placeholder:'KuCoin secret key...',secret:true},{key:'passphrase',label:'Passphrase',placeholder:'KuCoin passphrase...',secret:true}] },
  { id:'kraken',   name:'Kraken',            type:'CEX', region:'US/EU',  logo:'✦', color:'#5741D9', desc:'Regulated exchange, fiat on-ramps, staking',      features:['Spot','Futures','Staking','REST'], fields:[{key:'apiKey',label:'API Key',placeholder:'Kraken API key...'},{key:'apiSecret',label:'Private Key',placeholder:'Kraken private key...',secret:true}] },
  { id:'coinbase', name:'Coinbase Advanced',  type:'CEX', region:'US',    logo:'◉', color:'#1652F0', desc:'US-regulated, advanced trading API',               features:['Spot','Perpetuals','FIX API','WebSocket'], fields:[{key:'apiKey',label:'API Key',placeholder:'Coinbase API key...'},{key:'apiSecret',label:'API Secret',placeholder:'Coinbase secret...',secret:true},{key:'passphrase',label:'Passphrase',placeholder:'Passphrase...',secret:true}] },
  { id:'bitget',   name:'Bitget',            type:'CEX', region:'Global', logo:'◐', color:'#00CED1', desc:'Copy trading & futures specialist',                features:['Spot','Futures','Copy Trading','WebSocket'], fields:[{key:'apiKey',label:'API Key',placeholder:'Bitget API key...'},{key:'apiSecret',label:'Secret Key',placeholder:'Bitget secret key...',secret:true},{key:'passphrase',label:'Passphrase',placeholder:'Bitget passphrase...',secret:true}] },
  { id:'mexc',     name:'MEXC',              type:'CEX', region:'Global', logo:'◑', color:'#00B4D8', desc:'Low-fee exchange with 1500+ trading pairs',        features:['Spot','Futures','ETF','WebSocket'], fields:[{key:'apiKey',label:'API Key',placeholder:'MEXC API key...'},{key:'apiSecret',label:'Secret Key',placeholder:'MEXC secret key...',secret:true}] },
  { id:'gate',     name:'Gate.io',           type:'CEX', region:'Global', logo:'⬟', color:'#E85D04', desc:'1700+ assets, early-stage listings',               features:['Spot','Futures','Options','Lending'], fields:[{key:'apiKey',label:'API Key',placeholder:'Gate.io API key...'},{key:'apiSecret',label:'Secret Key',placeholder:'Gate.io secret key...',secret:true}] },
  { id:'htx',      name:'HTX (Huobi)',       type:'CEX', region:'Global', logo:'◎', color:'#2196F3', desc:'Legacy exchange, deep liquidity, 500+ pairs',      features:['Spot','Futures','Swap','Options'], fields:[{key:'apiKey',label:'Access Key',placeholder:'HTX access key...'},{key:'apiSecret',label:'Secret Key',placeholder:'HTX secret key...',secret:true}] },
  { id:'phemex',   name:'Phemex',            type:'CEX', region:'Global', logo:'⬢', color:'#9B59B6', desc:'Ultra-low latency, institutional-grade API',       features:['Spot','Perpetuals','Options','WebSocket'], fields:[{key:'apiKey',label:'API Key',placeholder:'Phemex API key...'},{key:'apiSecret',label:'API Secret',placeholder:'Phemex secret key...',secret:true}] },
  { id:'bitmex',   name:'BitMEX',            type:'CEX', region:'Global', logo:'⬣', color:'#FF4757', desc:'OG derivatives exchange, perpetual swaps',         features:['Perpetuals','Futures','Options','REST'], fields:[{key:'apiKey',label:'API Key',placeholder:'BitMEX API key...'},{key:'apiSecret',label:'API Secret',placeholder:'BitMEX secret key...',secret:true}] },
  { id:'oanda',    name:'OANDA',             type:'Forex/CFD', region:'Global', logo:'⬢', color:'#0090D4', desc:'Forex majors, gold & silver — free demo + live API', features:['Forex','Metals','Indices','REST'], fields:[{key:'apiKey',label:'Account ID',placeholder:'e.g. 101-004-12345678-001'},{key:'apiSecret',label:'Personal Access Token',placeholder:'OANDA API token...',secret:true}] },
];

const MODES = [
  { id: 'readonly', label: 'Read Only',     icon: '◎', color: '#64748b', desc: 'View balances & positions. No trading.' },
  { id: 'paper',    label: 'Paper Trading', icon: '◈', color: '#00f5d4', desc: 'Simulate trades with real prices. Zero risk.' },
  { id: 'live',     label: 'Live Trading',  icon: '⚡', color: '#f87171', desc: 'Real orders on the exchange. Real money.' },
];

function FeaturePill({ label }) {
  return (
    <span style={{ ...mono, fontSize:9, padding:'2px 7px', borderRadius:4, background:'rgba(0,245,212,0.06)', color:'var(--text-muted)', border:'1px solid rgba(0,245,212,0.1)' }}>
      {label}
    </span>
  );
}

function ModeBadge({ mode }) {
  const m = MODES.find(x => x.id === mode) || MODES[0];
  return (
    <span style={{ ...mono, fontSize:9, padding:'2px 9px', borderRadius:5, fontWeight:700,
      background: `${m.color}15`, color: m.color, border:`1px solid ${m.color}35` }}>
      {m.icon} {m.label.toUpperCase()}
    </span>
  );
}

function ModeSelector({ selected, onChange, isOanda }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {MODES.map(m => (
        <div
          key={m.id}
          onClick={() => onChange(m.id)}
          style={{
            display:'flex', alignItems:'center', gap:12, padding:'11px 14px', borderRadius:9, cursor:'pointer',
            border: `1px solid ${selected === m.id ? m.color + '50' : 'var(--border)'}`,
            background: selected === m.id ? `${m.color}0e` : 'rgba(255,255,255,0.02)',
            transition: 'all .15s',
          }}
        >
          <div style={{
            width:16, height:16, borderRadius:'50%', flexShrink:0,
            border: `2px solid ${selected === m.id ? m.color : 'var(--border)'}`,
            background: selected === m.id ? m.color : 'transparent',
            display:'flex', alignItems:'center', justifyContent:'center',
            transition:'all .15s',
          }}>
            {selected === m.id && <div style={{ width:6, height:6, borderRadius:'50%', background:'#000' }} />}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ ...mono, fontSize:11, fontWeight:700, color: selected === m.id ? m.color : 'var(--text-secondary)', marginBottom:2 }}>
              {m.icon} {m.label}
            </div>
            <div style={{ fontSize:11, color:'var(--text-muted)' }}>
              {isOanda && m.id === 'paper' ? 'Free OANDA practice account — virtual funds, real live prices.' : m.desc}
              {isOanda && m.id === 'live'  ? ' Requires a funded OANDA live account.' : ''}
            </div>
          </div>
        </div>
      ))}
      {selected === 'live' && (
        <div style={{ ...mono, fontSize:10, color:'#f87171', background:'rgba(248,113,113,0.06)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:8, padding:'8px 12px' }}>
          ⚠ Live mode executes real orders with real funds. Use with caution.
        </div>
      )}
    </div>
  );
}

function ConnectModal({ exchange, onClose, onConnected }) {
  const [values,   setValues]   = useState({});
  const [revealed, setRevealed] = useState({});
  const [mode,     setMode]     = useState('readonly');
  const [step,     setStep]     = useState(1);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState(false);

  const isOanda = exchange.id === 'oanda';
  const set = (k, v) => setValues(p => ({ ...p, [k]: v }));
  const allFilled = exchange.fields.every(f => (values[f.key] || '').trim());

  const handleConnect = async () => {
    setError(''); setLoading(true);
    try {
      await api.post('/exchanges/connect', { exchange: exchange.id, credentials: values, mode });
      setSuccess(true);
      setTimeout(() => { onConnected(exchange.id, mode); onClose(); }, 1200);
    } catch (err) {
      setError(err?.response?.data?.message || 'Connection failed. Check your credentials.');
    } finally { setLoading(false); }
  };

  return (
    <div
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(14px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background:'#080f1e', border:`1px solid ${exchange.color}30`, borderRadius:20, padding:32, width:500, boxShadow:`0 0 60px ${exchange.color}15, 0 32px 64px rgba(0,0,0,0.7)` }}>

        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:24 }}>
          <div style={{ width:48, height:48, borderRadius:12, background:`${exchange.color}15`, border:`1px solid ${exchange.color}35`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, color:exchange.color }}>
            {exchange.logo}
          </div>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:'var(--text-primary)', marginBottom:3 }}>Connect {exchange.name}</div>
            <div style={{ ...mono, fontSize:10, color:'var(--text-muted)' }}>{exchange.desc}</div>
          </div>
          <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
            {[1,2].map(s => (
              <div key={s} style={{ width:24, height:24, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', ...mono, fontSize:10, fontWeight:700,
                background: step >= s ? `${exchange.color}20` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${step >= s ? exchange.color + '60' : 'var(--border)'}`,
                color: step >= s ? exchange.color : 'var(--text-muted)',
              }}>{s}</div>
            ))}
          </div>
        </div>

        {step === 1 ? (
          <>
            <div style={{ display:'flex', gap:10, alignItems:'flex-start', background:'rgba(0,245,212,0.04)', border:'1px solid rgba(0,245,212,0.1)', borderRadius:10, padding:'10px 14px', marginBottom:20 }}>
              <span style={{ color:'var(--cyan)', fontSize:12, flexShrink:0 }}>⚡</span>
              <p style={{ ...mono, fontSize:10, color:'var(--text-muted)', margin:0, lineHeight:1.6 }}>
                {isOanda
                  ? <>Generate a token from <span style={{ color:'var(--cyan)' }}>My Account → Manage API Access</span> on your OANDA account. Use a practice (demo) account ID/token for risk-free testing. Keys encrypted AES-256.</>
                  : <>Enable <span style={{ color:'var(--cyan)' }}>Read + Trade</span> only — never withdrawals. Keys encrypted AES-256.</>
                }
              </p>
            </div>

            <div style={{ display:'flex', flexDirection:'column', gap:13, marginBottom:22 }}>
              {exchange.fields.map(f => (
                <div key={f.key}>
                  <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:7 }}>{f.label}</div>
                  <div style={{ position:'relative' }}>
                    <input
                      type={f.secret && !revealed[f.key] ? 'password' : 'text'}
                      value={values[f.key] || ''}
                      onChange={e => set(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      autoComplete="off"
                      style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:9, padding: f.secret ? '10px 44px 10px 14px' : '10px 14px', color:'var(--text-primary)', ...mono, fontSize:12, outline:'none' }}
                      onFocus={e => e.target.style.borderColor = `${exchange.color}60`}
                      onBlur={e  => e.target.style.borderColor = 'var(--border)'}
                    />
                    {f.secret && (
                      <button onClick={() => setRevealed(r => ({ ...r, [f.key]: !r[f.key] }))}
                        style={{ position:'absolute', right:12, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', ...mono, fontSize:9 }}>
                        {revealed[f.key] ? 'HIDE' : 'SHOW'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {isOanda && (
              <div style={{ ...mono, fontSize:9, color:'var(--text-muted)', marginBottom:16, lineHeight:1.6 }}>
                Don't have an account? <a href="https://www.oanda.com" target="_blank" rel="noreferrer" style={{ color:'var(--cyan)' }}>Sign up for free at oanda.com</a> — demo accounts are instant and free.
              </div>
            )}

            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setStep(2)} disabled={!allFilled}
                style={{ flex:1, padding:12, borderRadius:9, border:`1px solid ${exchange.color}50`, background:`${exchange.color}12`, color:exchange.color, fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor: allFilled ? 'pointer' : 'not-allowed', opacity: allFilled ? 1 : 0.4 }}>
                Next →
              </button>
              <button onClick={onClose} style={{ padding:'12px 20px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ ...mono, fontSize:9, letterSpacing:'.15em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:12 }}>Select Mode</div>
            <div style={{ marginBottom:22 }}>
              <ModeSelector selected={mode} onChange={setMode} isOanda={isOanda} />
            </div>

            {error && (
              <div style={{ ...mono, fontSize:10, color:'var(--red)', background:'rgba(248,113,113,0.06)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:8, padding:'9px 13px', marginBottom:14 }}>
                ✕ {error}
              </div>
            )}
            {success && (
              <div style={{ ...mono, fontSize:10, color:'var(--green)', background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:8, padding:'9px 13px', marginBottom:14 }}>
                ✓ Connected in {mode} mode!
              </div>
            )}

            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setStep(1)} style={{ padding:'12px 16px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
                ← Back
              </button>
              <button onClick={handleConnect} disabled={loading || success}
                style={{ flex:1, padding:12, borderRadius:9, border:`1px solid ${exchange.color}50`, background:`${exchange.color}12`, color:exchange.color, fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
                {loading ? 'Connecting...' : success ? '✓ Done' : `Connect ${exchange.name}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChangeModeModal({ exchange, currentMode, onClose, onChanged }) {
  const [mode,    setMode]    = useState(currentMode);
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (mode === currentMode) return onClose();
    setLoading(true);
    try {
      await api.patch(`/exchanges/${exchange.id}/mode`, { mode });
      onChanged(exchange.id, mode);
      onClose();
    } catch (err) {
      console.error(err);
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(14px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background:'#080f1e', border:'1px solid rgba(0,245,212,0.15)', borderRadius:20, padding:32, width:440 }}>
        <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)', marginBottom:20 }}>
          Change Mode — {exchange.name}
        </div>
        <ModeSelector selected={mode} onChange={setMode} isOanda={exchange.id === 'oanda'} />
        <div style={{ display:'flex', gap:10, marginTop:22 }}>
          <button onClick={handleSave} disabled={loading}
            style={{ flex:1, padding:12, borderRadius:9, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {loading ? 'Saving...' : 'Save Mode'}
          </button>
          <button onClick={onClose} style={{ padding:'12px 20px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function DisconnectModal({ exchange, onClose, onDisconnected }) {
  const [loading, setLoading] = useState(false);
  const handle = async () => {
    setLoading(true);
    try { await api.delete(`/exchanges/${exchange.id}`); onDisconnected(exchange.id); onClose(); }
    catch { setLoading(false); }
  };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(14px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background:'#080f1e', border:'1px solid rgba(248,113,113,0.2)', borderRadius:20, padding:32, width:400 }}>
        <div style={{ textAlign:'center', marginBottom:24 }}>
          <div style={{ fontSize:28, marginBottom:12 }}>⚠</div>
          <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)', marginBottom:8 }}>Disconnect {exchange.name}?</div>
          <div style={{ ...mono, fontSize:11, color:'var(--text-muted)', lineHeight:1.6 }}>
            Credentials will be permanently removed. Active automations on this exchange will stop.
          </div>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={handle} disabled={loading}
            style={{ flex:1, padding:12, borderRadius:9, border:'1px solid rgba(248,113,113,0.3)', background:'rgba(248,113,113,0.08)', color:'var(--red)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {loading ? 'Removing...' : 'Disconnect'}
          </button>
          <button onClick={onClose} style={{ padding:'12px 20px', borderRadius:9, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'Syne,sans-serif', fontSize:13, cursor:'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── NOUVEAU : Balance / Portfolio Modal ──────────────────────
// Appelle GET /:exchangeId/portfolio (déjà géré backend, jamais exposé
// côté UI avant). Gère les 2 formats de réponse possibles :
//   - mode live/readonly (crypto) → { mode, positions: [{symbol,free,locked,total}] }
//   - mode paper (crypto)          → { mode:'paper', positions: [paper_trades rows] }
//   - OANDA (n'importe quel mode)  → { mode, positions:[{symbol:'USD',free,locked,total}] }
function BalanceModal({ exchange, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [data,    setData]    = useState(null);

  useEffect(() => {
    api.get(`/exchanges/${exchange.id}/portfolio`)
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.message || 'Failed to load balance'))
      .finally(() => setLoading(false));
  }, [exchange.id]);

  const isPaperTrades = data?.mode === 'paper' && Array.isArray(data.positions) && data.positions[0]?.symbol === undefined;

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(14px)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background:'#080f1e', border:`1px solid ${exchange.color}30`, borderRadius:20, padding:32, width:460, maxHeight:'75vh', display:'flex', flexDirection:'column' }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:20 }}>
          <div style={{ width:40, height:40, borderRadius:10, background:`${exchange.color}15`, border:`1px solid ${exchange.color}35`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:exchange.color }}>
            {exchange.logo}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>{exchange.name} Balance</div>
            {data?.mode && <div style={{ ...mono, fontSize:9, color:'var(--text-muted)', textTransform:'uppercase' }}>{data.mode} mode</div>}
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:16 }}>×</button>
        </div>

        <div style={{ overflowY:'auto', flex:1 }}>
          {loading && (
            <div style={{ ...mono, fontSize:11, color:'var(--text-muted)', textAlign:'center', padding:'32px 0' }}>Loading balance...</div>
          )}

          {!loading && error && (
            <div style={{ ...mono, fontSize:10, color:'var(--red)', background:'rgba(248,113,113,0.06)', border:'1px solid rgba(248,113,113,0.2)', borderRadius:8, padding:'12px 14px' }}>
              ✕ {error}
            </div>
          )}

          {!loading && !error && data && (!data.positions || data.positions.length === 0) && (
            <div style={{ ...mono, fontSize:11, color:'var(--text-muted)', textAlign:'center', padding:'32px 0' }}>
              No balances or open positions found.
            </div>
          )}

          {!loading && !error && data?.positions?.length > 0 && !isPaperTrades && (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {data.positions.map(p => (
                <div key={p.symbol} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9 }}>
                  <span style={{ ...mono, fontSize:12, fontWeight:700, color:'var(--text-primary)' }}>{p.symbol}</span>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ ...mono, fontSize:12, color:'var(--cyan)' }}>{parseFloat(p.total).toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
                    {parseFloat(p.locked) > 0 && (
                      <div style={{ ...mono, fontSize:9, color:'var(--text-muted)' }}>
                        {parseFloat(p.free).toLocaleString(undefined, { maximumFractionDigits: 6 })} free · {parseFloat(p.locked).toLocaleString(undefined, { maximumFractionDigits: 6 })} locked
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && isPaperTrades && (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {data.positions.map(t => (
                <div key={t.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9 }}>
                  <div>
                    <span style={{ ...mono, fontSize:12, fontWeight:700, color:'var(--text-primary)' }}>{t.symbol}</span>
                    <span style={{ ...mono, fontSize:9, padding:'2px 6px', borderRadius:4, marginLeft:8, background: t.side === 'buy' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: t.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>
                      {t.side.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ ...mono, fontSize:11, color:'var(--text-secondary)' }}>
                    {t.quantity} @ {parseFloat(t.price).toLocaleString(undefined, { maximumFractionDigits: 5 })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExchangeCard({ exchange, connected, onConnect, onDisconnect, onChangeMode, onViewBalance }) {
  const isConnected = !!connected;
  const modeInfo = MODES.find(m => m.id === connected?.mode) || MODES[0];

  // ── NOUVEAU : état local du bouton "Test Connection" ──
  const [testState, setTestState] = useState('idle'); // idle | testing | ok | fail
  const [testMsg,    setTestMsg]  = useState('');

  const handleTest = async (e) => {
    e.stopPropagation();
    setTestState('testing'); setTestMsg('');
    try {
      const res = await api.post(`/exchanges/${exchange.id}/test`);
      setTestState('ok');
      setTestMsg(res.data?.message || 'Connection verified');
    } catch (err) {
      setTestState('fail');
      setTestMsg(err?.response?.data?.message || 'Verification failed');
    } finally {
      setTimeout(() => setTestState('idle'), 4000);
    }
  };

  return (
    <div
      style={{ background:'var(--surface)', border:`1px solid ${isConnected ? exchange.color + '30' : 'var(--border)'}`, borderRadius:16, padding:'20px 22px', display:'flex', flexDirection:'column', gap:14, transition:'border-color .2s, box-shadow .2s', boxShadow: isConnected ? `0 0 24px ${exchange.color}10` : 'none' }}
      onMouseEnter={e => { if (!isConnected) e.currentTarget.style.borderColor = `${exchange.color}25`; }}
      onMouseLeave={e => { if (!isConnected) e.currentTarget.style.borderColor = 'var(--border)'; }}
    >
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ width:40, height:40, borderRadius:10, flexShrink:0, background:`${exchange.color}12`, border:`1px solid ${exchange.color}25`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:exchange.color }}>
          {exchange.logo}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
            <div style={{ width:7, height:7, borderRadius:'50%', flexShrink:0, background: isConnected ? 'var(--green)' : 'rgba(100,116,139,0.4)', boxShadow: isConnected ? '0 0 6px var(--green)' : 'none' }} />
            <span style={{ fontSize:14, fontWeight:700, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{exchange.name}</span>
          </div>
          <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
            <span style={{ ...mono, fontSize:9, padding:'1px 6px', borderRadius:3, background:'rgba(100,116,139,0.1)', color:'var(--text-muted)', border:'1px solid rgba(100,116,139,0.15)' }}>{exchange.type}</span>
            <span style={{ ...mono, fontSize:9, padding:'1px 6px', borderRadius:3, background:'rgba(100,116,139,0.1)', color:'var(--text-muted)', border:'1px solid rgba(100,116,139,0.15)' }}>{exchange.region}</span>
          </div>
        </div>
        {isConnected && <ModeBadge mode={connected.mode} />}
      </div>

      <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.5 }}>{exchange.desc}</div>

      <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
        {exchange.features.map(f => <FeaturePill key={f} label={f} />)}
      </div>

      {isConnected && (
        <div style={{ ...mono, fontSize:10, color:'var(--text-muted)', display:'flex', gap:16, flexWrap:'wrap' }}>
          <span>Since: <span style={{ color:'var(--text-secondary)' }}>{connected.connectedAt}</span></span>
          {connected.lastSync && connected.lastSync !== '—' && (
            <span>Synced: <span style={{ color:'var(--cyan)' }}>{connected.lastSync}</span></span>
          )}
        </div>
      )}

      {/* ── NOUVEAU : résultat du Test Connection ── */}
      {testState !== 'idle' && (
        <div style={{
          ...mono, fontSize:10, padding:'7px 11px', borderRadius:7,
          background: testState === 'testing' ? 'rgba(148,163,184,0.08)' : testState === 'ok' ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
          color: testState === 'testing' ? 'var(--text-muted)' : testState === 'ok' ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${testState === 'testing' ? 'var(--border)' : testState === 'ok' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
        }}>
          {testState === 'testing' ? '⟳ Testing connection...' : testState === 'ok' ? `✓ ${testMsg}` : `✕ ${testMsg}`}
        </div>
      )}

      {isConnected ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => onViewBalance(exchange)}
              style={{ flex:1, ...mono, padding:'8px 0', borderRadius:8, border:'1px solid rgba(0,245,212,0.25)', background:'rgba(0,245,212,0.06)', color:'var(--cyan)', fontSize:10, cursor:'pointer', transition:'all .15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,245,212,0.14)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,245,212,0.06)'; }}>
              ◈ View Balance
            </button>
            <button onClick={handleTest} disabled={testState === 'testing'}
              style={{ flex:1, ...mono, padding:'8px 0', borderRadius:8, border:'1px solid var(--border)', background:'rgba(255,255,255,0.02)', color:'var(--text-secondary)', fontSize:10, cursor: testState === 'testing' ? 'not-allowed' : 'pointer', opacity: testState === 'testing' ? 0.6 : 1, transition:'all .15s' }}>
              {testState === 'testing' ? '⟳ Testing...' : '⚡ Test Connection'}
            </button>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => onChangeMode(exchange, connected.mode)}
              style={{ flex:1, ...mono, padding:'8px 0', borderRadius:8, border:`1px solid ${modeInfo.color}35`, background:`${modeInfo.color}08`, color:modeInfo.color, fontSize:10, cursor:'pointer', transition:'all .15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = `${modeInfo.color}18`; }}
              onMouseLeave={e => { e.currentTarget.style.background = `${modeInfo.color}08`; }}>
              ◈ Change Mode
            </button>
            <button onClick={() => onDisconnect(exchange)}
              style={{ flex:1, ...mono, padding:'8px 0', borderRadius:8, border:'1px solid rgba(248,113,113,0.2)', background:'rgba(248,113,113,0.05)', color:'var(--red)', fontSize:10, cursor:'pointer', transition:'all .15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.1)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.05)'; }}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => onConnect(exchange)}
          style={{ ...mono, width:'100%', padding:'9px 0', borderRadius:8, border:`1px solid ${exchange.color}35`, background:`${exchange.color}0D`, color:exchange.color, fontSize:10, fontWeight:700, cursor:'pointer', transition:'all .15s' }}
          onMouseEnter={e => { e.currentTarget.style.background = `${exchange.color}20`; }}
          onMouseLeave={e => { e.currentTarget.style.background = `${exchange.color}0D`; }}>
          Connect →
        </button>
      )}
    </div>
  );
}

export default function Exchanges() {
  const [connections,      setConnections]      = useState({});
  const [loading,          setLoading]          = useState(true);
  const [connectTarget,    setConnectTarget]    = useState(null);
  const [disconnectTarget, setDisconnectTarget] = useState(null);
  const [changeModeTarget, setChangeModeTarget] = useState(null);
  const [balanceTarget,    setBalanceTarget]    = useState(null); // NOUVEAU
  const [filter,           setFilter]           = useState('all');
  const [search,           setSearch]           = useState('');

  useEffect(() => {
    api.get('/exchanges/connections')
      .then(res => setConnections(res.data || {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleConnected    = (id, mode) => setConnections(c => ({ ...c, [id]: { mode, connectedAt: 'Just now', lastSync: '—' } }));
  const handleDisconnected = (id)       => setConnections(c => { const n = { ...c }; delete n[id]; return n; });
  const handleModeChanged  = (id, mode) => setConnections(c => ({ ...c, [id]: { ...c[id], mode } }));

  const connectedCount = Object.keys(connections).length;
  const liveCount      = Object.values(connections).filter(c => c.mode === 'live').length;
  const paperCount     = Object.values(connections).filter(c => c.mode === 'paper').length;

  const visible = EXCHANGES.filter(ex => {
    const matchFilter = filter === 'all' || !!connections[ex.id];
    const matchSearch = !search || ex.name.toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  if (loading) return (
    <div style={{ ...mono, color:'var(--text-muted)', padding:20, fontSize:12 }}>// Loading exchange connections...</div>
  );

  return (
    <>
      {connectTarget && (
        <ConnectModal exchange={connectTarget} onClose={() => setConnectTarget(null)}
          onConnected={(id, mode) => { handleConnected(id, mode); setConnectTarget(null); }} />
      )}
      {disconnectTarget && (
        <DisconnectModal exchange={disconnectTarget} onClose={() => setDisconnectTarget(null)}
          onDisconnected={(id) => { handleDisconnected(id); setDisconnectTarget(null); }} />
      )}
      {changeModeTarget && (
        <ChangeModeModal exchange={changeModeTarget.exchange} currentMode={changeModeTarget.mode}
          onClose={() => setChangeModeTarget(null)}
          onChanged={(id, mode) => { handleModeChanged(id, mode); setChangeModeTarget(null); }} />
      )}
      {balanceTarget && (
        <BalanceModal exchange={balanceTarget} onClose={() => setBalanceTarget(null)} />
      )}

      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between' }}>
        <div>
          <div style={{ ...mono, fontSize:10, letterSpacing:'.2em', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:6 }}>// Exchange Connections</div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', ...mono }}>
            <span style={{ color:'var(--cyan)' }}>{connectedCount}</span> of {EXCHANGES.length} connected
            {liveCount > 0 && <span style={{ color:'#f87171', marginLeft:12 }}>⚡ {liveCount} live</span>}
            {paperCount > 0 && <span style={{ color:'#00f5d4', marginLeft:12 }}>◈ {paperCount} paper</span>}
          </div>
        </div>
        <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', borderRadius:9, padding:4 }}>
          {['all','connected'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ ...mono, fontSize:10, padding:'6px 14px', borderRadius:6, border:'none', cursor:'pointer', background: filter===f ? 'rgba(0,245,212,0.1)' : 'transparent', color: filter===f ? 'var(--cyan)' : 'var(--text-muted)', fontWeight: filter===f ? 700 : 400, transition:'all .15s' }}>
              {f === 'all' ? `All (${EXCHANGES.length})` : `Connected (${connectedCount})`}
            </button>
          ))}
        </div>
      </div>

      <div style={{ position:'relative' }}>
        <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', ...mono, fontSize:12, color:'var(--text-muted)', pointerEvents:'none' }}>⌕</span>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search exchanges..."
          style={{ width:'100%', boxSizing:'border-box', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'10px 14px 10px 36px', color:'var(--text-primary)', ...mono, fontSize:12, outline:'none' }}
          onFocus={e => e.target.style.borderColor='rgba(0,245,212,0.3)'}
          onBlur={e  => e.target.style.borderColor='var(--border)'} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
        {[
          { label:'Connected',    value:connectedCount,                    accent:'var(--cyan)'   },
          { label:'Live',         value:liveCount,                         accent:'#f87171'        },
          { label:'Paper',        value:paperCount,                        accent:'#00f5d4'        },
          { label:'Available',    value:EXCHANGES.length-connectedCount,   accent:'var(--text-muted)' },
        ].map(s => (
          <div key={s.label} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'14px 18px', display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ fontSize:22, fontWeight:800, color:s.accent, ...mono }}>{s.value}</div>
            <div style={{ ...mono, fontSize:9, letterSpacing:'.12em', textTransform:'uppercase', color:'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {visible.length === 0 ? (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16, padding:'48px 24px', textAlign:'center' }}>
          <div style={{ fontSize:32, opacity:.15, marginBottom:12 }}>◎</div>
          <div style={{ ...mono, fontSize:12, color:'var(--text-muted)' }}>
            {filter === 'connected' ? 'No exchanges connected yet' : 'No exchanges match your search'}
          </div>
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:14 }}>
          {visible.map(ex => (
            <ExchangeCard key={ex.id} exchange={ex} connected={connections[ex.id] || null}
              onConnect={setConnectTarget}
              onDisconnect={setDisconnectTarget}
              onChangeMode={(exchange, mode) => setChangeModeTarget({ exchange, mode })}
              onViewBalance={setBalanceTarget} />
          ))}
        </div>
      )}

      <div style={{ background:'rgba(0,245,212,0.03)', border:'1px solid rgba(0,245,212,0.1)', borderRadius:12, padding:'16px 20px', display:'flex', gap:14, alignItems:'flex-start' }}>
        <span style={{ color:'var(--cyan)', fontSize:16, flexShrink:0 }}>🔒</span>
        <div>
          <div style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', marginBottom:5 }}>Security best practices</div>
          <div style={{ ...mono, fontSize:10, color:'var(--text-muted)', lineHeight:1.8 }}>
            Always restrict to <span style={{ color:'var(--cyan)' }}>Read + Trade</span> — never withdrawals.
            Whitelist AtlasQuant's IP if your exchange supports it.
            Keys stored encrypted AES-256, never transmitted in plain text.
          </div>
        </div>
      </div>
    </>
  );
}