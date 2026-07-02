// Přidat podúkol k existujícímu úkolu (typicky cross-team: host user dostane
// úkol z jiného týmu a potřebuje jej rozložit na podúkol pro svůj tým).
//
// Podúkol má stejné pole jako hlavní úkol (title, popis, assignee, priorita,
// termín, odhad hodin). Default parent_hidden=TRUE → řešitel podúkolu neuvidí,
// z jakého parent úkolu podúkol vznikl.

import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { tasks as tasksApi, users as usersApi } from '../api.js';

export default function AddSubtaskModal({ parentTask, onClose, onCreated }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({
    title: '',
    description: '',
    assignee_id: '',
    priority: 'normal',
    due_date: '',
    estimated_h: '',
    parent_hidden: true,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    // Distinct členové všech mých týmů — pro dropdown assignee.
    usersApi.listAcrossMyTeams()
      .then(d => setUsers(d.users || []))
      .catch(() => setErr('Načtení kolegů selhalo.'));
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    setErr(null);
    if (!form.title.trim()) { setErr('Vyplň název podúkolu.'); return; }
    if (!form.assignee_id) { setErr('Vyber, komu podúkol patří.'); return; }
    setSaving(true);
    try {
      await tasksApi.create({
        project_id: parentTask.project_id,
        parent_id: parentTask.id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        assignee_id: Number(form.assignee_id),
        priority: form.priority,
        due_date: form.due_date || null,
        estimated_h: form.estimated_h ? Number(form.estimated_h) : null,
        parent_hidden: form.parent_hidden,
      });
      onCreated();
    } catch (e2) {
      setErr(e2.response?.data?.message || e2.response?.data?.error || 'Vytvoření podúkolu selhalo.');
    } finally { setSaving(false); }
  };

  return (
    <Modal open={true} onClose={onClose} title="+ Nový podúkol"
      footer={<>
        <button onClick={onClose} disabled={saving}
          className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={saving}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Vytvářím…' : 'Vytvořit podúkol'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div className="text-xs text-ink-500 bg-cream-50 border border-cream-200 rounded p-2">
          Rozkládáš úkol <strong className="text-ink-800">„{parentTask.title}"</strong>.
          Řešitel podúkolu neuvidí hlavní úkol.
        </div>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Název podúkolu *</span>
          <input type="text" required autoFocus value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Popis / kontext</span>
          <textarea rows={3} value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="Co konkrétně řešitel podúkolu má udělat…"
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Komu *</span>
          <select required value={form.assignee_id}
            onChange={e => setForm({ ...form, assignee_id: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
            <option value="">— vyber řešitele —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Priorita</span>
            <select value={form.priority}
              onChange={e => setForm({ ...form, priority: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
              <option value="low">Nízká</option>
              <option value="normal">Normální</option>
              <option value="high">Vysoká</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Termín</span>
            <input type="date" value={form.due_date}
              onChange={e => setForm({ ...form, due_date: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Odhad (h)</span>
            <input type="number" step="0.25" min="0" value={form.estimated_h}
              onChange={e => setForm({ ...form, estimated_h: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        </div>
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input type="checkbox" checked={form.parent_hidden}
            onChange={e => setForm({ ...form, parent_hidden: e.target.checked })}
            className="mt-0.5" />
          <span className="text-ink-600">
            <strong>Skrýt hlavní úkol řešiteli</strong> (doporučeno pro úkoly napříč týmy).
            <br />
            <span className="text-ink-400">
              Řešitel podúkolu neuvidí, že vznikl z „{parentTask.title}". Odškrtni jen když pracujete oba ve stejném týmu a chceš, aby viděl kontext.
            </span>
          </span>
        </label>
        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </form>
    </Modal>
  );
}
