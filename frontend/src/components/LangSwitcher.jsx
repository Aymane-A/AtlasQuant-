import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const LANGUAGES = [
  { code: 'en', label: 'English',    flag: '🇬🇧' },
  { code: 'fr', label: 'Français',   flag: '🇫🇷' },
  { code: 'ar', label: 'العربية',    flag: '🇸🇦' },
  { code: 'es', label: 'Español',    flag: '🇪🇸' },
  { code: 'tr', label: 'Türkçe',     flag: '🇹🇷' },
  { code: 'pt', label: 'Português',  flag: '🇧🇷' },
  { code: 'ru', label: 'Русский',    flag: '🇷🇺' },
  { code: 'de', label: 'Deutsch',    flag: '🇩🇪' },
  { code: 'hi', label: 'हिन्दी',      flag: '🇮🇳' },
  { code: 'ko', label: '한국어',      flag: '🇰🇷' },
];

export default function LangSwitcher() {
  const { i18n } = useTranslation();
  const [open, setOpen]   = useState(false);
  const ref               = useRef(null);

  const current = LANGUAGES.find(l => l.code === i18n.language) || LANGUAGES[0];

  const select = (code) => {
    i18n.changeLanguage(code);
    setOpen(false);
  };

  // close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', zIndex: 1000, fontFamily: "'JetBrains Mono', monospace" }}>

      {/* ── Trigger button ── */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display:        'flex',
          alignItems:     'center',
          gap:            8,
          padding:        '7px 14px',
          background:     open ? 'rgba(0,245,212,0.1)' : 'rgba(255,255,255,0.04)',
          border:         `1px solid ${open ? 'rgba(0,245,212,0.35)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius:   8,
          color:          open ? '#00f5d4' : '#94a3b8',
          fontSize:       12,
          fontFamily:     'inherit',
          letterSpacing:  '0.06em',
          cursor:         'pointer',
          transition:     'all 0.2s',
          whiteSpace:     'nowrap',
          backdropFilter: 'blur(12px)',
        }}
        onMouseEnter={e => { if (!open) { e.currentTarget.style.borderColor = 'rgba(0,245,212,0.25)'; e.currentTarget.style.color = '#e2f0ff'; } }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#94a3b8'; } }}
      >
        {/* Globe icon */}
        <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
          <path d="M10 2a8 8 0 1 0 0 16A8 8 0 0 0 10 2zm0 1.5c.34 0 .9.4 1.44 1.5H8.56C9.1 3.9 9.66 3.5 10 3.5zm-2.2.7A8.4 8.4 0 0 0 6.6 6.5H4.4a6.5 6.5 0 0 1 3.4-2.3zM3.7 8H6.1a13.6 13.6 0 0 0-.1 2 13.6 13.6 0 0 0 .1 2H3.7A6.5 6.5 0 0 1 3.5 10c0-.7.07-1.37.2-2zm.7 5.5h2.2a8.4 8.4 0 0 0 1.2 2.3A6.5 6.5 0 0 1 4.4 13.5zm3.65 0h3.9C11.42 14.92 10.74 16 10 16s-1.42-1.08-1.95-2.5zm4.15-1.5H7.8a12 12 0 0 1-.12-2c0-.69.04-1.36.12-2h4.4c.08.64.12 1.31.12 2s-.04 1.36-.12 2zm.6 1.5a6.5 6.5 0 0 1-3.4 2.3 8.4 8.4 0 0 0 1.2-2.3h2.2zm1.5-1.5h-2.4a13.6 13.6 0 0 0 .1-2 13.6 13.6 0 0 0-.1-2h2.4c.13.63.2 1.3.2 2s-.07 1.37-.2 2zm-.8-5.5h-2.2a8.4 8.4 0 0 0-1.2-2.3 6.5 6.5 0 0 1 3.4 2.3z"/>
        </svg>

        <span style={{ fontSize: 13 }}>{current.flag}</span>
        <span style={{ textTransform: 'uppercase', fontSize: 11, fontWeight: 500 }}>{current.code}</span>

        {/* Chevron */}
        <svg
          width="10" height="10" viewBox="0 0 20 20" fill="currentColor"
          style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', opacity: 0.6 }}
        >
          <path d="M5 7l5 5 5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {/* ── Dropdown panel ── */}
      {open && (
        <div style={{
          position:        'absolute',
          top:             'calc(100% + 8px)',
          left:            0,
          minWidth:        170,
          background:      'rgba(7, 11, 20, 0.92)',
          border:          '1px solid rgba(0,245,212,0.18)',
          borderRadius:    10,
          backdropFilter:  'blur(24px)',
          boxShadow:       '0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,245,212,0.06)',
          padding:         '6px',
          animation:       'aqDropIn 0.15s ease',
        }}>
          <style>{`
            @keyframes aqDropIn {
              from { opacity: 0; transform: translateY(-6px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            .aq-lang-item:hover {
              background: rgba(0,245,212,0.08) !important;
              color: #00f5d4 !important;
            }
            .aq-lang-item.aq-active {
              background: rgba(0,245,212,0.1) !important;
              color: #00f5d4 !important;
              border-color: rgba(0,245,212,0.2) !important;
            }
          `}</style>

          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => select(lang.code)}
              className={`aq-lang-item${lang.code === i18n.language ? ' aq-active' : ''}`}
              style={{
                display:       'flex',
                alignItems:    'center',
                gap:           10,
                width:         '100%',
                padding:       '8px 10px',
                background:    'transparent',
                border:        '1px solid transparent',
                borderRadius:  7,
                color:         lang.code === i18n.language ? '#00f5d4' : '#64748b',
                fontSize:      12,
                fontFamily:    "'JetBrains Mono', monospace",
                cursor:        'pointer',
                textAlign:     'left',
                transition:    'all 0.15s',
              }}
            >
              <span style={{ fontSize: 15 }}>{lang.flag}</span>
              <span style={{ flex: 1 }}>{lang.label}</span>
              <span style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {lang.code}
              </span>
              {lang.code === i18n.language && (
                <svg width="10" height="10" viewBox="0 0 20 20" fill="#00f5d4">
                  <path d="M4 10l4 4 8-8" stroke="#00f5d4" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}