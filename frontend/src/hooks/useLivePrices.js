// frontend/src/hooks/useLivePrices.js
import { useState, useEffect, useRef } from 'react';
import api from '../services/api'; // ✅ uses axios instance with auth header

// Crypto symbols tracked via Binance WebSocket
const CRYPTO_STREAMS = ['btcusdt', 'ethusdt', 'solusdt'];

// Stock symbols fetched via backend (with cache — no 429)
const STOCK_SYMBOLS = 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,PLTR';

export function useLivePrices() {
  const [prices, setPrices] = useState({});
  const wsRef = useRef(null);

  // ── Crypto: Binance WebSocket (real-time) ────────────────────────────
  useEffect(() => {
    const streams = CRYPTO_STREAMS.map(s => `${s}@ticker`).join('/');

    const connect = () => {
      const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        try {
          const { data: d } = JSON.parse(e.data);
          if (!d?.s) return;

          // "BTCUSDT" → "BTC", "SOLUSDT" → "SOL"
          const sym = d.s.replace('USDT', '');
          setPrices(prev => ({
            ...prev,
            [sym]: {
              price:  parseFloat(d.c),
              change: parseFloat(d.P),
              up:     parseFloat(d.P) >= 0,
            },
          }));
        } catch { /* ignore malformed frames */ }
      };

      ws.onerror = () => ws.close();

      // Auto-reconnect after 3s if connection drops
      ws.onclose = () => {
        setTimeout(() => {
          if (wsRef.current === ws) connect(); // only if not manually closed
        }, 3000);
      };
    };

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, []);

  // ── Stocks: backend /api/prices/stocks (cached, every 30s) ──────────
  useEffect(() => {
    const load = async () => {
      try {
        // ✅ Fix 1: use `api` instance (adds Authorization header automatically)
        const res = await api.get(`/prices/stocks?symbols=${STOCK_SYMBOLS}`);

        // ✅ Fix 2: backend returns { success, data: [...] } — not a flat array
        if (!res.data?.success || !Array.isArray(res.data.data)) return;

        const map = {};
        res.data.data.forEach(q => {
          if (!q?.symbol) return;
          map[q.symbol] = {
            price:  q.price,   // number
            change: q.change,  // number, e.g. -4.02
            up:     q.up,      // boolean
          };
        });

        setPrices(prev => ({ ...prev, ...map }));
      } catch (err) {
        // Silent — portfolio still shows DB prices as fallback
        console.warn('[useLivePrices] stocks fetch failed:', err.message);
      }
    };

    load();
    // ✅ Fix 3: 30s interval — backend has 5min cache so no Yahoo 429
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  return prices;
}