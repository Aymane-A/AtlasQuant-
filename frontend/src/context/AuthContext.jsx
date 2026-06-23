// frontend/src/context/AuthContext.js
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  // ── Verify stored token on app mount ─────────────────
  useEffect(() => {
    const token = localStorage.getItem('aq_token');
    if (!token) { setLoading(false); return; }

    authAPI.me()
      .then(res => setUser(res.data.user))
      .catch(() => {
        localStorage.removeItem('aq_token');
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // ── Login ─────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    setError(null);
    const res = await authAPI.login(email, password);
    localStorage.setItem('aq_token', res.data.token);
    setUser(res.data.user);
    return res.data;
  }, []);

  // ── Register ──────────────────────────────────────────
  const register = useCallback(async (name, email, password) => {
    setError(null);
    const res = await authAPI.register(name, email, password);
    localStorage.setItem('aq_token', res.data.token);
    setUser(res.data.user);
    return res.data;
  }, []);

  // ── Logout ────────────────────────────────────────────
  const logout = useCallback(() => {
    authAPI.logout().catch(() => {});
    localStorage.removeItem('aq_token');
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