import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth as authApi } from '../api.js';
import { useAuth, ROLE_LABELS } from '../auth.jsx';
import VitomLogo from '../components/VitomLogo.jsx';

export default function Login() {
  const { user, devLogin } = useAuth();
  const nav = useNavigate();
  const [config, setConfig] = useState({ googleEnabled: false });
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [backendErr, setBackendErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) nav('/');
    authApi.config().then(setConfig).catch((e) => {
      setBackendErr(e.message || 'Backend nedostupný');
    });
    authApi.devUsers().then(d => setUsers(d.users)).catch((e) => {
      setBackendErr(e.message || 'Backend nedostupný');
    });
  }, [user]);

  const handleDevLogin = async (userId) => {
    setLoading(true); setError(null);
    try {
      await devLogin(userId);
      nav('/');
    } catch (e) {
      setError(e.response?.data?.error || 'Login selhal');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6 bg-cream-100">
      <div className="bg-white rounded-2xl shadow-xl p-10 w-full max-w-md border border-cream-200">
        <div className="text-center mb-8">
          <div className="text-brand-500 inline-flex">
            <VitomLogo size={64} />
          </div>
          <div className="text-3xl font-bold tracking-tight text-brand-500 mt-3">VITOM</div>
          <div className="text-xs uppercase tracking-[0.3em] text-accent-500 mt-0.5 font-semibold">IT Crew</div>
          <div className="w-12 h-px bg-accent-500 mx-auto mt-4" />
          <p className="text-sm text-ink-500 mt-4">Pěstujeme nový svět nemovitostí</p>
        </div>

        {config.googleEnabled && (
          <a
            href="/api/auth/google"
            className="block w-full text-center py-2.5 bg-white border border-ink-300 rounded-lg hover:bg-cream-50 mb-4 font-medium"
          >
            Přihlásit se přes Google
          </a>
        )}

        {backendErr && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-xs text-red-700">
            <div className="font-semibold mb-1">⚠️ Backend nedostupný</div>
            <div>Server na <code>localhost:4000</code> neodpovídá. V Terminálu zkontroluj, zda běží <code>npm run dev</code> a zda nehlásí chybu (pravděpodobně chybí <code>multer</code> – spusť <code>npm install --prefix server</code>).</div>
          </div>
        )}

        <div className="text-xs uppercase text-ink-400 my-5 text-center tracking-widest">
          {config.googleEnabled ? 'nebo dev login' : 'Dev login'}
        </div>

        <div className="space-y-2">
          {!backendErr && users.length === 0 && (
            <div className="text-xs text-ink-400 text-center py-4">Načítám uživatele…</div>
          )}
          {users.map(u => (
            <button
              key={u.id}
              onClick={() => handleDevLogin(u.id)}
              disabled={loading}
              className="w-full flex items-center justify-between px-4 py-3 bg-cream-100 hover:bg-cream-50 hover:border-brand-500 border border-cream-200 rounded-lg transition disabled:opacity-50"
            >
              <span className="text-left">
                <div className="font-medium text-ink-800">{u.name}</div>
                <div className="text-xs text-ink-500">{ROLE_LABELS[u.role]}</div>
              </span>
              <span className="text-accent-500">→</span>
            </button>
          ))}
        </div>

        {error && <div className="mt-4 text-sm text-red-600 text-center">{error}</div>}

        <p className="mt-6 text-xs text-ink-400 text-center">
          Dev login slouží pro rychlé testování bez Google OAuth.
        </p>
      </div>
    </div>
  );
}
