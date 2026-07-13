// Hledat úkoly podle uživatele — filtruje BE endpoint /api/tasks/search.
//
// Kdo koho vidí:
//   - Admin: dropdown Tým (všechny týmy) + dropdown Uživatel (všichni)
//   - Non-admin: dropdown Tým (jen moje týmy) + dropdown Uživatel (členové týmu)
//
// Filtry navíc: Projekt, Status. Klik na úkol → TaskDetailModal.

import { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import { StatusBadge, STATUS_META } from '../components/TaskStatus.jsx';
import { useAuth } from '../auth.jsx';
import { useTeams } from '../teams.jsx';
import { tasks as tasksApi, users as usersApi, teams as teamsApi, projects as projectsApi } from '../api.js';

const STATUS_OPTIONS = [
  { value: '',            label: 'Vše' },
  { value: 'todo',        label: '📥 K řešení' },
  { value: 'in_progress', label: '🛠 Rozpracované' },
  { value: 'review',      label: '👀 Review' },
  { value: 'needs_fix',   label: '🔄 K opravě' },
  { value: 'done',        label: '✅ Hotové' },
];

const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '—';

export default function FindTasks() {
  const { user } = useAuth();
  const { teams: myTeams } = useTeams();
  const isAdmin = user?.role === 'admin';

  const [teamId, setTeamId]   = useState(''); // '' = všechny (cross-team, jen admin) / mé týmy (non-admin)
  const [userId, setUserId]   = useState('');
  const [projectId, setProjectId] = useState('');
  // Default 'todo' — user typicky hledá co čeká na akci, ne archiv.
  const [status, setStatus]   = useState('todo');
  const [allTeams, setAllTeams] = useState([]);   // pro admin
  const [teamUsers, setTeamUsers] = useState([]); // pro dropdown users
  const [projects, setProjects]   = useState([]);
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [detailTask, setDetailTask] = useState(null);

  // Admin: načti všechny týmy (přes /teams endpoint). Non-admin: použije myTeams.
  useEffect(() => {
    if (!isAdmin) return;
    teamsApi.list().then(d => setAllTeams(d.teams || [])).catch(() => setAllTeams([]));
  }, [isAdmin]);

  const teamOptions = isAdmin ? allTeams : (myTeams || []);

  // Načti uživatele daného týmu (nebo napříč mými týmy / všechny pro admina).
  useEffect(() => {
    if (teamId) {
      usersApi.listInTeam(Number(teamId))
        .then(d => setTeamUsers(d.users || []))
        .catch(() => setTeamUsers([]));
    } else if (isAdmin) {
      // Admin + "Všechny týmy" → všichni aktivní uživatelé napříč všemi týmy.
      usersApi.listAll()
        .then(d => setTeamUsers((d.users || []).filter(u => u.active)))
        .catch(() => setTeamUsers([]));
    } else {
      usersApi.listAcrossMyTeams()
        .then(d => setTeamUsers(d.users || []))
        .catch(() => setTeamUsers([]));
    }
    setUserId(''); // reset user při změně týmu
    setProjectId('');
  }, [teamId, isAdmin]);

  // Načti projekty daného týmu (jen pro nabídku filtru)
  useEffect(() => {
    if (!teamId) { setProjects([]); return; }
    projectsApi.listAll()
      .then(d => setProjects((d.projects || []).filter(p => p.team_id === Number(teamId))))
      .catch(() => setProjects([]));
  }, [teamId]);

  // Hlavní fetch — spouští se automaticky při změně filtrů.
  useEffect(() => {
    setLoading(true);
    const params = {};
    if (userId)    params.assignee_id = Number(userId);
    if (teamId)    params.team_id     = Number(teamId);
    if (projectId) params.project_id  = Number(projectId);
    if (status)    params.status      = status;
    tasksApi.search(params)
      .then(d => setItems(d.tasks || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [teamId, userId, projectId, status]);

  const groupedByUser = useMemo(() => {
    const map = new Map();
    for (const t of items) {
      if (!map.has(t.assignee_id)) map.set(t.assignee_id, { id: t.assignee_id, name: t.assignee_name, avatar_updated_at: t.assignee_avatar_updated_at, tasks: [] });
      map.get(t.assignee_id).tasks.push(t);
    }
    return Array.from(map.values()).sort((a, b) => b.tasks.length - a.tasks.length);
  }, [items]);

  return (
    <div>
      <PageHeader
        title="🔍 Hledat úkoly"
        subtitle={loading ? 'Načítám…' : `${items.length} úkol(ů)${groupedByUser.length > 1 ? ` od ${groupedByUser.length} uživatelů` : ''}`}
      />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Filtry */}
        <div className="bg-white border border-cream-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Tým</span>
            <select value={teamId} onChange={e => setTeamId(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5 text-sm">
              <option value="">{isAdmin ? 'Všechny týmy' : 'Napříč mými týmy'}</option>
              {teamOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Uživatel</span>
            <select value={userId} onChange={e => setUserId(e.target.value)}
              disabled={teamUsers.length === 0}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5 text-sm disabled:bg-cream-50">
              <option value="">Vše</option>
              {teamUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Projekt</span>
            <select value={projectId} onChange={e => setProjectId(e.target.value)}
              disabled={!teamId}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5 text-sm disabled:bg-cream-50">
              <option value="">Vše</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Stav</span>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5 text-sm">
              {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>

        {/* Výsledky — grupováno per user */}
        {loading ? (
          <div className="text-ink-500 text-sm">Načítám…</div>
        ) : groupedByUser.length === 0 ? (
          <div className="bg-white border border-cream-200 rounded-xl p-8 text-center text-ink-400 text-sm">
            Žádné úkoly odpovídající filtru.
          </div>
        ) : (
          <div className="space-y-4">
            {groupedByUser.map(g => (
              <div key={g.id} className="bg-white border border-cream-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-cream-100 flex items-center gap-3 bg-cream-50">
                  <Avatar user={{ id: g.id, name: g.name, avatar_updated_at: g.avatar_updated_at }} size={28} />
                  <div className="font-medium text-ink-800">{g.name}</div>
                  <div className="text-xs text-ink-500">· {g.tasks.length} úkol(ů)</div>
                </div>
                <ul className="divide-y divide-cream-100">
                  {g.tasks.map(t => (
                    <li key={t.id}
                      onClick={() => setDetailTask(t)}
                      className="px-4 py-2.5 cursor-pointer hover:bg-cream-50 flex items-center gap-3">
                      <StatusBadge status={t.status} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-ink-800 truncate">{t.title}</div>
                        <div className="text-[11px] text-ink-500 truncate">
                          {t.project_name}{t.team_name && ` · ${t.team_name}`}
                          {t.due_date && ` · 📅 ${fmt(t.due_date)}`}
                          {t.completed_at && ` · ✅ ${fmt(t.completed_at)}`}
                        </div>
                      </div>
                      {t.priority && t.priority !== 'normal' && (
                        <span className="text-[10px] uppercase tracking-wide text-ink-500 shrink-0">
                          {t.priority === 'urgent' ? '🔥' : t.priority === 'high' ? '⬆' : '⬇'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {detailTask && (
        <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} onUpdate={() => {}} />
      )}
    </div>
  );
}
