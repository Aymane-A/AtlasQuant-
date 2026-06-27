import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import ThreeBackground from './ThreeBackground';
import LangSwitcher from './LangSwitcher';

const NAV = [
  { label: 'Dashboard',    path: '/dashboard',    icon: '⬡' },
  { label: 'Signals',      path: '/signals',       icon: '◈', badge: '12', badgeColor: 'green' },
  { label: 'Screener',     path: '/screener',      icon: '◫' },
  { label: 'Watchlist',    path: '/watchlist',     icon: '◉', badge: '3',  badgeColor: 'red'   },
  { label: 'Trading',      path: '/trading',       icon: '📈'},
];
const INTEL = [
  { label: 'Alpha Engine', path: '/alpha_engine',  icon: '⬙' },
  { label: 'Backtester',   path: '/backtester',    icon: '◈' },
  { label: 'Risk Matrix',  path: '/risk_matrix',   icon: '◪' },
];
const SYS = [
  { label: 'Settings',     path: '/settings',      icon: '⬡' },
  { label: 'Exchanges',     path: '/exchanges',      icon: '◎' },
];
const TOPNAV = ['Markets', 'Analytics', 'Portfolio', 'Alerts'];

const s = {
  shell:  { position:'relative', zIndex:1, display:'grid', gridTemplateColumns:'220px 1fr', gridTemplateRows:'64px 1fr', height:'100vh', overflow:'hidden' },
  header: { gridColumn:'1/-1', display:'flex', alignItems:'center', padding:'0 24px', borderBottom:'1px solid var(--border)', background:'rgba(3,7,18,0.7)', backdropFilter:'blur(20px)', gap:'24px', zIndex:10 },
  logo:   { fontSize:18, fontWeight:800, letterSpacing:'.08em', color:'var(--cyan)', textShadow:'0 0 20px rgba(0,245,212,0.5)', flexShrink:0, fontStyle:'normal' },
  sep:    { width:1, height:28, background:'var(--border)', flexShrink:0 },
  pill:   { padding:'6px 14px', borderRadius:6, fontSize:13, color:'var(--text-secondary)', background:'transparent', border:'none', fontFamily:'Syne,sans-serif', transition:'all .2s', cursor:'pointer' },
  sidebar:{ borderRight:'1px solid var(--border)', background:'rgba(3,7,18,0.6)', backdropFilter:'blur(20px)', padding:'24px 16px', display:'flex', flexDirection:'column', gap:4, overflowY:'auto' },
  slabel: { fontSize:10, letterSpacing:'.15em', color:'var(--text-muted)', padding:'16px 8px 8px', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace' },
  sitem:  { display:'flex', alignItems:'center', gap:10, padding:'9px 12px', borderRadius:8, fontSize:13, color:'var(--text-secondary)', border:'none', background:'transparent', fontFamily:'Syne,sans-serif', transition:'all .2s', width:'100%', textAlign:'left', cursor:'pointer' },
  badge:  (color) => ({ marginLeft:'auto', fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'2px 7px', borderRadius:10, background: color==='green'?'rgba(52,211,153,0.15)':'rgba(248,113,113,0.15)', color: color==='green'?'var(--green)':'var(--red)' }),
  main:   { overflowY:'auto', overflowX:'hidden', padding:'28px 28px 40px', display:'flex', flexDirection:'column', gap:20, scrollbarWidth:'thin', scrollbarColor:'#1e293b transparent' },
  dot:    { width:6, height:6, borderRadius:'50%', background:'var(--green)', animation:'pulse 2s infinite' },
  avatar: { width:32, height:32, borderRadius:'50%', border:'1.5px solid var(--border-accent)', background:'linear-gradient(135deg,#7b5ea7,#00f5d4)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:'#fff' },
  clock:  { fontSize:12, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' },
};

export default function Layout({ children }) {
  const { logout, user } = useAuth();
  const { t }            = useTranslation();
  const navigate         = useNavigate();
  const location         = useLocation();
  const [clock, setClock] = useState('');

  useEffect(() => {
    const tick = () => {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const isActive   = (path)  => location.pathname === path;
  const itemStyle  = (path)  => ({ ...s.sitem,  ...(isActive(path) ? { color:'var(--cyan)', background:'var(--cyan-glow)', boxShadow:'inset 0 0 0 1px rgba(0,245,212,0.1)' } : {}) });
  const pillStyle  = (label) => ({ ...s.pill,   ...(location.pathname.includes(label.toLowerCase()) ? { color:'var(--cyan)', background:'var(--cyan-glow)' } : {}) });
  const initials   = user?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'AK';

  return (
    <>
      <ThreeBackground />
      <div style={s.shell}>

        {/* ── HEADER ── */}
        <header style={s.header}>
          <em style={s.logo}>
            Atlas<span style={{ color:'var(--purple-bright)' }}>Quant</span>
            <span style={{ color:'var(--text-secondary)', fontWeight:400 }}> · AI</span>
          </em>
          <div style={s.sep} />
          <nav style={{ display:'flex', gap:4 }}>
            {TOPNAV.map(label => (
              <button key={label} style={pillStyle(label)} onClick={() => navigate(`/${label.toLowerCase()}`)}>
                {t(`nav.${label.toLowerCase()}`, label)}
              </button>
            ))}
          </nav>

          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:12 }}>
            {/* ── Language switcher ── */}
            <LangSwitcher variant="app" />

            <div style={s.sep} />

            <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
              <div style={s.dot} /> Live · NYSE
            </div>
            <div style={s.sep} />
            <div style={s.clock}>{clock}</div>
            <div style={s.avatar} title={user?.email}>{initials}</div>
          </div>
        </header>

        {/* ── SIDEBAR ── */}
        <aside style={s.sidebar}>
          <div style={s.slabel}>{t('sidebar.workspace', 'Workspace')}</div>
          {NAV.map(item => (
            <button key={item.path} style={itemStyle(item.path)} onClick={() => navigate(item.path)}>
              <span>{item.icon}</span>
              {t(`sidebar.${item.label.toLowerCase().replace(' ', '_')}`, item.label)}
              {item.badge && <span style={s.badge(item.badgeColor)}>{item.badge}</span>}
            </button>
          ))}

          <div style={s.slabel}>{t('sidebar.intelligence', 'Intelligence')}</div>
          {INTEL.map(item => (
            <button key={item.path} style={itemStyle(item.path)} onClick={() => navigate(item.path)}>
              <span>{item.icon}</span>
              {t(`sidebar.${item.label.toLowerCase().replace(' ', '_')}`, item.label)}
            </button>
          ))}

          <div style={s.slabel}>{t('sidebar.system', 'System')}</div>
          {SYS.map(item => (
            <button key={item.path} style={itemStyle(item.path)} onClick={() => navigate(item.path)}>
              <span>{item.icon}</span>
              {t(`sidebar.${item.label.toLowerCase().replace(' ', '_')}`, item.label)}
            </button>
          ))}

          <button onClick={logout} style={{ ...s.sitem, marginTop:'auto', color:'var(--red)', paddingTop:24 }}>
            <span>⏻</span> {t('sidebar.signout', 'Sign Out')}
          </button>
        </aside>

        {/* ── MAIN ── */}
        <main style={s.main}>
          {children || <Outlet />}
        </main>

      </div>
    </>
  );
}