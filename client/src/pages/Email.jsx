// Email agent — Phase 1: OAuth + Inbox. Phase 2a: AI klasifikace + akce.
//
// Zobrazení:
//   - Nepřipojený stav → karta "Propojit Outlook"
//   - Konfigurace na backendu chybí → návod, co admin musí nastavit v Renderu
//   - Připojený stav → list zpráv s badges, filtr per kategorie, akce
//
// Phase 2b (později) přidá drafty odpovědí v Outlooku + push notifikace.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { email as emailApi } from '../api.js';
import SuggestedTasksModal from '../components/SuggestedTasksModal.jsx';

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short' });
};

// Kategorie → emoji + barva + label. Pro 'other' nic nezobrazujeme (zbytečný šum).
const CATEGORY_META = {
  task:          { emoji: '✅', label: 'Úkol',            cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  question:      { emoji: '💬', label: 'Dotaz',           cls: 'bg-blue-100 text-blue-800 border-blue-300' },
  answer_needed: { emoji: '⚡', label: 'Čeká odpověď',     cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  fyi:           { emoji: '📰', label: 'FYI',             cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  spam:          { emoji: '🗑',  label: 'Spam',           cls: 'bg-ink-100 text-ink-500 border-ink-300' },
  other:         { emoji: '·',  label: 'Ostatní',         cls: 'bg-cream-100 text-ink-500 border-cream-300' },
};

const FILTERS = [
  { value: 'all',           label: 'Vše' },
  { value: 'task',          label: '✅ Úkoly' },
  { value: 'question',      label: '💬 Dotazy' },
  { value: 'answer_needed', label: '⚡ Čeká odpověď' },
  { value: 'fyi',           label: '📰 FYI' },
  { value: 'unclassified',  label: '? Neklasifikováno' },
];

export default function EmailPage() {
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('all');
  // Extrakce úkolů z konkrétního emailu → SuggestedTasksModal
  const [taskSuggestion, setTaskSuggestion] = useState(null);
  const [extractingFor, setExtractingFor] = useState(null);
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

  const classifyAll = async () => {
    // Klasifikujeme jen ne-klasifikované, ať neutrácíme tokeny zbytečně.
    const toClassify = messages.filter(m => !m.classification);
    if (toClassify.length === 0) return;
    setClassifying(true); setErr(null);
    try {
      const compact = toClassify.map(m => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        bodyPreview: m.bodyPreview,
      }));
      const d = await emailApi.classify(compact);
      // Merge výsledků zpět do messages
      const byId = Object.fromEntries((d.results || []).map(r => [r.message_id, r]));
      setMessages(ms => ms.map(m => byId[m.id] ? { ...m, classification: byId[m.id] } : m));
    } catch (e) {
      setErr(e.response?.data?.message || 'Klasifikace selhala.');
    } finally {
      setClassifying(false);
    }
  };

  const extractTasks = async (msg) => {
    setExtractingFor(msg.id); setErr(null);
    try {
      const d = await emailApi.extractTasks(msg.id);
      if (!d.tasks || d.tasks.length === 0) {
        alert('AI nenašla v tomto emailu žádné akční úkoly.');
        return;
      }
      // d obsahuje { tasks, available_projects, available_members } — předáme do modalu.
      setTaskSuggestion({ suggestion: d, sourceEmail: msg });
    } catch (e) {
      setErr(e.response?.data?.message || 'Extrakce úkolů selhala.');
    } finally {
      setExtractingFor(null);
    }
  };

  useEffect(() => { loadStatus(); }, []);
  useEffect(() => {
    if (status?.connected) loadMessages();
  }, [status?.connected]);

  useEffect(() => {
    if (params.get('connected')) {
      params.delete('connected');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const handleConnect = () => { window.location.href = emailApi.connectUrl(); };
  const handleDisconnect = async () => {
    if (!confirm('Odpojit Outlook? Server zapomene tvé tokeny.')) return;
    await emailApi.disconnect();
    setStatus(null); setMessages([]);
    loadStatus();
  };

  const visibleMessages = messages.filter(m => {
    if (filter === 'all') return true;
    if (filter === 'unclassified') return !m.classification;
    return m.classification?.category === filter;
  });
  const unclassifiedCount = messages.filter(m => !m.classification).length;

  return (
    <div>
      <PageHeader
        title="Email"
        subtitle="Inbox s AI klasifikací. Klikni na ✅ → úkol(y) z tohoto emailu."
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
            messages={visibleMessages}
            allCount={messages.length}
            unclassifiedCount={unclassifiedCount}
            filter={filter}
            setFilter={setFilter}
            loadingMsgs={loadingMsgs}
            classifying={classifying}
            extractingFor={extractingFor}
            err={err}
            onRefresh={loadMessages}
            onClassifyAll={classifyAll}
            onExtractTasks={extractTasks}
            onDisconnect={handleDisconnect}
          />
        )}
      </div>

      {taskSuggestion && (
        <SuggestedTasksModal
          suggestion={taskSuggestion.suggestion}
          sourceNote={null}
          sourceScope="team"
          onClose={() => setTaskSuggestion(null)}
          onCreated={(count) => {
            alert(`✅ Vytvořeno ${count} úkol(ů) z emailu „${taskSuggestion.sourceEmail.subject || '(bez předmětu)'}".`);
            setTaskSuggestion(null);
          }}
        />
      )}
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
    </div>
  );
}

function NotConnectedCard({ onConnect }) {
  return (
    <div className="bg-white border border-cream-300 rounded-xl p-6 text-center space-y-3">
      <div className="text-4xl">📧</div>
      <div className="text-lg font-semibold text-ink-800">Propojit Outlook</div>
      <p className="text-sm text-ink-600 max-w-md mx-auto">
        Po propojení uvidíš inbox + AI klasifikaci. Z mailů lze pak jedním klikem vytvořit úkoly.
      </p>
      <button
        onClick={onConnect}
        className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded font-medium"
      >
        🔗 Propojit Microsoft 365
      </button>
      <div className="text-[11px] text-ink-400">
        Přihlášení probíhá přímo na login.microsoftonline.com.
      </div>
    </div>
  );
}

function ConnectedView({
  status, messages, allCount, unclassifiedCount, filter, setFilter,
  loadingMsgs, classifying, extractingFor, err,
  onRefresh, onClassifyAll, onExtractTasks, onDisconnect,
}) {
  return (
    <>
      <div className="bg-white border border-cream-300 rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <div className="text-2xl">✅</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-800 truncate">{status.email}</div>
          <div className="text-[11px] text-ink-500">
            {allCount} zpráv · {unclassifiedCount > 0 ? `${unclassifiedCount} neklasifikováno` : 'vše klasifikováno'}
          </div>
        </div>
        <button onClick={onClassifyAll} disabled={classifying || unclassifiedCount === 0}
          className="px-3 py-1.5 text-sm rounded bg-accent-500 hover:bg-accent-600 text-white disabled:opacity-40">
          {classifying ? 'AI pracuje…' : `🤖 Klasifikovat (${unclassifiedCount})`}
        </button>
        <button onClick={onRefresh} disabled={loadingMsgs}
          className="px-3 py-1.5 text-sm rounded border border-cream-300 hover:bg-cream-50 disabled:opacity-50">
          {loadingMsgs ? 'Načítám…' : '↻ Obnovit'}
        </button>
        <button onClick={onDisconnect}
          className="px-3 py-1.5 text-sm rounded text-ink-500 hover:text-red-600">
          Odpojit
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map(f => (
          <button key={f.value} onClick={() => setFilter(f.value)}
            className={`px-3 py-1 text-xs rounded-full border ${
              filter === f.value
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">{err}</div>
      )}

      <div className="bg-white border border-cream-300 rounded-xl divide-y divide-cream-200">
        {messages.length === 0 && !loadingMsgs ? (
          <div className="p-6 text-center text-sm text-ink-400 italic">
            {filter === 'all' ? 'Žádné zprávy v Inboxu.' : 'Žádné zprávy v této kategorii.'}
          </div>
        ) : (
          messages.map(m => (
            <MessageRow key={m.id} m={m}
              onExtractTasks={onExtractTasks}
              extracting={extractingFor === m.id} />
          ))
        )}
      </div>
    </>
  );
}

function MessageRow({ m, onExtractTasks, extracting }) {
  const from = m.from?.emailAddress;
  const cat = m.classification?.category;
  const meta = cat ? CATEGORY_META[cat] : null;
  const canExtractTasks = cat === 'task' || cat === 'answer_needed';

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
          {meta && (
            <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${meta.cls}`}>
              {meta.emoji} {meta.label}
            </span>
          )}
          <div className="text-[11px] text-ink-400 ml-auto flex-shrink-0">{fmtDate(m.receivedDateTime)}</div>
        </div>
        <div className={`text-sm truncate ${m.isRead ? 'text-ink-500' : 'text-ink-700'}`}>
          {m.subject || '(bez předmětu)'}
        </div>
        {m.classification?.summary ? (
          <div className="text-xs text-ink-500 truncate italic">🤖 {m.classification.summary}</div>
        ) : (
          <div className="text-xs text-ink-400 truncate">{m.bodyPreview}</div>
        )}
        <div className="flex items-center gap-3 mt-1">
          {m.webLink && (
            <a href={m.webLink} target="_blank" rel="noreferrer"
              className="text-[11px] text-brand-500 hover:underline">otevřít v Outlooku ↗</a>
          )}
          {canExtractTasks && (
            <button onClick={() => onExtractTasks(m)} disabled={extracting}
              className="text-[11px] text-accent-600 hover:underline disabled:opacity-50">
              {extracting ? 'extrahuji…' : '+ úkoly z tohoto emailu'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
