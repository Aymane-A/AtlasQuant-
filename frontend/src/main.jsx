import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import './i18n';
import App from './app.jsx';
import './global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={
          <div style={{ background:'#030712', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', color:'#00f5d4', fontFamily:'JetBrains Mono, monospace', fontSize:13 }}>
            Loading...
          </div>
        }>
          <App />
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);