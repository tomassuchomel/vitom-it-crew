import { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import { Input, Select } from './ProjectsList.jsx';
import { users as usersApi } from '../api.js';
import { useAuth, can, ROLE_LABELS } from '../auth.jsx';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Project Manager' },
  { value: 'senior_dev', label: 'Senior programátor' },
  { value: 'external_dev', label: 'Externí programátor' },
];

export default function Team() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | user | 'new'

  const load = () => {
    setLoading(true);
    usersApi.list().then(d => setUsers(d.users)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resetPassword = async (u) => {
    if (!confirm(`Resetovat heslo uživatele ${u.name} na výchozí "ITCrew23"?\n\nUživatel bude muset při dalším přihlášení zvolit nové heslo.`)) return;
    try {
      await usersApi.resetPassword(u.id);
      alert(`Heslo uživatele ${u.name} resetováno na "ITCrew23".`);
      load();
    } catch (e) {
      alert('Reset selhal: ' + (e.response?.data?.error || 'unknown'));
    }
  };

  const deleteUser = async (u) => {
    if (u.id === user.id) {
      alert('Nemůžeš smazat sebe sama.');
      return;
    }
    const msg = `Opravdu smazat uživatele ${u.name}?\n\nTato akce je nevratná. Smaže se i jeho:\n• zápis hodin\n• dotazy (odeslané i přijaté)\n• nahrané přílohy\n• záznamy v historii projektů\n\nÚkoly přiřazené tomuto uživateli zůstanou, ale ztratí přiřazení.`;
    if (!confirm(msg)) return;
    try {
      await usersApi.remove(u.id);
      load();
    } catch (e) {
      const code = e.response?.data?.error;
      alert(
        code === 'last_admin'        ? 'Nelze smazat posledního aktivního admina.'
        : code === 'cannot_delete_self' ? 'Nemůžeš smazat sám sebe.'
        : 'Smazání selhalo: ' + (code || 'unknown')
      );
    }
  };

  return (
    <div>
      <PageHeader
        title="Tým"
        subtitle={`${users.length} členů`}
        actions={can.manageUsers(user) && (
          <button
            onClick={() => setEditing('new')}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 text-sm font-medium"
          >+ Přidat člena</button>
        )}
      />

      <div className="p-6">
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5">Jméno</th>
                <th className="text-left px-4 py-2.5">Email</th>
                <th className="text-left px-4 py-2.5">Role</th>
                {can.seeCosts(user) && <th className="text-right px-4 py-2.5">Sazba (Kč/h)</th>}
                <th className="text-center px-4 py-2.5">Aktivní</th>
                {(can.manageUsers(user) || can.deleteUsers(user)) && <th></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">Načítám…</td></tr>
              ) : users.map(u => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar user={u} size={32} />
                      <span className="font-medium text-slate-800">{u.name}</span>
                      {u.must_change_password && (
                        <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded" title="Má výchozí heslo – musí ho změnit při dalším loginu">výchozí heslo</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{u.email}</td>
                  <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                  {can.seeCosts(user) && (
                    <td className="px-4 py-2.5 text-right font-medium">{Number(u.hourly_rate || 0).toLocaleString('cs-CZ')} Kč</td>
                  )}
                  <td className="px-4 py-2.5 text-center">
                    {u.active ? <span className="text-emerald-600">●</span> : <span className="text-slate-300">●</span>}
                  </td>
                  {(can.manageUsers(user) || can.deleteUsers(user)) && (
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {can.manageUsers(user) && (
                        <>
                          <button
                            onClick={() => resetPassword(u)}
                            className="text-xs text-slate-400 hover:text-amber-600 mr-2"
                            title="Resetovat heslo na výchozí ITCrew23"
                          >🔑 Reset hesla</button>
                          <button
                            onClick={() => setEditing(u)}
                            className="text-slate-400 hover:text-brand-600 mr-2"
                            title="Upravit"
                          >✎</button>
                        </>
                      )}
                      {can.deleteUsers(user) && u.id !== user.id && (
                        <button
                          onClick={() => deleteUser(u)}
                          className="text-slate-400 hover:text-red-600"
                          title="Smazat uživatele"
                        >🗑</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <UserModal
          mode={editing === 'new' ? 'create' : 'edit'}
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function RoleBadge({ role }) {
  const map = {
    admin: 'bg-purple-100 text-purple-700',
    manager: 'bg-blue-100 text-blue-700',
    senior_dev: 'bg-emerald-100 text-emerald-700',
    external_dev: 'bg-amber-100 text-amber-700',
  };
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded ${map[role]}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}

function UserModal({ mode, user, onClose, onSaved }) {
  const [form, setForm] = useState({
    email: user?.email || '',
    name: user?.name || '',
    role: user?.role || 'external_dev',
    hourly_rate: user?.hourly_rate || '',
    active: user?.active ?? 1,
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      const payload = {
        ...form,
        hourly_rate: Number(form.hourly_rate) || 0,
        active: form.active ? 1 : 0,
      };
      if (mode === 'edit') await usersApi.update(user.id, payload);
      else await usersApi.create(payload);
      onSaved();
    } catch (err) { setErr(err.response?.data?.error || 'Uložení selhalo'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={mode === 'edit' ? `Upravit ${user.name}` : 'Nový člen týmu'}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300">Zrušit</button>
        <button onClick={submit} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Ukládám…' : 'Uložit'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <Input label="Email *" type="email" value={form.email} onChange={v => setForm({ ...form, email: v })} required disabled={mode === 'edit'} />
        <Input label="Jméno *" value={form.name} onChange={v => setForm({ ...form, name: v })} required />
        <Select label="Role *" value={form.role} onChange={v => setForm({ ...form, role: v })} options={ROLE_OPTIONS} />
        <Input label="Hodinová sazba (Kč/h)" type="number" value={form.hourly_rate} onChange={v => setForm({ ...form, hourly_rate: v })} />
        {mode === 'edit' && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.active}
              onChange={e => setForm({ ...form, active: e.target.checked })}
            />
            <span>Aktivní</span>
          </label>
        )}
        {err && <div className="text-red-600 text-xs">{err}</div>}
      </form>
    </Modal>
  );
}
