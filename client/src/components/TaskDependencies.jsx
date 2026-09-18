// Sekce „Návaznosti" v detailu úkolu (sekce 15 zadání).
// Ukazuje, na co úkol čeká a co sám blokuje, a umožní vazby přidat i zrušit.

import { useEffect, useMemo, useState } from 'react';
import { dependencies as depsApi, projects as projectsApi } from '../api.js';
import { StatusBadge } from './TaskStatus.jsx';

export default function TaskDependencies({ task, onOpenTask }) {
  const [data, setData] = useState({ waiting_on: [], blocking: [], can_edit: false });
  const [adding, setAdding] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => depsApi.list(task.id)
    .then(setData)
    .catch(() => setData({ waiting_on: [], blocking: [], can_edit: false }));
  useEffect(() => { load(); }, [task.id]);

  // Kandidáty bereme z projektu úkolu — navazovat napříč týmy stejně nejde.
  useEffect(() => {
    if (!adding) return;
    projectsApi.get(task.project_id)
      .then(d => setCandidates((d.tasks || []).filter(t => t.id !== task.id)))
      .catch(() => setCandidates([]));
  }, [adding, task.project_id, task.id]);

  const shown = useMemo(() => {
    const already = new Set(data.waiting_on.map(d => d.depends_on_id));
    return candidates
      .filter(t => !already.has(t.id))
      .filter(t => !q.trim() || t.title.toLowerCase().includes(q.toLowerCase()));
  }, [candidates, data.waiting_on, q]);

  const add = async (blockerId) => {
    setBusy(true); setErr(null);
    try {
      await depsApi.add(task.id, blockerId);
      setAdding(false); setQ('');
      await load();
    } catch (e) {
      setErr(e.response?.data?.message || 'Návaznost se nepodařilo vytvořit.');
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    setErr(null);
    try { await depsApi.remove(id); } catch (e) { setErr(e.response?.data?.message || 'Zrušení selhalo.'); }
    await load();
  };

  const Item = ({ d, side }) => (
    <li className="flex items-center gap-2 text-sm border border-cream-200 rounded px-2 py-1.5">
      <StatusBadge status={d.status} size="small" />
      <button
        onClick={() => onOpenTask?.(side === 'waiting' ? d.depends_on_id : d.task_id)}
        className="flex-1 min-w-0 text-left truncate text-ink-800 hover:text-brand-600 hover:underline">
        {d.title}
      </button>
      {d.due_date && <span className="text-[11px] text-ink-400 shrink-0">📅 {d.due_date}</span>}
      {data.can_edit && (
        <button onClick={() => remove(d.id)} className="text-red-500 text-xs px-1 shrink-0" title="Zrušit návaznost">×</button>
      )}
    </li>
  );

  const nothing = data.waiting_on.length === 0 && data.blocking.length === 0;

  return (
    <div className="border-t border-cream-200 pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">🔗 Návaznosti</div>
        {data.can_edit && !adding && (
          <button onClick={() => setAdding(true)} className="text-xs text-brand-600 hover:underline">
            + Přidat návaznost
          </button>
        )}
      </div>

      {nothing && !adding && (
        <div className="text-xs text-ink-400 italic">Úkol na nic nečeká a nic neblokuje.</div>
      )}

      {data.waiting_on.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] text-ink-500 mb-1">Čeká na:</div>
          <ul className="space-y-1">
            {data.waiting_on.map(d => <Item key={d.id} d={d} side="waiting" />)}
          </ul>
        </div>
      )}

      {data.blocking.length > 0 && (
        <div>
          <div className="text-[11px] text-ink-500 mb-1">Blokuje:</div>
          <ul className="space-y-1">
            {data.blocking.map(d => <Item key={d.id} d={d} side="blocking" />)}
          </ul>
        </div>
      )}

      {adding && (
        <div className="mt-2 border-t border-cream-200 pt-2">
          <div className="text-[11px] text-ink-500 mb-1">Na který úkol tenhle čeká?</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Hledat úkol…"
            className="w-full border border-ink-300 rounded px-2 py-1 text-sm mb-1" />
          <div className="max-h-44 overflow-y-auto border border-cream-200 rounded">
            {shown.map(t => (
              <button key={t.id} onClick={() => add(t.id)} disabled={busy}
                className="w-full text-left px-2 py-1.5 text-sm border-b border-cream-100 hover:bg-cream-50 disabled:opacity-50">
                {t.title}
              </button>
            ))}
            {shown.length === 0 && <div className="p-2 text-xs text-ink-400 italic">Žádný odpovídající úkol.</div>}
          </div>
          <button onClick={() => { setAdding(false); setQ(''); }}
            className="mt-1 text-xs text-ink-500 hover:underline">Zrušit</button>
        </div>
      )}

      {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
    </div>
  );
}
