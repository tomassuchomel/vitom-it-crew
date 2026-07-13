// Moje úkoly – hlavní pracovní prostor uživatele.
// Kliknutí na úkol otevře plný TaskDetailModal (editace, status, poznámka, přílohy, dotazy).
// Stránka Projekty je pak jen "big picture" a kliknutí v MyTasks nás tam nepřesměrovává.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import TaskCompletionDialog from '../components/TaskCompletionDialog.jsx';
import TimeTriad from '../components/TimeTriad.jsx';
import { StatusBadge, StatusActions, AIEstimateBadge, STATUS_META } from '../components/TaskStatus.jsx';
import { tasks as tasksApi, projects as projectsApi, users as usersApi, attachments as attachmentsApi } from '../api.js';
import { useAuth, can } from '../auth.jsx';
import { useTeams } from '../teams.jsx';
import Modal from '../components/Modal.jsx';

const STATUS = STATUS_META;
// needs_fix patří doprostřed – je to "vráceno k opravě, hned to vyřeš".
const PIPELINE_ORDER = ['todo', 'needs_fix', 'in_progress', 'review', 'done'];

const PRIORITY = {
  urgent: { label: '🔥 Urgent', color: 'text-red-600' },
  high:   { label: '⬆ Vysoká', color: 'text-amber-600' },
  normal: { label: 'Normální', color: 'text-ink-500' },
  low:    { label: '⬇ Nízká',  color: 'text-ink-400' },
};

const STATUS_TABS = [
  { value: 'all',         label: 'Vše' },
  { value: 'todo',        label: 'Čeká' },
  { value: 'needs_fix',   label: 'K opravě' },
  { value: 'in_progress', label: 'V práci' },
  { value: 'review',      label: 'Review' },
  { value: 'done',        label: 'Hotovo' },
];

export default function MyTasks() {
  const { user } = useAuth();
  const { currentTeam } = useTeams();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  // Default 'todo' — user typicky chce vidět, co příště udělat, ne archiv.
  // Přepínač 'Vše' zůstává k dispozici pro plný pohled.
  const [filter, setFilter] = useState('todo');
  const [view, setView] = useState(() => localStorage.getItem('myTasks.view') || 'list');
  const [detailTaskId, setDetailTaskId] = useState(null);
  const [completingTask, setCompletingTask] = useState(null);
  const [creating, setCreating] = useState(false);
  const canCreate = can.createTasks(user);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    localStorage.setItem('myTasks.view', view);
  }, [view]);

  // Deep-link z emailu: /my-tasks?taskId=N → otevři TaskDetailModal automaticky.
  useEffect(() => {
    const tid = Number(searchParams.get('taskId'));
    if (Number.isInteger(tid) && tid > 0) {
      setDetailTaskId(tid);
      // Vyčisti query, ať refresh nebo zavření modal ne-reopens
      const next = new URLSearchParams(searchParams);
      next.delete('taskId');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Načteme vždy všechny úkoly přiřazené mně – filtr aplikujeme čistě na klientu.
  // To zabraňuje dřívějšímu bugu, kdy se filtr na backend zaměňoval s view a nepřepočítával se UI.
  const load = () => {
    setLoading(true);
    tasksApi.mine()
      .then(d => setTasks(d.tasks))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // ?team=N v URL → filter na konkrétní tým (submenu v Layoutu).
  // Cross-team úkoly (Patricia scénář) mají skryté project_team_id na null.
  const teamIdFilter = Number(searchParams.get('team')) || null;

  const filteredTasks = useMemo(() => {
    let out = tasks;
    if (teamIdFilter) out = out.filter(t => t.project_team_id === teamIdFilter);
    if (view === 'pipeline' || filter === 'all') return out;
    return out.filter(t => t.status === filter);
  }, [tasks, filter, view, teamIdFilter]);

  const counts = useMemo(() => {
    const c = { all: tasks.length, todo: 0, in_progress: 0, review: 0, needs_fix: 0, done: 0 };
    for (const t of tasks) { if (c[t.status] !== undefined) c[t.status]++; }
    return c;
  }, [tasks]);

  const handleStatusChange = async (task, status) => {
    // Předání k review – vyskočí dialog na skutečný čas (programátor zaznamenává spotřebovaný čas).
    if (status === 'review' && task.status !== 'review') {
      setCompletingTask({ ...task, _targetStatus: 'review' });
      return;
    }
    // 'done' přímo už nejde (backend blokuje pro assignee). Ostatní stavy projdou normálně.
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status } : t));
    try {
      await tasksApi.update(task.id, { status });
    } finally {
      load();
    }
  };

  const handleCompletionConfirm = async (actualH) => {
    if (!completingTask) return;
    const id = completingTask.id;
    // _targetStatus rozhoduje – nový workflow používá 'review', legacy fallback 'done'
    const target = completingTask._targetStatus || 'done';
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: target, actual_h: actualH } : t));
    try {
      await tasksApi.update(id, { status: target, actual_h: actualH });
    } finally {
      setCompletingTask(null);
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
        actions={
          <>
            {canCreate && (
              <button
                onClick={() => setCreating(true)}
                className="px-3 py-1.5 bg-brand-500 text-white text-sm rounded-lg hover:bg-brand-600 font-medium"
              >+ Nový úkol</button>
            )}
            <ViewSwitcher value={view} onChange={setView} />
          </>
        }
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
            currentTeamId={currentTeam?.id}
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
      {completingTask && (
        <TaskCompletionDialog
          task={completingTask}
          onConfirm={handleCompletionConfirm}
          onCancel={() => setCompletingTask(null)}
        />
      )}
      {creating && (
        <NewTaskModal
          currentUser={user}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

// Modal: rychlý formulář na vytvoření úkolu.
// Pro admin/manager (can.createTasks): projekty napříč VŠEMI týmy + libovolný
// assignee z teamu vybraného projektu. Default assignee = currentUser.
// Pro ostatní: jen current team + assignee = sám.
function NewTaskModal({ currentUser, onClose, onCreated }) {
  const isManagerOrAdmin = can.createTasks(currentUser);
  const [projects, setProjects] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [form, setForm] = useState({
    project_id: '',
    assignee_id: currentUser.id,
    title: '', priority: 'normal',
    due_date: '', estimated_h: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Přílohy k novému úkolu — nahrají se hned po create.
  const [files, setFiles] = useState([]);

  // Načti projekty — cross-team pro manažery+, current team pro ostatní.
  useEffect(() => {
    const loader = isManagerOrAdmin ? projectsApi.listAll() : projectsApi.list();
    loader
      .then(d => {
        const active = (d.projects || []).filter(p => !p.status || p.status === 'active');
        setProjects(active);
        if (active.length === 1) setForm(f => ({ ...f, project_id: active[0].id }));
      })
      .catch(() => setErr('Načtení projektů selhalo.'));
  }, [isManagerOrAdmin]);

  // Po vybrání projektu načti assignees z jeho týmu (jinak cross-team výběr
  // by nedávaly seznam možností). Default assignee = currentUser, pokud je
  // členem; jinak první z listu.
  useEffect(() => {
    if (!form.project_id) { setAssignees([]); return; }
    const proj = projects.find(p => String(p.id) === String(form.project_id));
    if (!proj?.team_id) {
      // Fallback (single-team scope): current team users
      usersApi.list().then(d => setAssignees(d.users || [])).catch(() => setAssignees([]));
      return;
    }
    usersApi.listInTeam(proj.team_id)
      .then(d => {
        const list = d.users || [];
        setAssignees(list);
        // Pokud current user NENÍ v teamu projektu, předvyplnit prvním
        if (!list.some(u => u.id === currentUser.id)) {
          setForm(f => ({ ...f, assignee_id: list[0]?.id || '' }));
        }
      })
      .catch(() => setAssignees([]));
  }, [form.project_id, projects, currentUser.id]);

  const submit = async (e) => {
    e?.preventDefault();
    setErr(null);
    if (!form.project_id) { setErr('Vyber projekt.'); return; }
    if (!form.title.trim()) { setErr('Vyplň název úkolu.'); return; }
    if (!form.assignee_id) { setErr('Vyber, komu úkol patří.'); return; }
    setBusy(true);
    try {
      const created = await tasksApi.create({
        project_id: Number(form.project_id),
        title: form.title.trim(),
        assignee_id: Number(form.assignee_id),
        priority: form.priority,
        due_date: form.due_date || null,
        estimated_h: form.estimated_h ? Number(form.estimated_h) : null,
      });
      // Přílohy: uploadneme až po vytvoření (potřebujeme task.id).
      // Chyba uploadu neblokuje úspěch úkolu — jen upozorníme.
      const taskId = created?.task?.id || created?.id;
      if (files.length > 0 && taskId) {
        try {
          await attachmentsApi.upload(taskId, files);
        } catch (upErr) {
          setErr(`Úkol vytvořen, ale přílohy se nenahrály: ${upErr.response?.data?.error || upErr.message}`);
          setBusy(false);
          return; // nechme modal otevřený, ať to user vidí
        }
      }
      onCreated();
    } catch (e2) {
      setErr(e2.response?.data?.message || e2.response?.data?.error || 'Vytvoření selhalo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} title="Nový úkol"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Vytvářím…' : 'Vytvořit úkol'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs font-medium text-ink-600">
            Projekt *{isManagerOrAdmin && <span className="text-ink-400 ml-1">(napříč všemi tvými týmy)</span>}
          </span>
          <select required value={form.project_id} onChange={e => setForm({ ...form, project_id: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
            <option value="">— vyber projekt —</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{p.team_name ? ` · ${p.team_name}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Komu *</span>
          <select required value={form.assignee_id || ''} onChange={e => setForm({ ...form, assignee_id: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5"
            disabled={!form.project_id}>
            {assignees.length === 0 && <option value="">— vyber projekt nejdřív —</option>}
            {assignees.map(u => (
              <option key={u.id} value={u.id}>
                {u.name}{u.id === currentUser.id ? ' (já)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Název úkolu *</span>
          <input type="text" required value={form.title} autoFocus
            onChange={e => setForm({ ...form, title: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Priorita</span>
            <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
              <option value="low">Nízká</option>
              <option value="normal">Normální</option>
              <option value="high">Vysoká</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Termín</span>
            <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Odhad (h)</span>
            <input type="number" step="0.25" min="0" value={form.estimated_h}
              onChange={e => setForm({ ...form, estimated_h: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">
            Přílohy <span className="text-ink-400">(obrázky, videa, .md, .txt — max 10, à 25 MB)</span>
          </span>
          <input type="file" multiple
            accept="image/*,video/*,.md,.markdown,.txt,text/plain,text/markdown"
            onChange={e => setFiles(Array.from(e.target.files || []))}
            className="mt-1 block w-full text-xs file:mr-2 file:px-2 file:py-1 file:border-0 file:rounded file:bg-cream-200 file:text-ink-700 file:cursor-pointer" />
          {files.length > 0 && (
            <ul className="mt-1 text-xs text-ink-500 space-y-0.5">
              {files.map((f, i) => (
                <li key={i}>• {f.name} <span className="text-ink-400">({Math.round(f.size / 1024)} kB)</span></li>
              ))}
            </ul>
          )}
        </label>
        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </form>
    </Modal>
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
function ListView({ tasks, filter, currentTeamId, onStatusChange, onOpen }) {
  if (tasks.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-cream-200 p-10 text-center text-ink-400">
        {filter && filter !== 'all' ? 'V této kategorii nic nemáš.' : 'Zatím žádné přiřazené úkoly.'}
      </div>
    );
  }
  const STATUS_BAR = {
    todo: 'bg-amber-300',
    in_progress: 'bg-blue-400',
    review: 'bg-accent-400',
    done: 'bg-emerald-400',
  };
  const PRIORITY_PILL = {
    urgent: { label: '🔥 Urgent', cls: 'bg-red-50 text-red-700 border-red-200' },
    high:   { label: '⬆ Vysoká',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    low:    { label: '⬇ Nízká',   cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  };

  return (
    <div className="bg-white rounded-xl border border-cream-200 overflow-hidden">
      <ul className="divide-y divide-cream-200">
        {tasks.map(t => {
          const isDone = t.status === 'done';
          const priorityPill = PRIORITY_PILL[t.priority];
          return (
            <li
              key={t.id}
              onClick={() => onOpen(t)}
              className="flex hover:bg-cream-50 cursor-pointer transition"
            >
              {/* Levý status proužek pro rychlou orientaci */}
              <div className={`w-1 flex-shrink-0 ${STATUS_BAR[t.status] || 'bg-slate-200'}`} />
              <div className={`flex-1 min-w-0 p-4 ${isDone ? 'opacity-70' : ''}`}>
                {/* Top: NÁZEV dominantní + status badge vpravo */}
                <div className="flex items-start gap-3">
                  <h3 className={`flex-1 min-w-0 text-lg font-semibold leading-snug ${
                    isDone ? 'line-through text-ink-400' : 'text-ink-800'
                  }`}>
                    {t.title}
                  </h3>
                  <div className="flex-shrink-0">
                    <StatusBadge status={t.status} />
                  </div>
                </div>

                {/* Popis (zkrácený) */}
                {t.description && (
                  <div className="text-sm text-ink-600 mt-1 line-clamp-2">{t.description}</div>
                )}

                {/* Meta */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                  <span className="inline-flex items-center gap-1 text-ink-600">
                    <span>📁</span>{t.project_name}
                  </span>
                  {/* Host badge: úkol z týmu, kde současný user není členem. */}
                  {t.project_team_name && currentTeamId && t.project_team_id !== currentTeamId && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800"
                      title="Tento úkol je z jiného týmu, kam nemáš plný přístup. Vidíš pouze tento úkol.">
                      🔒 {t.project_team_name}
                    </span>
                  )}
                  {t.due_date && (
                    <span className="inline-flex items-center gap-1">
                      <span>📅</span>{String(t.due_date).slice(0, 10)}
                    </span>
                  )}
                  <TimeTriad task={t} compact />
                  {t.attachment_count > 0 && (
                    <span className="inline-flex items-center gap-1 text-brand-500 font-medium">
                      <span>📎</span>{t.attachment_count}
                    </span>
                  )}
                  {priorityPill && (
                    <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border ${priorityPill.cls}`}>
                      {priorityPill.label}
                    </span>
                  )}
                  <QuestionBadges task={t} />
                  <AIEstimateBadge task={t} />
                </div>

                {/* Akce stavu – stop click bubbling */}
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  <StatusActions task={t} onChange={onStatusChange} />
                </div>
              </div>
            </li>
          );
        })}
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
