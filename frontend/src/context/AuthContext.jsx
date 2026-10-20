// frontend/src/context/AuthContext.jsx
// The session is an HttpOnly cookie managed by the API: nothing auth-related is stored in
// localStorage anymore. The only thing kept client-side is the CSRF token (in memory, see services/api.js).
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI, setCsrfToken } from '../services/api';

const AuthContext = createContext(null);

// Key used before the cookie migration. Only read once, to upgrade an existing session, then deleted.
const LEGACY_TOKEN_KEY = 'aq_token';

const readLegacyToken = () => { try { return localStorage.getItem(LEGACY_TOKEN_KEY); } catch { return null; } };
const dropLegacyToken = () => { try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* storage unavailable */ } };

// Runs once per page load, even under React StrictMode's double-invoked effects
// (two parallel upgrades would race: the second would find the legacy token already revoked).
let bootPromise = null;
function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      // 1) Existing logged-in users: swap the old localStorage JWT for a cookie session (the API revokes the old token).
      const legacy = readLegacyToken();
      if (legacy) {
        try { await authAPI.upgradeLegacy(legacy); } catch { /* expired/revoked — a valid cookie may still exist */ }
        dropLegacyToken();
      }
      // 2) Ask the API who we are. 401 = not logged in. Also hands us the CSRF token after a reload.
      try {
        const res = await authAPI.me();
        return res.data.user;
      } catch {
        return null;
      }
    })();
  }
  return bootPromise;
}

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  // ── Restore the session on app mount ─────────────────
  useEffect(() => {
    let cancelled = false;
    boot().then((u) => {
      if (cancelled) return;
      setUser(u);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Login ─────────────────────────────────────────────
  // `twofa` is optional: { totp } or { backupCode }. When the account has 2FA
  // enabled and no code is given, the server answers { requires2FA: true }
  // WITHOUT setting a session — in that case the caller must ask the user for
  // a code and call login() again.
  const login = useCallback(async (email, password, twofa = {}) => {
    setError(null);
    const res = await authAPI.login(email, password, twofa);
    if (res.data.requires2FA) return res.data;
    dropLegacyToken();
    setUser(res.data.user);
    return res.data;
  }, []);

  // ── Register ──────────────────────────────────────────
  const register = useCallback(async (name, email, password) => {
    setError(null);
    const res = await authAPI.register(name, email, password);
    dropLegacyToken();
    setUser(res.data.user);
    return res.data;
  }, []);

  // ── Logout ────────────────────────────────────────────
  // The server revokes the session and clears the cookie. The CSRF token must outlive the request
  // (axios attaches headers asynchronously), so it is dropped only once the call has settled.
  const logout = useCallback(() => {
    authAPI.logout().catch(() => {}).finally(() => setCsrfToken(null));
    dropLegacyToken();
    bootPromise = null;
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, login, register, logout }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside <AuthProvider>');
  return ctx;
};
