// Email agent — Phase 1: připojit Outlook + zobrazit posledních 20 zpráv.
//
// Zobrazení:
//   - Nepřipojený stav → karta "Propojit Outlook" (vyžaduje OAuth flow)
//   - Konfigurace na backendu chybí → návod, co admin musí nastavit v Renderu
//   - Připojený stav → list zpráv (subject, odesílatel, datum, preview)
//
// Phase 2 (později) přidá AI klasifikaci + drafty + auto-akce.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { email as emailApi } from '../api.js';

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short' });
};

export default function EmailPage() {
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [err, setErr] = useState(null);
  const [params, setParams] = useSearchParams();

  const loadStatus = async () => {
    try {
      const s = await emailApi.status();
      setStatus(s);
    } finally {
      setLoadingStatus(false);
    }
  };

  const loadMessages = async () => {
    setLoadingMsgs(true); setErr(null);
    try {
      const d = await emailApi.messages(20);
      setMessages(d.messages || []);
    } catch (e) {
      setErr(e.response?.data?.message || 'Načtení zpráv selhalo.');
    } finally {
      setLoadingMsgs(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);
  useEffect(() => {
    if (status?.connected) loadMessages();
  }, [status?.connected]);

  // Po OAuth callbacku přichází ?connected=email — vyčistíme query.
  useEffect(() => {
    if (params.get('connected')) {
      params.delete('connected');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const handleConnect = () => {
    // Plain redirect na backend, ten 302 na MS authorize.
    window.location.href = emailApi.connectUrl();
  };

  const handleDisconnect = async () => {
    if (!confirm('Odpojit Outlook? Server zapomene tvé tokeny.')) return;
    await emailApi.disconnect();
    setStatus(null); setMessages([]);
    loadStatus();
  };

  return (
    <div>
      <PageHeader
        title="Email"
        subtitle="Propojení s tvojí Outlook schránkou (Microsoft 365)."
      />
      <div className="p-6 max-w-4xl space-y-4">
        {loadingStatus ? (
          <div className="text-ink-500 text-sm">Načítám stav…</div>
        ) : !status?.configured ? (
          <ConfigMissingCard config={status?.config} />
        ) : !status?.connected ? (
          <NotConnectedCard onConnect={handleConnect} />
        ) : (
          <ConnectedView
            status={status}
            messages={messages}
            loadingMsgs={loadingMsgs}
            err={err}
            onRefresh={loadMessages}
            onDisconnect={handleDisconnect}
          />
        )}
      </div>
    </div>
  );
}

function ConfigMissingCard({ config }) {
  const missing = [];
  if (!config?.has_client_id)     missing.push('MICROSOFT_CLIENT_ID');
  if (!config?.has_client_secret) missing.push('MICROSOFT_CLIENT_SECRET');
  if (!config?.has_redirect_uri)  missing.push('MICROSOFT_REDIRECT_URI');
  if (!config?.has_encryption)    missing.push('ENCRYPTION_KEY');

  return (
    <div className="bg-white border border-amber-300 rounded-xl p-6 space-y-3">
      <div className="text-lg font-semibold text-ink-800">⚠️ Email agent zatím není nakonfigurovaný</div>
      <p className="text-sm text-ink-600">
        Admin musí v Renderu nastavit env vars pro Microsoft OAuth + token encryption.
        Bez nich nelze propojit Outlook.
      </p>
      <div className="bg-cream-50 border border-cream-300 rounded p-3 text-xs font-mono text-ink-700">
        {missing.length > 0
          ? <>Chybí: <strong>{missing.join(', ')}</strong></>
          : <>Vše vyplněno — zkus refresh stránky.</>}
      </div>
      <p className="text-xs text-ink-500">
        Detailní postup (Azure App Registration → Render env vars) ti pošlu zvlášť.
      </p>
    </div>
  );
}

function NotConnectedCard({ onConnect }) {
  return (
    <div className="bg-white border border-cream-300 rounded-xl p-6 text-center space-y-3">
      <div className="text-4xl">📧</div>
      <div className="text-lg font-semibold text-ink-800">Propojit Outlook</div>
      <p className="text-sm text-ink-600 max-w-md mx-auto">
        Po propojení uvidíš ve schránce posledních 20 zpráv.
        V dalších fázích AI bude třídit, navrhovat odpovědi a vytvářet úkoly z emailů.
      </p>
      <button
        onClick={onConnect}
        className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded font-medium"
      >
        🔗 Propojit Microsoft 365
      </button>
      <div className="text-[11px] text-ink-400">
        Přihlášení probíhá přímo na login.microsoftonline.com. Heslo se k nám nedostane.
      </div>
    </div>
  );
}

function ConnectedView({ status, messages, loadingMsgs, err, onRefresh, onDisconnect }) {
  return (
    <>
      <div className="bg-white border border-cream-300 rounded-xl p-4 flex items-center gap-3">
        <div className="text-2xl">✅</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-800 truncate">{status.email}</div>
          <div className="text-[11px] text-ink-500">
            Připojeno {status.connected_at ? new Date(status.connected_at).toLocaleDateString('cs-CZ') : ''}
          </div>
        </div>
        <button onClick={onRefresh} disabled={loadingMsgs}
          className="px-3 py-1.5 text-sm rounded border border-cream-300 hover:bg-cream-50 disabled:opacity-50">
          {loadingMsgs ? 'Načítám…' : '↻ Obnovit'}
        </button>
        <button onClick={onDisconnect}
          className="px-3 py-1.5 text-sm rounded text-ink-500 hover:text-red-600">
          Odpojit
        </button>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">{err}</div>
      )}

      <div className="bg-white border border-cream-300 rounded-xl divide-y divide-cream-200">
        {messages.length === 0 && !loadingMsgs ? (
          <div className="p-6 text-center text-sm text-ink-400 italic">Žádné zprávy v Inboxu.</div>
        ) : (
          messages.map(m => <MessageRow key={m.id} m={m} />)
        )}
      </div>
    </>
  );
}

function MessageRow({ m }) {
  const from = m.from?.emailAddress;
  return (
    <div className={`p-3 flex gap-3 ${m.isRead ? '' : 'bg-cream-50'}`}>
      <div className="w-2 flex-shrink-0 pt-2">
        {!m.isRead && <div className="w-2 h-2 rounded-full bg-accent-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <div className={`text-sm truncate ${m.isRead ? 'text-ink-600' : 'text-ink-800 font-semibold'}`}>
            {from?.name || from?.address || '(neznámý)'}
          </div>
          <div className="text-[11px] text-ink-400 ml-auto flex-shrink-0">{fmtDate(m.receivedDateTime)}</div>
        </div>
        <div className={`text-sm truncate ${m.isRead ? 'text-ink-500' : 'text-ink-700'}`}>
          {m.subject || '(bez předmětu)'}
        </div>
        <div className="text-xs text-ink-400 truncate">{m.bodyPreview}</div>
        {m.webLink && (
          <a href={m.webLink} target="_blank" rel="noreferrer"
            className="text-[11px] text-brand-500 hover:underline">otevřít v Outlooku ↗</a>
        )}
      </div>
    </div>
  );
}
