import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import { projects as projectsApi, users as usersApi } from '../api.js';
import { useAuth, can } from '../auth.jsx';

const STATUS_LABEL = { active: 'Aktivní', done: 'Hotovo', cancelled: 'Zrušeno' };
const STATUS_COLOR = { active: 'bg-blue-100 text-blue-700', done: 'bg-emerald-100 text-emerald-700', cancelled: 'bg-slate-200 text-slate-600' };

export default function ProjectsList() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([projectsApi.list(), usersApi.list()])
      .then(([p, u]) => { setProjects(p.projects); setUsers(u.users); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <div className="p-6 text-slate-500">Načítám…</div>;

  return (
    <div>
      <PageHeader
        title="Projekty"
        subtitle={`${projects.length} projekt(ů)`}
        actions={can.manageProjects(user) && (
          <button
            onClick={() => setModal(true)}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 text-sm font-medium"
          >+ Nový projekt</button>
        )}
      />

      <div className="p-6 grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {projects.map(p => (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="bg-white rounded-xl shadow-sm border border-slate-200 hover:shadow-md transition p-5 block"
          >
            <div className="flex items-start justify-between mb-2">
              <div className="font-semibold text-slate-800 leading-tight">{p.name}</div>
              <span className={`text-[10px] px-2 py-0.5 rounded ${STATUS_COLOR[p.status]}`}>
                {STATUS_LABEL[p.status]}
              </span>
            </div>
            {p.client && <div className="text-xs text-slate-500 mb-3">{p.client}</div>}
            <div className="text-xs text-slate-600 space-y-1">
              <div className="flex justify-between"><span>Termín</span><span className="font-medium">{p.due_date}</span></div>
              <div className="flex justify-between"><span>Úkoly</span><span className="font-medium">{p.done_count} / {p.task_count}</span></div>
              <div className="flex justify-between"><span>Odpracováno</span><span className="font-medium">{p.hours_logged?.toFixed(1)} h</span></div>
              {can.seeCosts(user) && (
                <div className="flex justify-between text-slate-700 pt-1 border-t border-slate-100 mt-2">
                  <span>Náklady</span>
                  <span className="font-semibold">{Number(p.cost_so_far || 0).toLocaleString('cs-CZ')} Kč</span>
                </div>
              )}
            </div>
            {/* Progress bar tasks done */}
            <div className="mt-3 h-1.5 bg-slate-100 rounded">
              <div
                className="h-full bg-brand-500 rounded"
                style={{ width: `${p.task_count ? (p.done_count / p.task_count * 100) : 0}%` }}
              />
            </div>
          </Link>
        ))}
      </div>

      <CreateProjectModal
        open={modal}
        onClose={() => setModal(false)}
        users={users}
        onCreated={() => { setModal(false); load(); }}
      />
    </div>
  );
}

function CreateProjectModal({ open, onClose, users, onCreated }) {
  const [form, setForm] = useState({ name: '', client: '', description: '', start_date: '', due_date: '', manager_id: '', budget: '' });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      await projectsApi.create({
        ...form,
        manager_id: form.manager_id ? Number(form.manager_id) : null,
        budget: form.budget ? Number(form.budget) : null,
      });
      onCreated();
      setForm({ name: '', client: '', description: '', start_date: '', due_date: '', manager_id: '', budget: '' });
    } catch (e) { setErr(e.response?.data?.error || 'Uložení selhalo'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Nový projekt"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300">Zrušit</button>
        <button onClick={submit} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Ukládám…' : 'Vytvořit'}
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
        <Select label="Project manager" value={form.manager_id} onChange={v => setForm({ ...form, manager_id: v })}
          options={[{ value: '', label: '—' }, ...users.filter(u => ['admin', 'manager'].includes(u.role)).map(u => ({ value: u.id, label: u.name }))]} />
        <Input label="Rozpočet (Kč)" type="number" value={form.budget} onChange={v => setForm({ ...form, budget: v })} />
        {err && <div className="text-red-600 text-xs">{err}</div>}
      </form>
    </Modal>
  );
}

// Mini form helpery (sdílené i pro detail projektu)
export function Input({ label, type = 'text', value, onChange, ...rest }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm"
        {...rest}
      />
    </label>
  );
}
export function Textarea({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm"
      />
    </label>
  );
}
export function Select({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
