import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import api from './services/api';

import Layout from './components/Layout';
import { ProtectedRoute as PrivateRoute } from './components/ProtectedRoute';
import Cursor from './components/Cursor';

import Login       from './pages/Login';
import Landing     from './pages/Landing';
import Dashboard   from './pages/Dashboard';
import Signals     from './pages/signals';
import Markets     from './pages/Markets';
import Portfolio   from './pages/Portfolio';
import Analytics   from './pages/Analytics';
import Screener    from './pages/Screener';
import Watchlist   from './pages/Watchlist';
import Alerts      from './pages/Alerts';
import RiskMatrix  from './pages/RiskMatrix';
import Backtester  from './pages/Backtester';
import AlphaEngine from './pages/AlphaEngine';
import Settings    from './pages/Settings';
import ApiKeys     from './pages/ApiKeys';

export default function App() {
  const { user } = useAuth();

  // Load theme only after user is authenticated
  useEffect(() => {
    if (!user) return;
    api.get('/settings')
      .then(res => {
        if (res.data?.settings?.theme === 'light') {
          document.body.classList.add('light');
        } else {
          document.body.classList.remove('light');
        }
      })
      .catch(() => {});
  }, [user]);

  return (
    <>
      <Cursor />
      <Routes>
        {/* Public */}
        <Route path="/"      element={<Landing />} />
        <Route path="/login" element={<Login />}   />

        {/* Protected */}
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route path="dashboard"   element={<Dashboard />}   />
          <Route path="signals"     element={<Signals />}     />
          <Route path="markets"     element={<Markets />}     />
          <Route path="portfolio"   element={<Portfolio />}   />
          <Route path="analytics"   element={<Analytics />}   />
          <Route path="screener"    element={<Screener />}    />
          <Route path="watchlist"   element={<Watchlist />}   />
          <Route path="alerts"      element={<Alerts />}      />
          <Route path="risk_matrix" element={<RiskMatrix />}  />
          <Route path="backtester"  element={<Backtester />}  />
          <Route path="alpha_engine" element={<AlphaEngine />}/>
          <Route path="settings"    element={<Settings />}    />
          <Route path="api_keys"    element={<ApiKeys />}     />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}