// frontend/src/hooks/useSignals.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { signalsAPI } from '../services/api';

const POLL_MS   = 60 * 1000; // 1 min
const RETRY_MS  = 65 * 1000; // 65s after rate-limit

export function useSignals(interval = '4h') {
  const [signals,    setSignals]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const timerRef = useRef(null);

  const fetchSignals = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = force
        ? await signalsAPI.refresh(interval)
        : await signalsAPI.getAll(interval);

      // Normalize asset_class — fallback pour les anciennes lignes DB sans classe
      const normalized = (res.data.signals || []).map(s => ({
        ...s,
        asset_class: s.asset_class || 'Crypto',
      }));

      setSignals(normalized);
      setLastUpdate(new Date());
    } catch (err) {
      if (err.isRateLimit) {
        const waitMs = (err.retryAfter || 65) * 1000;
        setError(`Rate limited — retrying in ${Math.round(waitMs / 1000)}s`);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fetchSignals(), waitMs);
      } else {
        setError(err.error || 'Failed to load signals. Is the backend running on port 5000?');
      }
    } finally {
      setLoading(false);
    }
  }, [interval]);

  useEffect(() => {
    fetchSignals();
    timerRef.current = setInterval(() => fetchSignals(), POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchSignals]);

  return {
    signals,
    loading,
    error,
    lastUpdate,
    refresh: () => fetchSignals(true),
  };
}

export function useSignal(symbol, interval = '4h') {
  const [signal,  setSignal]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    signalsAPI.getOne(symbol, interval)
      .then(res => setSignal(res.data.signal))
      .catch(err => setError(err.error || 'Error loading signal'))
      .finally(() => setLoading(false));
  }, [symbol, interval]);

  return { signal, loading, error };
}