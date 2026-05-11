// Moje úkoly – přepínání List / Pipeline (Kanban) view
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { tasks as tasksApi } from '../api.js';
import { useAuth } from '../auth.jsx';

const STATUS = {
  todo:        { label: 'Čeká',     color: 'bg-cream-200 text-ink-600',         dot: 'bg-ink-400' },
  in_progress: { label: 'V práci',  color: 'bg-blue-100 text-blue-700',         dot: 'bg-blue-500' },
  review:      { label: 'Review',   color: 'bg-accent-100 text-accent-700',     dot: 'bg-accent-500' },
  done:        { label: 'Hotovo',   color: 'bg-emerald-100 text-emerald-700',   dot: 'bg-emerald-500' },
};
const PIPELINE_ORDER = ['todo', 'in_progress', 'review', 'done'];

const PRIORITY = {
  urgent: { label: '🔥 Urgent', color: 'text-red-600' },
  high:   { label: '⬆ Vysoká', color: 'text-amber-600' },
  normal: { label: 'Normální', color: 'text-ink-500' },
  low:    { label: '⬇ Nízká',  color: 'text-ink-400' },
};

const STATUS_TABS = [
  { value: '',           label: 'Vše' },
  { value: 'todo',       label: 'Čeká' },
  { value: 'in_progress',label: 'V práci' },
  { value: 'review',     label: 'Review' },
  { value: 'done',       label: 'Hotovo' },
];

export default function MyTasks() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState(() => localStorage.getItem('myTasks.view') || 'list');

  useEffect(() => {
    localStorage.setItem('myTasks.view', view);
  }, [view]);

  const load = () => {
    setLoading(true);
    // V Pipeline pohledu chceme všechny stavy najednou (nezávisle na filtru)
    const params = (view === 'list' && filter) ? { status: filter } : {};
    tasksApi.mine(params)
      .then(d => setTasks(d.tasks))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter, view]);

  const handleStatusChange = async (task, status) => {
    // Optimistic update – ihned přesune kartu, pak refetch
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status } : t));
    try {
      await tasksApi.update(task.id, { status });
    } finally {
      load();
    }
  };

  return (
    <div>
      <PageHeader
        title="Moje úkoly"
        subtitle={`Úkoly přiřazené ${user.name}`}
        actions={
          <ViewSwitcher value={view} onChange={setView} />
        }
      />

      <div className="p-8 space-y-4">
        {/* Filtry – jen v list view */}
        {view === 'list' && (
          <div className="flex gap-1 bg-white rounded-xl border border-cream-200 p-1 w-fit">
            {STATUS_TABS.map(t => (
              <button
                key={t.value}
                onClick={() => setFilter(t.value)}
                className={`px-3 py-1.5 text-sm rounded-lg transition ${
                  filter === t.value ? 'bg-brand-500 text-white' : 'hover:bg-cream-100 text-ink-600'
                }`}
              >{t.label}</button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-cream-200 p-6 text-center text-ink-400">Načítám…</div>
        ) : view === 'list' ? (
          <ListView tasks={tasks} filter={filter} onStatusChange={handleStatusChange} />
        ) : (
          <PipelineView tasks={tasks} onStatusChange={handleStatusChange} />
        )}
      </div>
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
function ListView({ tasks, filter, onStatusChange }) {
  if (tasks.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-cream-200 p-10 text-center text-ink-400">
        {filter ? 'V této kategorii nic nemáš.' : 'Zatím žádné přiřazené úkoly.'}
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl border border-cream-200 overflow-hidden">
      <ul className="divide-y divide-cream-200">
        {tasks.map(t => (
          <li key={t.id} className="p-4 hover:bg-cream-50">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={t.status === 'done'}
                onChange={(e) => onStatusChange(t, e.target.checked ? 'done' : 'todo')}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-medium ${t.status === 'done' ? 'line-through text-ink-400' : 'text-ink-800'}`}>
                    {t.title}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS[t.status].color}`}>
                    {STATUS[t.status].label}
                  </span>
                  {t.priority !== 'normal' && (
                    <span className={`text-xs font-bold ${PRIORITY[t.priority].color}`}>
                      {PRIORITY[t.priority].label}
                    </span>
                  )}
                  <QuestionBadges task={t} />
                </div>
                {t.description && <div className="text-sm text-ink-600 mt-1">{t.description}</div>}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500 mt-1">
                  <Link to={`/projects/${t.project_id}`} className="hover:text-brand-500">
                    📁 {t.project_name}{t.project_client && ` · ${t.project_client}`}
                  </Link>
                  {t.due_date && <span>📅 {t.due_date}</span>}
                  {t.estimated_h && <span>⏱ {t.estimated_h}h odhad</span>}
                </div>
              </div>
              <ActionButtons task={t} onStatusChange={onStatusChange} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- PIPELINE VIEW ----------
function PipelineView({ tasks, onStatusChange }) {
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
        />
      ))}
    </div>
  );
}

function Column({ statusKey, tasks, onDragStart, onDragEnd, onDrop, dragId, onStatusChange }) {
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
            />
          ))
        )}
      </div>
    </div>
  );
}

function PipelineCard({ task, isDragging, onDragStart, onDragEnd, onStatusChange }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onDragEnd={onDragEnd}
      className={`bg-white rounded-lg p-3 border border-cream-200 shadow-sm cursor-grab active:cursor-grabbing transition ${
        isDragging ? 'opacity-30 rotate-1' : 'hover:shadow-md hover:border-cream-300'
      }`}
    >
      {task.priority !== 'normal' && (
        <div className={`text-[10px] font-bold mb-1 ${PRIORITY[task.priority].color}`}>
          {PRIORITY[task.priority].label}
        </div>
      )}
      <div className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-ink-400' : 'text-ink-800'}`}>
        {task.title}
      </div>
      <Link to={`/projects/${task.project_id}`} className="text-xs text-ink-500 hover:text-brand-500 block mt-1 truncate">
        📁 {task.project_name}
      </Link>
      <div className="flex flex-wrap gap-1 text-[10px] text-ink-500 mt-2">
        {task.due_date && <span className="px-1.5 py-0.5 bg-cream-100 rounded">📅 {task.due_date}</span>}
        {task.estimated_h && <span className="px-1.5 py-0.5 bg-cream-100 rounded">⏱ {task.estimated_h}h</span>}
      </div>
      <div className="flex justify-between items-center mt-2 pt-2 border-t border-cream-100">
        <QuestionBadges task={task} small />
        <ActionButtons task={task} onStatusChange={onStatusChange} compact />
      </div>
    </div>
  );
}

// ---------- Sdílené komponenty ----------
function ActionButtons({ task, onStatusChange, compact = false }) {
  const isDone = task.status === 'done';
  if (isDone) {
    return (
      <button
        onClick={() => onStatusChange(task, 'todo')}
        className={`text-ink-500 hover:bg-cream-100 border border-cream-300 rounded ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'}`}
      >↩ Vrátit</button>
    );
  }
  const sz = compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs';
  return (
    <div className="flex items-center gap-1">
      {task.status === 'todo' && (
        <button
          onClick={() => onStatusChange(task, 'in_progress')}
          className={`bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded font-medium ${sz}`}
        >▶ {compact ? 'Začít' : 'Začít pracovat'}</button>
      )}
      <button
        onClick={() => onStatusChange(task, 'done')}
        className={`bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded font-medium ${sz}`}
      >✓ Hotovo</button>
    </div>
  );
}

function QuestionBadges({ task, small = false }) {
  const sz = small ? 'text-[9px]' : 'text-xs';
  if (task.pending_questions_for_me > 0) {
    return (
      <Link
        to="/questions"
        className={`px-2 py-0.5 bg-red-100 text-red-700 rounded font-semibold ${sz}`}
        title="Někdo se tě ptá"
      >💬 {task.pending_questions_for_me} pro mě</Link>
    );
  }
  if (task.pending_q > 0) {
    return (
      <Link to="/questions?box=sent" className={`px-2 py-0.5 bg-amber-100 text-amber-700 rounded font-semibold ${sz}`}>
        💬 {task.pending_q} čeká
      </Link>
    );
  }
  if (task.answered_q > 0) {
    return (
      <Link to="/questions?box=sent" className={`px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded ${sz}`}>
        💬 {task.answered_q} ✓
      </Link>
    );
  }
  return null;
}
