import { useEffect, useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { alertsAPI } from '../services/api';
import api from '../services/api';

// ✅ Feature: petit Levenshtein maison — pas de dépendance externe pour un
// besoin aussi simple. Sert à proposer des corrections quand ce que tape
// l'utilisateur ne matche aucun symbole connu exactement (fautes de frappe).
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// ✅ Feature: wildcards de classe — couvrent toute une classe d'actifs sans
// devoir taper chaque ticker un par un.
const WILDCARDS = [
  { key:'ALL_CRYPTO',    label:'All Crypto'    },
  { key:'ALL_FOREX',     label:'All Forex'     },
  { key:'ALL_COMMODITY', label:'All Commodity' },
  { key:'ALL_INDICES',   label:'All Indices'   },
];

// ✅ Feature: durées de snooze proposées pour les alertes actives
const SNOOZE_OPTS = [
  { label:'1h',  hours:1  },
  { label:'4h',  hours:4  },
  { label:'24h', hours:24 },
];

// ✅ Feature: petit beep synthétique (Web Audio API) — pas de fichier audio à
// héberger, marche offline, taille zéro.
function playAlertBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.35);
    setTimeout(() => ctx.close(), 500);
  } catch { /* environnement sans Web Audio, non-bloquant */ }
}

// ✅ Fix: modal de confirmation custom qui respecte le design de l'app
// (dark/neon), remplace window.confirm() natif qui cassait le style SaaS
// (barre de titre "Code", boutons OS par défaut). Réutilisable pour
// n'importe quelle action destructive dans l'app.
function ConfirmModal({ open, title, message, confirmLabel = 'Confirm', danger = true, onConfirm, onCancel }) {
  if (!open) return null;

  return (
    <div
      onClick={onCancel}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(5,8,16,0.72)', backdropFilter:'blur(3px)',
        display:'flex', alignItems:'center', justifyContent:'center',
        animation:'fadeIn .15s ease',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width:'min(400px, 90vw)', background:'var(--surface, #0a0f1e)',
          border:`1px solid ${danger ? 'rgba(248,113,113,0.3)' : 'var(--cyan-dim)'}`,
          borderRadius:14, padding:24,
          boxShadow:`0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)`,
          animation:'slideUp .18s ease',
        }}
      >
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
          <div style={{
            width:32, height:32, borderRadius:8, flexShrink:0,
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:15,
            background: danger ? 'rgba(248,113,113,0.12)' : 'rgba(0,245,212,0.1)',
            color: danger ? 'var(--red)' : 'var(--cyan)',
          }}>
            {danger ? '⚠️' : 'ℹ️'}
          </div>
          <div style={{ fontSize:14, fontWeight:700, fontFamily:'Syne,sans-serif' }}>{title}</div>
        </div>

        <div style={{ fontSize:12, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', lineHeight:1.6, marginBottom:22 }}>
          {message}
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding:'9px 18px', borderRadius:8, border:'1px solid var(--border)',
              background:'transparent', color:'var(--text-secondary)',
              fontFamily:'JetBrains Mono,monospace', fontSize:12, fontWeight:600, cursor:'pointer',
              transition:'all .15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.25)'; e.currentTarget.style.color='var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.color='var(--text-secondary)'; }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding:'9px 18px', borderRadius:8, border:`1px solid ${danger ? 'rgba(248,113,113,0.4)' : 'var(--cyan-dim)'}`,
              background: danger ? 'rgba(248,113,113,0.12)' : 'var(--cyan-glow)',
              color: danger ? 'var(--red)' : 'var(--cyan)',
              fontFamily:'Syne,sans-serif', fontSize:12, fontWeight:700, cursor:'pointer',
              transition:'all .15s',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes slideUp { from { opacity:0; transform:translateY(8px) scale(.98) } to { opacity:1; transform:translateY(0) scale(1) } }
      `}</style>
    </div>
  );
}

// ✅ Feature: toasts in-app pour les nouveaux triggers — marchent MÊME si
// l'utilisateur n'a jamais accordé la permission navigateur (contrairement
// à Notification API), donc c'est le canal garanti. Empilés en haut à droite,
// auto-dismiss après 6s.
function ToastStack({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{
      position:'fixed', top:20, right:20, zIndex:900,
      display:'flex', flexDirection:'column', gap:8, width:320, maxWidth:'90vw',
    }}>
      {toasts.map(toast => (
        <div key={toast.id} style={{
          display:'flex', gap:10, alignItems:'flex-start',
          background:'var(--surface, #0a0f1e)', border:'1px solid var(--cyan-dim)',
          borderRadius:10, padding:'12px 14px',
          boxShadow:'0 10px 30px rgba(0,0,0,0.5)',
          animation:'toastIn .2s ease',
        }}>
          <div style={{ fontSize:16 }}>🤖</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:12, fontWeight:700, marginBottom:2 }}>{toast.title}</div>
            <div style={{ fontSize:10, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>{toast.desc}</div>
          </div>
          <span onClick={() => onDismiss(toast.id)} style={{ cursor:'pointer', color:'var(--text-muted)', fontSize:12, padding:'2px 4px' }}>✕</span>
        </div>
      ))}
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateX(20px) } to { opacity:1; transform:translateX(0) } }`}</style>
    </div>
  );
}

export default function Alerts() {
  const { t } = useTranslation();
  const a = key => t(`alerts.${key}`);

  // ✅ Fix Bug 2: 'typeAiSignal' n'existe probablement pas dans les fichiers
  // de traduction (type ajouté après coup, généré par le backend, jamais
  // choisi via le formulaire). On l'affiche directement en clair plutôt que
  // de risquer d'afficher la clé brute "alerts.typeAiSignal" non traduite.
  const typeLabel = key => key === 'typeAiSignal' ? 'AI Signal' : a(key);

  const [form, setForm]         = useState({ symbol:'', type:'typePrice', condition:'above', value:'', notify:'once' });
  const [channels, setChannels] = useState({ inapp:true, email:true, telegram:false, sms:false });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const toggleChannel = k => setChannels(c => ({ ...c, [k]: !c[k] }));

  const [submitted, setSubmitted] = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'history'
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [data, setData]           = useState({ stats:null, notifications:[], alerts:[] });
  const [history, setHistory]     = useState([]);

  // ✅ Fix: state du ConfirmModal (remplace window.confirm natif)
  const [confirmState, setConfirmState] = useState({ open:false, title:'', message:'', onConfirm:null });
  const closeConfirm = () => setConfirmState(s => ({ ...s, open:false }));
  const askConfirm = ({ title, message, confirmLabel, danger, onConfirm }) => {
    setConfirmState({
      open:true, title, message, confirmLabel, danger,
      onConfirm: async () => { closeConfirm(); await onConfirm(); },
    });
  };

  // ✅ Feature: notifications navigateur + son quand un nouvel alert AI se
  // déclenche, sans dépendre d'un WebSocket dédié — on compare simplement les
  // IDs entre deux polls (déjà à 30s) et on notifie ce qui est nouveau.
  const [notifyEnabled, setNotifyEnabled] = useState(
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  );
  const notifyEnabledRef = useRef(notifyEnabled);
  useEffect(() => { notifyEnabledRef.current = notifyEnabled; }, [notifyEnabled]);
  const knownNotifIdsRef = useRef(null); // null = premier chargement, on ne spam pas au démarrage

  const enableBrowserNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const perm = await Notification.requestPermission();
      setNotifyEnabled(perm === 'granted');
    } catch { /* refusé ou non-supporté, on ignore silencieusement */ }
  };

  // ✅ Feature: "soft-ask" — explique le bénéfice AVANT de déclencher le
  // popup natif du navigateur (celui-ci ne peut pas être stylé, c'est une
  // protection du navigateur contre le spoofing). Rend le flow moins abrupt:
  // l'utilisateur voit d'abord notre modal, PUIS le popup natif s'il accepte.
  const askEnableNotifications = () => {
    if (notifyEnabled) return;
    askConfirm({
      title: 'Enable browser notifications',
      message: "Get notified the instant a high-confidence AI signal triggers, even when this tab isn't focused. Your browser will ask you to confirm this next.",
      confirmLabel: 'Continue',
      danger: false,
      onConfirm: enableBrowserNotifications,
    });
  };

  // ✅ Feature: toasts in-app — canal garanti, indépendant de la permission
  // navigateur.
  const [toasts, setToasts] = useState([]);
  const pushToast = (title, desc) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(ts => [...ts, { id, title, desc }].slice(-4));
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 6000);
  };
  const dismissToast = (id) => setToasts(ts => ts.filter(t => t.id !== id));

  // ✅ Feature: préférences AI Signal Alerts — Follow All vs Custom (liste de
  // symboles précis tapés par l'utilisateur, ex. BTC, AAPL, EURUSD) + seuil
  // de confiance minimum
  const [alertPrefs, setAlertPrefs]     = useState({ mode:'all', symbols:[] });
  const [minConfidence, setMinConfidence] = useState(75);
  const [symbolInput, setSymbolInput]   = useState('');
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [prefsSaving, setPrefsSaving]   = useState(false);
  const [prefsSaved, setPrefsSaved]     = useState(false);

  // ✅ Feature: liste des symboles réellement scannés par AtlasQuant (crypto +
  // forex + commodities + indices), utilisée pour l'autocomplete/fuzzy-match
  // afin que l'utilisateur ne puisse pas taper un ticker inexistant sans s'en
  // rendre compte.
  const [knownSymbols, setKnownSymbols] = useState([]);
  useEffect(() => {
    api.get('/signals/meta/supported')
      .then(res => { if (res.data?.success) setKnownSymbols(res.data.symbols || []); })
      .catch(() => { /* autocomplete juste indisponible, pas bloquant */ });
  }, []);

  // Suggestions: substring match en priorité, sinon fuzzy (distance ≤ 3) pour
  // couvrir les fautes de frappe (ex. "BYC" → "BTC").
  const symbolSuggestions = useMemo(() => {
    const q = symbolInput.toUpperCase().trim();
    if (!q || knownSymbols.length === 0) return [];
    const substringMatches = knownSymbols.filter(s => s.symbol?.toUpperCase().includes(q));
    if (substringMatches.length > 0) return substringMatches.slice(0, 6);
    return knownSymbols
      .map(s => ({ ...s, _dist: levenshtein(q, (s.symbol || '').toUpperCase()) }))
      .sort((x, y) => x._dist - y._dist)
      .filter(s => s._dist <= 3)
      .slice(0, 6);
  }, [symbolInput, knownSymbols]);

  const loadAlerts = async () => {
    try {
      const res = await alertsAPI.getAll();
      const newNotifs = res.data.notifications || [];

      // ✅ Feature: détecte les nouveaux triggers vs. le poll précédent
      if (knownNotifIdsRef.current) {
        const freshOnes = newNotifs.filter(n => !knownNotifIdsRef.current.has(n.id));
        if (freshOnes.length > 0) {
          // Toast in-app: toujours affiché, indépendant de la permission navigateur
          freshOnes.slice(0, 3).forEach(n => pushToast(n.title, n.desc));
          if (notifyEnabledRef.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            freshOnes.slice(0, 3).forEach(n => {
              try { new Notification(n.title, { body: n.desc, icon: '/favicon.ico', tag: `alert-${n.id}` }); } catch {}
            });
          }
          if (notifyEnabledRef.current) playAlertBeep();
        }
      }
      knownNotifIdsRef.current = new Set(newNotifs.map(n => n.id));

      setData({
        stats:         res.data.stats,
        notifications: newNotifs,
        alerts:        res.data.alerts || [],
      });
      setError('');
    } catch (err) {
      setError(err.error || 'Alerts unavailable');
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    try {
      const res = await alertsAPI.getHistory();
      setHistory(res.data.history || []);
    } catch {}
  };

  // ✅ Feature: charge les préférences AI Signal Alerts existantes
  const loadAlertPrefs = async () => {
    setPrefsLoading(true);
    try {
      const res = await api.get('/settings');
      const s = res.data?.settings || {};
      setAlertPrefs({
        mode:    s.signal_alert_mode === 'custom' ? 'custom' : 'all',
        symbols: Array.isArray(s.signal_alert_symbols) ? s.signal_alert_symbols : [],
      });
      setMinConfidence(
        Number.isFinite(s.signal_alert_min_confidence) ? s.signal_alert_min_confidence : 75
      );
    } catch { /* garde les valeurs par défaut si l'appel échoue */ }
    finally { setPrefsLoading(false); }
  };

  useEffect(() => {
    loadAlerts();
    loadHistory();
    loadAlertPrefs();
    const id = setInterval(() => { loadAlerts(); loadHistory(); }, 30000);
    return () => clearInterval(id);
  }, []);

  // ✅ Fix: delete/reset individuels passent aussi par le ConfirmModal —
  // cohérence UX (avant: delete silencieux en un clic, clear-all seul avec
  // confirm natif — asymétrie corrigée)
  const handleDelete = (id, sym) => {
    askConfirm({
      title: 'Delete alert',
      message: `Delete the alert for ${sym || 'this symbol'}? This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        try { await alertsAPI.remove(id); loadAlerts(); loadHistory(); }
        catch { setError('Failed to delete alert'); }
      },
    });
  };

  const handlePause = async (id) => {
    try { await alertsAPI.togglePause(id); loadAlerts(); }
    catch { setError('Failed to pause alert'); }
  };

  // ✅ Feature: Snooze — met l'alerte en pause pour une durée précise plutôt
  // qu'indéfiniment. NÉCESSITE un endpoint backend PATCH /api/alerts/:id/snooze
  // qui accepte { hours } et calcule paused_until = NOW() + hours. Voir note
  // en fin de réponse pour le snippet à ajouter côté alerts.controller.js.
  const [snoozeMenuId, setSnoozeMenuId] = useState(null);
  const handleSnooze = async (id, hours) => {
    setSnoozeMenuId(null);
    try {
      await api.patch(`/alerts/${id}/snooze`, { hours });
      loadAlerts();
    } catch {
      setError('Failed to snooze alert — backend endpoint may be missing');
    }
  };

  const handleReset = async (id) => {
    try { await alertsAPI.reset(id); loadAlerts(); loadHistory(); }
    catch { setError('Failed to reset alert'); }
  };

  // ✅ Feature: "Clear All" — supprime tous les alerts déclenchés d'un coup
  // (Notification Feed ET History, car ils partagent les mêmes lignes
  // triggered=true côté backend). Passe par le ConfirmModal custom.
  const handleClearAll = () => {
    if (notifications.length === 0) return;
    askConfirm({
      title: 'Clear all triggered alerts',
      message: `Clear all ${notifications.length} triggered alerts? This also removes them from History.`,
      confirmLabel: 'Clear All',
      danger: true,
      onConfirm: async () => {
        try {
          await api.delete('/alerts/triggered/all');
          loadAlerts();
          loadHistory();
        } catch {
          setError('Failed to clear alerts');
        }
      },
    });
  };

  // ✅ Fix "unread" mzawer: marque une notification comme lue au clic
  const handleMarkRead = async (id) => {
    try {
      await api.patch(`/alerts/${id}/read`);
      setData(d => ({
        ...d,
        notifications: d.notifications.map(n => n.id === id ? { ...n, unread: false } : n),
      }));
    } catch { /* non-bloquant */ }
  };

  const handleMarkAllRead = async () => {
    if (notifications.filter(n => n.unread).length === 0) return;
    try {
      await api.patch('/alerts/read-all');
      setData(d => ({
        ...d,
        notifications: d.notifications.map(n => ({ ...n, unread: false })),
      }));
    } catch {
      setError('Failed to mark alerts as read');
    }
  };

  const handleCreate = async () => {
    if (!form.symbol || !form.value) return;
    try {
      const activeChannels = Object.entries(channels).filter(([,v]) => v).map(([k]) => k);
      await alertsAPI.create({
        symbol: form.symbol, type: form.type,
        condition: form.condition, value: form.value,
        notify: form.notify, channels: activeChannels,
      });
      setSubmitted(true);
      setForm({ symbol:'', type:'typePrice', condition:'above', value:'', notify:'once' });
      setChannels({ inapp:true, email:true, telegram:false, sms:false });
      loadAlerts();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create alert');
    }
  };

  // ✅ Feature: ajoute un symbole (ou un wildcard de classe) à la liste suivie
  const addSymbolValue = (raw) => {
    const sym = String(raw).toUpperCase().trim();
    if (!sym) return;
    setPrefsSaved(false);
    setAlertPrefs(p => p.symbols.includes(sym) ? p : { ...p, symbols: [...p.symbols, sym] });
    setSymbolInput('');
  };

  const addSymbol = () => addSymbolValue(symbolInput);

  const removeSymbol = (sym) => {
    setPrefsSaved(false);
    setAlertPrefs(p => ({ ...p, symbols: p.symbols.filter(s => s !== sym) }));
  };

  const handleSymbolKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      // Si une suggestion existe et que ce qui est tapé ne matche aucun
      // symbole connu exactement, on prend la meilleure suggestion — évite
      // d'ajouter un ticker mal orthographié tel quel.
      const q = symbolInput.toUpperCase().trim();
      const exact = knownSymbols.find(s => s.symbol?.toUpperCase() === q);
      if (!exact && symbolSuggestions[0]) {
        addSymbolValue(symbolSuggestions[0].symbol);
      } else {
        addSymbol();
      }
    }
  };

  const setPrefsMode = (mode) => {
    setPrefsSaved(false);
    setAlertPrefs(p => ({ ...p, mode }));
  };

  const handleConfidenceChange = (e) => {
    setPrefsSaved(false);
    setMinConfidence(Number(e.target.value));
  };

  const savePrefs = async () => {
    if (alertPrefs.mode === 'custom' && alertPrefs.symbols.length === 0) {
      setError('Add at least one symbol to follow');
      return;
    }
    setPrefsSaving(true);
    try {
      await api.post('/settings/update', {
        section: 'signalAlerts',
        payload: { mode: alertPrefs.mode, symbols: alertPrefs.symbols, minConfidence },
      });
      setPrefsSaved(true);
      setError('');
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save alert preferences');
    } finally {
      setPrefsSaving(false);
    }
  };

  // ── Filtered alert cards by search ───────────────────────
  const filteredCards = useMemo(() =>
    (data.alerts || []).filter(c =>
      !search || c.sym.toLowerCase().includes(search.toLowerCase())
    ), [data.alerts, search]);

  const filteredHistory = useMemo(() =>
    history.filter(h =>
      !search || h.sym.toLowerCase().includes(search.toLowerCase())
    ), [history, search]);

  // ✅ Feature: grouping de l'History par symbole (utile quand un même ticker
  // se déclenche plusieurs fois en peu de temps, ex. FILUSDT x5)
  const [groupBySymbol, setGroupBySymbol] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const toggleGroup = (sym) => setExpandedGroups(s => {
    const next = new Set(s);
    next.has(sym) ? next.delete(sym) : next.add(sym);
    return next;
  });
  const groupedHistory = useMemo(() => {
    const map = new Map();
    filteredHistory.forEach(h => {
      if (!map.has(h.sym)) map.set(h.sym, []);
      map.get(h.sym).push(h);
    });
    return Array.from(map.entries())
      .map(([sym, items]) => ({ sym, items }))
      .sort((x, y) => y.items.length - x.items.length);
  }, [filteredHistory]);

  // ✅ Feature: export History en CSV, généré côté client — pas besoin
  // d'endpoint backend dédié.
  const handleExportCSV = () => {
    if (filteredHistory.length === 0) return;
    const headers = ['Symbol', 'Type', 'Condition', 'Target', 'Triggered At'];
    const rows = filteredHistory.map(h => [
      h.sym,
      typeLabel(h.typeKey),
      h.condition ?? '',
      h.target ?? '',
      h.triggeredAt ? new Date(h.triggeredAt).toISOString() : '',
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `atlasquant-alerts-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const inp = {
    width:'100%', padding:'10px 13px', borderRadius:8,
    border:'1px solid var(--border)', background:'rgba(255,255,255,0.04)',
    color:'var(--text-primary)', fontFamily:'JetBrains Mono,monospace',
    fontSize:12, outline:'none',
  };

  const ALERT_TYPES = ['typePrice','typeRsi','typeMacd','typeVolume','typePct'];
  const NOTIFY_OPTS = [
    { val:'once',   labelKey:'notifyOnce'   },
    { val:'always', labelKey:'notifyAlways' },
    { val:'daily',  labelKey:'notifyDaily'  },
  ];
  const CHANNEL_OPTS = [
    { key:'inapp',    label:'In-App',   icon:'🔔', always:true  },
    { key:'email',    label:'Email',    icon:'📧', always:false },
    { key:'telegram', label:'Telegram', icon:'✈️', always:false },
    { key:'sms',      label:'SMS',      icon:'💬', always:false, disabled:true },
  ];

  const STAT_CARDS = [
    { labelKey:'statActive',    v:data.stats?.active    ?? 0, color:'var(--cyan)'          },
    { labelKey:'statTriggered', v:data.stats?.triggered ?? 0, color:'var(--amber)'         },
    { labelKey:'statNear',      v:data.stats?.near      ?? 0, color:'var(--red)'           },
    { labelKey:'statPaused',    v:data.stats?.paused    ?? 0, color:'var(--text-secondary)'},
  ];

  const notifications = data.notifications || [];
  const unreadCount   = notifications.filter(n => n.unread).length;

  const iconBtn = (onClick, title, hoverColor='var(--red)') => ({
    onClick, title,
    style: {
      background:'transparent', border:'none', cursor:'pointer',
      color:'var(--text-muted)', fontSize:13, padding:'4px 6px',
      borderRadius:6, transition:'color .15s', fontFamily:'JetBrains Mono,monospace',
    },
    onMouseEnter: e => e.currentTarget.style.color = hoverColor,
    onMouseLeave: e => e.currentTarget.style.color = 'var(--text-muted)',
  });

  const tabStyle = (tab) => ({
    padding:'7px 18px', borderRadius:7, border:'none', cursor:'pointer',
    fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600,
    letterSpacing:'.06em', textTransform:'uppercase',
    background: activeTab === tab ? 'rgba(0,245,212,0.12)' : 'transparent',
    color:      activeTab === tab ? 'var(--cyan)' : 'var(--text-muted)',
    transition: 'all .15s',
  });

  const smallBtn = {
    background:'transparent', border:'1px solid rgba(255,255,255,0.1)',
    color:'var(--text-muted)', fontSize:9, fontFamily:'JetBrains Mono,monospace',
    padding:'3px 10px', borderRadius:5, cursor:'pointer', transition:'all .15s',
  };

  return (
    <>
      <ConfirmModal
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        danger={confirmState.danger}
        onConfirm={confirmState.onConfirm}
        onCancel={closeConfirm}
      />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {loading && (
        <div style={{ padding:'10px 14px', border:'1px solid var(--border)', borderRadius:10, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
          Loading alerts...
        </div>
      )}
      {error && (
        <div style={{ padding:'10px 14px', border:'1px solid rgba(248,113,113,0.25)', background:'rgba(248,113,113,0.08)', borderRadius:10, color:'var(--red)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
          {error}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:4 }}>
            {a('pageEngine')}
          </div>
          <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
            {a('pageSubtitle')}
          </div>
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          {/* ✅ Feature: notifications navigateur + son */}
          <button
            onClick={askEnableNotifications}
            disabled={notifyEnabled}
            title={notifyEnabled ? 'Browser notifications enabled' : 'Enable browser notifications for new alerts'}
            style={{
              padding:'9px 14px', borderRadius:8, cursor: notifyEnabled ? 'default' : 'pointer',
              border:`1px solid ${notifyEnabled ? 'rgba(52,211,153,0.3)' : 'var(--border)'}`,
              background: notifyEnabled ? 'rgba(52,211,153,0.08)' : 'transparent',
              color: notifyEnabled ? 'var(--green)' : 'var(--text-secondary)',
              fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600,
              display:'flex', alignItems:'center', gap:6,
            }}
          >
            {notifyEnabled ? '🔔 Notifications on' : '🔕 Enable notifications'}
          </button>
          <button
            onClick={() => { setShowForm(true); setSubmitted(false); }}
            style={{ padding:'10px 22px', borderRadius:8, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer' }}
          >
            {a('newAlert')}
          </button>
        </div>
      </div>

      {/* ══ AI SIGNAL ALERT PREFERENCES ══ */}
      {/* ✅ Feature: choix entre "suivre tout" et "suivre seulement certaines
          classes d'actifs" pour les alertes AI auto-générées (signalAlert.service.js) */}
      <div className="panel" style={{ padding:20 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:10 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--purple-bright, #a78bfa)' }} />
              🤖 AI Signal Alerts
            </div>
            <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>
              Auto-alerts for high-confidence signals — choose what to follow
            </div>
          </div>
          {!prefsLoading && (
            <button onClick={savePrefs} disabled={prefsSaving} style={{
              padding:'8px 18px', borderRadius:8, border:'1px solid var(--cyan-dim)',
              background: prefsSaved ? 'rgba(52,211,153,0.1)' : 'var(--cyan-glow)',
              color: prefsSaved ? 'var(--green)' : 'var(--cyan)',
              fontFamily:'Syne,sans-serif', fontSize:12, fontWeight:700,
              cursor: prefsSaving ? 'not-allowed' : 'pointer', opacity: prefsSaving ? 0.7 : 1,
            }}>
              {prefsSaving ? 'Saving...' : prefsSaved ? '✓ Saved' : 'Save preferences'}
            </button>
          )}
        </div>

        {prefsLoading ? (
          <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>Loading preferences...</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {/* Mode choice */}
            <div style={{ display:'flex', gap:10 }}>
              {[
                { val:'all',    label:'Follow Everything', desc:'Get alerted on every high-confidence signal, any asset class' },
                { val:'custom', label:'Custom',             desc:'Only follow specific symbols you choose' },
              ].map(opt => (
                <button key={opt.val} onClick={() => setPrefsMode(opt.val)} style={{
                  flex:1, textAlign:'left', padding:'12px 16px', borderRadius:10, cursor:'pointer',
                  border:`1px solid ${alertPrefs.mode===opt.val ? 'var(--cyan-dim)' : 'var(--border)'}`,
                  background: alertPrefs.mode===opt.val ? 'rgba(0,245,212,0.06)' : 'transparent',
                  transition:'all .15s',
                }}>
                  <div style={{ fontSize:12, fontWeight:700, color: alertPrefs.mode===opt.val ? 'var(--cyan)' : 'var(--text-primary)', marginBottom:3 }}>
                    {alertPrefs.mode===opt.val ? '● ' : '○ '}{opt.label}
                  </div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', lineHeight:1.5 }}>
                    {opt.desc}
                  </div>
                </button>
              ))}
            </div>

            {/* ✅ Feature: seuil de confiance minimum, s'applique aux deux modes */}
            <div style={{ padding:'12px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <span style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace' }}>
                  Minimum confidence to alert
                </span>
                <span style={{ fontSize:14, fontWeight:700, color:'var(--cyan)', fontFamily:'JetBrains Mono,monospace' }}>
                  {minConfidence}%
                </span>
              </div>
              <input
                type="range" min={50} max={95} step={5}
                value={minConfidence} onChange={handleConfidenceChange}
                style={{ width:'100%', accentColor:'var(--cyan, #00f5d4)' }}
              />
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:4 }}>
                <span>50% (more alerts)</span>
                <span>95% (only strongest signals)</span>
              </div>
            </div>

            {/* Symbol watchlist — only when 'custom' */}
            {alertPrefs.mode === 'custom' && (
              <div style={{ padding:'12px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:10 }}>

                {/* Wildcard quick-add */}
                <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
                  {WILDCARDS.map(w => {
                    const active = alertPrefs.symbols.includes(w.key);
                    return (
                      <button key={w.key} onClick={() => addSymbolValue(w.key)} disabled={active} style={{
                        padding:'5px 12px', borderRadius:20, cursor: active ? 'default' : 'pointer',
                        fontFamily:'JetBrains Mono,monospace', fontSize:10, fontWeight:600,
                        border:`1px solid ${active ? 'rgba(167,139,250,0.15)' : 'rgba(167,139,250,0.3)'}`,
                        background: active ? 'rgba(167,139,250,0.05)' : 'rgba(167,139,250,0.1)',
                        color: active ? 'rgba(167,139,250,0.4)' : '#a78bfa',
                        opacity: active ? 0.6 : 1,
                      }}>
                        🌐 {w.label}{active ? ' ✓' : ''}
                      </button>
                    );
                  })}
                </div>

                {/* Text input + autocomplete dropdown */}
                <div style={{ position:'relative' }}>
                  <div style={{ display:'flex', gap:8 }}>
                    <input
                      style={{ ...inp, flex:1 }}
                      placeholder="Type a symbol (BTC, AAPL, EURUSD...) — suggestions appear below"
                      value={symbolInput}
                      onChange={e => setSymbolInput(e.target.value)}
                      onKeyDown={handleSymbolKeyDown}
                    />
                    <button onClick={addSymbol} style={{
                      padding:'0 18px', borderRadius:8, border:'1px solid var(--cyan-dim)',
                      background:'rgba(0,245,212,0.08)', color:'var(--cyan)',
                      fontFamily:'JetBrains Mono,monospace', fontSize:12, fontWeight:700, cursor:'pointer',
                    }}>
                      + Add
                    </button>
                  </div>

                  {/* Live suggestions — ✅ Feature: le système propose les
                      symboles réellement suivis par AtlasQuant, tolère les
                      fautes de frappe via fuzzy match */}
                  {symbolSuggestions.length > 0 && (
                    <div style={{
                      position:'absolute', top:'calc(100% + 4px)', left:0, right:90, zIndex:20,
                      background:'#0a0f1e', border:'1px solid var(--cyan-dim)', borderRadius:8,
                      boxShadow:'0 8px 24px rgba(0,0,0,0.5)', overflow:'hidden',
                    }}>
                      {symbolSuggestions.map(s => (
                        <div key={s.symbol} onClick={() => addSymbolValue(s.symbol)} style={{
                          padding:'8px 14px', cursor:'pointer', display:'flex',
                          justifyContent:'space-between', alignItems:'center',
                          fontFamily:'JetBrains Mono,monospace', fontSize:11,
                          borderBottom:'1px solid rgba(255,255,255,0.05)',
                        }}
                          onMouseEnter={e => e.currentTarget.style.background='rgba(0,245,212,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background='transparent'}
                        >
                          <span style={{ color:'var(--text-primary)', fontWeight:700 }}>{s.symbol}</span>
                          <span style={{ color:'var(--text-muted)', fontSize:9 }}>{s.asset_class}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Chips */}
                {alertPrefs.symbols.length === 0 ? (
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:10 }}>
                    No symbols yet — add tickers above, or use "All Crypto" / "All Forex" / etc.
                  </div>
                ) : (
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:10 }}>
                    {alertPrefs.symbols.map(sym => {
                      const isWildcard = sym.startsWith('ALL_');
                      const wLabel = isWildcard ? WILDCARDS.find(w => w.key === sym)?.label || sym : sym;
                      return (
                        <span key={sym} style={{
                          display:'flex', alignItems:'center', gap:6,
                          padding:'6px 10px 6px 14px', borderRadius:20,
                          border:`1px solid ${isWildcard ? 'rgba(167,139,250,0.3)' : 'var(--cyan-dim)'}`,
                          background: isWildcard ? 'rgba(167,139,250,0.1)' : 'rgba(0,245,212,0.1)',
                          color: isWildcard ? '#a78bfa' : 'var(--cyan)',
                          fontFamily:'JetBrains Mono,monospace', fontSize:11, fontWeight:600,
                        }}>
                          {isWildcard ? '🌐 ' : ''}{wLabel}
                          <span onClick={() => removeSymbol(sym)} style={{ cursor:'pointer', opacity:0.7, fontWeight:700, padding:'0 2px' }}>✕</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
        {STAT_CARDS.map(k => (
          <div key={k.labelKey} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'18px 20px' }}>
            <div style={{ fontSize:10, letterSpacing:'.12em', color:'var(--text-secondary)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:10 }}>
              {a(k.labelKey)}
            </div>
            <div style={{ fontSize:28, fontWeight:700, color:k.color }}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Feed + Form */}
      <div style={{ display:'grid', gridTemplateColumns: showForm ? '1fr 1fr' : '1fr', gap:16 }}>

        {/* Notification Feed */}
        <div className="panel" style={{ padding:22 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ background:'rgba(248,113,113,0.15)', color:'var(--red)', fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'2px 8px', borderRadius:5 }}>
                {t('alerts.unread', { count: unreadCount })}
              </span>
              {unreadCount > 0 && (
                <button onClick={handleMarkAllRead} title="Mark all as read" style={smallBtn}
                  onMouseEnter={e => { e.currentTarget.style.borderColor='var(--cyan-dim)'; e.currentTarget.style.color='var(--cyan)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; e.currentTarget.style.color='var(--text-muted)'; }}
                >
                  ✓ Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button onClick={handleClearAll} title="Delete all triggered alerts" style={smallBtn}
                  onMouseEnter={e => { e.currentTarget.style.borderColor='rgba(244,63,94,0.4)'; e.currentTarget.style.color='var(--red)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; e.currentTarget.style.color='var(--text-muted)'; }}
                >
                  🗑 Clear All
                </button>
              )}
            </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {notifications.length === 0 && (
              <div style={{ padding:'20px 0', textAlign:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
                No triggered alerts yet
              </div>
            )}
            {notifications.map((n) => (
              <div key={n.id} onClick={() => n.unread && handleMarkRead(n.id)} style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'12px 14px', borderRadius:10, cursor: n.unread ? 'pointer' : 'default', background: n.unread ? 'rgba(251,191,36,0.03)' : 'rgba(255,255,255,0.02)', border:`1px solid ${n.unread ? 'rgba(251,191,36,0.25)' : 'var(--border)'}` }}>
                <div style={{ width:34, height:34, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, background:n.bg, color:n.color, flexShrink:0 }}>
                  {n.icon}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, marginBottom:3 }}>{n.title}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', lineHeight:1.5 }}>{n.desc}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', marginTop:4 }}>
                    {t('alerts.timeAgo', { time: n.time })}
                  </div>
                </div>
                {n.unread && <div style={{ width:7, height:7, borderRadius:'50%', background:'var(--amber)', flexShrink:0 }} />}
              </div>
            ))}
          </div>
        </div>

        {/* Create Alert */}
        {showForm && (
          <div className="panel" style={{ padding:22 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
              <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--green)' }} />
                {a('createTitle')}
              </div>
              <button onClick={() => setShowForm(false)} style={{ background:'transparent', border:'none', color:'var(--text-muted)', fontSize:16, cursor:'pointer', padding:'2px 6px' }}>✕</button>
            </div>
            {submitted ? (
              <div style={{ textAlign:'center', padding:40, color:'var(--green)', fontFamily:'JetBrains Mono,monospace' }}>
                {a('successMsg')}
                <br />
                <button onClick={() => setSubmitted(false)} style={{ marginTop:16, padding:'8px 20px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', fontSize:12, cursor:'pointer' }}>
                  {a('newBtn')}
                </button>
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <input style={inp} placeholder={a('symPlaceholder')} value={form.symbol} onChange={set('symbol')} />
                  <select style={{ ...inp, color:'var(--text-secondary)' }} value={form.type} onChange={set('type')}>
                    {ALERT_TYPES.map(tk => <option key={tk} value={tk}>{a(tk)}</option>)}
                  </select>
                </div>
                <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, padding:3 }}>
                  {['above','below','equal'].map(c => (
                    <button key={c} onClick={() => setForm(f => ({ ...f, condition:c }))}
                      style={{ flex:1, padding:7, borderRadius:6, border:'none', fontFamily:'JetBrains Mono,monospace', fontSize:11, cursor:'pointer', background: form.condition===c ? 'rgba(0,245,212,0.12)' : 'transparent', color: form.condition===c ? 'var(--cyan)' : 'var(--text-secondary)' }}>
                      {c==='above' ? a('condAbove') : c==='below' ? a('condBelow') : a('condEqual')}
                    </button>
                  ))}
                </div>
                <input style={inp} placeholder={a('valuePlaceholder')} value={form.value} onChange={set('value')} type="number" />
                <select style={{ ...inp, color:'var(--text-secondary)' }} value={form.notify} onChange={set('notify')}>
                  {NOTIFY_OPTS.map(o => <option key={o.val} value={o.val}>{a(o.labelKey)}</option>)}
                </select>
                <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:8, padding:'12px 14px' }}>
                  <div style={{ fontSize:10, letterSpacing:'.1em', color:'var(--text-muted)', textTransform:'uppercase', fontFamily:'JetBrains Mono,monospace', marginBottom:10 }}>Notify via</div>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                    {CHANNEL_OPTS.map(ch => (
                      <button key={ch.key} onClick={() => !ch.always && !ch.disabled && toggleChannel(ch.key)}
                        style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', borderRadius:8, fontSize:12, fontFamily:'JetBrains Mono,monospace', cursor:ch.disabled?'not-allowed':'pointer', border:`1px solid ${channels[ch.key]?'var(--cyan-dim)':'var(--border)'}`, background:channels[ch.key]?'rgba(0,245,212,0.08)':'transparent', color:channels[ch.key]?'var(--cyan)':'var(--text-muted)', opacity:ch.disabled?0.4:1, transition:'all .15s' }}>
                        <span>{ch.icon}</span><span>{ch.label}</span>
                        {ch.disabled && <span style={{ fontSize:9, opacity:.6 }}>(soon)</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={handleCreate} style={{ padding:12, borderRadius:8, border:'1px solid var(--cyan-dim)', background:'var(--cyan-glow)', color:'var(--cyan)', fontFamily:'Syne,sans-serif', fontSize:13, fontWeight:700, cursor:'pointer', letterSpacing:'.04em' }}>
                  {a('createBtn')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs + Search + Group/Export */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
        {/* Tabs */}
        <div style={{ display:'flex', gap:4, background:'rgba(255,255,255,0.02)', border:'1px solid var(--border)', borderRadius:9, padding:3 }}>
          <button style={tabStyle('active')} onClick={() => setActiveTab('active')}>
            Active {data.stats?.active > 0 && <span style={{ marginLeft:6, background:'rgba(0,245,212,0.15)', color:'var(--cyan)', fontSize:10, padding:'1px 6px', borderRadius:4 }}>{data.stats.active}</span>}
          </button>
          <button style={tabStyle('history')} onClick={() => setActiveTab('history')}>
            History {history.length > 0 && <span style={{ marginLeft:6, background:'rgba(251,191,36,0.15)', color:'var(--amber)', fontSize:10, padding:'1px 6px', borderRadius:4 }}>{history.length}</span>}
          </button>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, justifyContent:'flex-end' }}>
          {/* ✅ Feature: group-by-symbol + export, seulement pertinents pour History */}
          {activeTab === 'history' && (
            <>
              <button onClick={() => setGroupBySymbol(g => !g)} style={{
                ...smallBtn, padding:'7px 12px', fontSize:10,
                border:`1px solid ${groupBySymbol ? 'var(--cyan-dim)' : 'rgba(255,255,255,0.1)'}`,
                color: groupBySymbol ? 'var(--cyan)' : 'var(--text-muted)',
                background: groupBySymbol ? 'rgba(0,245,212,0.06)' : 'transparent',
              }}>
                {groupBySymbol ? '☑' : '☐'} Group by symbol
              </button>
              <button onClick={handleExportCSV} disabled={filteredHistory.length === 0} style={{
                ...smallBtn, padding:'7px 12px', fontSize:10,
                opacity: filteredHistory.length === 0 ? 0.4 : 1,
                cursor: filteredHistory.length === 0 ? 'not-allowed' : 'pointer',
              }}>
                ⬇ Export CSV
              </button>
            </>
          )}

          {/* Search */}
          <div style={{ position:'relative', flex:1, maxWidth:260 }}>
            <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-muted)', fontSize:12 }}>🔍</span>
            <input
              style={{ ...inp, paddingLeft:30, width:'100%' }}
              placeholder="Filter by symbol..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* ── ACTIVE TAB ── */}
      {activeTab === 'active' && (
        <div>
          {filteredCards.length === 0 && !loading && (
            <div style={{ padding:'30px 0', textAlign:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
              {search ? `No alerts matching "${search}"` : 'No active alerts — create one above'}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
            {filteredCards.map(card => (
              <div key={card.id} style={{ background:'var(--surface)', border:`1px solid ${card.near?'rgba(251,191,36,0.3)':'var(--border)'}`, borderRadius:12, padding:18, borderTop:`2px solid ${card.color}` }}>
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:17, fontWeight:700 }}>{card.sym}</div>
                    <div style={{ fontSize:11, color:'var(--text-secondary)', fontFamily:'JetBrains Mono,monospace', marginTop:2 }}>{typeLabel(card.typeKey)}</div>
                  </div>
                  <span style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'3px 9px', borderRadius:5, background:card.near?'rgba(251,191,36,0.12)':'rgba(0,245,212,0.08)', color:card.near?'var(--amber)':'var(--cyan)', fontWeight:600 }}>
                    {card.near ? a('near') : a('active')}
                  </span>
                </div>
                <div style={{ fontSize:22, fontWeight:700, fontFamily:'JetBrains Mono,monospace', color:card.color, marginBottom:8 }}>{card.cur}</div>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontFamily:'JetBrains Mono,monospace', marginBottom:6 }}>
                  <span style={{ color:'var(--text-muted)' }}>{a('target')}</span>
                  <span style={{ color:'var(--text-secondary)' }}>{card.target}</span>
                </div>
                <div style={{ height:4, background:'rgba(255,255,255,0.05)', borderRadius:2, overflow:'hidden', marginBottom:8 }}>
                  <div style={{ height:'100%', width:`${card.pct}%`, background:card.color, borderRadius:2, transition:'width 1s ease' }} />
                </div>
                {/* Channel badges */}
                <div style={{ display:'flex', gap:5, marginBottom:8 }}>
                  {card.notifyEmail    && <span style={{ fontSize:9, fontFamily:'JetBrains Mono,monospace', padding:'2px 7px', borderRadius:4, background:'rgba(0,245,212,0.08)', color:'var(--cyan)', border:'1px solid var(--cyan-dim)' }}>📧 Email</span>}
                  {card.notifyTelegram && <span style={{ fontSize:9, fontFamily:'JetBrains Mono,monospace', padding:'2px 7px', borderRadius:4, background:'rgba(99,102,241,0.08)', color:'#818cf8', border:'1px solid rgba(99,102,241,0.25)' }}>✈️ Telegram</span>}
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, fontFamily:'JetBrains Mono,monospace' }}>
                  <span style={{ color:'var(--text-secondary)' }}>{t('alerts.threshold', { pct: card.pct })}</span>
                  <div style={{ display:'flex', gap:2, position:'relative' }}>
                    {/* ✅ Feature: Snooze dropdown au lieu d'un simple Pause */}
                    <button
                      {...iconBtn(() => setSnoozeMenuId(id => id === card.id ? null : card.id), 'Snooze / Pause', 'var(--amber)')}
                    >⏸</button>
                    {snoozeMenuId === card.id && (
                      <div style={{
                        position:'absolute', bottom:'calc(100% + 6px)', right:0, zIndex:30,
                        background:'#0a0f1e', border:'1px solid var(--border)', borderRadius:8,
                        boxShadow:'0 8px 24px rgba(0,0,0,0.5)', overflow:'hidden', minWidth:130,
                      }}>
                        {SNOOZE_OPTS.map(opt => (
                          <div key={opt.hours} onClick={() => handleSnooze(card.id, opt.hours)} style={{
                            padding:'8px 14px', cursor:'pointer', fontSize:11,
                            fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)',
                            borderBottom:'1px solid rgba(255,255,255,0.05)',
                          }}
                            onMouseEnter={e => e.currentTarget.style.background='rgba(251,191,36,0.06)'}
                            onMouseLeave={e => e.currentTarget.style.background='transparent'}
                          >
                            Snooze {opt.label}
                          </div>
                        ))}
                        <div onClick={() => { setSnoozeMenuId(null); handlePause(card.id); }} style={{
                          padding:'8px 14px', cursor:'pointer', fontSize:11,
                          fontFamily:'JetBrains Mono,monospace', color:'var(--red)',
                        }}
                          onMouseEnter={e => e.currentTarget.style.background='rgba(248,113,113,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background='transparent'}
                        >
                          Pause indefinitely
                        </div>
                      </div>
                    )}
                    <button {...iconBtn(() => handleDelete(card.id, card.sym), 'Delete', 'var(--red)')}>🗑</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {activeTab === 'history' && (
        <div>
          {filteredHistory.length === 0 && (
            <div style={{ padding:'30px 0', textAlign:'center', color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace', fontSize:11 }}>
              {search ? `No history matching "${search}"` : 'No triggered alerts yet'}
            </div>
          )}

          {/* Row renderer réutilisé (flat ou groupé) */}
          {!groupBySymbol && filteredHistory.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {filteredHistory.map(h => (
                <div key={h.id} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 18px', display:'flex', alignItems:'center', gap:16 }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', background:h.color, flexShrink:0 }} />
                  <div style={{ minWidth:80 }}>
                    <div style={{ fontSize:14, fontWeight:700 }}>{h.sym}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'JetBrains Mono,monospace' }}>{typeLabel(h.typeKey)}</div>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>
                      {h.condition} {h.target}
                    </div>
                  </div>
                  <div style={{ fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)', textAlign:'right' }}>
                    <div style={{ color:'var(--amber)', marginBottom:2 }}>✓ Triggered</div>
                    <div>{h.triggeredAt ? new Date(h.triggeredAt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}</div>
                  </div>
                  <div style={{ display:'flex', gap:4 }}>
                    {h.notifyEmail    && <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, background:'rgba(0,245,212,0.08)', color:'var(--cyan)', border:'1px solid var(--cyan-dim)', fontFamily:'JetBrains Mono,monospace' }}>📧</span>}
                    {h.notifyTelegram && <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, background:'rgba(99,102,241,0.08)', color:'#818cf8', border:'1px solid rgba(99,102,241,0.25)', fontFamily:'JetBrains Mono,monospace' }}>✈️</span>}
                  </div>
                  <button {...iconBtn(() => handleReset(h.id), 'Reset alert — watch again', 'var(--cyan)')}>↺</button>
                  <button {...iconBtn(() => handleDelete(h.id, h.sym), 'Delete', 'var(--red)')}>🗑</button>
                </div>
              ))}
            </div>
          )}

          {/* ✅ Feature: vue groupée par symbole, collapsible */}
          {groupBySymbol && filteredHistory.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {groupedHistory.map(({ sym, items }) => {
                const isOpen = expandedGroups.has(sym);
                return (
                  <div key={sym} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
                    <div onClick={() => toggleGroup(sym)} style={{
                      display:'flex', alignItems:'center', justifyContent:'space-between',
                      padding:'12px 18px', cursor:'pointer',
                    }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ fontSize:11, color:'var(--text-muted)', transform: isOpen ? 'rotate(90deg)' : 'none', transition:'transform .15s', display:'inline-block' }}>▶</span>
                        <span style={{ fontSize:14, fontWeight:700 }}>{sym}</span>
                        <span style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', padding:'2px 8px', borderRadius:5, background:'rgba(251,191,36,0.12)', color:'var(--amber)' }}>
                          {items.length} triggered
                        </span>
                      </div>
                      <div style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' }}>
                        Last: {items[0]?.triggeredAt ? new Date(items[0].triggeredAt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}
                      </div>
                    </div>
                    {isOpen && (
                      <div style={{ borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column' }}>
                        {items.map(h => (
                          <div key={h.id} style={{ display:'flex', alignItems:'center', gap:16, padding:'10px 18px 10px 42px', borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
                            <div style={{ width:6, height:6, borderRadius:'50%', background:h.color, flexShrink:0 }} />
                            <div style={{ flex:1, fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-secondary)' }}>
                              {typeLabel(h.typeKey)} · {h.condition} {h.target}
                            </div>
                            <div style={{ fontSize:10, fontFamily:'JetBrains Mono,monospace', color:'var(--text-muted)' }}>
                              {h.triggeredAt ? new Date(h.triggeredAt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}
                            </div>
                            <button {...iconBtn(() => handleReset(h.id), 'Reset alert', 'var(--cyan)')}>↺</button>
                            <button {...iconBtn(() => handleDelete(h.id, h.sym), 'Delete', 'var(--red)')}>🗑</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}