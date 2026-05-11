// Hlavní dashboard – Gantt-style časová osa projektů
// + sekce "Kdo na čem pracuje" pod osou
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { projects as projectsApi, reports as reportsApi } from '../api.js';

// barvy pro projekty (cyklicky)
const PROJECT_COLORS = ['#3b6cf6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

// Pomocné datumové funkce
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const todayMid = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };
const parseDate = (s) => { const d = new Date(s + 'T12:00:00'); return d; };
const daysBetween = (a, b) => Math.round((b - a) / dayMs);
const fmtCs = (d) => d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short' });

// Spočítá odpočet do deadlinu – text + barva
function countdown(dueDateISO) {
  const due = new Date(dueDateISO + 'T23:59:59');
  const now = new Date();
  const diffMs = due - now;
  const overdue = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const days = Math.floor(absMs / dayMs);
  const hours = Math.floor((absMs % dayMs) / hourMs);
  const text = overdue
    ? `po termínu o ${days} d ${hours} h`
    : (days >= 1 ? `zbývá ${days} d ${hours} h` : `zbývá ${hours} h`);
  let color = 'text-emerald-600';
  if (overdue) color = 'text-red-600';
  else if (days <= 3) color = 'text-red-500';
  else if (days <= 7) color = 'text-amber-600';
  return { text, color, overdue };
}

export default function Timeline() {
  const [projects, setProjects] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [doneBy, setDoneBy] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([projectsApi.list(), reportsApi.who(), reportsApi.done({ days: 14 })])
      .then(([p, w, d]) => {
        setProjects(p.projects);
        setWorkers(w.workers);
        setDoneBy(d.done_by);
      })
      .finally(() => setLoading(false));
  }, []);

  // Spočítáme rozsah časové osy: nejstarší start a nejpozdější due, padding ±5 dní
  const range = useMemo(() => {
    if (!projects.length) return null;
    const today = todayMid();
    const starts = projects.map(p => parseDate(p.start_date));
    const dues   = projects.map(p => parseDate(p.due_date));
    const min = new Date(Math.min(...starts, today.getTime()) - 5 * dayMs);
    const max = new Date(Math.max(...dues, today.getTime()) + 5 * dayMs);
    return { min, max, totalDays: daysBetween(min, max) };
  }, [projects]);

  if (loading) return <div className="p-6 text-slate-500">Načítám…</div>;

  return (
    <div>
      <PageHeader
        title="Timeline"
        subtitle="Časová osa projektů – kde stojíme a kam směřujeme"
      />

      <div className="p-6 space-y-8">
        {projects.length === 0 ? (
          <div className="bg-white p-8 rounded-xl text-center text-slate-500">
            Zatím žádné projekty. <Link to="/projects" className="text-brand-500 underline">Přidej první</Link>.
          </div>
        ) : (
          <GanttChart projects={projects} range={range} />
        )}

        <div>
          <h2 className="text-lg font-semibold text-slate-800 mb-3">Kdo na čem pracuje</h2>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
            {workers.map(w => <WorkerCard key={w.user_id} worker={w} />)}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-slate-800 mb-3">
            Kdo má co hotovo
            <span className="text-xs text-slate-400 font-normal ml-2">posledních 14 dní</span>
          </h2>
          {doneBy.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-400 text-center">
              Zatím nic dokončeno v posledních 14 dnech.
            </div>
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
              {doneBy.map(w => <DoneCard key={w.user_id} worker={w} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Gantt komponenta ----------
function GanttChart({ projects, range }) {
  const today = todayMid();
  const todayPct = ((today - range.min) / dayMs) / range.totalDays * 100;

  // Měsíční značky pro hlavičku
  const months = [];
  let cursor = new Date(range.min.getFullYear(), range.min.getMonth(), 1, 12, 0, 0);
  while (cursor <= range.max) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12, 0, 0);
    const start = cursor < range.min ? range.min : cursor;
    const end = next > range.max ? range.max : next;
    const left = ((start - range.min) / dayMs) / range.totalDays * 100;
    const width = ((end - start) / dayMs) / range.totalDays * 100;
    months.push({
      label: cursor.toLocaleDateString('cs-CZ', { month: 'short', year: 'numeric' }),
      left, width,
    });
    cursor = next;
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      {/* Header s měsíci */}
      <div className="flex border-b border-slate-200 bg-slate-50">
        <div className="w-72 shrink-0 px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide border-r border-slate-200">Projekt</div>
        <div className="relative flex-1 h-9">
          {months.map((m, i) => (
            <div
              key={i}
              className="absolute top-0 h-full border-l border-slate-200 px-2 py-2 text-xs text-slate-500"
              style={{ left: `${m.left}%`, width: `${m.width}%` }}
            >{m.label}</div>
          ))}
        </div>
      </div>

      {/* Řádky projektů */}
      <div className="relative">
        {/* Vertikální čára „dnes" – přes celou tabulku */}
        <div
          className="absolute top-0 bottom-0 w-px bg-red-500 z-10"
          style={{ left: `calc(18rem + ${todayPct}% * (100% - 18rem) / 100)` }}
        >
          <div className="absolute -top-0.5 -translate-x-1/2 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded">Dnes</div>
        </div>

        {projects.map((p, idx) => {
          const start = parseDate(p.start_date);
          const due = parseDate(p.due_date);
          const left = ((start - range.min) / dayMs) / range.totalDays * 100;
          const width = ((due - start) / dayMs) / range.totalDays * 100;
          const color = PROJECT_COLORS[idx % PROJECT_COLORS.length];
          const totalDays = daysBetween(start, due);
          const elapsed = Math.max(0, Math.min(totalDays, daysBetween(start, today)));
          const progressPct = totalDays > 0 ? (elapsed / totalDays * 100) : 0;
          const isDone = p.status === 'done';
          const cd = countdown(p.due_date);

          return (
            <div key={p.id} className="flex border-b border-slate-100 hover:bg-slate-50 transition">
              <Link to={`/projects/${p.id}`} className="w-72 shrink-0 px-4 py-3 text-sm border-r border-slate-200">
                <div className="font-medium text-slate-800 truncate">{p.name}</div>
                <div className="text-xs text-slate-500 truncate">{p.client || '—'}</div>
                {!isDone && (
                  <div className={`text-xs font-semibold mt-0.5 ${cd.color}`}>
                    {cd.overdue ? '⚠ ' : '⏱ '}{cd.text}
                  </div>
                )}
                {isDone && (
                  <div className="text-xs text-emerald-600 font-semibold mt-0.5">✅ Hotovo</div>
                )}
              </Link>
              <div className="relative flex-1 py-3 h-16">
                <div
                  className="absolute top-3 h-8 rounded-lg shadow-sm flex items-center px-2 text-xs text-white truncate"
                  style={{ left: `${left}%`, width: `${Math.max(width, 1)}%`, background: color, opacity: cd.overdue ? 1 : 0.85 }}
                  title={`${fmtCs(start)} – ${fmtCs(due)} · ${cd.text}`}
                >
                  {/* progress overlay */}
                  <div
                    className="absolute inset-y-0 left-0 rounded-lg bg-black/20"
                    style={{ width: `${progressPct}%` }}
                  />
                  <span className="relative z-10 truncate">{p.name}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Karta "kdo na čem pracuje" ----------
const ROLE_BADGE = {
  admin:        'bg-purple-100 text-purple-700',
  manager:      'bg-blue-100 text-blue-700',
  senior_dev:   'bg-emerald-100 text-emerald-700',
  external_dev: 'bg-amber-100 text-amber-700',
};
const ROLE_SHORT = {
  admin: 'Admin', manager: 'PM', senior_dev: 'Senior', external_dev: 'External',
};
const STATUS_LABEL = {
  todo: 'Čeká', in_progress: 'V práci', review: 'Review', done: 'Hotovo',
};

// Karta "Kdo má co hotovo"
function DoneCard({ worker }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-emerald-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center text-sm font-bold text-emerald-700">
          {worker.user_name.split(' ').map(s => s[0]).slice(0,2).join('')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-800 truncate">{worker.user_name}</div>
          <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
            ✅ {worker.tasks.length} hotov{worker.tasks.length === 1 ? 'ý' : 'ých'}
          </span>
        </div>
      </div>
      <ul className="space-y-2">
        {worker.tasks.slice(0, 6).map(t => (
          <li key={t.id} className="text-xs">
            <Link to={`/projects/${t.project_id}`} className="block hover:bg-emerald-50 -mx-1 px-1 py-1 rounded">
              <div className="font-medium text-slate-700 truncate line-through decoration-emerald-400">{t.title}</div>
              <div className="text-slate-500 truncate mt-0.5">{t.project_name}</div>
            </Link>
          </li>
        ))}
        {worker.tasks.length > 6 && (
          <li className="text-xs text-slate-400">+ {worker.tasks.length - 6} dalších</li>
        )}
      </ul>
    </div>
  );
}

function WorkerCard({ worker }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-sm font-bold text-slate-600">
          {worker.user_name.split(' ').map(s => s[0]).slice(0,2).join('')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-800 truncate">{worker.user_name}</div>
          <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded ${ROLE_BADGE[worker.role]}`}>
            {ROLE_SHORT[worker.role]}
          </span>
        </div>
      </div>
      {worker.tasks.length === 0 ? (
        <div className="text-xs text-slate-400 italic">Žádné aktivní úkoly</div>
      ) : (
        <ul className="space-y-2">
          {worker.tasks.slice(0, 5).map(t => (
            <li key={t.id} className="text-xs">
              <Link to={`/projects/${t.project_id}`} className="block hover:bg-slate-50 -mx-1 px-1 py-1 rounded">
                <div className="font-medium text-slate-700 truncate">{t.title}</div>
                <div className="text-slate-500 flex items-center gap-2 mt-0.5">
                  <span className="truncate">{t.project_name}</span>
                  <span>·</span>
                  <span>{STATUS_LABEL[t.status]}</span>
                </div>
              </Link>
            </li>
          ))}
          {worker.tasks.length > 5 && (
            <li className="text-xs text-slate-400">+ {worker.tasks.length - 5} dalších</li>
          )}
        </ul>
      )}
    </div>
  );
}
