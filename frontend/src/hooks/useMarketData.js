import { useEffect, useState, useRef } from 'react';

// URL dyal backend local awla production stream
// Mis à jour : le WebSocket de marché tourne maintenant sur le MÊME
// port que l'API REST (attaché au serveur HTTP Express), plutôt qu'un
// port 8080 séparé — nécessaire pour les hébergeurs qui n'exposent
// qu'un seul port en production.
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:5000';

export function useMarketData() {
  const [data, setData] = useState({
    ticks: [],
    indices: [],
    sectors: [],
    comms: [],
    forex: [],
    cryptos: [],
    sp500Intraday: []
  });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  // Gha n-khb3w automatic reconnect timer dynamic reference
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectDelay = 30000; // maximum time limit delay (30 seconds)

  useEffect(() => {
    let ws = null;
    let isComponentMounted = true;

    function connect() {
      // Ila kan chi connection thbta, n-ql3oha before creating a new single client session
      if (ws) {
        ws.close();
      }

      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        if (!isComponentMounted) return;
        setConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0; // Reset counter levels successful login
        console.log('🚀 AtlasQuant WS Stream Connected Successfully');
      };

      ws.onmessage = (event) => {
        if (!isComponentMounted) return;
        try {
          const streamPayload = JSON.parse(event.data);

          setData(prevData => ({
            ...prevData,
            ...streamPayload
          }));
        } catch (err) {
          console.error('⚠️ Parsing mismatch on incoming market payload:', err);
        }
      };

      ws.onerror = (err) => {
        if (!isComponentMounted) return;
        setError('WS Stream Connection Failed');
      };

      ws.onclose = (e) => {
        if (!isComponentMounted) return;
        setConnected(false);
        ws = null;

        // Ila ma-khrejch l-user mn l-page (Component properties explicitly mounted frame)
        // trigger system retry logic pattern tht dynamic limits
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), maxReconnectDelay);
        console.warn(`🔌 Connection dropped. Retrying streaming layout in ${delay}ms... (Attempt ${reconnectAttemptsRef.current + 1})`);

        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptsRef.current += 1;
          connect();
        }, delay);
      };
    }

    connect();

    // Clean up completely structural unmount elements pointers wrappers references
    return () => {
      isComponentMounted = false;
      if (ws) {
        ws.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  return { data, connected, error };
}