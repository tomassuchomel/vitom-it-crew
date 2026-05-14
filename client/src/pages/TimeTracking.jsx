// Denní zápis hodin – formulář na vrchu, historie pod tím
import { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import { Input, Textarea, Select } from './ProjectsList.jsx';
import { time as timeApi, projects as projectsApi, users as usersApi } from '../api.js';
import { useAuth, can } from '../auth.jsx';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function TimeTracking() {
  const { user } = useAuth();
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filtry pro zobrazení historie
  const [filterUser, setFilterUser] = useState(can.seeAllHours(user) ? '' : String(user.id));
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(todayISO());

  const load = () => {
    setLoading(true);
    const params = { from, to };
    if (filterUser) params.userId = filterUser;
    Promise.all([
      timeApi.list(params),
      projectsApi.list(),
      can.seeAllHours(user) ? usersApi.list() : Promise.resolve({ users: [] }),
    ]).then(([t, p, u]) => {
      setEntries(t.entries);
      setProjects(p.projects);
      setUsers(u.users || []);
    }).finally(() => setLoading(false));
  };
  useEffect(load, [from, to, filterUser]);

  // Souhrny
  const totals = useMemo(() => {
    const totalH = entries.reduce((s, e) => s + e.hours, 0);
    const totalCost = can.seeCosts(user) ? entries.reduce((s, e) => s + (e.cost || 0), 0) : null;
    const byProject = {};
    for (const e of entries) {
      byProject[e.project_name] = (byProject[e.project_name] || 0) + e.hours;
    }
    return { totalH, totalCost, byProject };
  }, [entries, user]);

  return (
    <div>
      <PageHeader title="Hodiny" subtitle="Zapiš si, kolik hodin a na čem jsi dnes pracoval(a)" />

      <div className="p-6 space-y-6">
        <NewEntryForm projects={projects} onCreated={load} />

        {/* Souhrn karty */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SummaryCard label="Hodin v období" value={`${totals.totalH.toFixed(1)} h`} />
          {totals.totalCost !== null && (
            <SummaryCard label="Náklady (Kč)" value={`${Number(totals.totalCost).toLocaleString('cs-CZ')} Kč`} />
          )}
          <SummaryCard label="Záznamů" value={entries.length} />
        </div>

        {/* Filtry */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-end gap-3">
          <Input label="Od" type="date" value={from} onChange={setFrom} />
          <Input label="Do" type="date" value={to} onChange={setTo} />
          {can.seeAllHours(user) && (
            <Select label="Uživatel" value={filterUser} onChange={setFilterUser}
              options={[{ value: '', label: 'Všichni' }, ...users.map(u => ({ value: String(u.id), label: u.name }))]} />
          )}
        </div>

        {/* Tabulka */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5">Datum</th>
                {can.seeAllHours(user) && <th className="text-left px-4 py-2.5">Osoba</th>}
                <th className="text-left px-4 py-2.5">Projekt</th>
                <th className="text-left px-4 py-2.5">Popis</th>
                <th className="text-right px-4 py-2.5">Hodin</th>
                {can.seeCosts(user) && <th className="text-right px-4 py-2.5">Cena</th>}
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">Načítám…</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">Žádné záznamy v období</td></tr>
              ) : entries.map(e => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 whitespace-nowrap">{e.date}</td>
                  {can.seeAllHours(user) && (
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar user={{ id: e.user_id, name: e.user_name }} size={24} />
                        <span>{e.user_name}</span>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-2.5">{e.project_name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{e.description || '—'}</td>
                  <td className="px-4 py-2.5 text-right font-medium">{e.hours.toFixed(1)}</td>
                  {can.seeCosts(user) && <td className="px-4 py-2.5 text-right">{Math.round(e.cost || 0).toLocaleString('cs-CZ')} Kč</td>}
                  <td className="px-4 py-2.5 text-right">
                    {(e.user_id === user.id || can.seeAllHours(user)) && (
                      <button
                        onClick={async () => {
                          if (confirm('Smazat záznam?')) { await timeApi.remove(e.id); load(); }
                        }}
                        className="text-slate-300 hover:text-red-600"
                      >🗑</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="text-xs uppercase text-slate-500 tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-slate-800 mt-1">{value}</div>
    </div>
  );
}

function NewEntryForm({ projects, onCreated }) {
  const [form, setForm] = useState({
    date: todayISO(),
    project_id: '',
    hours: '',
    description: '',
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      await timeApi.create({
        ...form,
        project_id: Number(form.project_id),
        hours: Number(form.hours),
      });
      setForm({ date: todayISO(), project_id: '', hours: '', description: '' });
      onCreated();
    } catch (err) { setErr(err.response?.data?.error || 'Uložení selhalo'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800">Zapsat hodiny</h2>
        <span className="text-xs text-slate-500">Rychlý zápis – co jsi dnes dělal(a)</span>
      </div>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-12">
        <div className="md:col-span-2">
          <Input label="Datum *" type="date" value={form.date} onChange={v => setForm({ ...form, date: v })} required />
        </div>
        <div className="md:col-span-3">
          <Select label="Projekt *" value={form.project_id} onChange={v => setForm({ ...form, project_id: v })}
            options={[{ value: '', label: '— vyber —' }, ...projects.map(p => ({ value: p.id, label: p.name }))]} />
        </div>
        <div className="md:col-span-2">
          <Input label="Hodin *" type="number" step="0.25" value={form.hours} onChange={v => setForm({ ...form, hours: v })} required />
        </div>
        <div className="md:col-span-4">
          <Input label="Co se dělalo" value={form.description} onChange={v => setForm({ ...form, description: v })} placeholder="např. implementace login formuláře" />
        </div>
        <div className="md:col-span-1 flex items-end">
          <button
            type="submit"
            disabled={saving || !form.project_id || !form.hours}
            className="w-full px-3 py-1.5 bg-brand-500 text-white rounded text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
          >Zapsat</button>
        </div>
      </div>
      {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
    </form>
  );
}
