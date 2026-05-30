// Admin sekce – jediný zdroj pravdy pro:
//   - Teams (vytvořit, edit, edit features)
//   - Users (vytvořit, edit profil, role, přidělit do teamů)
//
// Tato stránka je viditelná jen pro globálního admina (user.role === 'admin').
// Pro správu napříč teamy používá GET /api/users?scope=all – vrací všechny
// usery + jejich team membership v poli `teams`.
//
// Workflow:
//   1. Admin otevře /admin
//   2. Tab "Teams" → vidí všechny teamy, může vytvořit nový, kliknout na detail
//      → modal "Edit team" s name, description, features (JSON) + seznam členů
//      → tam přidá/odebere usery a změní jim team_role.
//   3. Tab "Users" → vidí všechny usery, klik na řádek → modal "Edit user"
//      s name, email, role, hourly_rate, active + checklist teamů, ve kterých je
//      a možnost přidat ho do dalšího teamu / odebrat.

import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import { useAuth, ROLE_LABELS } from '../auth.jsx';
import { useTeams } from '../teams.jsx';
import { teams as teamsApi, users as usersApi } from '../api.js';

const TABS = [
  { value: 'teams', label: '🏢 Teamy' },
  { value: 'users', label: '👥 Uživatelé' },
];

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState('teams');

  if (!user) return null;
  if (user.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div>
      <PageHeader
        title="Admin"
        subtitle="Jediný zdroj pravdy pro teamy a uživatele"
      />
      <div className="px-6 pt-4">
        <div className="flex gap-1 border-b border-cream-300">
          {TABS.map(t => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition ${
                tab === t.value
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-ink-500 hover:text-ink-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="p-6">
        {tab === 'teams' ? <TeamsAdminSection /> : <UsersAdminSection />}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Teams sekce
// ──────────────────────────────────────────────────────────────────────

function TeamsAdminSection() {
  const { refresh: refreshTeams } = useTeams();
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingTeamId, setEditingTeamId] = useState(null);

  const load = () => {
    setLoading(true);
    teamsApi.list()
      .then(d => setTeams(d.teams || []))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <div className="text-ink-500">Načítám…</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="text-sm text-ink-600">{teams.length} team(ů)</div>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600"
        >+ Nový team</button>
      </div>

      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {teams.map(t => (
          <button
            key={t.id}
            onClick={() => setEditingTeamId(t.id)}
            className="bg-white border border-cream-200 rounded-lg p-4 text-left hover:shadow-md transition"
          >
            <div className="font-semibold text-ink-800">{t.name}</div>
            <div className="text-xs text-ink-500 font-mono mt-0.5">{t.slug}</div>
            {t.description && <div className="text-xs text-ink-600 mt-2 line-clamp-2">{t.description}</div>}
            <div className="text-xs text-ink-500 mt-2">
              👥 {t.member_count} {t.member_count == 1 ? 'člen' : (t.member_count < 5 ? 'členové' : 'členů')}
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {Object.entries(t.features || {}).filter(([_, v]) => v).map(([k]) => (
                <span key={k} className="text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">{k}</span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {creating && (
        <CreateTeamModal
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); refreshTeams(); }}
        />
      )}
      {editingTeamId && (
        <EditTeamModal
          teamId={editingTeamId}
          onClose={() => setEditingTeamId(null)}
          onSaved={() => { load(); refreshTeams(); }}
        />
      )}
    </div>
  );
}

function CreateTeamModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', slug: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(null);
    try {
      await teamsApi.create({ ...form, features: {} });
      onCreated();
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Vytvoření selhalo');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={true} onClose={onClose} title="Nový team"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Vytvářím…' : 'Vytvořit'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Název *</span>
          <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Slug * (URL identifikátor, lowercase, pomlčky)</span>
          <input type="text" required pattern="[a-z0-9-]+" value={form.slug}
            onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5 font-mono"
            placeholder="napr-marketing" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Popis</span>
          <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
            rows={2} className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </form>
    </Modal>
  );
}

function EditTeamModal({ teamId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [form, setForm] = useState({ name: '', description: '', features: {} });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => {
    Promise.all([teamsApi.get(teamId), usersApi.listAll()])
      .then(([t, u]) => {
        setData(t);
        setAllUsers(u.users || []);
        setForm({
          name: t.team.name,
          description: t.team.description || '',
          features: t.team.features || {},
        });
      });
  };
  useEffect(() => { load(); }, [teamId]);

  if (!data) return <Modal open={true} onClose={onClose} title="Načítám…"><div className="p-4 text-ink-500">…</div></Modal>;

  const saveTeam = async () => {
    setBusy(true); setErr(null);
    try {
      await teamsApi.update(teamId, form);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.message || 'Uložení selhalo');
    } finally { setBusy(false); }
  };

  const addMember = async (userId, teamRole) => {
    await teamsApi.addMember(teamId, { user_id: userId, team_role: teamRole });
    load();
    onSaved();
  };
  const removeMember = async (userId) => {
    if (!confirm('Odebrat člena z teamu?')) return;
    try {
      await teamsApi.removeMember(teamId, userId);
      load();
      onSaved();
    } catch (e) {
      alert(e.response?.data?.message || 'Nelze odebrat');
    }
  };
  const changeRole = async (userId, newRole) => {
    await teamsApi.addMember(teamId, { user_id: userId, team_role: newRole });
    load();
    onSaved();
  };

  const memberIds = new Set(data.members.map(m => m.user_id));
  const nonMembers = allUsers.filter(u => !memberIds.has(u.id));

  // Povolené role v tomto teamu (z features.team_roles).
  // Když team nemá nastaveno, vrátíme prázdný objekt → fallback na free text.
  const allowedRoles = data.team.features?.team_roles || {};
  const roleKeys = Object.keys(allowedRoles);
  const defaultRole = roleKeys[0] || 'member';

  return (
    <Modal open={true} onClose={onClose} title={`Team: ${data.team.name} (${data.team.slug})`}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={saveTeam} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Ukládám…' : 'Uložit team'}
        </button>
      </>}>
      <div className="space-y-4 text-sm">
        {/* Základní info */}
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-500">Základní info</div>
          <label className="block">
            <span className="text-xs text-ink-600">Název</span>
            <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs text-ink-600">Popis</span>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              rows={2} className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
          <div>
            <span className="text-xs text-ink-600">Feature flags</span>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {['ai_agent', 'review_workflow', 'code_repo'].map(key => (
                <label key={key} className="flex items-center gap-2 text-xs bg-cream-50 border border-cream-200 rounded p-2 cursor-pointer">
                  <input type="checkbox"
                    checked={!!form.features[key]}
                    onChange={e => setForm({ ...form, features: { ...form.features, [key]: e.target.checked } })}
                  />
                  <span className="font-mono">{key}</span>
                </label>
              ))}
            </div>
          </div>
          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        </div>

        {/* Členové */}
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-500">
            Členové ({data.members.length})
          </div>
          <ul className="bg-cream-50 border border-cream-200 rounded divide-y divide-cream-200">
            {data.members.map(m => (
              <li key={m.user_id} className="flex items-center gap-3 p-2">
                <Avatar user={{ id: m.user_id, name: m.name }} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink-800 truncate">{m.name}</div>
                  <div className="text-[11px] text-ink-500 truncate">{m.email}</div>
                </div>
                {/* Když má team definované team_roles, použijeme dropdown.
                    Fallback na text input jen pokud team nemá vůbec roles nakonfigurované. */}
                {roleKeys.length > 0 ? (
                  <select
                    value={m.team_role}
                    onChange={(e) => { if (e.target.value !== m.team_role) changeRole(m.user_id, e.target.value); }}
                    className="text-xs border border-ink-200 rounded px-1.5 py-1 bg-white"
                  >
                    {/* Pokud current role není v povolených (legacy), ukážeme ji s ⚠ */}
                    {!(m.team_role in allowedRoles) && (
                      <option value={m.team_role} disabled>⚠ {m.team_role} (legacy)</option>
                    )}
                    {Object.entries(allowedRoles).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    defaultValue={m.team_role}
                    onBlur={(e) => { if (e.target.value !== m.team_role) changeRole(m.user_id, e.target.value); }}
                    className="w-28 text-xs border border-ink-200 rounded px-1.5 py-0.5"
                    placeholder="team_role"
                  />
                )}
                <button onClick={() => removeMember(m.user_id)} className="text-ink-400 hover:text-red-600 px-1" title="Odebrat">×</button>
              </li>
            ))}
            {data.members.length === 0 && (
              <li className="p-3 text-xs text-ink-400 italic text-center">Žádní členové</li>
            )}
          </ul>
        </div>

        {/* Přidat nového člena */}
        {nonMembers.length > 0 && (
          <AddMemberPicker
            nonMembers={nonMembers}
            allowedRoles={allowedRoles}
            defaultRole={defaultRole}
            onAdd={addMember}
          />
        )}

        {/* Vytvořit zcela nového uživatele a rovnou přidat do teamu */}
        <CreateNewUserForm
          allowedRoles={allowedRoles}
          defaultRole={defaultRole}
          onCreated={async (newUser, teamRole) => {
            // Server vytvořil usera → přidáme ho do teamu existujícím handlerem
            await addMember(newUser.id, teamRole);
          }}
        />
      </div>
    </Modal>
  );
}

// Inline collapsible formulář: admin zadá email + jméno + (volitelně) heslo,
// vybere globální + týmovou roli. Server vytvoří usera, my ho rovnou strčíme
// do teamu. Bez separátního modalu — drží to vše v jedné editaci teamu.
function CreateNewUserForm({ allowedRoles, defaultRole, onCreated }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState({
    email: '',
    first_name: '',
    last_name: '',
    password: '',
    role: 'external_dev', // bezpečný default — admin si může změnit
    team_role: defaultRole,
  });
  const roleKeys = Object.keys(allowedRoles || {});

  const reset = () => {
    setForm({ email: '', first_name: '', last_name: '', password: '', role: 'external_dev', team_role: defaultRole });
    setErr(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!form.email.trim() || !form.first_name.trim() || !form.last_name.trim()) {
      setErr('Vyplň email, jméno a příjmení.');
      return;
    }
    if (form.password && form.password.length < 6) {
      setErr('Heslo musí mít aspoň 6 znaků (nebo nech prázdné — použije se výchozí).');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        email: form.email.trim(),
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        role: form.role,
        hourly_rate: 0,
      };
      if (form.password.trim()) payload.password = form.password.trim();
      const r = await usersApi.create(payload);
      await onCreated(r.user, form.team_role);
      reset();
      setOpen(false);
    } catch (e2) {
      const code = e2.response?.data?.error;
      if (code === 'email_exists') setErr('Uživatel s tímto emailem už existuje.');
      else if (code === 'password_too_short') setErr('Heslo musí mít aspoň 6 znaků.');
      else setErr(e2.response?.data?.message || 'Vytvoření selhalo');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left px-3 py-2 text-xs text-ink-500 hover:text-ink-700 border border-dashed border-cream-300 rounded hover:bg-cream-50"
      >
        + Vytvořit zcela nového uživatele
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="border border-cream-300 rounded-lg p-3 space-y-2 bg-cream-50">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wide text-ink-500">Nový uživatel</div>
        <button type="button" onClick={() => { setOpen(false); reset(); }} className="text-ink-400 hover:text-ink-700 text-sm">×</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="email"
          required
          placeholder="email *"
          value={form.email}
          onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
          className="border border-ink-300 rounded px-2 py-1.5 text-sm col-span-2"
        />
        <input
          type="text"
          required
          placeholder="jméno *"
          value={form.first_name}
          onChange={(e) => setForm(f => ({ ...f, first_name: e.target.value }))}
          className="border border-ink-300 rounded px-2 py-1.5 text-sm"
        />
        <input
          type="text"
          required
          placeholder="příjmení *"
          value={form.last_name}
          onChange={(e) => setForm(f => ({ ...f, last_name: e.target.value }))}
          className="border border-ink-300 rounded px-2 py-1.5 text-sm"
        />
        <input
          type="text"
          placeholder="heslo (volitelné — jinak výchozí + nucená změna)"
          value={form.password}
          onChange={(e) => setForm(f => ({ ...f, password: e.target.value }))}
          className="border border-ink-300 rounded px-2 py-1.5 text-sm col-span-2 font-mono"
        />
        <select
          value={form.role}
          onChange={(e) => setForm(f => ({ ...f, role: e.target.value }))}
          className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
          title="Globální role"
        >
          <option value="admin">admin</option>
          <option value="manager">manager</option>
          <option value="senior_dev">senior_dev</option>
          <option value="external_dev">external_dev</option>
        </select>
        {roleKeys.length > 0 ? (
          <select
            value={form.team_role}
            onChange={(e) => setForm(f => ({ ...f, team_role: e.target.value }))}
            className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
            title="Týmová role"
          >
            {Object.entries(allowedRoles).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={form.team_role}
            onChange={(e) => setForm(f => ({ ...f, team_role: e.target.value }))}
            placeholder="týmová role"
            className="border border-ink-300 rounded px-2 py-1.5 text-sm"
          />
        )}
      </div>
      {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { setOpen(false); reset(); }} disabled={busy}
          className="px-3 py-1 text-xs rounded border border-ink-300">Zrušit</button>
        <button type="submit" disabled={busy}
          className="px-3 py-1 text-xs rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Vytvářím…' : 'Vytvořit + přidat do teamu'}
        </button>
      </div>
    </form>
  );
}

// Pomocná komponenta v EditTeamModal — výběr člena + role pro přidání do teamu.
// Uživatel vidí user dropdown + role dropdown a teprve potom přidává.
function AddMemberPicker({ nonMembers, allowedRoles, defaultRole, onAdd }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState(defaultRole);
  const roleKeys = Object.keys(allowedRoles || {});

  const submit = () => {
    if (!userId) return;
    onAdd(Number(userId), role);
    setUserId('');
    setRole(defaultRole);
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-bold uppercase tracking-wide text-ink-500">Přidat člena</div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="border border-ink-300 rounded px-2 py-1.5 text-sm"
        >
          <option value="">— Vyber uživatele —</option>
          {nonMembers.map(u => (
            <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
          ))}
        </select>
        {roleKeys.length > 0 ? (
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
            title="Týmová role"
          >
            {Object.entries(allowedRoles).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="role"
            className="w-32 border border-ink-300 rounded px-2 py-1.5 text-sm"
          />
        )}
        <button
          onClick={submit}
          disabled={!userId}
          className="px-3 py-1.5 bg-brand-500 text-white rounded text-sm disabled:opacity-40"
        >Přidat</button>
      </div>
      <div className="text-[11px] text-ink-400">
        Tento team povoluje role: {roleKeys.length > 0 ? roleKeys.join(', ') : '(neomezeno)'}.
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Users sekce
// ──────────────────────────────────────────────────────────────────────

function UsersAdminSection() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingUserId, setEditingUserId] = useState(null);
  const [filter, setFilter] = useState('');

  const load = () => {
    setLoading(true);
    usersApi.listAll()
      .then(d => setUsers(d.users || []))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!filter.trim()) return users;
    const q = filter.toLowerCase();
    return users.filter(u =>
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.teams || []).some(t => t.team_name.toLowerCase().includes(q))
    );
  }, [users, filter]);

  if (loading) return <div className="text-ink-500">Načítám…</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="🔍 Hledat (jméno, email, team)…"
          className="flex-1 min-w-[200px] max-w-md border border-ink-300 rounded px-3 py-1.5 text-sm"
        />
        <div className="flex items-center gap-3">
          <div className="text-sm text-ink-600">{filtered.length} / {users.length} uživatelů</div>
          <button
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600"
          >+ Nový uživatel</button>
        </div>
      </div>

      <div className="bg-white border border-cream-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs uppercase tracking-wider text-ink-600">
            <tr>
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2">Jméno</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Globální role</th>
              <th className="px-3 py-2">Teamy</th>
              <th className="px-3 py-2">Stav</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-100">
            {filtered.map(u => (
              <tr key={u.id}
                onClick={() => setEditingUserId(u.id)}
                className="hover:bg-cream-50 cursor-pointer">
                <td className="px-3 py-2"><Avatar user={u} size={28} /></td>
                <td className="px-3 py-2 font-medium text-ink-800">{u.name}</td>
                <td className="px-3 py-2 text-ink-500">{u.email}</td>
                <td className="px-3 py-2 text-ink-600">{ROLE_LABELS[u.role] || u.role}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(u.teams || []).map(t => (
                      <span key={t.team_id}
                        className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-700 rounded border border-brand-200"
                        title={`${t.team_name} (${t.team_role})`}>
                        {t.team_name} <span className="text-brand-400">· {t.team_role}</span>
                      </span>
                    ))}
                    {(u.teams || []).length === 0 && <span className="text-[11px] text-ink-400 italic">— bez teamu</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {u.active
                    ? <span className="text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">aktivní</span>
                    : <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">deaktivovaný</span>
                  }
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-ink-400 italic">Žádní uživatelé neodpovídají filtru.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}
      {editingUserId && (
        <EditUserModal
          userId={editingUserId}
          users={users}
          onClose={() => setEditingUserId(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', role: 'manager', hourly_rate: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [created, setCreated] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(null);
    try {
      const d = await usersApi.create(form);
      setCreated(d);
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Vytvoření selhalo');
    } finally { setBusy(false); }
  };

  if (created) {
    return (
      <Modal open={true} onClose={() => { onCreated(); onClose(); }} title="Uživatel vytvořen ✅"
        footer={<button onClick={() => { onCreated(); onClose(); }} className="px-4 py-1.5 text-sm rounded bg-brand-500 text-white">Hotovo</button>}>
        <div className="space-y-3 text-sm">
          <div>
            <strong>{created.user.name}</strong> ({created.user.email}) je vytvořen.
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded p-3">
            <div className="text-xs font-semibold text-amber-800 mb-1">Výchozí heslo</div>
            <code className="text-sm">{created.default_password}</code>
            <div className="text-[11px] text-amber-700 mt-1">
              Pošli ho uživateli. Při prvním přihlášení si musí změnit. Pak ho přidej do potřebných teamů v sekci „Teamy".
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={true} onClose={onClose} title="Nový uživatel"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Vytvářím…' : 'Vytvořit'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Jméno *</span>
            <input type="text" required value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Příjmení *</span>
            <input type="text" required value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Email *</span>
          <input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Globální role *</span>
            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
              {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Sazba (Kč/h)</span>
            <input type="number" value={form.hourly_rate} onChange={e => setForm({ ...form, hourly_rate: Number(e.target.value) || 0 })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        </div>
        <div className="text-[11px] text-ink-500">
          Uživatel dostane výchozí heslo a bude ho muset změnit při prvním přihlášení. Přidat do teamů můžeš v sekci „Teamy".
        </div>
        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </form>
    </Modal>
  );
}

function EditUserModal({ userId, users, onClose, onSaved }) {
  const userData = users.find(u => u.id === userId);
  const [form, setForm] = useState({
    first_name: userData?.first_name || '',
    last_name:  userData?.last_name || '',
    role:       userData?.role || 'manager',
    hourly_rate:userData?.hourly_rate || 0,
    active:     userData?.active ?? true,
  });
  const [allTeams, setAllTeams] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    teamsApi.list().then(d => setAllTeams(d.teams || []));
  }, []);

  if (!userData) return null;

  const userTeams = userData.teams || [];
  const userTeamIds = new Set(userTeams.map(t => t.team_id));
  const nonUserTeams = allTeams.filter(t => !userTeamIds.has(t.id));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await usersApi.update(userId, form);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Uložení selhalo');
    } finally { setBusy(false); }
  };

  const addToTeam = async (teamId, teamRole) => {
    await teamsApi.addMember(teamId, { user_id: userId, team_role: teamRole });
    onSaved();
  };
  const removeFromTeam = async (teamId) => {
    if (!confirm(`Odebrat ${userData.name} z teamu?`)) return;
    try {
      await teamsApi.removeMember(teamId, userId);
      onSaved();
    } catch (e) {
      alert(e.response?.data?.message || 'Nelze odebrat');
    }
  };
  const changeTeamRole = async (teamId, newRole) => {
    await teamsApi.addMember(teamId, { user_id: userId, team_role: newRole });
    onSaved();
  };
  const resetPassword = async () => {
    if (!confirm(`Resetovat heslo pro ${userData.name}? Dostane výchozí heslo a musí ho při příštím loginu změnit.`)) return;
    const d = await usersApi.resetPassword(userId);
    alert(`Nové výchozí heslo: ${d.default_password}\n\nPošli ho uživateli. Změní si při příštím loginu.`);
  };

  return (
    <Modal open={true} onClose={onClose} title={`Uživatel: ${userData.name}`}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Ukládám…' : 'Uložit'}
        </button>
      </>}>
      <div className="space-y-4 text-sm">
        {/* Profile */}
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-500">Profil</div>
          <div className="text-[11px] text-ink-500">Email: <code>{userData.email}</code> (nelze měnit)</div>
          <div className="grid grid-cols-2 gap-2">
            <input type="text" value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })}
              placeholder="Jméno" className="border border-ink-300 rounded px-2 py-1.5" />
            <input type="text" value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })}
              placeholder="Příjmení" className="border border-ink-300 rounded px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-ink-600">Globální role</span>
              <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
                {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-ink-600">Sazba (Kč/h)</span>
              <input type="number" value={form.hourly_rate} onChange={e => setForm({ ...form, hourly_rate: Number(e.target.value) || 0 })}
                className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />
            Aktivní (může se přihlásit a být asignován)
          </label>
          <button onClick={resetPassword} className="text-xs text-brand-500 hover:text-brand-600 underline">
            Resetovat heslo na výchozí
          </button>
          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        </div>

        {/* Teams */}
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-500">
            Členství v teamech ({userTeams.length})
          </div>
          {userTeams.length === 0 ? (
            <div className="text-[11px] text-ink-400 italic">— uživatel není v žádném teamu</div>
          ) : (
            <ul className="bg-cream-50 border border-cream-200 rounded divide-y divide-cream-200">
              {userTeams.map(t => {
                // Najdi povolené role z allTeams (které mají features.team_roles)
                const fullTeam = allTeams.find(at => at.id === t.team_id);
                const allowedRoles = fullTeam?.features?.team_roles || {};
                const hasEnum = Object.keys(allowedRoles).length > 0;
                return (
                  <li key={t.team_id} className="flex items-center gap-3 p-2">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-ink-800">{t.team_name}</div>
                      <div className="text-[10px] text-ink-500 font-mono">{t.team_slug}</div>
                    </div>
                    {hasEnum ? (
                      <select
                        value={t.team_role}
                        onChange={(e) => { if (e.target.value !== t.team_role) changeTeamRole(t.team_id, e.target.value); }}
                        className="text-xs border border-ink-200 rounded px-1.5 py-1 bg-white"
                      >
                        {!(t.team_role in allowedRoles) && (
                          <option value={t.team_role} disabled>⚠ {t.team_role} (legacy)</option>
                        )}
                        {Object.entries(allowedRoles).map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        defaultValue={t.team_role}
                        onBlur={(e) => { if (e.target.value !== t.team_role) changeTeamRole(t.team_id, e.target.value); }}
                        className="w-28 text-xs border border-ink-200 rounded px-1.5 py-0.5"
                      />
                    )}
                    <button onClick={() => removeFromTeam(t.team_id)} className="text-ink-400 hover:text-red-600 px-1">×</button>
                  </li>
                );
              })}
            </ul>
          )}
          {nonUserTeams.length > 0 && (
            <div className="pt-1">
              <select
                onChange={(e) => {
                  const teamId = Number(e.target.value);
                  if (teamId) {
                    const team = allTeams.find(t => t.id === teamId);
                    // Default role = první role v features.team_roles, jinak 'member'
                    const allowedRoles = team?.features?.team_roles || {};
                    const defaultRole = Object.keys(allowedRoles)[0] || 'member';
                    addToTeam(teamId, defaultRole);
                  }
                  e.target.value = '';
                }}
                defaultValue=""
                className="w-full border border-ink-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="" disabled>+ Přidat do teamu…</option>
                {nonUserTeams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.slug})</option>)}
              </select>
              <div className="text-[11px] text-ink-400 mt-1">
                Po přidání můžeš změnit roli v dropdown výše. Každý team má svoje povolené role.
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
