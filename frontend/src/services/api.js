import axios from 'axios';

// ── Base instance (HTTP Pure Config) ──────────────────────
// The localhost fallback is for `npm run dev` only. A production build without
// VITE_API_URL would point every visitor's browser at THEIR OWN machine, so we fail loudly.
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:5000/api' : '');
if (!API_URL) {
  throw new Error('VITE_API_URL is not set. Set it at build time to the public API URL, e.g. https://api.example.com/api');
}

const api = axios.create({
  baseURL: API_URL,
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Request interceptor — attach JWT ─────────────────────
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('aq_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (err) => Promise.reject(err)
);

// ── Response interceptor — handle 401 / 429 ──────────────
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;

    if (status === 401) {
      localStorage.removeItem('aq_token');
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }

    if (status === 429) {
      err.isRateLimit = true;
      err.retryAfter  = err.response?.headers?.['retry-after'] || 60;
    }

    return Promise.reject({
      status,
      error:      err.response?.data?.error || err.message,
      isRateLimit: err.isRateLimit || false,
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