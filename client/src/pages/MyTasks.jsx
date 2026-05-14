// Moje úkoly – hlavní pracovní prostor uživatele.
// Kliknutí na úkol otevře plný TaskDetailModal (editace, status, poznámka, přílohy, dotazy).
// Stránka Projekty je pak jen "big picture" a kliknutí v MyTasks nás tam nepřesměrovává.
import { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import { StatusBadge, StatusActions, AIEstimateBadge, STATUS_META } from '../components/TaskStatus.jsx';
import { tasks as tasksApi } from '../api.js';
import { useAuth } from '../auth.jsx';

const STATUS = STATUS_META;
const PIPELINE_ORDER = ['todo', 'in_progress', 'review', 'done'];

const PRIORITY = {
  urgent: { label: '🔥 Urgent', color: 'text-red-600' },
  high:   { label: '⬆ Vysoká', color: 'text-amber-600' },
  normal: { label: 'Normální', color: 'text-ink-500' },
  low:    { label: '⬇ Nízká',  color: 'text-ink-400' },
};

const STATUS_TABS = [
  { value: 'all',        label: 'Vše' },
  { value: 'todo',       label: 'Čeká' },
  { value: 'in_progress',label: 'V práci' },
  { value: 'review',     label: 'Review' },
  { value: 'done',       label: 'Hotovo' },
];

export default function MyTasks() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState(() => localStorage.getItem('myTasks.view') || 'list');
  const [detailTaskId, setDetailTaskId] = useState(null);

  useEffect(() => {
    localStorage.setItem('myTasks.view', view);
  }, [view]);

  // Načteme vždy všechny úkoly přiřazené mně – filtr aplikujeme čistě na klientu.
  // To zabraňuje dřívějšímu bugu, kdy se filtr na backend zaměňoval s view a nepřepočítával se UI.
  const load = () => {
    setLoading(true);
    tasksApi.mine()
      .then(d => setTasks(d.tasks))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filteredTasks = useMemo(() => {
    if (view === 'pipeline' || filter === 'all') return tasks;
    return tasks.filter(t => t.status === filter);
  }, [tasks, filter, view]);

  const counts = useMemo(() => {
    const c = { all: tasks.length, todo: 0, in_progress: 0, review: 0, done: 0 };
    for (const t of tasks) { if (c[t.status] !== undefined) c[t.status]++; }
    return c;
  }, [tasks]);

  const handleStatusChange = async (task, status) => {
    // Optimistic update – ihned přesune kartu, pak refetch
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status } : t));
    try {
      await tasksApi.update(task.id, { status });
    } finally {
      load();
    }
  };

  const detailTask = useMemo(
    () => tasks.find(t => t.id === detailTaskId) || null,
    [detailTaskId, tasks]
  );

  return (
    <div>
      <PageHeader
        title="Moje úkoly"
        subtitle={`Úkoly přiřazené ${user.name} – tvůj hlavní pracovní prostor`}
        actions={<ViewSwitcher value={view} onChange={setView} />}
      />

      <div className="p-8 space-y-4">
        {/* Filtry – jen v list view */}
        {view === 'list' && (
          <div className="flex gap-1 bg-white rounded-xl border border-cream-200 p-1 w-fit flex-wrap">
            {STATUS_TABS.map(t => (
              <button
                key={t.value}
                onClick={() => setFilter(t.value)}
                className={`px-3 py-1.5 text-sm rounded-lg transition flex items-center gap-1.5 ${
                  filter === t.value ? 'bg-brand-500 text-white' : 'hover:bg-cream-100 text-ink-600'
                }`}
              >
                <span>{t.label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  filter === t.value ? 'bg-white/20 text-white' : 'bg-cream-200 text-ink-500'
                }`}>{counts[t.value] || 0}</span>
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-cream-200 p-6 text-center text-ink-400">Načítám…</div>
        ) : view === 'list' ? (
          <ListView
            tasks={filteredTasks}
            filter={filter}
            onStatusChange={handleStatusChange}
            onOpen={(t) => setDetailTaskId(t.id)}
          />
        ) : (
          <PipelineView
            tasks={tasks}
            onStatusChange={handleStatusChange}
            onOpen={(t) => setDetailTaskId(t.id)}
          />
        )}
      </div>

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTaskId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// ---------- View Switcher ----------
function ViewSwitcher({ value, onChange }) {
  return (
    <div className="flex bg-cream-100 rounded-lg p-1">
      <button
        onClick={() => onChange('list')}
        className={`px-3 py-1.5 text-sm rounded-md transition ${value === 'list' ? 'bg-white shadow-sm font-medium text-brand-500' : 'text-ink-500'}`}
      >☰ Seznam</button>
      <button
        onClick={() => onChange('pipeline')}
        className={`px-3 py-1.5 text-sm rounded-md transition ${value === 'pipeline' ? 'bg-white shadow-sm font-medium text-brand-500' : 'text-ink-500'}`}
      >▦ Pipeline</button>
    </div>
  );
}

// ---------- LIST VIEW ----------
function ListView({ tasks, filter, onStatusChange, onOpen }) {
  if (tasks.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-cream-200 p-10 text-center text-ink-400">
        {filter && filter !== 'all' ? 'V této kategorii nic nemáš.' : 'Zatím žádné přiřazené úkoly.'}
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl border border-cream-200 overflow-hidden">
      <ul className="divide-y divide-cream-200">
        {tasks.map(t => (
          <li
            key={t.id}
            onClick={() => onOpen(t)}
            className="p-4 hover:bg-cream-50 cursor-pointer transition"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={t.status} />
              <span className={`font-medium ${t.status === 'done' ? 'line-through text-ink-400' : 'text-ink-800'}`}>
                {t.title}
              </span>
              {t.priority !== 'normal' && (
                <span className={`text-xs font-bold ${PRIORITY[t.priority].color}`}>
                  {PRIORITY[t.priority].label}
                </span>
              )}
              <QuestionBadges task={t} />
              <AIEstimateBadge task={t} />
              {t.attachment_count > 0 && (
                <span className="text-xs text-brand-500 font-medium">📎 {t.attachment_count}</span>
              )}
            </div>
            {t.description && <div className="text-sm text-ink-600 mt-1 line-clamp-2">{t.description}</div>}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500 mt-1">
              <span>📁 {t.project_name}</span>
              {t.due_date && <span>📅 {String(t.due_date).slice(0, 10)}</span>}
              {t.estimated_h && <span>⏱ ruční odhad {t.estimated_h}h</span>}
            </div>
            {/* Akce stavu – aby se kliknutí nepropagovalo do otevření detailu */}
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <StatusActions task={t} onChange={onStatusChange} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- PIPELINE VIEW ----------
function PipelineView({ tasks, onStatusChange, onOpen }) {
  const [dragId, setDragId] = useState(null);

  const grouped = useMemo(() => {
    const g = { todo: [], in_progress: [], review: [], done: [] };
    for (const t of tasks) {
      if (g[t.status]) g[t.status].push(t);
    }
    return g;
  }, [tasks]);

  const onDragStart = (e, task) => {
    setDragId(task.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(task.id));
  };
  const onDragEnd = () => setDragId(null);
  const onDropIntoColumn = (e, status) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const task = tasks.find(t => t.id === id);
    if (task && task.status !== status) onStatusChange(task, status);
    setDragId(null);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {PIPELINE_ORDER.map(statusKey => (
        <Column
          key={statusKey}
          statusKey={statusKey}
          tasks={grouped[statusKey]}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDrop={onDropIntoColumn}
          dragId={dragId}
          onStatusChange={onStatusChange}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function Column({ statusKey, tasks, onDragStart, onDragEnd, onDrop, dragId, onStatusChange, onOpen }) {
  const [over, setOver] = useState(false);
  const status = STATUS[statusKey];
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); onDrop(e, statusKey); }}
      className={`bg-cream-100/60 rounded-xl border-2 transition ${over ? 'border-brand-500 bg-brand-50/50' : 'border-transparent'}`}
    >
      <div className="px-3 py-2.5 flex items-center gap-2 border-b border-cream-200">
        <span className={`w-2 h-2 rounded-full ${status.dot}`} />
        <span className="font-semibold text-ink-800 text-sm">{status.label}</span>
        <span className="text-xs text-ink-400 ml-auto">{tasks.length}</span>
      </div>
      <div className="p-2 space-y-2 min-h-[80px] max-h-[calc(100vh-260px)] overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="text-xs text-ink-300 text-center py-6 border-2 border-dashed border-cream-200 rounded-lg">
            přesuň úkol sem
          </div>
        ) : (
          tasks.map(t => (
            <PipelineCard
              key={t.id}
              task={t}
              isDragging={dragId === t.id}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onStatusChange={onStatusChange}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PipelineCard({ task, isDragging, onDragStart, onDragEnd, onStatusChange, onOpen }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task)}
      className={`bg-white rounded-lg p-3 border border-cream-200 shadow-sm cursor-pointer transition ${
        isDragging ? 'opacity-30 rotate-1' : 'hover:shadow-md hover:border-cream-300'
      }`}
    >
      <div className="flex items-center gap-1 mb-2">
        <StatusBadge status={task.status} size="small" />
        {task.priority !== 'normal' && (
          <span className={`text-[10px] font-bold ${PRIORITY[task.priority].color}`}>
            {PRIORITY[task.priority].label}
          </span>
        )}
      </div>
      <div className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-ink-400' : 'text-ink-800'}`}>
        {task.title}
      </div>
      <div className="text-xs text-ink-500 block mt-1 truncate">
        📁 {task.project_name}
      </div>
      <div className="flex flex-wrap gap-1 text-[10px] text-ink-500 mt-2">
        {task.due_date && <span className="px-1.5 py-0.5 bg-cream-100 rounded">📅 {String(task.due_date).slice(0, 10)}</span>}
        {task.estimated_h && <span className="px-1.5 py-0.5 bg-cream-100 rounded">⏱ {task.estimated_h}h</span>}
        {task.attachment_count > 0 && <span className="px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded">📎 {task.attachment_count}</span>}
        <AIEstimateBadge task={task} />
      </div>
      <div className="flex justify-between items-center mt-2 pt-2 border-t border-cream-100" onClick={(e) => e.stopPropagation()}>
        <QuestionBadges task={task} small />
        <StatusActions task={task} onChange={onStatusChange} compact />
      </div>
    </div>
  );
}

// ---------- Sdílené komponenty ----------
function QuestionBadges({ task, small = false }) {
  const sz = small ? 'text-[9px]' : 'text-xs';
  if (task.pending_questions_for_me > 0) {
    return (
      <span
        className={`px-2 py-0.5 bg-red-100 text-red-700 rounded font-semibold ${sz}`}
        title="Někdo se tě ptá"
      >💬 {task.pending_questions_for_me} pro mě</span>
    );
  }
  if (task.pending_q > 0) {
    return (
      <span className={`px-2 py-0.5 bg-amber-100 text-amber-700 rounded font-semibold ${sz}`}>
        💬 {task.pending_q} čeká
      </span>
    );
  }
  if (task.answered_q > 0) {
    return (
      <span className={`px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded ${sz}`}>
        💬 {task.answered_q} ✓
      </span>
    );
  }
  return null;
}
