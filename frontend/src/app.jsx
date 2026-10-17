import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import api from './services/api';

import Layout from './components/Layout';
import { ProtectedRoute as PrivateRoute } from './components/ProtectedRoute';
import Cursor from './components/Cursor';

// Pages are code-split (React.lazy): one chunk per page instead of a single 1.6 MB bundle.
const Login       = lazy(() => import('./pages/Login'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const Landing     = lazy(() => import('./pages/Landing'));
const Dashboard   = lazy(() => import('./pages/Dashboard'));
const Signals     = lazy(() => import('./pages/signals'));
const Markets     = lazy(() => import('./pages/Markets'));
const Portfolio   = lazy(() => import('./pages/Portfolio'));
const Analytics   = lazy(() => import('./pages/Analytics'));
const Screener    = lazy(() => import('./pages/Screener'));
const Watchlist   = lazy(() => import('./pages/Watchlist'));
const Alerts      = lazy(() => import('./pages/Alerts'));
const RiskMatrix  = lazy(() => import('./pages/RiskMatrix'));
const Backtester  = lazy(() => import('./pages/Backtester'));
const AlphaEngine = lazy(() => import('./pages/AlphaEngine'));
const Settings    = lazy(() => import('./pages/Settings'));
const Exchanges   = lazy(() => import('./pages/Exchanges.jsx'));
const Trading     = lazy(() => import('./pages/Trading.jsx'));
const AutoTradeDashboard = lazy(() => import('./pages/AutoTradeDashboard'));

const PageFallback = () => (
  <div style={{ padding: 32, textAlign: 'center', opacity: 0.6 }} role="status" aria-live="polite">
    Loading…
  </div>
);

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
      <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* Public */}
        <Route path="/"      element={<Landing />} />
        <Route path="/login" element={<Login />}   />
        <Route path="/verify-email" element={<VerifyEmail />} />

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
          <Route path="exchanges"   element={<Exchanges />}   />
          <Route path="trading"     element={<Trading />}     />
          <Route path="/paper-trading"  element={<AutoTradeDashboard />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </>
  );
}