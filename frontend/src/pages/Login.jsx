import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import ThreeBackground from '../components/ThreeBackground';
import LangSwitcher from '../components/LangSwitcher';

// Khorshnal style array bera l-component bach may-3awdch y-t-creata 
// reference memory jdid m3a koll input change wla switch dial language.
const INPUT_STYLE = {
  width: '100%', 
  padding: '12px 14px',
  background: 'rgba(0,245,212,0.04)',
  border: '1px solid rgba(0,245,212,0.12)',
  borderRadius: 10, 
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono,monospace', 
  fontSize: 14, 
  outline: 'none',
};

export default function Login() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      if (!form.email.includes('@')) throw { error: t('login.errEmail') };
      if (form.password.length < 6)   throw { error: t('login.errPass')  };
      if (tab === 'register' && form.password !== form.confirm)
        throw { error: t('login.errMatch') };

      if (tab === 'login') await login(form.email, form.password);
      else                 await register(form.name, form.email, form.password);

      navigate('/dashboard');
    } catch (err) {
      setError(err.error || err.message || t('login.errConn'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <ThreeBackground />

      {/* Nav */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
        padding: '18px 60px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        background: 'linear-gradient(to bottom,rgba(3,5,10,0.92),transparent)',
        backdropFilter: 'blur(16px)',
      }}>
        <span style={{
          fontFamily: 'Syne,sans-serif', fontSize: 17, fontWeight: 700,
          background: 'linear-gradient(120deg,var(--cyan),var(--purple-bright))',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          AtlasQuant AI
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              fontFamily: 'JetBrains Mono,monospace', fontSize: 11,
              letterSpacing: '.1em', cursor: 'pointer',
            }}
          >
            {t('login.back')}
          </button>
          <LangSwitcher />
        </div>
      </nav>

      {/* Card */}
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: '100px 24px 24px',
        position: 'relative', zIndex: 2,
      }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <div style={{
            background: 'rgba(7,11,18,0.75)',
            border: '1px solid rgba(0,245,212,0.15)',
            borderRadius: 20, padding: 40, backdropFilter: 'blur(32px)',
          }}>

            {/* Header */}
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'Syne,sans-serif', marginBottom: 6 }}>
                {tab === 'login' ? t('login.welcome') : t('login.create')}
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                {tab === 'login' ? t('login.accessSignals') : t('login.joinAtlas')}
              </div>
            </div>

            {/* Tabs */}
            <div style={{
              display: 'flex', background: 'rgba(0,245,212,0.05)',
              border: '1px solid var(--border)', borderRadius: 10,
              padding: 3, marginBottom: 24,
            }}>
              {['login', 'register'].map(tabKey => (
                <button
                  key={tabKey}
                  onClick={() => setTab(tabKey)}
                  style={{
                    flex: 1, padding: 9, borderRadius: 8, border: 'none',
                    fontFamily: 'Syne,sans-serif', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', transition: 'all .2s',
                    background: tab === tabKey ? 'rgba(0,245,212,0.1)' : 'transparent',
                    color:      tab === tabKey ? 'var(--cyan)' : 'var(--text-secondary)',
                    boxShadow:  tab === tabKey ? 'inset 0 0 0 1px rgba(0,245,212,0.2)' : 'none',
                  }}
                >
                  {tabKey === 'login' ? t('login.tabLogin') : t('login.tabRegister')}
                </button>
              ))}
            </div>

            {/* Error */}
            {error && (
              <div style={{
                padding: '10px 14px', borderRadius: 8,
                background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.2)',
                color: 'var(--red)', fontFamily: 'JetBrains Mono,monospace',
                fontSize: 12, marginBottom: 16,
              }}>
                {error}
              </div>
            )}

            {/* Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {tab === 'register' && (
                <input
                  style={INPUT_STYLE}
                  placeholder={t('login.name')}
                  value={form.name}
                  onChange={set('name')}
                />
              )}
              <input
                style={INPUT_STYLE}
                type="email"
                placeholder={t('login.email')}
                value={form.email}
                onChange={set('email')}
              />
              <input
                style={INPUT_STYLE}
                type="password"
                placeholder={t('login.password')}
                value={form.password}
                onChange={set('password')}
                onKeyDown={e => e.key === 'Enter' && submit()}
              />
              {tab === 'register' && (
                <input
                  style={INPUT_STYLE}
                  type="password"
                  placeholder={t('login.confirm')}
                  value={form.confirm}
                  onChange={set('confirm')}
                  onKeyDown={e => e.key === 'Enter' && submit()}
                />
              )}

              <button
                onClick={submit}
                disabled={loading}
                style={{
                  padding: 13,
                  background: 'linear-gradient(135deg,var(--cyan),var(--cyan-dim))',
                  color: '#030712', fontFamily: 'Syne,sans-serif',
                  fontSize: 14, fontWeight: 700, letterSpacing: '.04em',
                  border: 'none', borderRadius: 10, cursor: 'pointer',
                  opacity: loading ? 0.7 : 1, transition: 'all .25s',
                }}
              >
                {loading
                  ? t('login.loading')
                  : tab === 'login'
                    ? t('login.submitLogin')
                    : t('login.submitRegister')
                }
              </button>
            </div>

            {/* Switch */}
            <div style={{
              textAlign: 'center', fontSize: 13,
              color: 'var(--text-secondary)', marginTop: 16,
            }}>
              {tab === 'login' ? t('login.noAccount') : t('login.hasAccount')}
              {' '}
              <span
                onClick={() => setTab(tab === 'login' ? 'register' : 'login')}
                style={{ color: 'var(--cyan)', cursor: 'pointer' }}
              >
                {tab === 'login' ? t('login.doRegister') : t('login.doLogin')}
              </span>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
