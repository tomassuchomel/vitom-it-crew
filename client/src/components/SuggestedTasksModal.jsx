// Modal: AI navrhla úkoly z poznámky → uživatel zkontroluje/upraví → založí.
// Bezpečný review krok před zápisem. Úkoly se zakládají přes POST /api/tasks
// (běžné, ne-AI úkoly) do vybraného projektu current teamu.

import { useEffect, useState } from 'react';
import { projects as projectsApi, users as usersApi, tasks as tasksApi } from '../api.js';

const PRIORITIES = [
  { value: 'low', label: 'Nízká' },
  { value: 'normal', label: 'Normální' },
  { value: 'high', label: 'Vysoká' },
  { value: 'urgent', label: 'Urgentní' },
];

export default function SuggestedTasksModal({ suggestion, onClose, onCreated }) {
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [projectId, setProjectId] = useState(suggestion.projectId || '');
  // Každý úkol + příznak include
  const [rows, setRows] = useState(
    (suggestion.tasks || []).map(t => ({ ...t, include: true }))
  );
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([projectsApi.list(), usersApi.list()])
      .then(([p, u]) => { setProjects(p.projects || []); setUsers(u.users || []); })
      .finally(() => setLoading(false));
  }, []);

  const setRow = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const includedCount = rows.filter(r => r.include).length;

  const create = async () => {
    setErr(null);
    if (!projectId) { setErr('Vyber projekt, do kterého se úkoly založí.'); return; }
    const toCreate = rows.filter(r => r.include && r.title.trim());
    if (toCreate.length === 0) { setErr('Není co založit – zaškrtni aspoň jeden úkol s názvem.'); return; }
    setCreating(true);
    try {
      for (const t of toCreate) {
        await tasksApi.create({
          project_id: Number(projectId),
          title: t.title.trim(),
          description: t.description || null,
          assignee_id: t.assignee_id ? Number(t.assignee_id) : null,
          priority: t.priority || 'normal',
          due_date: t.due_date || null,
        });
      }
      onCreated?.(toCreate.length, Number(projectId));
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
            <div className="text-xs text-ink-500">Zkontroluj, uprav a založ. Nic se nevytvoří, dokud neklikneš dole.</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {loading ? <div className="text-ink-400 text-sm">Načítám projekty…</div> : (
            <>
              {/* Cílový projekt */}
              <label className="block mb-4">
                <span className="text-xs font-medium text-ink-600">Založit do projektu *</span>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5 text-sm"
                >
                  <option value="">— vyber projekt —</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {suggestion.projectName && (
                  <span className="text-[11px] text-ink-400">AI navrhla: {suggestion.projectName}</span>
                )}
              </label>

              {rows.length === 0 ? (
                <div className="text-sm text-ink-400 italic">AI nenašla v poznámce žádné akční úkoly.</div>
              ) : (
                <div className="space-y-2">
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
                          {r.description && (
                            <textarea value={r.description} onChange={(e) => setRow(i, { description: e.target.value })}
                              rows={2} className="w-full border border-cream-300 rounded px-2 py-1 text-xs" />
                          )}
                          <div className="grid grid-cols-3 gap-2">
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
                </div>
              )}
              {err && <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-cream-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={creating}
            className="px-3 py-1.5 text-sm rounded border border-cream-300 hover:bg-cream-50">Zrušit</button>
          <button onClick={create} disabled={creating || includedCount === 0}
            className="px-4 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
            {creating ? 'Zakládám…' : `Vytvořit ${includedCount} úkol(ů)`}
          </button>
        </div>
      </div>
    </div>
  );
}
