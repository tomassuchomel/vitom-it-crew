import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import AskQuestionModal from '../components/AskQuestionModal.jsx';
import Attachments from '../components/Attachments.jsx';
import { StatusBadge, StatusActions, AIEstimateBadge } from '../components/TaskStatus.jsx';
import { Input, Textarea, Select } from './ProjectsList.jsx';
import { projects as projectsApi, tasks as tasksApi, users as usersApi } from '../api.js';
import { useAuth, can } from '../auth.jsx';

const STATUS_OPTIONS = [
  { value: 'todo', label: 'Čeká' },
  { value: 'in_progress', label: 'V práci' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Hotovo' },
];
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Nízká' },
  { value: 'normal', label: 'Normální' },
  { value: 'high', label: 'Vysoká' },
  { value: 'urgent', label: 'Urgentní' },
];
const STATUS_BADGE = {
  todo: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  review: 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
};
const PROJECT_STATUS_LABEL = {
  active: 'Aktivní', done: 'Hotovo', cancelled: 'Zrušeno',
};
// PostgreSQL vrací DATE jako ISO string – ořežeme čas
const fmtDate = (v) => {
  if (!v) return '—';
  return String(v).slice(0, 10);
};
const PRIORITY_BADGE = {
  low: 'text-slate-400', normal: 'text-slate-500', high: 'text-amber-600', urgent: 'text-red-600',
};

export default function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [taskModal, setTaskModal] = useState(null); // null | { parent_id?, task? }
  const [askModal, setAskModal] = useState(null);   // null | { taskId, taskTitle, defaultToUserId }
  const [editOpen, setEditOpen] = useState(false);
  const [edits, setEdits] = useState([]);
  const [editsLoading, setEditsLoading] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([projectsApi.get(id), usersApi.list()])
      .then(([d, u]) => { setData(d); setUsers(u.users); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [id]);

  // Pokud nějaký úkol má ai_estimate_status = 'pending', polluj DB každých 4s,
  // dokud všechny AI odhady nedoběhnou.
  useEffect(() => {
    if (!data) return;
    const hasPending = data.tasks.some(t => t.ai_estimate_status === 'pending');
    if (!hasPending) return;
    const timer = setTimeout(() => {
      projectsApi.get(id).then(setData).catch(() => {});
    }, 4000);
    return () => clearTimeout(timer);
  }, [data, id]);

  const loadEdits = () => {
    setEditsLoading(true);
    projectsApi.edits(id).then(d => setEdits(d.edits)).finally(() => setEditsLoading(false));
  };
  useEffect(() => { loadEdits(); }, [id]);

  if (loading || !data) return <div className="p-6 text-slate-500">Načítám…</div>;
  const { project, tasks } = data;

  // Postavíme strom: top-level úkoly a jejich podúkoly
  const topTasks = tasks.filter(t => !t.parent_id);
  const childMap = tasks.reduce((m, t) => {
    if (t.parent_id) (m[t.parent_id] = m[t.parent_id] || []).push(t);
    return m;
  }, {});

  const handleStatusChange = async (task, status) => {
    await tasksApi.update(task.id, { status });
    load();
  };
  const handleDelete = async (task) => {
    if (!confirm(`Smazat úkol „${task.title}"?`)) return;
    await tasksApi.remove(task.id);
    load();
  };
  const handleDeleteProject = async () => {
    const msg = `Opravdu smazat projekt „${data.project.name}"?\n\nTato akce je nevratná. Smaže se i:\n• všechny úkoly (${tasks.length}) a jejich podúkoly\n• všechny dotazy a přílohy spojené s tímto projektem\n• zápisy hodin na tento projekt\n• historie změn projektu`;
    if (!confirm(msg)) return;
    try {
      await projectsApi.remove(data.project.id);
      nav('/projects');
    } catch (e) {
      alert('Smazání selhalo: ' + (e.response?.data?.error || 'unknown'));
    }
  };

  return (
    <div>
      <PageHeader
        title={project.name}
        subtitle={`${project.client || 'Bez klienta'} · ${fmtDate(project.start_date)} → ${fmtDate(project.due_date)}`}
        actions={
          <div className="flex items-center gap-2">
            {can.manageProjects(user) && (
              <>
                <button
                  onClick={() => setEditOpen(true)}
                  className="px-3 py-1.5 text-sm border border-brand-500 text-brand-500 rounded-lg hover:bg-brand-50 font-medium"
                >✎ Editovat projekt</button>
                <button
                  onClick={handleDeleteProject}
                  className="px-3 py-1.5 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 font-medium"
                  title="Smazat projekt"
                >🗑 Smazat</button>
              </>
            )}
            <Link to="/projects" className="text-sm text-ink-500 hover:text-ink-800">← Zpět</Link>
          </div>
        }
      />

      <div className="p-6 grid gap-6 grid-cols-1 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-800">Úkoly</h2>
              {can.createTasks(user) && (
                <button
                  onClick={() => setTaskModal({ parent_id: null })}
                  className="px-3 py-1.5 bg-brand-500 text-white rounded-lg hover:bg-brand-600 text-sm font-medium"
                >+ Nový úkol</button>
              )}
            </div>

            {topTasks.length === 0 ? (
              <div className="text-sm text-slate-400 italic">Zatím žádné úkoly.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {topTasks.map(t => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    children={childMap[t.id] || []}
                    user={user}
                    onStatusChange={handleStatusChange}
                    onAddSubtask={(pid) => setTaskModal({ parent_id: pid })}
                    onEdit={(task) => setTaskModal({ task })}
                    onDelete={handleDelete}
                    onAsk={(task) => setAskModal({ taskId: task.id, taskTitle: task.title, defaultToUserId: task.assignee_id })}
                  />
                ))}
              </ul>
            )}
          </div>

          {project.description && (
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-800 mb-2">Popis projektu</h3>
              <p className="text-sm text-slate-600 whitespace-pre-wrap">{project.description}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-cream-200 p-5 text-sm">
            <h3 className="font-semibold text-ink-800 mb-3">Detaily</h3>
            <Row label="Stav" value={PROJECT_STATUS_LABEL[project.status] || project.status} />
            <Row label="Manager" value={project.manager_name || '—'} />
            <Row label="Začátek" value={fmtDate(project.start_date)} />
            <Row label="Termín" value={fmtDate(project.due_date)} />
            <Row label="Odhad úkolů" value={`${Number(project.estimated_h_total || 0).toFixed(1)} h`} />
            {can.seeCosts(user) && project.budget && (
              <Row label="Rozpočet" value={`${Number(project.budget).toLocaleString('cs-CZ')} Kč`} />
            )}
          </div>

          {/* Historie změn */}
          <div className="bg-white rounded-xl border border-cream-200 p-5 text-sm">
            <h3 className="font-semibold text-ink-800 mb-3">Historie změn</h3>
            {editsLoading ? (
              <div className="text-xs text-ink-400">Načítám…</div>
            ) : edits.length === 0 ? (
              <div className="text-xs text-ink-400 italic">Žádné změny zatím nezaznamenány.</div>
            ) : (
              <ul className="space-y-2 max-h-96 overflow-y-auto">
                {edits.map(e => <EditLogItem key={e.id} edit={e} />)}
              </ul>
            )}
          </div>
        </div>
      </div>

      {taskModal && (
        <TaskModal
          open
          onClose={() => setTaskModal(null)}
          users={users}
          projectId={project.id}
          parentId={taskModal.parent_id}
          task={taskModal.task}
          onSaved={() => { setTaskModal(null); load(); }}
        />
      )}

      <AskQuestionModal
        open={!!askModal}
        onClose={() => setAskModal(null)}
        taskId={askModal?.taskId}
        taskTitle={askModal?.taskTitle}
        defaultToUserId={askModal?.defaultToUserId}
        onCreated={() => setAskModal(null)}
      />

      <EditProjectModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        users={users}
        onSaved={() => { setEditOpen(false); load(); loadEdits(); }}
      />
    </div>
  );
}

// ---------- Edit Project Modal ----------
function EditProjectModal({ open, onClose, project, users, onSaved }) {
  const [form, setForm] = useState({
    name: '', client: '', description: '',
    start_date: '', due_date: '',
    status: 'active', manager_id: '', budget: '',
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && project) {
      setForm({
        name: project.name || '',
        client: project.client || '',
        description: project.description || '',
        start_date: fmtDate(project.start_date),
        due_date: fmtDate(project.due_date),
        status: project.status || 'active',
        manager_id: project.manager_id || '',
        budget: project.budget != null ? String(project.budget) : '',
      });
      setErr(null);
    }
  }, [open, project]);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      await projectsApi.update(project.id, {
        ...form,
        manager_id: form.manager_id ? Number(form.manager_id) : null,
        budget: form.budget ? Number(form.budget) : null,
      });
      onSaved();
    } catch (er) {
      setErr(er.response?.data?.error || 'Uložení selhalo');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Editace projektu: ${project?.name || ''}`}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-cream-300">Zrušit</button>
        <button onClick={submit} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Ukládám…' : 'Uložit změny'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <Input label="Název *" value={form.name} onChange={v => setForm({ ...form, name: v })} required />
        <Input label="Klient" value={form.client} onChange={v => setForm({ ...form, client: v })} />
        <Textarea label="Popis" value={form.description} onChange={v => setForm({ ...form, description: v })} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Začátek *" type="date" value={form.start_date} onChange={v => setForm({ ...form, start_date: v })} required />
          <Input label="Termín *" type="date" value={form.due_date} onChange={v => setForm({ ...form, due_date: v })} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Stav" value={form.status} onChange={v => setForm({ ...form, status: v })} options={[
            { value: 'active', label: 'Aktivní' },
            { value: 'done', label: 'Hotovo' },
            { value: 'cancelled', label: 'Zrušeno' },
          ]} />
          <Select label="Manager" value={form.manager_id} onChange={v => setForm({ ...form, manager_id: v })}
            options={[{ value: '', label: '—' }, ...users.filter(u => ['admin', 'manager'].includes(u.role)).map(u => ({ value: u.id, label: u.name }))]} />
        </div>
        <Input label="Rozpočet (Kč)" type="number" value={form.budget} onChange={v => setForm({ ...form, budget: v })} />
        {err && <div className="text-red-600 text-xs">{err}</div>}
        <div className="text-xs text-ink-400">Změny se zaznamenají do historie projektu.</div>
      </form>
    </Modal>
  );
}

// ---------- Edit Log Item ----------
function EditLogItem({ edit }) {
  const date = new Date(edit.created_at);
  const dateStr = date.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (edit.action === 'create') {
    return (
      <li className="text-xs border-l-2 border-emerald-400 pl-2 py-1">
        <div className="font-medium text-emerald-700">🌱 Vytvořeno</div>
        <div className="text-ink-500">{edit.user_name} · {dateStr}</div>
      </li>
    );
  }
  if (edit.action === 'delete') {
    return (
      <li className="text-xs border-l-2 border-red-400 pl-2 py-1">
        <div className="font-medium text-red-700">🗑 Smazáno</div>
        <div className="text-ink-500">{edit.user_name} · {dateStr}</div>
      </li>
    );
  }
  // update
  return (
    <li className="text-xs border-l-2 border-brand-400 pl-2 py-1">
      <div className="font-medium text-ink-800">
        ✎ {edit.field_label}
      </div>
      <div className="text-ink-600 mt-0.5">
        <span className="line-through text-ink-400">{edit.old_value || '∅'}</span>
        {' → '}
        <span className="font-medium">{edit.new_value || '∅'}</span>
      </div>
      <div className="text-ink-500 mt-0.5">{edit.user_name} · {dateStr}</div>
    </li>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between py-1.5">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  );
}

// Badge zobrazující stav dotazů na úkolu – klik vede na stránku Dotazy
function QuestionBadge({ task }) {
  const pending = task.pending_q || 0;
  const answered = task.answered_q || 0;
  if (pending === 0 && answered === 0) return null;
  if (pending > 0) {
    return (
      <Link
        to="/questions?box=all"
        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold hover:bg-amber-200"
        title="Na úkolu jsou nezodpovězené dotazy"
      >💬 {pending} čeká na odpověď</Link>
    );
  }
  return (
    <Link
      to="/questions?box=all"
      className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium hover:bg-emerald-200"
      title="Všechny dotazy zodpovězeny"
    >💬 {answered} zodpovězeno</Link>
  );
}

function TaskRow({ task, children, user, onStatusChange, onAddSubtask, onEdit, onDelete, onAsk, indent = 0 }) {
  const canEditFully = can.createTasks(user);
  const canEditStatus = canEditFully || task.assignee_id === user.id;
  const isDone = task.status === 'done';

  return (
    <li className="py-2.5">
      <div className="flex items-start gap-3" style={{ paddingLeft: indent * 24 }}>
        {/* Žádný checkbox – stav je v badge, akce v tlačítkách */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Velký, jasně viditelný status badge */}
            <StatusBadge status={task.status} />
            <span className={`font-medium text-sm ${isDone ? 'line-through text-ink-400' : 'text-ink-800'}`}>
              {task.title}
            </span>
            {task.priority !== 'normal' && (
              <span className={`text-[10px] font-bold ${PRIORITY_BADGE[task.priority]}`}>
                {task.priority === 'urgent' ? '🔥' : task.priority === 'high' ? '⬆' : task.priority === 'low' ? '⬇' : ''}
              </span>
            )}
            <QuestionBadge task={task} />
            <AIEstimateBadge task={task} />
          </div>
          <div className="text-xs text-ink-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {task.assignee_name && (
              <span className="inline-flex items-center gap-1.5">
                <Avatar user={{ id: task.assignee_id, name: task.assignee_name }} size={20} />
                {task.assignee_name}
              </span>
            )}
            {task.due_date && <span>📅 {fmtDate(task.due_date)}</span>}
            {task.estimated_h && <span>⏱ ruční odhad {task.estimated_h}h</span>}
            {task.attachment_count > 0 && (
              <span className="text-brand-500 font-medium">📎 {task.attachment_count}</span>
            )}
          </div>
          {/* Inline náhled příloh */}
          {task.attachment_count > 0 && (
            <div className="mt-2">
              <Attachments taskId={task.id} canEdit={false} compact />
            </div>
          )}
          {/* Akční tlačítka – ZMĚNA STAVU. Vizuálně oddělené od status badge výše. */}
          <div className="mt-2 flex items-center gap-1 flex-wrap">
            <StatusActions task={task} onChange={onStatusChange} canChange={canEditStatus} />
            <span className="mx-1 text-ink-200">|</span>
            <button
              onClick={() => onAsk(task)}
              className="px-2 py-1 text-xs text-ink-500 hover:text-brand-500 hover:bg-cream-50 rounded"
              title="Přidat dotaz"
            >💬 Dotaz</button>
            {canEditFully && (
              <>
                <button onClick={() => onAddSubtask(task.id)} className="px-2 py-1 text-xs text-ink-400 hover:text-brand-500" title="Přidat podúkol">+ podúkol</button>
                <button onClick={() => onEdit(task)} className="px-2 py-1 text-xs text-ink-400 hover:text-brand-500" title="Upravit">✎ Edit</button>
                <button onClick={() => onDelete(task)} className="px-2 py-1 text-xs text-ink-400 hover:text-red-600" title="Smazat">🗑</button>
              </>
            )}
          </div>
        </div>
      </div>
      {children.length > 0 && (
        <ul className="mt-1">
          {children.map(c => (
            <TaskRow
              key={c.id}
              task={c}
              children={[]}
              user={user}
              onStatusChange={onStatusChange}
              onAddSubtask={onAddSubtask}
              onEdit={onEdit}
              onDelete={onDelete}
              onAsk={onAsk}
              indent={indent + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskModal({ open, onClose, users, projectId, parentId, task, onSaved }) {
  const [form, setForm] = useState({
    title: task?.title || '',
    description: task?.description || '',
    assignee_id: task?.assignee_id || '',
    status: task?.status || 'todo',
    priority: task?.priority || 'normal',
    estimated_h: task?.estimated_h || '',
    due_date: task?.due_date || '',
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      const payload = {
        ...form,
        project_id: projectId,
        parent_id: parentId || task?.parent_id || null,
        assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
        estimated_h: form.estimated_h ? Number(form.estimated_h) : null,
      };
      if (task) await tasksApi.update(task.id, payload);
      else await tasksApi.create(payload);
      onSaved();
    } catch (e) { setErr(e.response?.data?.error || 'Uložení selhalo'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose}
      title={task ? 'Upravit úkol' : (parentId ? 'Nový podúkol' : 'Nový úkol')}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300">Zrušit</button>
        <button onClick={submit} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Ukládám…' : 'Uložit'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <Input label="Název *" value={form.title} onChange={v => setForm({ ...form, title: v })} required />
        <Textarea label="Popis" value={form.description} onChange={v => setForm({ ...form, description: v })} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Přiřazeno" value={form.assignee_id} onChange={v => setForm({ ...form, assignee_id: v })}
            options={[{ value: '', label: '—' }, ...users.map(u => ({ value: u.id, label: u.name }))]} />
          <Select label="Priorita" value={form.priority} onChange={v => setForm({ ...form, priority: v })} options={PRIORITY_OPTIONS} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Stav" value={form.status} onChange={v => setForm({ ...form, status: v })} options={STATUS_OPTIONS} />
          <Input label="Termín" type="date" value={form.due_date} onChange={v => setForm({ ...form, due_date: v })} />
        </div>
        <Input label="Odhad (h)" type="number" value={form.estimated_h} onChange={v => setForm({ ...form, estimated_h: v })} />
        {err && <div className="text-red-600 text-xs">{err}</div>}
      </form>

      {/* Přílohy – jen u existujícího úkolu (potřebujeme task_id) */}
      {task && (
        <div className="mt-5 pt-4 border-t border-cream-200">
          <div className="text-xs font-medium text-ink-600 mb-2">Přílohy (foto/video)</div>
          <Attachments taskId={task.id} canEdit compact />
        </div>
      )}
    </Modal>
  );
}
