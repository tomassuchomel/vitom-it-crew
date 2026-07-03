// Review k dokončení – stránka pro managera projektu / admina.
// Ukazuje seznam úkolů ve stavu 'review' (čekající na schválení), kde
// je current user manager projektu nebo má roli admin.
//
// Klik na úkol otevře TaskDetailModal s plnou kontext (popis, přílohy)
// a tlačítky „Schválit & dokončit" / „Vrátit k opravě". To je hlavní akce.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import ReviewTaskDialog from '../components/ReviewTaskDialog.jsx';
import Avatar from '../components/Avatar.jsx';
import { reviews as reviewsApi } from '../api.js';

const PRIORITY_PILL = {
  urgent: { label: '🔥 Urgent', cls: 'bg-red-50 text-red-700 border-red-200' },
  high:   { label: '⬆ Vysoká',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  normal: null,
  low:    { label: '⬇ Nízká',   cls: 'bg-slate-50 text-slate-500 border-slate-200' },
};

export default function Review() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailTask, setDetailTask] = useState(null);
  // null | { task, verdict } – pro ReviewTaskDialog otevřený přímo z listu
  const [reviewing, setReviewing] = useState(null);
  const [searchParams] = useSearchParams();
  const teamIdFilter = Number(searchParams.get('team')) || null;

  // Cross-team default (review-queue vrací všechny mé projekty). Filter na tým dle URL.
  const filteredTasks = useMemo(
    () => teamIdFilter ? tasks.filter(t => t.project_team_id === teamIdFilter) : tasks,
    [tasks, teamIdFilter]
  );

  const load = (silent = false) => {
    if (!silent) setLoading(true);
    reviewsApi.queue()
      .then(d => setTasks(d.tasks || []))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div>
      <PageHeader
        title="Review k dokončení"
        subtitle={
          loading ? 'Načítám…'
            : filteredTasks.length === 0
              ? 'Žádné úkoly nečekají na review.'
              : `${filteredTasks.length} úkol(ů) čeká na tvé schválení${teamIdFilter ? ' (filtrováno)' : ''}`
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="text-slate-500">Načítám…</div>
        ) : filteredTasks.length === 0 ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-8 text-center">
            <div className="text-4xl mb-2">🎉</div>
            <div className="text-emerald-700 font-medium">Vše schválené!</div>
            <div className="text-sm text-emerald-600 mt-1">
              {teamIdFilter ? 'V tomto týmu nic k review.' : 'Programátoři ti nedali nic k review.'}
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {filteredTasks.map(t => (
              <ReviewRow
                key={t.id}
                task={t}
                onOpen={() => setDetailTask(t)}
                onApprove={() => setReviewing({ task: t, verdict: 'approved' })}
                onReject={() => setReviewing({ task: t, verdict: 'rejected' })}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Detail úkolu – plný kontext + akce */}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onChanged={() => { setDetailTask(null); load(true); }}
        />
      )}

      {/* Rychlé schválení/vrácení z listu (bez otevírání detailu) */}
      {reviewing && (
        <ReviewTaskDialog
          task={reviewing.task}
          verdict={reviewing.verdict}
          onClose={() => setReviewing(null)}
          onDone={() => { setReviewing(null); load(true); }}
        />
      )}
    </div>
  );
}

function ReviewRow({ task, onOpen, onApprove, onReject }) {
  const due = task.due_date ? String(task.due_date).slice(0, 10) : null;
  const priorityPill = PRIORITY_PILL[task.priority];
  const wasRejected = task.review_count > 0;

  return (
    <li className="bg-white border border-cream-200 rounded-xl p-4 hover:shadow-md transition">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <button
            onClick={onOpen}
            className="text-left w-full"
          >
            <div className="font-semibold text-ink-800 hover:text-brand-500 leading-snug">
              {task.title}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
              <Link to={`/projects/${task.project_id}`} className="hover:text-brand-500" onClick={(e) => e.stopPropagation()}>
                📁 {task.project_name}
              </Link>
              {task.assignee_name && (
                <span className="inline-flex items-center gap-1.5">
                  <Avatar user={{ id: task.assignee_id, name: task.assignee_name }} size={18} />
                  <span>{task.assignee_name}</span>
                </span>
              )}
              {due && <span>📅 {due}</span>}
              {task.attachment_count > 0 && (
                <span className="text-brand-500 font-medium">📎 {task.attachment_count}</span>
              )}
              {priorityPill && (
                <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border ${priorityPill.cls}`}>
                  {priorityPill.label}
                </span>
              )}
              {wasRejected && (
                <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-orange-50 text-orange-700 border-orange-200">
                  ↻ Iterace {task.review_count}
                </span>
              )}
            </div>
            {task.description && (
              <div className="text-sm text-ink-600 mt-2 line-clamp-2">{task.description}</div>
            )}
          </button>
        </div>

        <div className="flex flex-col gap-1.5 flex-shrink-0">
          <button
            onClick={onApprove}
            className="px-3 py-1.5 text-xs font-medium bg-emerald-500 text-white rounded hover:bg-emerald-600 whitespace-nowrap"
          >✅ Schválit</button>
          <button
            onClick={onReject}
            className="px-3 py-1.5 text-xs font-medium border border-orange-300 text-orange-700 rounded hover:bg-orange-50 whitespace-nowrap"
          >🔄 Vrátit</button>
          <button
            onClick={onOpen}
            className="px-3 py-1 text-[11px] text-ink-500 hover:text-brand-500"
          >Detail →</button>
        </div>
      </div>
    </li>
  );
}
