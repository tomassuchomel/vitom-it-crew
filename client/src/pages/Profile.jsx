import { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import { useAuth, ROLE_LABELS } from '../auth.jsx';
import { users as usersApi, mcpTokens as mcpTokensApi } from '../api.js';
import PushOptIn from '../components/PushOptIn.jsx';
import EmailNotificationPrefs from '../components/EmailNotificationPrefs.jsx';

export default function Profile() {
  const { user, refreshMe, changePassword } = useAuth();
  if (!user) return null;

  return (
    <div>
      <PageHeader title="Můj profil" subtitle={`${user.email} · ${ROLE_LABELS[user.role]}`} />
      <div className="p-6 max-w-3xl space-y-6">
        <AvatarCard user={user} onChanged={refreshMe} />
        <NameCard user={user} onSaved={refreshMe} />
        <PasswordCard mustChange={user.must_change_password} onChanged={changePassword} />
        <Card title="Notifikace v aplikaci" subtitle="Push notifikace v prohlížeči i nainstalované appce.">
          <PushOptIn />
        </Card>
        <Card title="Notifikace e‑mailem" subtitle="Vyber, na které události chceš dostávat e‑maily.">
          <EmailNotificationPrefs />
        </Card>
        <Card title="MCP tokeny (Claude / Cowork)"
          subtitle="Vytvoř si vlastní token pro připojení AI klienta ke svým úkolům. Token vidíš JEN JEDNOU po vytvoření — ulož si ho hned.">
          <McpTokensCard />
        </Card>
      </div>
    </div>
  );
}

function McpTokensCard() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [freshToken, setFreshToken] = useState(null); // { plain, name, prefix }

  const load = () => {
    setLoading(true);
    mcpTokensApi.list()
      .then(d => setTokens(d.tokens || []))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const d = await mcpTokensApi.create(name.trim() || null);
      setFreshToken({ plain: d.token, name: d.name, prefix: d.token_prefix });
      setName('');
      load();
    } catch (e) {
      setErr(e.response?.data?.message || 'Vytvoření selhalo.');
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    if (!confirm('Opravdu smazat token? Klient, který ho používá, se odpojí.')) return;
    try { await mcpTokensApi.remove(id); load(); } catch { /* ignore */ }
  };

  const copy = (text) => navigator.clipboard?.writeText(text);

  return (
    <div className="space-y-3">
      {/* Fresh token výpis — jen jednou */}
      {freshToken && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-amber-800">
            🔑 Nový token — zkopíruj ho HNED, znovu ho neuvidíš.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-amber-200 rounded px-2 py-1.5 font-mono break-all">
              {freshToken.plain}
            </code>
            <button onClick={() => copy(freshToken.plain)}
              className="px-3 py-1.5 bg-amber-500 text-white text-xs rounded hover:bg-amber-600">
              📋 Kopírovat
            </button>
          </div>
          <div className="text-[11px] text-amber-700">
            Použij ho jako <code>Authorization: Bearer {freshToken.plain.slice(0, 8)}…</code>
          </div>
          <button onClick={() => setFreshToken(null)}
            className="text-xs text-amber-700 hover:underline">Skrýt</button>
        </div>
      )}

      {/* Form na vytvoření */}
      <form onSubmit={create} className="flex gap-2 items-end">
        <label className="flex-1">
          <span className="text-xs font-medium text-ink-500">Popisek (např. MacBook, iPhone)</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="MacBook Cowork"
            className="mt-1 w-full px-3 py-1.5 border border-ink-300 rounded text-sm" />
        </label>
        <button type="submit" disabled={busy}
          className="px-3 py-1.5 bg-brand-500 text-white text-sm rounded hover:bg-brand-600 disabled:opacity-50">
          {busy ? 'Vytvářím…' : '+ Vytvořit token'}
        </button>
      </form>
      {err && <div className="text-xs text-red-600">{err}</div>}

      {/* Seznam existujících */}
      {loading ? (
        <div className="text-xs text-ink-400">Načítám…</div>
      ) : tokens.length === 0 ? (
        <div className="text-xs text-ink-400 italic">Zatím žádný token. Vytvoř si první výše.</div>
      ) : (
        <ul className="divide-y divide-cream-100 border border-cream-200 rounded-lg">
          {tokens.map(t => (
            <li key={t.id} className="px-3 py-2 flex items-center gap-3 text-sm">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-ink-800 truncate">{t.name || <span className="italic text-ink-400">bez popisku</span>}</div>
                <div className="text-[11px] text-ink-500 font-mono">
                  {t.token_prefix}…
                  <span className="ml-2 text-ink-400">vytvořeno {new Date(t.created_at).toLocaleDateString('cs-CZ')}</span>
                  {t.last_used_at && <span className="ml-2 text-emerald-600">použito {new Date(t.last_used_at).toLocaleDateString('cs-CZ')}</span>}
                </div>
              </div>
              <button onClick={() => remove(t.id)}
                className="text-xs text-red-600 hover:underline">Smazat</button>
            </li>
          ))}
        </ul>
      )}

      <div className="text-[11px] text-ink-500 bg-cream-50 border border-cream-200 rounded p-2">
        <strong>Připojení v Coworku / Claude Desktop:</strong> URL <code>https://it.realitniekosystem.cz/mcp</code>,
        header <code>Authorization: Bearer &lt;token&gt;</code>. Token uvidí a bude ovládat <strong>jen tvoje úkoly</strong> —
        cizí úkoly jsou pro něj neviditelné.
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white border border-cream-200 rounded-xl p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-ink-800">{title}</h2>
        {subtitle && <p className="text-xs text-ink-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function AvatarCard({ user, onChanged }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const onPick = () => fileRef.current?.click();

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      await usersApi.uploadAvatar(f);
      await onChanged();
    } catch (e) {
      setErr(e.response?.data?.message || 'Upload selhal.');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (!confirm('Opravdu smazat avatar?')) return;
    setBusy(true); setErr(null);
    try {
      await usersApi.removeAvatar();
      await onChanged();
    } catch (e) {
      setErr(e.response?.data?.message || 'Smazání selhalo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Avatar" subtitle="Obrázek se zobrazuje vedle tvého jména v celé aplikaci. Max 2 MB.">
      <div className="flex items-center gap-5">
        <Avatar user={user} size={96} />
        <div className="flex flex-col gap-2">
          <button
            onClick={onPick}
            disabled={busy}
            className="px-4 py-2 bg-brand-500 text-white text-sm rounded-lg hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? 'Nahrávám…' : 'Nahrát nový obrázek'}
          </button>
          {user.avatar_updated_at && (
            <button
              onClick={onRemove}
              disabled={busy}
              className="px-4 py-2 text-sm text-red-600 hover:text-red-700 underline disabled:opacity-50 text-left"
            >
              Odstranit avatar
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={onFile}
          />
        </div>
      </div>
      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
    </Card>
  );
}

function NameCard({ user, onSaved }) {
  const [first, setFirst] = useState(user.first_name || '');
  const [last, setLast] = useState(user.last_name || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null); setOk(false);
    try {
      await usersApi.updateMe({ first_name: first.trim(), last_name: last.trim() });
      await onSaved();
      setOk(true);
    } catch (e) {
      setErr(e.response?.data?.message || 'Uložení selhalo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Jméno" subtitle="Mění se i v ukázce u úkolů, dotazů a reportů.">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Jméno</label>
            <input
              type="text"
              required
              value={first}
              onChange={e => setFirst(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Příjmení</label>
            <input
              type="text"
              required
              value={last}
              onChange={e => setLast(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-brand-500 text-white text-sm rounded-lg hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? 'Ukládám…' : 'Uložit jméno'}
          </button>
          {ok && <span className="text-sm text-emerald-600">Uloženo ✓</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard({ mustChange, onChanged }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setOk(false);
    if (next.length < 6) { setErr('Heslo musí mít alespoň 6 znaků.'); return; }
    if (next !== confirm) { setErr('Hesla se neshodují.'); return; }
    setBusy(true);
    try {
      await onChanged(mustChange ? null : current, next);
      setOk(true);
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e) {
      const code = e.response?.data?.error;
      setErr(
        code === 'invalid_current_password' ? 'Současné heslo není správně.'
        : code === 'weak_password' ? 'Heslo musí mít alespoň 6 znaků.'
        : 'Změna hesla selhala.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Změna hesla" subtitle={mustChange ? 'Máš nastavené výchozí heslo. Zvol si vlastní.' : 'Pro změnu zadej současné a nové heslo.'}>
      <form onSubmit={submit} className="space-y-3 max-w-md">
        {!mustChange && (
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Současné heslo</label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-ink-500 mb-1">Nové heslo (min. 6 znaků)</label>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={next}
            onChange={e => setNext(e.target.value)}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-500 mb-1">Nové heslo (potvrzení)</label>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-brand-500 text-white text-sm rounded-lg hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? 'Ukládám…' : 'Změnit heslo'}
          </button>
          {ok && <span className="text-sm text-emerald-600">Heslo změněno ✓</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
