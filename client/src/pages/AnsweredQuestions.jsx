// Odpovědi na moje položené dotazy.
// Server vrátí questions where from_user_id = me AND status = 'answered'.
// Neread odpovědi mají answer_read=false (badge v menu).
// Po otevření stránky voláme mark-answers-read → badge zmizí.

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import { questions as questionsApi, tasks as tasksApi } from '../api.js';

const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function AnsweredQuestions() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailTask, setDetailTask] = useState(null);
  const [searchParams] = useSearchParams();
  const teamIdFilter = Number(searchParams.get('team')) || null;

  // Client-side filter dle URL ?team=N (BE questions vrací scope_team_id).
  const filteredItems = useMemo(
    () => teamIdFilter ? items.filter(q => q.scope_team_id === teamIdFilter) : items,
    [items, teamIdFilter]
  );

  const load = () => {
    setLoading(true);
    questionsApi.list({ box: 'answered-to-me' })
      .then(d => setItems(d.questions || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Po prvním načtení stránky označíme všechny za přečtené (badge zmizí).
    questionsApi.markAnswersRead().catch(() => {});
  }, []);

  const openTask = async (taskId) => {
    if (!taskId) return;
    try {
      const d = await tasksApi.get(taskId);
      setDetailTask(d.task);
    } catch {
      alert('Úkol se nepodařilo načíst.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Odpovědi na dotazy"
        subtitle={`${filteredItems.length} odpověď/i na tvoje položené dotazy${teamIdFilter ? ' (filtrováno)' : ''}`}
        actions={
          <button onClick={load} disabled={loading}
            className="px-3 py-1.5 text-sm rounded border border-cream-300 hover:bg-cream-50 disabled:opacity-50">
            {loading ? 'Načítám…' : '↻ Obnovit'}
          </button>
        }
      />

      <div className="p-6 max-w-4xl">
        {loading ? (
          <div className="text-ink-400 text-sm">Načítám…</div>
        ) : filteredItems.length === 0 ? (
          <div className="bg-white border border-cream-200 rounded-xl p-8 text-center text-ink-400 text-sm">
            Zatím žádné odpovědi. Když někdo odpoví na tvůj dotaz, objeví se tady.
          </div>
        ) : (
          <ul className="space-y-2">
            {filteredItems.map(q => (
              <li key={q.id}
                className={`bg-white border rounded-lg p-4 ${
                  q.answer_read === false ? 'border-accent-300 bg-accent-50/30' : 'border-cream-200'
                }`}>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-ink-500 flex items-center gap-2">
                      <span>Odpověděl(a) <strong>{q.to_user_name}</strong></span>
                      {q.answer_read === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-500 text-white font-bold">
                          NOVÉ
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-400 mt-0.5">
                      {q.project_name && <>{q.project_name} · </>}
                      {q.task_title && <>„{q.task_title}"</>}
                    </div>
                  </div>
                  <div className="text-[10px] text-ink-400 whitespace-nowrap">
                    {fmt(q.answered_at)}
                  </div>
                </div>

                <div className="text-sm text-ink-600 mb-1 pl-3 border-l-2 border-cream-300">
                  <span className="text-ink-400 text-[11px] mr-1">Ptal(a) ses:</span>
                  {q.question}
                </div>
                <div className="text-sm text-ink-800 mt-2 pl-3 border-l-2 border-emerald-400 bg-emerald-50/50 py-2 rounded-r">
                  <span className="text-emerald-700 text-[11px] mr-1 font-semibold">ODPOVĚĎ:</span>
                  {q.answer}
                </div>

                {q.task_id && (
                  <button onClick={() => openTask(q.task_id)}
                    className="mt-3 text-xs text-brand-500 hover:underline">
                    → Otevřít úkol
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onChanged={() => setDetailTask(null)}
        />
      )}
    </div>
  );
}
