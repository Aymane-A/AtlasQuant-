import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import api from '../services/api';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState('verifying'); // 'verifying' | 'success' | 'error'
  const [error, setError] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setError('Lien de vérification invalide');
      return;
    }
    api.post('/settings/email/verify', { token })
      .then(() => setStatus('success'))
      .catch(err => {
        setStatus('error');
        setError(err?.error || 'Lien de vérification invalide ou expiré');
      });
  }, [searchParams]);

  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg, #0a0b0f)', fontFamily:'JetBrains Mono,monospace',
    }}>
      <div style={{
        background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16,
        padding:'40px 32px', maxWidth:400, textAlign:'center',
      }}>
        {status === 'verifying' && (
          <div style={{ color:'var(--text-secondary)', fontSize:14 }}>Vérification en cours...</div>
        )}
        {status === 'success' && (
          <>
            <div style={{ fontSize:32, marginBottom:16 }}>✓</div>
            <div style={{ color:'var(--green)', fontSize:16, fontWeight:700, marginBottom:8 }}>
              Email vérifié avec succès
            </div>
            <div style={{ color:'var(--text-secondary)', fontSize:13, marginBottom:24 }}>
              Ton adresse email est maintenant confirmée.
            </div>
            <Link to="/settings" style={{
              display:'inline-block', padding:'10px 24px', borderRadius:9,
              border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)',
              color:'var(--cyan)', textDecoration:'none', fontWeight:700, fontSize:13,
            }}>
              Retour aux paramètres
            </Link>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize:32, marginBottom:16 }}>✕</div>
            <div style={{ color:'var(--red)', fontSize:16, fontWeight:700, marginBottom:8 }}>
              Échec de la vérification
            </div>
            <div style={{ color:'var(--text-secondary)', fontSize:13, marginBottom:24 }}>
              {error}
            </div>
            <Link to="/settings" style={{
              display:'inline-block', padding:'10px 24px', borderRadius:9,
              border:'1px solid var(--border)', color:'var(--text-secondary)', textDecoration:'none', fontSize:13,
            }}>
              Retour aux paramètres
            </Link>
          </>
        )}
      </div>
    </div>
  );
}