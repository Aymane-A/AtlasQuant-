// frontend/src/hooks/useLivePrices.js
import { useState, useEffect } from 'react';

const STOCK_SYMBOLS = 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,PLTR';

export function useLivePrices() {
  const [prices, setPrices] = useState({});

  // ── Crypto : Binance WebSocket (real-time) ──────────────────────────
  useEffect(() => {
    const streams = ['btcusdt', 'ethusdt']
      .map(s => `${s}@ticker`)
      .join('/');

    const ws = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${streams}`
    );

    ws.onmessage = (e) => {
      try {
        const { data: d } = JSON.parse(e.data);
        const sym = d.s.replace('USDT', ''); // "BTC" ou "ETH"
        setPrices(prev => ({
          ...prev,
          [sym]: {
            price:  parseFloat(d.c),
            change: parseFloat(d.P),
            up:     parseFloat(d.P) >= 0,
          },
        }));
      } catch { /* ignore */ }
    };

    ws.onerror = () => ws.close();

    return () => ws.close();
  }, []);

  // ── Stocks : Yahoo Finance via backend (kol 15s) ────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch(
          `http://localhost:5000/api/prices/stocks?symbols=${STOCK_SYMBOLS}`
        );
        const data = await res.json();
        const map  = {};
        data.forEach(q => { map[q.symbol] = q; });
        setPrices(prev => ({ ...prev, ...map }));
      } catch { /* silent — static fallback */ }
    };

    load();
    const id = setInterval(load, 15 * 1000);
    return () => clearInterval(id);
  }, []);

  return prices;
}