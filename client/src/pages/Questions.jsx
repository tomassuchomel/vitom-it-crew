// Stránka dotazů – záložky: Vše moje (default) | Příchozí | Odeslané | Všechny (admin)
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import { questions as questionsApi } from '../api.js';
import { useAuth, can } from '../auth.jsx';

const TABS = [
  { value: 'mine',   label: 'Vše moje',   countKey: 'mineTotal'  },
  { value: 'inbox',  label: 'Příchozí',   countKey: 'inboxTotal' },
  { value: 'sent',   label: 'Odeslané',   countKey: 'sentTotal'  },
  { value: 'all',    label: 'Všechny',    needAdmin: true },
];

const STATUS_FILTERS = [
  { value: '',         label: 'Vše' },
  { value: 'pending',  label: 'Čekající' },
  { value: 'answered', label: 'Zodpovězené' },
];

export default function Questions() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [box, setBox] = useState(searchParams.get('box') || 'mine');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ mineTotal: 0, inboxTotal: 0, sentTotal: 0, inboxPending: 0, sentPending: 0 });
  const [loading, setLoading] = useState(true);
  const [answering, setAnswering] = useState(null);
  const [answerText, setAnswerText] = useState('');

  // Synchronizace box/status do URL
  useEffect(() => {
    const next = {};
    if (box && box !== 'mine') next.box = box;
    if (status) next.status = status;
    setSearchParams(next, { replace: true });
  }, [box, status]);

  const load = () => {
    setLoading(true);
    const params = { box };
    if (status) params.status = status;
    Promise.all([
      questionsApi.list(params),
      questionsApi.counts(),
    ]).then(([d, c]) => {
      setItems(d.questions);
      setCounts(c);
    }).finally(() => setLoading(false));
  };
  useEffect(load, [box, status]);

  const submitAnswer = async (id) => {
    if (!answerText.trim()) return;
    await questionsApi.answer(id, answerText.trim());
    setAnswering(null);
    setAnswerText('');
    load();
  };

  const reopen = async (id) => {
    if (!confirm('Vrátit dotaz mezi čekající?')) return;
    await questionsApi.reopen(id);
    load();
  };

  const remove = async (id) => {
    if (!confirm('Smazat dotaz?')) return;
    await questionsApi.remove(id);
    load();
  };

  const visibleTabs = TABS.filter(t => !t.needAdmin || can.seeAllHours(user));

  // Pro "mine" boxu rozlišíme směr u každého dotazu
  const directionFor = (q) => {
    if (q.from_user_id === user.id && q.to_user_id === user.id) return 'self';
    if (q.from_user_id === user.id) return 'sent';
    if (q.to_user_id === user.id)   return 'received';
    return 'other';
  };

  return (
    <div>
      <PageHeader title="Dotazy" subtitle="Týmová komunikace k úkolům" />

      <div className="p-8 space-y-4 max-w-5xl">
        {/* Záložky */}
        <div className="flex gap-1 bg-white rounded-xl border border-cream-200 p-1 w-fit">
          {visibleTabs.map(t => (
            <button
              key={t.value}
              onClick={() => setBox(t.value)}
              className={`px-3 py-1.5 text-sm rounded-lg transition flex items-center gap-2 ${
                box === t.value ? 'bg-brand-500 text-white' : 'hover:bg-cream-100 text-ink-600'
              }`}
            >
              <span>{t.label}</span>
              {!t.needAdmin && counts[t.countKey] > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  box === t.value ? 'bg-white/20 text-white' : 'bg-cream-200 text-ink-600'
                }`}>{counts[t.countKey]}</span>
              )}
            </button>
          ))}
        </div>

        {/* Filtr stavu */}
        <div className="flex gap-1 text-sm">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`px-3 py-1 rounded-lg ${
                status === f.value ? 'bg-cream-200 text-ink-800 font-medium' : 'text-ink-500 hover:text-ink-800'
              }`}
            >{f.label}</button>
          ))}
        </div>

        {loading ? (
          <div className="p-6 text-center text-ink-400">Načítám…</div>
        ) : items.length === 0 ? (
          <EmptyState box={box} status={status} counts={counts} onSwitchBox={setBox} />
        ) : (
          <ul className="space-y-3">
            {items.map(q => (
              <li key={q.id} className="bg-white rounded-xl border border-cream-200 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Hlavička s odesílatelem/příjemcem */}
                    <div className="flex items-center gap-2 flex-wrap text-xs text-ink-500 mb-1">
                      {/* Mini směr ve "mine" boxu */}
                      {box === 'mine' && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          directionFor(q) === 'sent'     ? 'bg-blue-100 text-blue-700' :
                          directionFor(q) === 'received' ? 'bg-purple-100 text-purple-700' : 'bg-cream-200 text-ink-600'
                        }`}>
                          {directionFor(q) === 'sent' ? '↗ Odeslal jsem' : directionFor(q) === 'received' ? '↘ Pro mě' : ''}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink-700">
                        <Avatar user={{ id: q.from_user_id, name: q.from_user_name }} size={20} />
                        {q.from_user_name}
                      </span>
                      <span>→</span>
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink-700">
                        <Avatar user={{ id: q.to_user_id, name: q.to_user_name }} size={20} />
                        {q.to_user_name}
                      </span>
                      <span>·</span>
                      <span>{new Date(q.created_at + 'Z').toLocaleString('cs-CZ')}</span>
                      {q.status === 'pending' ? (
                        <span className="ml-auto text-xs px-2 py-0.5 bg-accent-100 text-accent-800 rounded font-semibold">
                          ⏳ Čeká na odpověď
                        </span>
                      ) : (
                        <span className="ml-auto text-xs px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded font-semibold">
                          ✅ Zodpovězeno
                        </span>
                      )}
                    </div>
                    {q.task_title && (
                      <div className="text-xs text-ink-500 mb-1">
                        K úkolu:{' '}
                        <Link to={`/projects/${q.project_id}`} className="text-brand-500 hover:underline">
                          {q.task_title}
                        </Link>
                        {q.project_name && <span> · {q.project_name}</span>}
                      </div>
                    )}
                    <div className="text-sm text-ink-800 whitespace-pre-wrap mt-2 p-3 bg-cream-50 rounded">
                      {q.question}
                    </div>

                    {q.answer && (
                      <div className="mt-3 p-3 bg-emerald-50 rounded border-l-4 border-emerald-400">
                        <div className="text-xs text-emerald-700 font-medium mb-1">
                          Odpověď ({new Date(q.answered_at + 'Z').toLocaleString('cs-CZ')})
                        </div>
                        <div className="text-sm text-ink-800 whitespace-pre-wrap">{q.answer}</div>
                      </div>
                    )}

                    {/* Form na odpověď */}
                    {q.status === 'pending' && (q.to_user_id === user.id || can.seeAllHours(user)) && (
                      answering === q.id ? (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={answerText}
                            onChange={(e) => setAnswerText(e.target.value)}
                            rows={3}
                            placeholder="Tvoje odpověď…"
                            className="w-full border border-cream-300 rounded px-2 py-1.5 text-sm"
                            autoFocus
                          />
                          <div className="flex gap-2 justify-end">
                            <button onClick={() => { setAnswering(null); setAnswerText(''); }}
                              className="px-3 py-1 text-sm rounded border border-cream-300">Zrušit</button>
                            <button onClick={() => submitAnswer(q.id)} disabled={!answerText.trim()}
                              className="px-3 py-1 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
                              Odeslat odpověď
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setAnswering(q.id); setAnswerText(''); }}
                          className="mt-3 px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600"
                        >Odpovědět</button>
                      )
                    )}
                  </div>
                </div>

                <div className="flex gap-1 justify-end mt-2 text-xs">
                  {q.status === 'answered' && (q.from_user_id === user.id || q.to_user_id === user.id || can.seeAllHours(user)) && (
                    <button onClick={() => reopen(q.id)} className="text-ink-400 hover:text-accent-600 px-2">
                      ↩ Znovu otevřít
                    </button>
                  )}
                  {(q.from_user_id === user.id || can.manageUsers(user)) && (
                    <button onClick={() => remove(q.id)} className="text-ink-400 hover:text-red-600 px-2">
                      🗑 Smazat
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({ box, status, counts, onSwitchBox }) {
  let msg = 'Žádné dotazy';
  let hint = null;
  if (box === 'mine') {
    msg = status ? 'Žádné dotazy v této kategorii' : 'Zatím nemáš žádné dotazy';
    hint = 'Dotaz vytvoříš tlačítkem 💬 u úkolu v detailu projektu.';
  } else if (box === 'inbox') {
    msg = 'Nikdo se tě teď neptá';
    if (counts.sentTotal > 0) {
      hint = (
        <span>
          Tvoje odeslané dotazy najdeš v záložce{' '}
          <button onClick={() => onSwitchBox('sent')} className="text-brand-500 underline">Odeslané ({counts.sentTotal})</button>.
        </span>
      );
    }
  } else if (box === 'sent') {
    msg = 'Žádné odeslané dotazy';
    hint = 'Dotaz vytvoříš tlačítkem 💬 u úkolu v detailu projektu.';
  }
  return (
    <div className="p-12 text-center bg-white rounded-xl border border-cream-200">
      <div className="text-4xl mb-2">💬</div>
      <div className="text-ink-600 font-medium">{msg}</div>
      {hint && <div className="text-sm text-ink-400 mt-2">{hint}</div>}
    </div>
  );
}
