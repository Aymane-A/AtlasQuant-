// frontend/src/pages/Overview.jsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function Overview() {
  const { t } = useTranslation();
  const o = (key, options = {}) => t(`overviewPage.${key}`, options);

  // ── 1. STATES DYAL L-DATA (Rj3ohom variables) ───────────────────
  const [loading, setLoading] = useState(true);
  const [portfolio, setPortfolio] = useState({
    totalValue: 2847391, // default mock content initial
    delta: 4.82,
    todayGain: 131204,
    ytdReturn: 38.4,
    cashAvailable: 342000
  });

  const [stats, setStats] = useState({
    winRate: 74.2,
    vsLastMonth: 68.1,
    sharpeRatio: 2.14,
    maxDrawdown: -12.4,
    signalsToday: 42
  });

  const [liveSignals, setLiveSignals] = useState([
    { id: 1, type: 'buy', sym: 'BTCUSDT', reason: 'MA Cross + RSI Oversold [4H]', price: '67,420', conf: 94 },
    { id: 2, type: 'sell', sym: 'ETHUSDT', reason: 'Orderblock Rejection [1H]', price: '3,510', conf: 89 }
  ]);

  const [riskMetrics, setRiskMetrics] = useState({
    score: 42,
    status: 'Moderate Risk',
    leverage: '3.5x',
    beta: 1.12
  });

  const [platformHealth, setPlatformHealth] = useState({
    api: '99.98%',
    latency: '18ms',
    engine: 'Running'
  });

  useEffect(() => {
    // ── 2. FETCH FUNCTION MN L-BACKEND API ──────────────────────────
    const fetchQuantumData = async () => {
      try {
        // Hna mnin t-wjed l-endpoints d l-backend, direct uncomment o 7tt l-URLs:
        // const res = await fetch('http://localhost:5000/api/v1/overview');
        // const data = await res.json();
        // setPortfolio(data.portfolio);
        // setStats(data.stats);
        // setLiveSignals(data.signals);
        // setRiskMetrics(data.risk);
        // setPlatformHealth(data.health);
        
        setLoading(false); 
      } catch (error) {
        console.error("Error loading live system matrices:", error);
      }
    };

    fetchQuantumData();
    const apiInterval = setInterval(fetchQuantumData, 5000); // Poll data koly 5 thwani

    // ── 3. LIVE CLOCK TRIGGER ───────────────────────────────────────
    const clkElement = document.getElementById('clk');
    const updateClock = () => {
      if (clkElement) {
        const now = new Date();
        clkElement.textContent = now.toTimeString().split(' ')[0];
      }
    };
    const clockInterval = setInterval(updateClock, 1000);
    updateClock();

    // ── 4. CYBERPUNK CUSTOM CURSOR TRACKING ──────────────────────────
    const cursor = document.getElementById('cursor');
    const cursorRing = document.getElementById('cursor-ring');

    const moveCursor = (e) => {
      if (cursor && cursorRing) {
        cursor.style.left = `${e.clientX}px`;
        cursor.style.top = `${e.clientY}px`;
        cursorRing.style.left = `${e.clientX}px`;
        cursorRing.style.top = `${e.clientY}px`;
      }
    };
    window.addEventListener('mousemove', moveCursor);

    // ── 5. DYNAMIC TICKER TAPE TRACK FEEDER ─────────────────────────
    const track1 = document.getElementById('ticker-track');
    const track2 = document.getElementById('ticker-track2');
    
    const mockTickers = [
      { s: 'BTCUSDT', v: '67,420', c: '+1.20%', up: true },
      { s: 'ETHUSDT', v: '3,512', c: '-0.45%', up: false },
      { s: 'SOLUSDT', v: '148.50', c: '+4.82%', up: true },
      { s: 'BNBUSDT', v: '592.10', c: '+0.15%', up: true },
      { s: 'EURUSD', v: '1.0821', c: '-0.08%', up: false },
    ];

    if (track1 && track2) {
      const htmlContent = mockTickers.map(ticker => `
        <div class="tick-item">
          <span class="tick-sym">${ticker.s}</span>
          <span class="tick-val">${ticker.v}</span>
          <span class="${ticker.up ? 'tick-up' : 'tick-dn'}">${ticker.c}</span>
        </div>
      `).join('');
      track1.innerHTML = htmlContent;
      track2.innerHTML = htmlContent;
    }

    return () => {
      clearInterval(apiInterval);
      clearInterval(clockInterval);
      window.removeEventListener('mousemove', moveCursor);
    };
  }, []);

  return (
    <>
      <meta charSet="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>AtlasQuant AI · Overview</title>
      <link
        href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap"
        rel="stylesheet"
      />
      <style
        dangerouslySetInnerHTML={{
          __html:
            "\n*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}\n:root{\n  --cyan:#00f5d4;--cyan-dim:#00c4aa;--cyan-glow:rgba(0,245,212,0.15);\n  --purple:#7b5ea7;--purple-bright:#a78bfa;--amber:#fbbf24;\n  --red:#f87171;--green:#34d399;--bg:#030712;\n  --surface:rgba(255,255,255,0.03);--surface-hover:rgba(255,255,255,0.06);\n  --border:rgba(255,255,255,0.06);--border-accent:rgba(0,245,212,0.25);\n  --text-primary:#f1f5f9;--text-secondary:#64748b;--text-muted:#334155;\n}\nhtml,body{width:100%;height:100%;background:var(--bg);color:var(--text-primary);font-family:'Syne',sans-serif;overflow:hidden}\n*{cursor:none!important}\n#cursor{position:fixed;width:8px;height:8px;background:var(--cyan);border-radius:50%;pointer-events:none;z-index:9999;transform:translate(-50%,-50%);mix-blend-mode:screen;transition:width .2s,height .2s}\n#cursor-ring{position:fixed;width:32px;height:32px;border:1px solid rgba(0,245,212,0.4);border-radius:50%;pointer-events:none;z-index:9998;transform:translate(-50%,-50%);transition:width .35s,height .35s,border-color .35s}\nbody:has(button:hover,a:hover) #cursor{width:16px;height:16px}\nbody:has(button:hover,a:hover) #cursor-ring{width:48px;height:48px;border-color:rgba(0,245,212,0.7)}\n#bg-canvas{position:fixed;inset:0;z-index:0}\n.shell{position:relative;z-index:1;display:grid;grid-template-columns:220px 1fr;grid-template-rows:64px 1fr;height:100vh;overflow:hidden}\n\n/* ── HEADER ── */\n.header{grid-column:1/-1;display:flex;align-items:center;padding:0 24px;border-bottom:1px solid var(--border);background:rgba(3,7,18,0.75);backdrop-filter:blur(24px);gap:24px;z-index:10}\n.logo{font-size:16px;font-weight:800;letter-spacing:.08em;color:var(--cyan);text-shadow:0 0 24px rgba(0,245,212,0.6);flex-shrink:0}\n.logo span{color:var(--text-secondary);font-weight:400}.logo em{color:var(--purple-bright);font-style:normal}\n.hsep{width:1px;height:28px;background:var(--border)}\n.npill{padding:6px 14px;border-radius:6px;font-size:13px;color:var(--text-secondary);background:transparent;border:none;font-family:'Syne',sans-serif;transition:all .2s}\n.npill:hover{color:var(--text-primary);background:var(--surface-hover)}.npill.active{color:var(--cyan);background:var(--cyan-glow)}\n.hright{margin-left:auto;display:flex;align-items:center;gap:16px}\n.sdot{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace}\n.dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pg 2s infinite}\n@keyframes pg{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}50%{box-shadow:0 0 0 6px rgba(52,211,153,0)}}\n.avatar{width:32px;height:32px;border-radius:50%;border:1.5px solid var(--border-accent);background:linear-gradient(135deg,#7b5ea7,#00f5d4);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff}\n\n/* ── SIDEBAR ── */\n.sidebar{border-right:1px solid var(--border);background:rgba(3,7,18,0.65);backdrop-filter:blur(24px);padding:24px 16px;display:flex;flex-direction:column;gap:4px;overflow-y:auto}\n.sidebar::-webkit-scrollbar{width:3px}.sidebar::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}\n.slabel{font-size:10px;letter-spacing:.15em;color:var(--text-muted);padding:16px 8px 8px;text-transform:uppercase;font-family:'JetBrains Mono',monospace}\n.sitem{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;color:var(--text-secondary);border:none;background:transparent;font-family:'Syne',sans-serif;transition:all .2s;width:100%;text-align:left;position:relative;overflow:hidden}\n.sitem::before{content:'';position:absolute;left:0;top:50%;width:3px;height:0;background:var(--cyan);transform:translateY(-50%);border-radius:0 2px 2px 0;transition:height .2s}\n.sitem:hover{color:var(--text-primary);background:var(--surface-hover)}.sitem.active{color:var(--cyan);background:var(--cyan-glow);box-shadow:inset 0 0 0 1px rgba(0,245,212,.1)}.sitem.active::before{height:60%}\n.badge{margin-left:auto;font-size:10px;font-family:'JetBrains Mono',monospace;padding:2px 7px;border-radius:10px;background:rgba(248,113,113,.15);color:var(--red)}.badge.g{background:rgba(52,211,153,.15);color:var(--green)}\n\n/* ── MAIN ── */\n.main{overflow-y:auto;overflow-x:hidden;padding:0;display:flex;flex-direction:column;gap:0;scrollbar-width:thin;scrollbar-color:#1e293b transparent}\n.main::-webkit-scrollbar{width:4px}.main::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}\n\n/* ── TICKER TAPE ── */\n.ticker-tape{background:rgba(0,245,212,0.03);border-bottom:1px solid var(--border);overflow:hidden;display:flex;height:38px;align-items:center}\n.ticker-track{display:flex;animation:tickScroll 40s linear infinite;white-space:nowrap;align-items:center}\n@keyframes tickScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}\n.tick-item{display:inline-flex;align-items:center;gap:8px;padding:0 24px;border-right:1px solid var(--border);font-family:'JetBrains Mono',monospace;font-size:11px;height:38px}\n.tick-sym{color:var(--cyan);font-weight:500}\n.tick-up{color:var(--green)}.tick-dn{color:var(--red)}\n\n/* ── HERO BAND ── */\n.hero-band{padding:28px 28px 0;display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px}\n.hero-main{grid-column:span 1;background:linear-gradient(135deg,rgba(0,245,212,0.06),rgba(124,58,237,0.04));border:1px solid var(--border-accent);border-radius:16px;padding:24px 26px;position:relative;overflow:hidden}\n.hero-main::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 20% 50%,rgba(0,245,212,0.08),transparent 60%);pointer-events:none}\n.hero-label{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-secondary);font-family:'JetBrains Mono',monospace;margin-bottom:8px}\n.hero-val{font-size:36px;font-weight:800;letter-spacing:-.04em;color:var(--cyan);line-height:1;text-shadow:0 0 40px rgba(0,245,212,0.3)}\n.hero-sub{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;font-family:'JetBrains Mono',monospace}\n.delta-pill{padding:3px 8px;border-radius:5px;font-size:11px;font-weight:600}\n.delta-up{background:rgba(52,211,153,.15);color:var(--green);border:1px solid rgba(52,211,153,.25)}\n.delta-dn{background:rgba(248,113,113,.15);color:var(--red);border:1px solid rgba(248,113,113,.25)}\n.hero-stat{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px 22px;position:relative;overflow:hidden;transition:border-color .3s,transform .3s}\n.hero-stat:hover{border-color:rgba(0,245,212,.2);transform:translateY(-2px)}\n.hero-stat::after{content:'';position:absolute;inset:0;border-radius:16px;background:radial-gradient(circle at 90% 10%,rgba(0,245,212,0.04),transparent 60%);pointer-events:none}\n.hs-label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-secondary);font-family:'JetBrains Mono',monospace;margin-bottom:10px}\n.hs-val{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1}\n.hs-desc{font-size:11px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace;margin-top:6px}\n.hs-spark{position:absolute;bottom:0;right:0;opacity:.3}\n\n/* ── CONTENT AREA ── */\n.content-grid{padding:20px 28px 28px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px}\n.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;position:relative;overflow:hidden;backdrop-filter:blur(10px);transition:border-color .3s}\n.panel:hover{border-color:rgba(0,245,212,.12)}\n.panel.wide{grid-column:span 2}\n.panel.full{grid-column:span 3}\n.ptitle{font-size:13px;font-weight:600;letter-spacing:.04em;margin-bottom:16px;color:var(--text-primary);display:flex;align-items:center;gap:8px}\n.pdot{width:6px;height:6px;border-radius:50%;background:var(--cyan);flex-shrink:0}\n\n/* ── SYSTEM STATUS ── */\n.status-grid{display:flex;flex-direction:column;gap:10px}\n.status-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.02);border:1px solid var(--border);transition:border-color .2s}\n.status-row:hover{border-color:rgba(0,245,212,.15)}\n.status-indicator{width:8px;height:8px;border-radius:50%;flex-shrink:0}\n.status-indicator.on{background:var(--green);box-shadow:0 0 8px rgba(52,211,153,.5);animation:pg 2s infinite}\n.status-indicator.warn{background:var(--amber);box-shadow:0 0 8px rgba(251,191,36,.4)}\n.status-indicator.off{background:var(--text-muted)}\n.status-name{font-size:12px;font-weight:500;flex:1}\n.status-tag{font-size:10px;font-family:'JetBrains Mono',monospace;padding:2px 7px;border-radius:4px}\n.status-tag.ok{background:rgba(52,211,153,.1);color:var(--green)}\n.status-tag.warn{background:rgba(251,191,36,.1);color:var(--amber)}\n.status-metric{font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-secondary);margin-left:auto}\n\n/* ── QUICK NAV ── */\n.qnav-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}\n.qnav-card{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:left;transition:all .25s;position:relative;overflow:hidden;text-decoration:none;display:block}\n.qnav-card:hover{border-color:rgba(0,245,212,.3);background:rgba(0,245,212,.04);transform:translateY(-2px)}\n.qnav-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--qcolor,var(--cyan));opacity:0;transition:opacity .3s;border-radius:12px 12px 0 0}\n.qnav-card:hover::before{opacity:1}\n.qnav-icon{font-size:18px;margin-bottom:8px;display:block}\n.qnav-name{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--text-primary);margin-bottom:3px}\n.qnav-desc{font-size:10px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace;line-height:1.5}\n\n/* ── SIGNALS MINI ── */\n.sig-mini{display:flex;flex-direction:column;gap:8px}\n.sig-mini-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.02);border:1px solid var(--border);transition:all .2s}\n.sig-mini-row:hover{border-color:rgba(0,245,212,.15);background:rgba(0,245,212,.03)}\n.sig-dot{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}\n.sig-dot.buy{background:rgba(52,211,153,.12);color:var(--green)}\n.sig-dot.sell{background:rgba(248,113,113,.12);color:var(--red)}\n.sig-mini-body{flex:1;min-width:0}\n.sig-mini-sym{font-size:13px;font-weight:700;letter-spacing:.03em}\n.sig-mini-reason{font-size:10px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.sig-mini-right{text-align:right;flex-shrink:0}\n.sig-mini-price{font-size:13px;font-weight:600;font-family:'JetBrains Mono',monospace}\n.sig-mini-conf{font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--text-secondary);margin-top:2px}\n\n/* ── RISK MATRIX ── */\n.risk-gauge-wrap{display:flex;flex-direction:column;align-items:center;padding:10px 0}\n.risk-score-num{font-size:32px;font-weight:800;text-align:center;letter-spacing:-.04em;font-family:'JetBrains Mono',monospace}\n.risk-score-label{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-secondary);font-family:'JetBrains Mono',monospace;text-align:center;margin-top:4px}\n.risk-breakdown{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}\n.rb-item{display:flex;justify-content:space-between;font-size:11px;font-family:'JetBrains Mono',monospace;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.02);border:1px solid var(--border)}\n\n/* ── ANIMATIONS ── */\n@keyframes fsu{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}\n.ai{animation:fsu .55s ease both}\n\n.main{scrollbar-gutter:stable}\n"
        }}
      />

      <div id="cursor" />
      <div id="cursor-ring" />
      <canvas id="bg-canvas" />

      <div className="shell">
        {/* ── HEADER ── */}
        <header className="header">
          <div className="logo">
            Atlas<em>Quant</em>
            <span> · AI</span>
          </div>
          <div className="hsep" />
          <nav style={{ display: "flex", gap: 4 }}>
            <button className="npill active" onClick={() => window.location.href='/overview'}>
              {t('nav.overview', { defaultValue: 'Overview' })}
            </button>
            <button className="npill" onClick={() => window.location.href='/markets'}>
              {t('nav.markets', { defaultValue: 'Markets' })}
            </button>
            <button className="npill" onClick={() => window.location.href='/analytics'}>
              {t('nav.analytics', { defaultValue: 'Analytics' })}
            </button>
            <button className="npill" onClick={() => window.location.href='/portfolio'}>
              {t('nav.portfolio', { defaultValue: 'Portfolio' })}
            </button>
            <button className="npill" onClick={() => window.location.href='/alerts'}>
              {t('nav.alerts', { defaultValue: 'Alerts' })}
            </button>
          </nav>
          <div className="hright">
            <div className="sdot">
              <div className="dot" />
              {o('allSystemsLive', { defaultValue: 'All Systems Live' })}
            </div>
            <div className="hsep" />
            <div className="sdot" id="clk">--:--:--</div>
            <div className="hsep" />
            <div className="avatar">AK</div>
          </div>
        </header>

        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div className="slabel">{t('sidebar.workspace', { defaultValue: 'Workspace' })}</div>
          <button className="sitem active" onClick={() => window.location.href='/overview'}>
            <span>⬛</span> {t('nav.overview', { defaultValue: 'Overview' })}
          </button>
          <button className="sitem" onClick={() => window.location.href='/dashboard'}>
            <span>⬡</span> {t('sidebar.dashboard', { defaultValue: 'Dashboard' })}
          </button>
          <button className="sitem" onClick={() => window.location.href='/signals'}>
            <span>◈</span> {t('sidebar.signals', { defaultValue: 'Signals' })}
            <span className="badge g">12</span>
          </button>
          <button className="sitem" onClick={() => window.location.href='/screener'}>
            <span>◫</span> {t('sidebar.screener', { defaultValue: 'Screener' })}
          </button>
          <button className="sitem" onClick={() => window.location.href='/watchlist'}>
            <span>◉</span> {t('sidebar.watchlist', { defaultValue: 'Watchlist' })}
            <span className="badge">3</span>
          </button>

          <div className="slabel">{t('sidebar.intelligence', { defaultValue: 'Intelligence' })}</div>
          <button className="sitem" onClick={() => window.location.href='/alpha-engine'}>
            <span>⬙</span> {t('sidebar.alpha_engine', { defaultValue: 'Alpha Engine' })}
          </button>
          <button className="sitem" onClick={() => window.location.href='/backtester'}>
            <span>◈</span> {t('sidebar.backtester', { defaultValue: 'Backtester' })}
          </button>
          <button className="sitem" onClick={() => window.location.href='/risk-matrix'}>
            <span>◪</span> {t('sidebar.risk_matrix', { defaultValue: 'Risk Matrix' })}
          </button>

          <div className="slabel">{t('sidebar.system', { defaultValue: 'System' })}</div>
          <button className="sitem" onClick={() => window.location.href='/settings'}>
            <span>⬡</span> {t('sidebar.settings', { defaultValue: 'Settings' })}
          </button>

          <div style={{ marginTop: "auto", paddingTop: 24 }}>
            <div className="slabel" style={{ paddingTop: 0 }}>
              {o('platformHealth', { defaultValue: 'Platform Health' })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: "0 4px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                <span style={{ color: "var(--text-secondary)" }}>{o('apiLabel', { defaultValue: 'API' })}</span>
                <span style={{ color: "var(--green)" }}>{platformHealth.api} ↑</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                <span style={{ color: "var(--text-secondary)" }}>{o('latencyLabel', { defaultValue: 'Latency' })}</span>
                <span style={{ color: "var(--cyan)" }}>{platformHealth.latency}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                <span style={{ color: "var(--text-secondary)" }}>{o('engineLabel', { defaultValue: 'Engine' })}</span>
                <span style={{ color: "var(--green)" }}>{platformHealth.engine}</span>
              </div>
            </div>
          </div>
        </aside>

        {/* ── MAIN CONTENT AREA ── */}
        <main className="main">
          {/* TICKER TAPE */}
          <div className="ticker-tape">
            <div className="ticker-track" id="ticker-track" />
            <div className="ticker-track" id="ticker-track2" aria-hidden="true" />
          </div>

          {/* HERO METRICS */}
          <div className="hero-band ai" style={{ animationDelay: ".05s" }}>
            <div className="hero-main">
              <div className="hero-label">{o('totalPortfolioValue', { defaultValue: 'Total Portfolio Value' })}</div>
              <div className="hero-val" id="port-val">
                ${portfolio.totalValue.toLocaleString()}
              </div>
              <div className="hero-sub">
                <span className={`delta-pill ${portfolio.delta >= 0 ? 'delta-up' : 'delta-dn'}`}>
                  {portfolio.delta >= 0 ? '▲' : '▼'} {portfolio.delta}%
                </span>
                <span style={{ color: "var(--text-secondary)", fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                  {o('todaySuffix', { defaultValue: 'today' })} · {portfolio.todayGain >= 0 ? '+$' : '-$'}{Math.abs(portfolio.todayGain).toLocaleString()}
                </span>
              </div>
              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={{ fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                  <div style={{ color: "var(--text-muted)", marginBottom: 3 }}>{o('ytdReturn', { defaultValue: 'YTD Return' })}</div>
                  <div style={{ color: "var(--green)", fontWeight: 600 }}>+{portfolio.ytdReturn}%</div>
                </div>
                <div style={{ fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                  <div style={{ color: "var(--text-muted)", marginBottom: 3 }}>{o('cashAvailable', { defaultValue: 'Cash Available' })}</div>
                  <div style={{ color: "var(--cyan)", fontWeight: 600 }}>${portfolio.cashAvailable.toLocaleString()}</div>
                </div>
              </div>
            </div>

            {/* Win Rate Stat */}
            <div className="hero-stat">
              <div className="hs-label">{o('winRate30d', { defaultValue: 'Win Rate (30d)' })}</div>
              <div className="hs-val" style={{ color: "var(--amber)" }}>{stats.winRate}%</div>
              <div className="hs-desc">vs {stats.vsLastMonth}% last month</div>
              <div style={{ marginTop: 14, height: 3, background: "rgba(255,255,255,.06)", borderRadius: 2 }}>
                <div style={{ width: `${stats.winRate}%`, height: "100%", background: "var(--amber)", borderRadius: 2 }} />
              </div>
            </div>

            {/* Sharpe Stat */}
            <div className="hero-stat">
              <div className="hs-label">{o('sharpeRatio', { defaultValue: 'Sharpe Ratio' })}</div>
              <div className="hs-val" style={{ color: "var(--cyan)" }}>{stats.sharpeRatio}</div>
              <div className="hs-desc">{o('excellentBenchmark', { defaultValue: 'Institutional Grade' })}</div>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: '"JetBrains Mono",monospace' }}>
                  <span style={{ color: "var(--text-muted)" }}>Max DD</span>
                  <span style={{ color: "var(--red)" }}>{stats.maxDrawdown}%</span>
                </div>
              </div>
            </div>

            {/* Signals Today Stat */}
            <div className="hero-stat">
              <div className="hs-label">{o('signalsToday', { defaultValue: 'Signals Today' })}</div>
              <div className="hs-val" style={{ color: "var(--green)" }}>{stats.signalsToday}</div>
              <div className="hs-desc">{o('vsYesterdayActive', { defaultValue: 'Engine high-activity' })}</div>
            </div>
          </div>

          {/* CONTENT GRID */}
          <div className="content-grid">
            {/* Live Signals Panel */}
            <div className="panel wide ai" style={{ animationDelay: ".20s" }}>
              <div className="ptitle">
                <div className="pdot" />
                {o('recentSignalsTitle', { defaultValue: 'Recent High-Confidence Signals' })}
              </div>
              <div className="sig-mini">
                {liveSignals.map(sig => (
                  <div className="sig-mini-row" key={sig.id}>
                    <div className={`sig-dot ${sig.type === 'buy' ? 'buy' : 'sell'}`}>
                      {sig.type === 'buy' ? '▲' : '▼'}
                    </div>
                    <div className="sig-mini-body">
                      <div className="sig-mini-sym">{sig.sym}</div>
                      <div className="sig-mini-reason">{sig.reason}</div>
                    </div>
                    <div className="sig-mini-right">
                      <div className="sig-mini-price" style={{ color: sig.type === 'buy' ? 'var(--green)' : 'var(--red)' }}>
                        ${sig.price}
                      </div>
                      <div className="sig-mini-conf">{sig.conf}% conf</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Risk Gauge Panel */}
            <div className="panel ai" style={{ animationDelay: ".22s" }}>
              <div className="ptitle">
                <div className="pdot" style={{ background: 'var(--amber)' }} />
                {o('riskMetricsTitle', { defaultValue: 'Risk Matrix & Leverage' })}
              </div>
              <div className="risk-gauge-wrap">
                <div className="risk-score-num" style={{ color: 'var(--amber)' }}>{riskMetrics.score}</div>
                <div className="risk-score-label">{riskMetrics.status}</div>
              </div>
              <div className="risk-breakdown">
                <div className="rb-item">
                  <span style={{ color: 'var(--text-secondary)' }}>Leverage</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{riskMetrics.leverage}</span>
                </div>
                <div className="rb-item">
                  <span style={{ color: 'var(--text-secondary)' }}>Beta</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{riskMetrics.beta}</span>
                </div>
              </div>
            </div>

            {/* Quick Actions Footer Row */}
            <div className="panel full ai" style={{ animationDelay: ".26s" }}>
              <div className="ptitle">
                <div className="pdot" />
                {o('quickActions', { defaultValue: 'System Quick Actions Engine Core' })}
              </div>
              <div className="qnav-grid">
                <a href="/signals" className="qnav-card" style={{ '--qcolor': 'var(--cyan)' }}>
                  <span className="qnav-icon">◈</span>
                  <div className="qnav-name">Signals Alpha</div>
                  <div className="qnav-desc">View real-time engine matrix executions.</div>
                </a>
                <a href="/backtester" className="qnav-card" style={{ '--qcolor': 'var(--purple-bright)' }}>
                  <span className="qnav-icon">⬙</span>
                  <div className="qnav-name">Backtest Rig</div>
                  <div className="qnav-desc">Simulate historical strategy layers parameters.</div>
                </a>
                <a href="/risk-matrix" className="qnav-card" style={{ '--qcolor': 'var(--amber)' }}>
                  <span className="qnav-icon">◪</span>
                  <div className="qnav-name">Risk Parameters</div>
                  <div className="qnav-desc">Adjust max drawdowns limits safeguards.</div>
                </a>
                <a href="/settings" className="qnav-card" style={{ '--qcolor': 'var(--text-secondary)' }}>
                  <span className="qnav-icon">⬡</span>
                  <div className="qnav-name">API Integrations</div>
                  <div className="qnav-desc">Manage Binance, Coinbase and Postgres keys hooks.</div>
                </a>
              </div>
            </div>

          </div>
        </main>
      </div>
    </>
  );
}