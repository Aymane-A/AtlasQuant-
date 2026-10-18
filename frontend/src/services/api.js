import axios from 'axios';

// ── Base instance (HTTP Pure Config) ──────────────────────
// The localhost fallback is for `npm run dev` only. A production build without
// VITE_API_URL would point every visitor's browser at THEIR OWN machine, so we fail loudly.
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:5000/api' : '');
if (!API_URL) {
  throw new Error('VITE_API_URL is not set. Set it at build time to the public API URL, e.g. https://api.example.com/api');
}

// ── Session = HttpOnly cookie ─────────────────────────────
// The JWT lives in an HttpOnly cookie set by the API: JavaScript can't read it (so XSS can't steal it).
// withCredentials makes the browser send it. The CSRF token (returned by login/register/refresh/me) is
// kept in memory ONLY and sent as X-CSRF-Token on state-changing requests.
const api = axios.create({
  baseURL: API_URL,
  timeout: 120000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

let csrfToken = null;
export const setCsrfToken = (t) => { csrfToken = t || null; };

const SAFE_METHODS = new Set(['get', 'head', 'options']);
// Auth probes whose 401 is an expected answer ("not logged in"), not a reason to bounce to /login.
const isAuthProbe = (url = '') => /\/auth\/(me|refresh)$/.test(String(url).split('?')[0]);

api.interceptors.request.use(
  (config) => {
    if (csrfToken && !SAFE_METHODS.has(String(config.method || 'get').toLowerCase())) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }
    return config;
  },
  (err) => Promise.reject(err)
);

// ── Response interceptor — keep CSRF token fresh, handle 401 / 403 CSRF / 429 ──
api.interceptors.response.use(
  (res) => {
    if (res.data && res.data.csrfToken) csrfToken = res.data.csrfToken;
    return res;
  },
  async (err) => {
    const status = err.response?.status;
    const cfg = err.config;

    // Stale CSRF token (e.g. the session was refreshed in another tab): fetch a fresh one via /auth/me, retry once.
    if (status === 403 && err.response?.data?.code === 'CSRF_INVALID' && cfg && !cfg._csrfRetried) {
      cfg._csrfRetried = true;
      try {
        await api.get('/auth/me');
        return await api(cfg);
      } catch (retryErr) {
        if (retryErr && retryErr.status !== undefined) return Promise.reject(retryErr); // already normalised
      }
    }

    if (status === 401) {
      csrfToken = null;
      if (!isAuthProbe(cfg?.url) && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }

    if (status === 429) {
      err.isRateLimit = true;
      err.retryAfter  = err.response?.headers?.['retry-after'] || 60;
    }

    // `response` is kept on purpose: ~20 call sites read err.response.data.error. Without it they all
    // fell back to a generic message ("Order failed", "Failed to save…") and hid the real reason.
    return Promise.reject({
      status,
      code:       err.response?.data?.code,
      error:      err.response?.data?.error || err.message,
      isRateLimit: err.isRateLimit || false,
      response:   err.response,
    });
  }
);

// ── Auth API ──────────────────────────────────────────────
export const authAPI = {
  login:    (email, password, twofa = {}) => api.post('/auth/login', { email, password, ...twofa }),
  register: (name, email, password)   => api.post('/auth/register', { name, email, password }),
  me:       ()                        => api.get('/auth/me'),
  logout:   ()                        => api.post('/auth/logout'),
  refresh:  ()                        => api.post('/auth/refresh'),
  // One-time migration: exchange a legacy localStorage JWT for a cookie session (the API revokes the old token).
  upgradeLegacy: (legacyToken)        => api.post('/auth/refresh', null, { headers: { Authorization: `Bearer ${legacyToken}` } }),
};

// ── Signals API ───────────────────────────────────────────
export const signalsAPI = {
  getAll:   (interval = '4h')         => api.get(`/signals?interval=${interval}`),
  getOne:   (symbol, interval = '4h') => api.get(`/signals/${symbol}?interval=${interval}`),
  refresh:  (interval = '4h')         => api.get(`/signals?interval=${interval}&refresh=true`),
  symbols:  ()                        => api.get('/signals/meta/supported'),
};

// ── Market API ────────────────────────────────────────────
export const marketAPI = {
  prices:      ()                                    => api.get('/market/prices'),
  forex:       ()                                    => api.get('/market/forex/prices'),
  commodities: ()                                    => api.get('/market/commodities/prices'),
  stats:       (symbol)                               => api.get(`/market/${symbol}/stats`),
  candles:     (symbol, interval = '4h', limit = 100) => api.get(`/market/${symbol}/candles?interval=${interval}&limit=${limit}`),
};

export const alertsAPI = {
  getAll:      ()        => api.get('/alerts'),
  getHistory:  ()        => api.get('/alerts/history'),
  create:      (payload) => api.post('/alerts', payload),
  remove:      (id)      => api.delete(`/alerts/${id}`),
  togglePause: (id)      => api.patch(`/alerts/${id}/pause`),
  reset:       (id)      => api.patch(`/alerts/${id}/reset`),
};

export const screenerAPI = {
  presets:      ()          => api.get('/screener/presets'),
  savePreset:   (payload)   => api.post('/screener/presets', payload),
  deletePreset: (id)        => api.delete(`/screener/presets/${id}`),
};

// ── Health ────────────────────────────────────────────────
export const healthAPI = {
  check: () => api.get('/health'),
};

export default api;