// Modal: AI navrhla úkoly z poznámky → uživatel zkontroluje/upraví → založí.
// Bezpečný review krok před zápisem. Každý úkol může být v JINÉM projektu.
// Do popisu se automaticky vkládá zdroj (poznámka + odkaz), aby měl člověk
// otevřený úkol kontext odkud pochází.

import { useEffect, useState } from 'react';
import { projects as projectsApi, users as usersApi, tasks as tasksApi } from '../api.js';

const PRIORITIES = [
  { value: 'low', label: 'Nízká' },
  { value: 'normal', label: 'Normální' },
  { value: 'high', label: 'Vysoká' },
  { value: 'urgent', label: 'Urgentní' },
];

// Formátuje datum DD.MM.YYYY z ISO/Date stringu (nebo dnešní pokud chybí)
const dateLabel = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('cs-CZ');
};

// Postaví "zdroj" blok do popisu úkolu. Plain text – TaskDetailModal ho
// vykreslí whitespace-pre-wrap, takže URL je aspoň vidět a dá se zkopírovat.
const buildSourcePrefix = (note, scope) => {
  if (!note) return '';
  const date = dateLabel(note.updated_at || note.created_at);
  const url = `/notes?noteId=${note.id}&scope=${encodeURIComponent(scope || 'team')}`;
  return `📝 Z poznámky „${note.title || '(bez názvu)'}" (${date})\n🔗 Otevřít: ${url}`;
};

export default function SuggestedTasksModal({ suggestion, sourceNote, sourceScope, onClose, onCreated }) {
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  // Každý úkol + příznak include + per-row project_id (z AI návrhu nebo prázdné)
  const [rows, setRows] = useState(
    (suggestion.tasks || []).map(t => ({ ...t, include: true, project_id: t.project_id || '' }))
  );
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    // Preferuj cross-team katalog ze server-side suggest_tasks (obsahuje projekty
    // i členy ze VŠECH týmů uživatele). Fallback na API list (current team only).
    if (suggestion.available_projects && suggestion.available_members) {
      setProjects(suggestion.available_projects);
      setUsers(suggestion.available_members);
      setLoading(false);
      return;
    }
    Promise.all([projectsApi.list(), usersApi.list()])
      .then(([p, u]) => { setProjects(p.projects || []); setUsers(u.users || []); })
      .finally(() => setLoading(false));
  }, [suggestion]);

  const setRow = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const includedRows = rows.filter(r => r.include);
  const missingProject = includedRows.filter(r => !r.project_id);

  const create = async () => {
    setErr(null);
    if (includedRows.length === 0) { setErr('Není co založit – zaškrtni aspoň jeden úkol.'); return; }
    if (missingProject.length > 0) { setErr(`U ${missingProject.length} úkol(ů) chybí projekt. Doplň ho v dropdownu.`); return; }
    const sourcePrefix = buildSourcePrefix(sourceNote, sourceScope);
    setCreating(true);
    try {
      const createdByProject = {};
      for (const t of includedRows) {
        if (!t.title.trim()) continue;
        const aiDesc = (t.description || '').trim();
        const description = sourcePrefix + (aiDesc ? `\n\n${aiDesc}` : '');
        await tasksApi.create({
          project_id: Number(t.project_id),
          title: t.title.trim(),
          description,
          assignee_id: t.assignee_id ? Number(t.assignee_id) : null,
          priority: t.priority || 'normal',
          due_date: t.due_date || null,
        });
        createdByProject[t.project_id] = (createdByProject[t.project_id] || 0) + 1;
      }
      // Pokud byly všechny do jednoho projektu, předáme jeho id pro odkaz
      const projectIds = Object.keys(createdByProject);
      const singleProject = projectIds.length === 1 ? Number(projectIds[0]) : null;
      onCreated?.(includedRows.length, singleProject);
      onClose();
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Založení úkolů selhalo');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-cream-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink-800">📋 Návrh úkolů z poznámky</h2>
            <div className="text-xs text-ink-500">Každý úkol může být v jiném projektu. Nic se nevytvoří, dokud neklikneš dole.</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {loading ? <div className="text-ink-400 text-sm">Načítám projekty…</div> : rows.length === 0 ? (
            <div className="text-sm text-ink-400 italic">AI nenašla v poznámce žádné akční úkoly.</div>
          ) : (
            <div className="space-y-3">
              {rows.map((r, i) => (
                <div key={i} className={`border rounded-lg p-3 ${r.include ? 'border-cream-300' : 'border-cream-200 opacity-50'}`}>
                  <div className="flex items-start gap-2">
                    <input type="checkbox" checked={r.include}
                      onChange={(e) => setRow(i, { include: e.target.checked })}
                      className="mt-2 w-4 h-4" />
                    <div className="flex-1 space-y-2">
                      <input value={r.title} onChange={(e) => setRow(i, { title: e.target.value })}
                        placeholder="Název úkolu"
                        className="w-full border border-ink-300 rounded px-2 py-1.5 text-sm font-medium" />

                      {/* Projekt per úkol */}
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-ink-500 w-14 shrink-0">Projekt:</span>
                        <select value={r.project_id || ''} onChange={(e) => setRow(i, { project_id: e.target.value })}
                          className={`flex-1 border rounded px-2 py-1 text-xs ${
                            r.include && !r.project_id ? 'border-red-300 bg-red-50' : 'border-cream-300'
                          }`}>
                          <option value="">— vyber projekt —</option>
                          {projects.map(p => (
                            <option key={p.id} value={p.id}>
                              {p.name}{p.team_name ? ` · ${p.team_name}` : ''}
                            </option>
                          ))}
                        </select>
                        {r.project_name && <span className="text-[10px] text-ink-400 whitespace-nowrap">AI: {r.project_name}</span>}
                      </div>

                      <textarea value={r.description || ''} onChange={(e) => setRow(i, { description: e.target.value })}
                        placeholder="Kontext (volitelně)"
                        rows={2} className="w-full border border-cream-300 rounded px-2 py-1 text-xs" />

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select value={r.assignee_id || ''} onChange={(e) => setRow(i, { assignee_id: e.target.value })}
                          className="border border-cream-300 rounded px-1.5 py-1 text-xs">
                          <option value="">— kdo —</option>
                          {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <select value={r.priority} onChange={(e) => setRow(i, { priority: e.target.value })}
                          className="border border-cream-300 rounded px-1.5 py-1 text-xs">
                          {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                        </select>
                        <input type="date" value={r.due_date || ''} onChange={(e) => setRow(i, { due_date: e.target.value })}
                          className="border border-cream-300 rounded px-1.5 py-1 text-xs" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="text-[11px] text-ink-400 px-1">
                Do popisu každého úkolu se automaticky vloží zdroj („Z poznámky „X" + odkaz").
              </div>
            </div>
          )}
          {err && <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        </div>

        <div className="px-5 py-3 border-t border-cream-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={creating}
            className="px-3 py-1.5 text-sm rounded border border-cream-300 hover:bg-cream-50">Zrušit</button>
          <button onClick={create} disabled={creating || includedRows.length === 0}
            className="px-4 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
            {creating ? 'Zakládám…' : `Vytvořit ${includedRows.length} úkol(ů)`}
          </button>
        </div>
      </div>
    </div>
  );
}
