import { useEffect, useState, useRef } from 'react';
import api from '../services/api';

// The JWT never goes in the WebSocket URL: before each connection we ask the API for a
// single-use 30 s ticket (POST /auth/ws-ticket, normal Bearer auth) and connect with that.
const TOKEN_KEY = 'aq_token';

// localhost fallback = dev only; production builds must set VITE_WS_URL.
const WS_ROOT = import.meta.env.VITE_WS_URL || (import.meta.env.DEV ? 'ws://localhost:5000' : '');
if (!WS_ROOT) throw new Error('VITE_WS_URL is not set (build-time), e.g. wss://api.example.com');
const WS_BASE = WS_ROOT + '/ws/dashboard';

export function useDashboardData(range = '30') {
  const [data, setData]           = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError]         = useState(null);

  const reconnectTimerRef     = useRef(null);
  const reconnectAttemptsRef  = useRef(0);
  const maxReconnectDelay     = 30000;

  useEffect(() => {
    let ws = null;
    let isComponentMounted = true;

    async function connect() {
      if (!localStorage.getItem(TOKEN_KEY)) {
        setError('Not authenticated');
        return;
      }

      let ticket;
      try {
        const res = await api.post('/auth/ws-ticket');
        ticket = res.data?.ticket;
        if (!ticket) throw new Error('no ticket in response');
      } catch (err) {
        if (!isComponentMounted) return;
        setConnected(false);
        setError('Dashboard stream unavailable');
        scheduleReconnect();
        return;
      }
      if (!isComponentMounted) return;

      if (ws) ws.close();

      ws = new WebSocket(`${WS_BASE}?ticket=${encodeURIComponent(ticket)}&range=${encodeURIComponent(range)}`);

      ws.onopen = () => {
        if (!isComponentMounted) return;
        setConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        if (!isComponentMounted) return;
        try {
          const payload = JSON.parse(event.data);
          setData(payload);
        } catch (err) {
          console.error('[useDashboardData] parse error:', err);
        }
      };

      ws.onerror = () => {
        if (!isComponentMounted) return;
        setError('Dashboard stream connection failed');
      };

      ws.onclose = () => {
        if (!isComponentMounted) return;
        setConnected(false);
        ws = null;

        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), maxReconnectDelay);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectAttemptsRef.current += 1;
        connect();
      }, delay);
    }

    connect();

    return () => {
      isComponentMounted = false;
      if (ws) ws.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // Reconnects whenever `range` changes — a fresh connection with the
    // new range in the query string is simpler than a message-based
    // "change range" protocol for something the user does rarely.
  }, [range]);

  return { data, connected, error };
}