import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth as authApi } from '../api.js';
import { useAuth } from '../auth.jsx';
import VitomLogo from '../components/VitomLogo.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [config, setConfig] = useState({ googleEnabled: false });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [backendErr, setBackendErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) nav('/');
    authApi.config().then(setConfig).catch((e) => {
      setBackendErr(e.message || 'Backend nedostupný');
    });
  }, [user]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      await login(email.trim(), password);
      nav('/');
    } catch (e) {
      const code = e.response?.data?.error;
      setError(code === 'invalid_credentials' ? 'Špatný email nebo heslo.' : 'Přihlášení selhalo.');
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
            <div>Server na <code>localhost:4000</code> neodpovídá. Zkontroluj <code>npm run dev</code>.</div>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              className="w-full px-3 py-2.5 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              placeholder="tvuj.email@vitom.cz"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Heslo</label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2.5 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-brand-500 text-white rounded-lg hover:bg-brand-600 font-medium disabled:opacity-50"
          >
            {loading ? 'Přihlašuji…' : 'Přihlásit se'}
          </button>
        </form>

        {error && <div className="mt-4 text-sm text-red-600 text-center">{error}</div>}

        <div className="mt-6 text-xs text-ink-500 text-center">
          Nové účty mají výchozí heslo <code className="bg-cream-100 px-1.5 py-0.5 rounded">ITCrew23</code>.
          <div className="mt-1 text-ink-400">Po prvním přihlášení si nastavíš vlastní.</div>
        </div>
      </div>
    </div>
  );
}
