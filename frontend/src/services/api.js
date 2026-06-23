import axios from 'axios';

// ── Base instance (HTTP Pure Config) ──────────────────────
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
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
  login:    (email, password)         => api.post('/auth/login',    { email, password }),
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
  prices:  ()                                        => api.get('/market/prices'),
  stats:   (symbol)                                  => api.get(`/market/${symbol}/stats`),
  candles: (symbol, interval = '4h', limit = 100)   => api.get(`/market/${symbol}/candles?interval=${interval}&limit=${limit}`),
};

export const alertsAPI = {
  getAll: () => api.get('/alerts'),
  create: (payload) => api.post('/alerts', payload),
};

// ── Health ────────────────────────────────────────────────
export const healthAPI = {
  check: () => api.get('/health'),
};

export default api;