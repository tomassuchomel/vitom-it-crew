// Vrácené k opravě – stránka pro programátora/asignéeho. Symetrie k /review.
//
// Backend GET /api/tasks/needs-fix vrací jen úkoly:
//   - aktuálního uživatele (assignee_id = me)
//   - ve stavu 'needs_fix' (manager vrátil k opravě)
//   - v current teamu
// + s nejnovějším rejected reviewem (komentář + reviewer + datum).
//
// Klik na kartu otevře TaskDetailModal s plnou aktivitou (review history,
// přílohy, popis). Tlačítko "Začít opravu" rovnou přepne status na in_progress.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import Avatar from '../components/Avatar.jsx';
import { reviews as reviewsApi, tasks as tasksApi } from '../api.js';

const PRIORITY_PILL = {
  urgent: { label: '🔥 Urgent', cls: 'bg-red-50 text-red-700 border-red-200' },
  high:   { label: '⬆ Vysoká',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  normal: null,
  low:    { label: '⬇ Nízká',   cls: 'bg-slate-50 text-slate-500 border-slate-200' },
};

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + (String(iso).endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function NeedsFix() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailTask, setDetailTask] = useState(null);

  const load = (silent = false) => {
    if (!silent) setLoading(true);
    reviewsApi.needsFix()
      .then(d => setTasks(d.tasks || []))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Tlačítko "Začít opravu" → posune needs_fix → in_progress přímo z list view
  const startFix = async (taskId, e) => {
    e?.stopPropagation();
    if (!confirm('Začít pracovat na opravě? Úkol se přesune do „V práci".')) return;
    try {
      await tasksApi.update(taskId, { status: 'in_progress' });
      load(true);
    } catch (e) {
      alert(e.response?.data?.message || 'Akce selhala');
    }
  };

  return (
    <div>
      <PageHeader
        title="🔄 Vrácené k opravě"
        subtitle={
          loading ? 'Načítám…'
            : tasks.length === 0
              ? 'Žádné úkoly vrácené k úpravě 🎉'
              : `${tasks.length} úkol(ů) ti manager vrátil k opravě`
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="text-slate-500">Načítám…</div>
        ) : tasks.length === 0 ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-8 text-center">
            <div className="text-4xl mb-2">✨</div>
            <div className="text-emerald-700 font-medium">Žádné vrácené úkoly</div>
            <div className="text-sm text-emerald-600 mt-1">
              Všechno, co jsi předal k review, prošlo nebo se ještě nevyhodnotilo.
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {tasks.map(t => (
              <TaskCard
                key={t.id}
                task={t}
                onOpen={() => setDetailTask(t)}
                onStartFix={(e) => startFix(t.id, e)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Detail úkolu — review history, přílohy, popis. Po zavření refresh. */}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onChanged={() => { setDetailTask(null); load(true); }}
        />
      )}
    </div>
  );
}

function TaskCard({ task, onOpen, onStartFix }) {
  const priorityPill = PRIORITY_PILL[task.priority];
  const dueDate = task.due_date ? String(task.due_date).slice(0, 10) : null;
  const iter = task.total_reviews || 0;

  return (
    <li
      onClick={onOpen}
      className="bg-white border border-orange-200 rounded-xl p-4 hover:shadow-md transition cursor-pointer"
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {/* Title + meta */}
          <div className="font-semibold text-ink-800 leading-snug">{task.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            <Link to={`/projects/${task.project_id}`}
              className="hover:text-brand-500"
              onClick={(e) => e.stopPropagation()}>
              📁 {task.project_name}
            </Link>
            {dueDate && <span>📅 {dueDate}</span>}
            {task.attachment_count > 0 && (
              <span className="text-brand-500 font-medium">📎 {task.attachment_count}</span>
            )}
            {priorityPill && (
              <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border ${priorityPill.cls}`}>
                {priorityPill.label}
              </span>
            )}
            {iter > 1 && (
              <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
                ↻ Iterace {iter}
              </span>
            )}
          </div>

          {/* Latest review comment */}
          {task.latest_review_comment && (
            <div className="mt-3 bg-orange-50 border-l-4 border-orange-400 rounded-r p-3">
              <div className="text-[11px] text-orange-700 font-medium mb-1">
                🔄 Vrácení od {task.latest_reviewer_name || 'neznámý'} · {fmtDateTime(task.latest_review_at)}
              </div>
              <div className="text-sm text-ink-800 whitespace-pre-wrap">
                {task.latest_review_comment}
              </div>
            </div>
          )}
          {!task.latest_review_comment && (
            <div className="mt-3 text-xs text-ink-400 italic">
              (manager nenapsal komentář – otevři detail úkolu pro plnou historii)
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5 flex-shrink-0">
          <button
            onClick={onStartFix}
            className="px-3 py-1.5 text-xs font-medium bg-blue-500 text-white rounded hover:bg-blue-600 whitespace-nowrap"
          >🔧 Začít opravu</button>
          <button
            onClick={onOpen}
            className="px-3 py-1 text-[11px] text-ink-500 hover:text-brand-500"
          >Detail →</button>
        </div>
      </div>
    </li>
  );
}
