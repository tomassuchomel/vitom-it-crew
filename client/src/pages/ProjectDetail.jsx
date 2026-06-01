import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import AskQuestionModal from '../components/AskQuestionModal.jsx';
import TaskCompletionDialog from '../components/TaskCompletionDialog.jsx';
import TimeTriad from '../components/TimeTriad.jsx';
import Attachments from '../components/Attachments.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import ReviewTaskDialog from '../components/ReviewTaskDialog.jsx';
import { StatusBadge, StatusActions, AIEstimateBadge } from '../components/TaskStatus.jsx';
import { Input, Textarea, Select, TimelineFlags } from './ProjectsList.jsx';
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
  const [completingTask, setCompletingTask] = useState(null);
  const [aiDetailTask, setAiDetailTask] = useState(null);  // null | task – pro TaskDetailModal s AI panelem
  const [editOpen, setEditOpen] = useState(false);
  const [reviewing, setReviewing] = useState(null);    // null | { task, verdict } pro ReviewTaskDialog
  const [edits, setEdits] = useState([]);
  const [editsLoading, setEditsLoading] = useState(false);

  // load() bez argumentu = počáteční load (ukáže "Načítám..." přes celou stránku).
  // load(true) = silent refresh po save/akci – nezatemní obsah, jen tiše překreslí
  // novou verzí. Bez tohohle problikne celá stránka při každém uložení úkolu.
  const load = (silent = false) => {
    if (!silent) setLoading(true);
    return Promise.all([projectsApi.get(id), usersApi.list()])
      .then(([d, u]) => { setData(d); setUsers(u.users); })
      .finally(() => { if (!silent) setLoading(false); });
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
    // Předání k review (in_progress → review) vyžaduje actual_h – otevři dialog
    if (status === 'review' && task.status !== 'review') {
      setCompletingTask({ ...task, _targetStatus: 'review' });
      return;
    }
    // Manager/admin používá review endpoint pro 'done'. Senior_dev s createTasks
    // může přímo na 'done' (legacy fallback) – v UI se nabízí ale jen v badge "Otevřít znovu".
    if (status === 'done' && task.status !== 'done') {
      setCompletingTask({ ...task, _targetStatus: 'done' });
      return;
    }
    await tasksApi.update(task.id, { status });
    load(true);
  };
  const handleCompletionConfirm = async (actualH) => {
    if (!completingTask) return;
    const target = completingTask._targetStatus || 'done';
    await tasksApi.update(completingTask.id, { status: target, actual_h: actualH });
    setCompletingTask(null);
    load(true);
  };
  // Manager schvaluje/vrací z ProjectDetail (otevře ReviewTaskDialog)
  const handleReview = (task, verdict) => setReviewing({ task, verdict });
  const handleReviewDone = () => { setReviewing(null); load(true); };
  const handleDelete = async (task) => {
    if (!confirm(`Smazat úkol „${task.title}"?`)) return;
    await tasksApi.remove(task.id);
    load(true);
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
        subtitle={
          project.effective_due_date
            ? `${fmtDate(project.start_date)} → ${fmtDate(project.effective_due_date)}${project.due_source === 'task' ? ' (termín z úkolu)' : ''}`
            : `Od ${fmtDate(project.start_date)} · bez termínu`
        }
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
                    onReview={handleReview}
                    onAddSubtask={(pid) => setTaskModal({ parent_id: pid })}
                    onEdit={(task) => setTaskModal({ task })}
                    onDelete={handleDelete}
                    onAsk={(task) => setAskModal({ taskId: task.id, taskTitle: task.title, defaultToUserId: task.assignee_id })}
                    onAiDetail={(task) => setAiDetailTask(task)}
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
            <Row label="Zodpovědnost" value={project.responsible_name || '—'} />
            <Row label="Začátek" value={fmtDate(project.start_date)} />
            <Row
              label="Termín"
              value={project.effective_due_date
                ? `${fmtDate(project.effective_due_date)}${project.due_source === 'task' ? ' (z úkolu)' : ''}`
                : 'bez termínu'}
            />
            <Row label="Odhad úkolů" value={`${Number(project.estimated_h_total || 0).toFixed(1)} h`} />
            {can.seeCosts(user) && project.budget && (
              <Row label="Rozpočet" value={`${Number(project.budget).toLocaleString('cs-CZ')} Kč`} />
            )}
            <Row
              label="GitHub repo"
              value={project.repo_url
                ? <a href={project.repo_url} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline break-all">{project.repo_url.replace(/^https?:\/\//, '')}</a>
                : <span className="text-red-500 text-xs">není nastaveno (Claude nemůže pracovat)</span>}
            />
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
          onSaved={(opts) => {
            // Silent reload – nezhasne stránku na "Načítám...", jen tiše překreslí.
            // Pokud má modal zůstat otevřený (ukázat preflight), nezavírat.
            load(true);
            if (!opts?.keepOpen) setTaskModal(null);
          }}
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

      {completingTask && (
        <TaskCompletionDialog
          task={completingTask}
          onConfirm={handleCompletionConfirm}
          onCancel={() => setCompletingTask(null)}
        />
      )}

      <EditProjectModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        users={users}
        onSaved={() => { setEditOpen(false); load(true); loadEdits(); }}
      />

      {/* Detail úkolu s AI panelem – otevírá se z TaskRow tlačítkem "🤖 AI detail".
          Ukazuje stav agenta, "Spustit Claude" tlačítko a živou activity timeline. */}
      {aiDetailTask && (
        <TaskDetailModal
          task={aiDetailTask}
          onClose={() => setAiDetailTask(null)}
          onChanged={() => load(true)}
        />
      )}

      {/* Schválit / vrátit z review – jen pro manager projektu nebo admin */}
      {reviewing && (
        <ReviewTaskDialog
          task={reviewing.task}
          verdict={reviewing.verdict}
          onClose={() => setReviewing(null)}
          onDone={handleReviewDone}
        />
      )}
    </div>
  );
}

// ---------- Edit Project Modal ----------
function EditProjectModal({ open, onClose, project, users, onSaved }) {
  const [form, setForm] = useState({
    name: '', description: '',
    start_date: '', due_date: '',
    status: 'active', manager_id: '', responsible_id: '', budget: '', repo_url: '',
    no_timeline: false, hidden_from_timeline: false,
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && project) {
      setForm({
        name: project.name || '',
        description: project.description || '',
        start_date: project.start_date ? fmtDate(project.start_date) : '',
        due_date:   project.due_date   ? fmtDate(project.due_date)   : '',
        status: project.status || 'active',
        manager_id: project.manager_id || '',
        responsible_id: project.responsible_id || '',
        budget: project.budget != null ? String(project.budget) : '',
        repo_url: project.repo_url || '',
        no_timeline: !!project.no_timeline,
        hidden_from_timeline: !!project.hidden_from_timeline,
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
        responsible_id: form.responsible_id ? Number(form.responsible_id) : null,
        budget: form.budget ? Number(form.budget) : null,
        repo_url: form.repo_url ? form.repo_url.trim() : null,
      });
      onSaved();
    } catch (er) {
      setErr(er.response?.data?.message || er.response?.data?.error || 'Uložení selhalo');
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
        <Textarea label="Popis" value={form.description} onChange={v => setForm({ ...form, description: v })} />
        <TimelineFlags form={form} setForm={setForm} />
        {!form.no_timeline && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Začátek *" type="date" value={form.start_date} onChange={v => setForm({ ...form, start_date: v })} required={!form.no_timeline} />
            <Input label="Termín (nepovinné)" type="date" value={form.due_date} onChange={v => setForm({ ...form, due_date: v })} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Select label="Stav" value={form.status} onChange={v => setForm({ ...form, status: v })} options={[
            { value: 'active', label: 'Aktivní' },
            { value: 'done', label: 'Hotovo' },
            { value: 'cancelled', label: 'Zrušeno' },
          ]} />
          <Select label="Manager (schvaluje review)" value={form.manager_id} onChange={v => setForm({ ...form, manager_id: v })}
            options={[{ value: '', label: '—' }, ...users.filter(u => ['admin', 'manager'].includes(u.role)).map(u => ({ value: u.id, label: u.name }))]} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Zodpovědná osoba" value={form.responsible_id} onChange={v => setForm({ ...form, responsible_id: v })}
            options={[{ value: '', label: '—' }, ...users.map(u => ({ value: u.id, label: u.name }))]} />
        </div>
        <Input label="Rozpočet (Kč)" type="number" value={form.budget} onChange={v => setForm({ ...form, budget: v })} />
        <div>
          <Input label="GitHub repo URL (pro AI agenta)"
            placeholder="https://github.com/owner/repo"
            value={form.repo_url}
            onChange={v => setForm({ ...form, repo_url: v })} />
          <div className="text-[11px] text-slate-500 mt-1">
            Bez URL nebude AI agent (Claude) na tomto projektu pracovat.
          </div>
        </div>
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

// Lidsky čitelný popisek + barva pro AI status. Zrcadlí AiAgentPanel.jsx.
const AI_STATUS_BADGE = {
  idle:                    { label: '🤖 Idle',                cls: 'bg-slate-100 text-slate-700' },
  queued:                  { label: '🤖 Ve frontě',           cls: 'bg-amber-100 text-amber-800' },
  running:                 { label: '🤖 Pracuje…',            cls: 'bg-blue-100 text-blue-800 animate-pulse' },
  awaiting_clarification:  { label: '🤖 ❓ Čeká na odpověď',   cls: 'bg-purple-100 text-purple-800' },
  in_review:               { label: '🤖 🔍 Review',           cls: 'bg-indigo-100 text-indigo-800' },
  needs_changes:           { label: '🤖 🔄 Vrátil reviewer',  cls: 'bg-orange-100 text-orange-800' },
  needs_human:             { label: '🤖 🆘 Potřebuje člověka', cls: 'bg-red-100 text-red-800' },
  done:                    { label: '🤖 ✅ Hotovo',            cls: 'bg-emerald-100 text-emerald-800' },
  failed:                  { label: '🤖 ❌ Selhalo',          cls: 'bg-red-100 text-red-800' },
};

function TaskRow({ task, children, user, onStatusChange, onReview, onAddSubtask, onEdit, onDelete, onAsk, onAiDetail, indent = 0 }) {
  const canEditFully = can.createTasks(user);
  const canEditStatus = canEditFully || task.assignee_id === user.id;
  const canReview     = can.reviewTask(user, task);
  const isDone = task.status === 'done';
  const isSubtask = indent > 0;

  // Levý barevný proužek dle stavu – diskrétní vizuální kotva
  const STATUS_BAR = {
    todo: 'bg-amber-300',
    in_progress: 'bg-blue-400',
    review: 'bg-accent-400',
    done: 'bg-emerald-400',
  };

  // Priorita – kompaktní, ale výrazná. Normální se nezobrazuje vůbec.
  const PRIORITY_PILL = {
    urgent: { label: '🔥 Urgent', cls: 'bg-red-50 text-red-700 border-red-200' },
    high:   { label: '⬆ Vysoká',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    low:    { label: '⬇ Nízká',   cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  };
  const priorityPill = PRIORITY_PILL[task.priority];

  return (
    <li className="py-1">
      <div className="flex" style={{ paddingLeft: indent * 24 }}>
        {/* Levý status proužek */}
        <div className={`w-1 rounded-full flex-shrink-0 ${STATUS_BAR[task.status] || 'bg-slate-200'}`} />
        <div className={`flex-1 min-w-0 pl-3 py-2 ${isDone ? 'opacity-70' : ''}`}>
          {/* Top řádek: NÁZEV (dominantní) + status badge vpravo */}
          <div className="flex items-start gap-3">
            <h3 className={`flex-1 min-w-0 ${isSubtask ? 'text-base' : 'text-lg'} font-semibold leading-snug ${
              isDone ? 'line-through text-ink-400' : 'text-ink-800'
            }`}>
              {task.title}
            </h3>
            <div className="flex-shrink-0">
              <StatusBadge status={task.status} size={isSubtask ? 'small' : 'normal'} />
            </div>
          </div>

          {/* Meta řádek: avatar + jméno · termín · odhad · přílohy · priorita · dotazy · AI */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            {task.assignee_name && (
              <span className="inline-flex items-center gap-1.5 text-ink-600">
                <Avatar user={{ id: task.assignee_id, name: task.assignee_name }} size={20} />
                <span className="font-medium">{task.assignee_name}</span>
              </span>
            )}
            {task.due_date && (
              <span className="inline-flex items-center gap-1">
                <span>📅</span>{fmtDate(task.due_date)}
              </span>
            )}
            <TimeTriad task={task} />
            {task.attachment_count > 0 && (
              <span className="inline-flex items-center gap-1 text-brand-500 font-medium">
                <span>📎</span>{task.attachment_count}
              </span>
            )}
            {priorityPill && (
              <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border ${priorityPill.cls}`}>
                {priorityPill.label}
              </span>
            )}
            <QuestionBadge task={task} />
            <AIEstimateBadge task={task} />
            {task.ai_assignee && AI_STATUS_BADGE[task.ai_status] && (
              <button
                onClick={() => onAiDetail(task)}
                className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${AI_STATUS_BADGE[task.ai_status].cls} hover:opacity-80`}
                title="Otevřít detail AI agenta (stav, akce, aktivity)"
              >
                {AI_STATUS_BADGE[task.ai_status].label}
              </button>
            )}
          </div>

          {/* Inline náhled příloh */}
          {task.attachment_count > 0 && (
            <div className="mt-2">
              <Attachments taskId={task.id} canEdit={false} compact />
            </div>
          )}

          {/* Akční tlačítka */}
          <div className="mt-2 flex items-center gap-1 flex-wrap">
            <StatusActions
              task={task}
              onChange={onStatusChange}
              onReview={onReview}
              canChange={canEditStatus}
              canReview={canReview}
            />
            {(canEditFully || true) && (
              <>
                <span className="mx-1 text-ink-200">|</span>
                {task.ai_assignee && (
                  <button
                    onClick={() => onAiDetail(task)}
                    className="px-2 py-1 text-xs text-accent-700 hover:text-accent-800 hover:bg-accent-50 rounded font-medium"
                    title="Otevřít AI panel – stav, akce, activity timeline"
                  >🤖 AI detail</button>
                )}
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
              onReview={onReview}
              onAddSubtask={onAddSubtask}
              onEdit={onEdit}
              onDelete={onDelete}
              onAsk={onAsk}
              onAiDetail={onAiDetail}
              indent={indent + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Pro AI agenta vyžadujeme aspoň takhle dlouhý popis – jinak agent nemá kontext.
// Zrcadli AI_DESCRIPTION_MIN v server/src/routes/tasks.js
const AI_DESC_MIN = 30;

// Inline preflight banner – ukazuje stav AI agenta po uložení úkolu.
// Tři možnosti:
//   1) auto_enqueued=true → "Zařazeno do fronty"
//   2) issues > 0 → vypíše konkrétní problémy (chybí repo_url, agent disabled, …)
//   3) žádné issues a manual mode → "Úkol uložen, čeká na ruční spuštění"
//      (jinak by user nevěděl, že musí kliknout „Spustit Claude")
function PreflightIssues({ issues, autoEnqueued, executionMode }) {
  if (autoEnqueued) {
    return (
      <div className="rounded border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-800">
        ✅ Úkol byl zařazen do fronty pro Claude. Worker si ho vyzvedne. Stav uvidíš v detailu úkolu.
      </div>
    );
  }
  const hasIssues = issues && issues.length > 0;
  if (!hasIssues) {
    // Žádné chyby, ale ani auto-enqueue – manual mode čeká na uživatele
    return (
      <div className="rounded border border-blue-300 bg-blue-50 p-2.5 text-xs text-blue-800">
        ℹ️ Úkol je uložen a připraven pro Claude. Spustíš ho v detailu úkolu tlačítkem „Spustit Claude".
        {executionMode === 'manual' && <> Můžeš taky přepnout na „Spustit automaticky", pak se zařadí hned po uložení.</>}
      </div>
    );
  }
  const sevStyle = (s) => s === 'error'
    ? 'border-red-300 bg-red-50 text-red-800'
    : s === 'warning'
      ? 'border-amber-300 bg-amber-50 text-amber-800'
      : 'border-slate-200 bg-slate-50 text-slate-700';
  const sevIcon = (s) => s === 'error' ? '⛔' : s === 'warning' ? '⚠️' : 'ℹ️';
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-ink-500 font-medium">Co je potřeba doplnit:</div>
      {issues.map((i, idx) => (
        <div key={idx} className={`rounded border ${sevStyle(i.severity)} p-2.5 text-xs`}>
          <span className="font-medium mr-1">{sevIcon(i.severity)}</span>{i.message}
        </div>
      ))}
    </div>
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
    // AI agent fields
    ai_assignee: !!task?.ai_assignee,
    execution_mode: task?.execution_mode || 'manual',
    acceptance_criteria: Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : [],
    out_of_scope: Array.isArray(task?.out_of_scope) ? task.out_of_scope : [],
    scope_paths: Array.isArray(task?.scope_paths) ? task.scope_paths : [],
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  // Preflight z odpovědi serveru po uložení – zobrazí se inline.
  // null = ještě se neukládalo (nebo preflight neproběhl, např. ai_assignee=false).
  const [preflight, setPreflight] = useState(null);
  const [autoEnqueued, setAutoEnqueued] = useState(false);

  // Klientská validace – vrátí null pokud OK, jinak chybový string.
  // Backend dělá identickou kontrolu, ale tady chytíme chybu před zbytečným kolečkem.
  const clientValidate = () => {
    if (!form.ai_assignee) return null;
    const acs = form.acceptance_criteria.map(s => String(s).trim()).filter(Boolean);
    if (acs.length === 0) return 'Pro Claude úkol musíš zadat alespoň 1 acceptance criterion.';
    if (String(form.description).trim().length < AI_DESC_MIN) {
      return `Popis je krátký pro AI agenta. Potřebujeme alespoň ${AI_DESC_MIN} znaků kontextu.`;
    }
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setPreflight(null);
    setAutoEnqueued(false);
    const cErr = clientValidate();
    if (cErr) { setErr(cErr); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        project_id: projectId,
        parent_id: parentId || task?.parent_id || null,
        assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
        estimated_h: form.estimated_h ? Number(form.estimated_h) : null,
        // Při ukládání ořežeme prázdné řádky z dynamických listů
        acceptance_criteria: form.acceptance_criteria.map(s => String(s).trim()).filter(Boolean),
        out_of_scope: form.out_of_scope.map(s => String(s).trim()).filter(Boolean),
        scope_paths: form.scope_paths.map(s => String(s).trim()).filter(Boolean),
      };
      const resp = task ? await tasksApi.update(task.id, payload) : await tasksApi.create(payload);
      // Pro AI úkoly necháme modal vždy otevřený s feedbackem – user musí vidět,
      // co se stalo (auto-zařazeno / čeká na manuální spuštění / preflight selhal).
      // Bez toho se modal po save zavřel a user neviděl žádnou reakci → "nic se nestalo".
      if (form.ai_assignee) {
        setPreflight(resp.ai_preflight);
        setAutoEnqueued(!!resp.auto_enqueued);
        onSaved({ keepOpen: true });
      } else {
        onSaved();
      }
    } catch (e) {
      const code = e.response?.data?.error;
      setErr(
        code === 'ai_assignee_requires_acceptance_criteria' ? 'Pro Claude úkol musíš zadat alespoň 1 acceptance criterion.'
        : code === 'ai_assignee_requires_description' ? `Popis je krátký pro AI agenta. Potřebujeme alespoň ${e.response.data.min} znaků kontextu.`
        : code || 'Uložení selhalo'
      );
    }
    finally { setSaving(false); }
  };

  // Po úspěšném save AI úkolu změníme tlačítka – "Zrušit/Uložit" je matoucí
  // (uživatel by myslel, že "Zrušit" odvolá save). Místo toho ukážeme jen "Zavřít".
  const savedSuccessfully = preflight !== null || autoEnqueued;
  return (
    <Modal open={open} onClose={onClose}
      title={task ? 'Upravit úkol' : (parentId ? 'Nový podúkol' : 'Nový úkol')}
      footer={savedSuccessfully && form.ai_assignee ? (
        <button onClick={onClose} className="px-4 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600">
          Zavřít
        </button>
      ) : (<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300">Zrušit</button>
        <button onClick={submit} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Ukládám…' : 'Uložit'}
        </button>
      </>)}>
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

        {/* ── AI agent ── */}
        <AiAgentSection form={form} setForm={setForm} />

        {/* Preflight výsledek z posledního save – ukáže se vždy po save AI úkolu. */}
        {form.ai_assignee && (preflight !== null || autoEnqueued) && (
          <PreflightIssues
            issues={preflight?.issues}
            autoEnqueued={autoEnqueued}
            executionMode={form.execution_mode}
          />
        )}

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

// ---------- AI Agent sekce v TaskModalu ----------
// Vizuálně oddělená sekce s vlastním rámečkem a accent barvou. Když je toggle off,
// ukáže se jen krátké vysvětlení, žádné další pole. Po zapnutí naroste o tři
// dynamické listy + radio pro execution mode.
function AiAgentSection({ form, setForm }) {
  const on = form.ai_assignee;
  return (
    <div className={`rounded-lg border ${on ? 'border-accent-300 bg-accent-50/40' : 'border-cream-200 bg-cream-50/60'} p-3 mt-1`}>
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={e => setForm({ ...form, ai_assignee: e.target.checked })}
          className="mt-0.5 w-4 h-4 accent-accent-500"
        />
        <div className="flex-1">
          <div className="text-sm font-semibold text-ink-800">
            🤖 Přiřadit Claudovi
          </div>
          <div className="text-xs text-ink-500 mt-0.5">
            AI agent dostane úkol, naplánuje kroky a otevře PR. Vyžaduje jasná
            acceptance criteria a popis s kontextem (min {AI_DESC_MIN} znaků).
          </div>
        </div>
      </label>

      {on && (
        <div className="mt-4 space-y-4 pl-6 border-l-2 border-accent-300">
          <StringList
            label="Acceptance criteria *"
            help="Co musí být splněno, aby Claude úkol uzavřel. Buď konkrétní (např. „Tlačítko Smazat funguje a maže přes API“)."
            value={form.acceptance_criteria}
            onChange={v => setForm({ ...form, acceptance_criteria: v })}
            placeholder="např. Test prochází zelený"
            requireAtLeastOne
          />
          <StringList
            label="Out of scope"
            help="Co Claude NESMÍ řešit (i kdyby narazil). Drží ho v mantinelech."
            value={form.out_of_scope}
            onChange={v => setForm({ ...form, out_of_scope: v })}
            placeholder="např. Nemigruj databázové schéma"
          />
          <StringList
            label="Scope paths"
            help="Povolené složky/soubory pro úpravu. Mimo tento seznam nesmí sahat. Necháš-li prázdné, dovolíš celý projekt."
            value={form.scope_paths}
            onChange={v => setForm({ ...form, scope_paths: v })}
            placeholder="např. client/src/components/"
          />
          <div>
            <div className="text-xs font-medium text-slate-600 mb-1.5">Spuštění agenta</div>
            <div className="space-y-1.5">
              <RadioOpt
                checked={form.execution_mode === 'manual'}
                onChange={() => setForm({ ...form, execution_mode: 'manual' })}
                label="Čekat na můj souhlas"
                help="Po uložení úkol skončí ve stavu „idle“. Agenta spustíš ručně později."
              />
              <RadioOpt
                checked={form.execution_mode === 'auto'}
                onChange={() => setForm({ ...form, execution_mode: 'auto' })}
                label="Spustit automaticky"
                help="Jakmile úkol uložíš, agent ho začne řešit. Vhodné pro drobné úkoly s jasnými kritérii."
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Dynamický seznam textových řádků s tlačítkem + Přidat a × pro mazání.
// Hodnota je vždy pole stringů; uvnitř komponenty udržujeme stejnou strukturu
// a prázdné stringy se ořežou až při submitu.
function StringList({ label, help, value, onChange, placeholder, requireAtLeastOne = false }) {
  const items = value.length === 0 && requireAtLeastOne ? [''] : value;

  const update = (i, v) => {
    const next = [...items];
    next[i] = v;
    onChange(next);
  };
  const remove = (i) => {
    const next = items.filter((_, idx) => idx !== i);
    onChange(next.length === 0 && requireAtLeastOne ? [''] : next);
  };
  const add = () => onChange([...items, '']);

  return (
    <div>
      <div className="text-xs font-medium text-slate-600">{label}</div>
      {help && <div className="text-[11px] text-ink-400 mb-1.5">{help}</div>}
      <div className="space-y-1.5">
        {items.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              value={v}
              onChange={(e) => update(i, e.target.value)}
              placeholder={placeholder}
              className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400"
            />
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={requireAtLeastOne && items.length === 1}
              className="text-ink-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed px-2"
              title="Smazat řádek"
            >×</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1.5 text-xs text-accent-700 hover:text-accent-800 font-medium"
      >+ Přidat řádek</button>
    </div>
  );
}

function RadioOpt({ checked, onChange, label, help }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer text-sm">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 w-4 h-4 accent-accent-500"
      />
      <div className="flex-1">
        <div className="text-ink-800">{label}</div>
        {help && <div className="text-[11px] text-ink-500">{help}</div>}
      </div>
    </label>
  );
}
