// TaskDetailModal – plnohodnotný detail úkolu otevřený přímo z "Moje úkoly".
// Sloučí: editaci úkolu, akce stavu, poznámku (popis), přílohy a vlákno dotazů.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { tasks as tasksApi, questions as questionsApi, users as usersApi } from '../api.js';
import { useAuth, can, ROLE_LABELS } from '../auth.jsx';
import { StatusBadge, StatusActions, AIEstimateBadge, STATUS_META } from './TaskStatus.jsx';
import Avatar from './Avatar.jsx';
import Attachments from './Attachments.jsx';

const PRIORITY_OPTIONS = [
  { value: 'low',    label: '⬇ Nízká' },
  { value: 'normal', label: 'Normální' },
  { value: 'high',   label: '⬆ Vysoká' },
  { value: 'urgent', label: '🔥 Urgentní' },
];

export default function TaskDetailModal({ task: initialTask, onClose, onChanged }) {
  const { user } = useAuth();
  const [task, setTask] = useState(initialTask);

  // Sync, pokud parent dodá nový úkol
  useEffect(() => { setTask(initialTask); }, [initialTask?.id]);

  if (!task) return null;

  const canEditFull   = can.createTasks(user);            // admin / manager / senior_dev
  const isMyTask      = task.assignee_id === user.id;
  const canEditNote   = canEditFull || isMyTask;          // assignee může psát poznámku
  const canChangeStatus = canEditFull || isMyTask;

  const refresh = async () => {
    // Server nemá GET single task, ale můžeme znovu načíst seznam mých úkolů
    // a najít aktuální verzi. Levnější je přepsat lokální state přímo z PUT responsí.
    onChanged?.();
  };

  const handleStatusChange = async (_t, newStatus) => {
    const updated = await tasksApi.update(task.id, { status: newStatus });
    setTask(prev => ({ ...prev, ...updated.task }));
    refresh();
  };

  const handleSave = async (patch) => {
    const updated = await tasksApi.update(task.id, patch);
    setTask(prev => ({ ...prev, ...updated.task }));
    refresh();
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-40 flex items-stretch justify-end md:items-center md:justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full md:max-w-3xl md:rounded-xl shadow-2xl flex flex-col md:max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hlavička */}
        <div className="px-5 py-4 border-b border-cream-200 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={task.status} />
              {task.priority !== 'normal' && (
                <span className="text-[10px] font-bold uppercase tracking-wide text-ink-500">
                  {PRIORITY_OPTIONS.find(p => p.value === task.priority)?.label || task.priority}
                </span>
              )}
              <AIEstimateBadge task={task} />
            </div>
            <h2 className="text-xl font-bold text-ink-800 mt-1 truncate">{task.title}</h2>
            <div className="text-xs text-ink-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {task.project_name && (
                <Link to={`/projects/${task.project_id}`} className="hover:text-brand-500" onClick={onClose}>
                  📁 {task.project_name}{task.project_client && ` · ${task.project_client}`}
                </Link>
              )}
              {task.due_date && <span>📅 {String(task.due_date).slice(0, 10)}</span>}
              {task.estimated_h && <span>⏱ odhad {task.estimated_h}h</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none -mt-1">×</button>
        </div>

        {/* Tělo – scrollable */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Akce stavu */}
          {canChangeStatus && (
            <Section title="Stav úkolu">
              <StatusActions task={task} onChange={handleStatusChange} />
            </Section>
          )}

          {/* Poznámka / popis */}
          <NoteSection task={task} canEdit={canEditNote} onSave={handleSave} />

          {/* Detaily úkolu – jen pro plný edit */}
          {canEditFull && (
            <FullEditSection task={task} onSave={handleSave} />
          )}

          {/* Přílohy */}
          <Section title="Přílohy" subtitle="Foto, video a další soubory (max 25 MB)">
            <Attachments taskId={task.id} canEdit />
          </Section>

          {/* Dotazy */}
          <QuestionsSection task={task} onAsked={refresh} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children, action }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
          {subtitle && <p className="text-xs text-ink-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function NoteSection({ task, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.description || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { setText(task.description || ''); }, [task.id, task.description]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await onSave({ description: text });
      setEditing(false);
    } catch (e) {
      setErr(e.response?.data?.error || 'Uložení selhalo');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Poznámka / popis"
      subtitle="Místo pro detaily, postup nebo poznámky k úkolu."
      action={canEdit && !editing && (
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-brand-500 hover:text-brand-600 font-medium"
        >{task.description ? '✎ Upravit' : '+ Přidat'}</button>
      )}
    >
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            autoFocus
            className="w-full border border-ink-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Napiš poznámku…"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 disabled:opacity-50"
            >{busy ? 'Ukládám…' : 'Uložit'}</button>
            <button
              onClick={() => { setEditing(false); setText(task.description || ''); setErr(null); }}
              className="px-3 py-1.5 text-xs text-ink-500 hover:text-ink-700"
            >Zrušit</button>
            {err && <span className="text-xs text-red-600">{err}</span>}
          </div>
        </div>
      ) : task.description ? (
        <div className="text-sm text-ink-700 whitespace-pre-wrap bg-cream-100 border border-cream-200 rounded-lg p-3">
          {task.description}
        </div>
      ) : (
        <div className="text-xs text-ink-400 italic">Bez poznámky.</div>
      )}
    </Section>
  );
}

function FullEditSection({ task, onSave }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: task.title || '',
    priority: task.priority || 'normal',
    due_date: task.due_date ? String(task.due_date).slice(0, 10) : '',
    estimated_h: task.estimated_h ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setForm({
      title: task.title || '',
      priority: task.priority || 'normal',
      due_date: task.due_date ? String(task.due_date).slice(0, 10) : '',
      estimated_h: task.estimated_h ?? '',
    });
  }, [task.id]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await onSave({
        title: form.title.trim(),
        priority: form.priority,
        due_date: form.due_date || null,
        estimated_h: form.estimated_h === '' ? null : Number(form.estimated_h),
      });
      setOpen(false);
    } catch (e) {
      setErr(e.response?.data?.error || 'Uložení selhalo');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Section title="Detaily úkolu" subtitle={`Priorita: ${PRIORITY_OPTIONS.find(p => p.value === task.priority)?.label || task.priority} · termín: ${task.due_date ? String(task.due_date).slice(0,10) : '—'} · odhad: ${task.estimated_h ?? '—'}h`}
        action={<button onClick={() => setOpen(true)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">✎ Upravit</button>}>
        <div className="text-xs text-ink-400">Klikni „Upravit" pro změnu názvu, priority, termínu nebo odhadu.</div>
      </Section>
    );
  }

  return (
    <Section title="Detaily úkolu">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-ink-500 mb-1">Název úkolu</label>
          <input
            type="text"
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Priorita</label>
            <select
              value={form.priority}
              onChange={e => setForm({ ...form, priority: e.target.value })}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {PRIORITY_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Termín</label>
            <input
              type="date"
              value={form.due_date}
              onChange={e => setForm({ ...form, due_date: e.target.value })}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Odhad (h)</label>
            <input
              type="number"
              step="0.5"
              value={form.estimated_h}
              onChange={e => setForm({ ...form, estimated_h: e.target.value })}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={busy}
            className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 disabled:opacity-50"
          >{busy ? 'Ukládám…' : 'Uložit změny'}</button>
          <button
            onClick={() => setOpen(false)}
            className="px-3 py-1.5 text-xs text-ink-500 hover:text-ink-700"
          >Zrušit</button>
          {err && <span className="text-xs text-red-600">{err}</span>}
        </div>
      </div>
    </Section>
  );
}

function QuestionsSection({ task, onAsked }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [toUserId, setToUserId] = useState(task.assignee_id && task.assignee_id !== user.id ? String(task.assignee_id) : '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => {
    setLoading(true);
    questionsApi.list({ taskId: task.id }).then(d => setItems(d.questions)).finally(() => setLoading(false));
  };
  useEffect(load, [task.id]);
  useEffect(() => {
    usersApi.list().then(d => setUsers(d.users.filter(u => u.active && u.id !== user.id)));
  }, [user.id]);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(null);
    try {
      await questionsApi.create({
        task_id: task.id,
        to_user_id: Number(toUserId),
        question: text.trim(),
      });
      setText(''); setAddOpen(false);
      load();
      onAsked?.();
    } catch (e) {
      setErr(e.response?.data?.error || 'Uložení selhalo');
    } finally {
      setBusy(false);
    }
  };

  const answer = async (q, answerText) => {
    await questionsApi.answer(q.id, answerText);
    load();
    onAsked?.();
  };

  return (
    <Section
      title={`Dotazy k úkolu${items.length ? ` (${items.length})` : ''}`}
      subtitle="Polož otázku komukoli z týmu k tomuhle úkolu."
      action={!addOpen && (
        <button
          onClick={() => setAddOpen(true)}
          className="text-xs text-brand-500 hover:text-brand-600 font-medium"
        >+ Nový dotaz</button>
      )}
    >
      {addOpen && (
        <form onSubmit={submit} className="bg-cream-100 border border-cream-200 rounded-lg p-3 mb-3 space-y-2">
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Komu</label>
            <select
              value={toUserId}
              onChange={e => setToUserId(e.target.value)}
              required
              className="w-full px-2 py-1.5 border border-ink-300 rounded text-sm"
            >
              <option value="">— vyber osobu —</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-500 mb-1">Dotaz</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={3}
              autoFocus
              required
              className="w-full px-2 py-1.5 border border-ink-300 rounded text-sm"
              placeholder="Napiš svůj dotaz…"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !toUserId || !text.trim()}
              className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-md hover:bg-brand-600 disabled:opacity-50"
            >{busy ? 'Odesílám…' : 'Odeslat'}</button>
            <button
              type="button"
              onClick={() => { setAddOpen(false); setText(''); setErr(null); }}
              className="px-3 py-1.5 text-xs text-ink-500 hover:text-ink-700"
            >Zrušit</button>
            {err && <span className="text-xs text-red-600">{err}</span>}
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-xs text-ink-400">Načítám…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-ink-400 italic">Žádné dotazy k tomuhle úkolu.</div>
      ) : (
        <ul className="space-y-3">
          {items.map(q => <QuestionItem key={q.id} q={q} currentUser={user} onAnswer={answer} />)}
        </ul>
      )}
    </Section>
  );
}

function QuestionItem({ q, currentUser, onAnswer }) {
  const [answerText, setAnswerText] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isForMe = q.to_user_id === currentUser.id;
  const isAnswered = q.status === 'answered';

  const submit = async () => {
    if (!answerText.trim()) return;
    setBusy(true);
    try {
      await onAnswer(q, answerText.trim());
      setAnswerText('');
      setOpen(false);
    } finally { setBusy(false); }
  };

  return (
    <li className="bg-white border border-cream-200 rounded-lg p-3">
      <div className="flex items-center gap-2 text-xs text-ink-500 mb-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink-700">
          <Avatar user={{ id: q.from_user_id, name: q.from_user_name }} size={20} />
          {q.from_user_name}
        </span>
        <span>→</span>
        <span className="inline-flex items-center gap-1.5 font-medium text-ink-700">
          <Avatar user={{ id: q.to_user_id, name: q.to_user_name }} size={20} />
          {q.to_user_name}
        </span>
        <span className="ml-auto">{new Date(q.created_at + 'Z').toLocaleString('cs-CZ')}</span>
        {isAnswered ? (
          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">✓</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 bg-accent-100 text-accent-800 rounded">⏳</span>
        )}
      </div>
      <div className="text-sm text-ink-800 whitespace-pre-wrap">{q.question}</div>
      {q.answer && (
        <div className="mt-2 pl-3 border-l-2 border-emerald-300 text-sm text-ink-700 whitespace-pre-wrap">
          <div className="text-[10px] uppercase tracking-wide text-emerald-700 mb-0.5">Odpověď</div>
          {q.answer}
        </div>
      )}
      {!isAnswered && isForMe && (
        open ? (
          <div className="mt-2 space-y-2">
            <textarea
              value={answerText}
              onChange={e => setAnswerText(e.target.value)}
              rows={2}
              autoFocus
              className="w-full px-2 py-1.5 border border-ink-300 rounded text-sm"
              placeholder="Tvoje odpověď…"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={submit}
                disabled={busy || !answerText.trim()}
                className="px-3 py-1.5 text-xs bg-emerald-500 text-white rounded-md hover:bg-emerald-600 disabled:opacity-50"
              >{busy ? 'Odesílám…' : 'Odpovědět'}</button>
              <button
                onClick={() => { setOpen(false); setAnswerText(''); }}
                className="px-3 py-1.5 text-xs text-ink-500 hover:text-ink-700"
              >Zrušit</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="mt-2 text-xs text-brand-500 hover:text-brand-600 font-medium"
          >+ Odpovědět</button>
        )
      )}
    </li>
  );
}
