// Hlavní dashboard – Gantt-style časová osa projektů
// Nejdelší projekt určuje šířku osy (zoomovatelnou). Countdown je přímo v baru.
// Pod každým hlavním barem je tenčí linka odhadu práce: sum(estimated_h)/HOURS_PER_DAY = pracovní dny.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { projects as projectsApi, reports as reportsApi } from '../api.js';
import { useFeature, useTeams } from '../teams.jsx';
import Avatar from '../components/Avatar.jsx';
import ScoreStrip from '../components/ScoreStrip.jsx';

const PROJECT_COLORS = ['#0c363e', '#e72b78', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];
const HOURS_PER_DAY = 6; // pracovních hodin denně – konstanta podle zadání

// ---------- Datumové utility ----------
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const todayMid = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };
const parseDate = (s) => new Date(String(s).slice(0, 10) + 'T12:00:00');
const daysBetween = (a, b) => Math.round((b - a) / dayMs);
const fmtCs = (d) => d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short' });
const isoDate = (d) => d.toISOString().slice(0, 10);

function countdown(dueDateISO) {
  const due = new Date(String(dueDateISO).slice(0, 10) + 'T23:59:59');
  const now = new Date();
  const diffMs = due - now;
  const overdue = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const days = Math.floor(absMs / dayMs);
  const hours = Math.floor((absMs % dayMs) / hourMs);
  let text;
  if (overdue) text = `po termínu ${days} d ${hours} h`;
  else if (days >= 1) text = `zbývá ${days} d ${hours} h`;
  else text = `zbývá ${hours} h`;
  let color = 'bg-emerald-500';      // > 7 dní
  if (overdue) color = 'bg-red-600';
  else if (days <= 3) color = 'bg-red-500';
  else if (days <= 7) color = 'bg-accent-500'; // Cerise pro <7 dní
  return { text, color, overdue, days };
}

// Převod odhadu na pracovní dni + zbylé hodiny: 20h, 6h/den → "3 d 2 h"
function workdaysLabel(totalHours) {
  if (!totalHours || totalHours <= 0) return null;
  const fullDays = Math.floor(totalHours / HOURS_PER_DAY);
  const remHours = +(totalHours - fullDays * HOURS_PER_DAY).toFixed(1);
  if (fullDays === 0) return `${remHours} h`;
  if (remHours === 0) return `${fullDays} d`;
  return `${fullDays} d ${remHours} h`;
}

// ---------- Komponenta ----------
export default function Timeline() {
  const [projects, setProjects] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [doneBy, setDoneBy] = useState([]);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);   // 1 = default; 0.5 = oddálené; 2 = přiblížené
  // Forecast linka „od dneška + zbývající odhad" – zapnutá jen pro teamy s feature flag
  // timeline_forecast (default: IT team). Ukazuje overcommit, když odhad přesahuje deadline.
  const forecastEnabled = useFeature('timeline_forecast');
  // Score Strip nahoře — jen když má team feature flag success_metrics.
  const scoreEnabled = useFeature('success_metrics');
  const { currentTeam } = useTeams();

  useEffect(() => {
    Promise.all([projectsApi.list(), reportsApi.who(), reportsApi.done({ days: 14 })])
      .then(([p, w, d]) => {
        setProjects(p.projects);
        setWorkers(w.workers);
        setDoneBy(d.done_by);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6 text-ink-500">Načítám…</div>;

  return (
    <div>
      <PageHeader
        title="Timeline"
        subtitle="Časová osa projektů – kde stojíme a kam směřujeme"
        actions={
          projects.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink-500">Zoom:</span>
              <button onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                className="w-8 h-8 rounded border border-cream-300 hover:bg-cream-100">−</button>
              <span className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(4, +(z + 0.25).toFixed(2)))}
                className="w-8 h-8 rounded border border-cream-300 hover:bg-cream-100">+</button>
              <button onClick={() => setZoom(1)} className="px-2 py-1 text-xs border border-cream-300 rounded hover:bg-cream-100">reset</button>
            </div>
          )
        }
      />

      {scoreEnabled && (
        <div className="px-4 sm:px-8 pt-4 sm:pt-6">
          <div className="bg-white border border-cream-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
                🏆 Skóre týmu {currentTeam?.name ? `— ${currentTeam.name}` : ''}
              </div>
              <Link to="/scoreboard" className="text-xs text-brand-600 hover:underline">Celý přehled →</Link>
            </div>
            <ScoreStrip teamName={currentTeam?.name} />
          </div>
        </div>
      )}

      <div className="p-4 sm:p-8 space-y-6 sm:space-y-8">
        {projects.length === 0 ? (
          <div className="bg-white p-8 rounded-xl text-center text-ink-500">
            Zatím žádné projekty. <Link to="/projects" className="text-brand-500 underline">Přidej první</Link>.
          </div>
        ) : (
          <>
            {(() => {
              // Filtr projekty: vyhodit ty, které mají hidden_from_timeline=true.
              // Zbylé rozdělit na timeline (mají termín) vs undated (no_timeline nebo bez data).
              const visible = projects.filter(p => !p.hidden_from_timeline);
              // Projekty s no_timeline nikdy nejdou na Gantt — patří do "běží bez termínu" sekce.
              const timeline = visible.filter(p => !p.no_timeline && p.effective_due_date);
              const undated  = visible.filter(p =>  p.no_timeline || !p.effective_due_date);
              return (
                <>
                  {timeline.length > 0 && (
                    <GanttChart
                      projects={timeline}
                      zoom={zoom}
                      forecastEnabled={forecastEnabled}
                    />
                  )}
                  {undated.length > 0 && (
                    <UndatedProjects projects={undated} />
                  )}
                </>
              );
            })()}
          </>
        )}

        <div>
          <h2 className="text-lg font-semibold text-ink-800 mb-3">Kdo na čem pracuje</h2>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
            {workers.map(w => <WorkerCard key={w.user_id} worker={w} />)}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-ink-800 mb-3">
            Kdo má co hotovo
            <span className="text-xs text-ink-400 font-normal ml-2">posledních 14 dní</span>
          </h2>
          {doneBy.length === 0 ? (
            <div className="bg-white rounded-xl border border-cream-200 p-6 text-sm text-ink-400 text-center">
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

// ---------- Gantt ----------
function GanttChart({ projects, zoom, forecastEnabled }) {
  const today = todayMid();
  const scrollRef = useRef(null);

  // Spočítáme rozsah osy + délku osy v px (zoom × pixels per day)
  const layout = useMemo(() => {
    const starts = projects.map(p => parseDate(p.start_date));
    const dues   = projects.map(p => parseDate(p.effective_due_date));
    const min = new Date(Math.min(...starts, today.getTime()) - 5 * dayMs);
    const max = new Date(Math.max(...dues, today.getTime()) + 5 * dayMs);
    const totalDays = Math.max(1, daysBetween(min, max));

    // Najdeme nejdelší projekt – jeho délka určuje pixelovou škálu
    const longestDays = Math.max(...projects.map(p => daysBetween(parseDate(p.start_date), parseDate(p.effective_due_date))));
    // Při zoom=1 chceme, aby nejdelší projekt zabíral cca 800 px → pixels per day:
    const basePxPerDay = Math.max(8, Math.round(800 / Math.max(1, longestDays)));
    const pxPerDay = basePxPerDay * zoom;
    const totalWidth = totalDays * pxPerDay;
    return { min, max, totalDays, pxPerDay, totalWidth, longestDays };
  }, [projects, zoom]);

  // Měsíční a týdenní mřížka
  const gridMarks = useMemo(() => {
    const marks = [];
    let cursor = new Date(layout.min);
    cursor.setHours(12, 0, 0, 0);
    while (cursor <= layout.max) {
      const left = daysBetween(layout.min, cursor) * layout.pxPerDay;
      const day = cursor.getDay(); // 0 = neděle
      const isMonthStart = cursor.getDate() === 1;
      marks.push({
        date: new Date(cursor),
        left,
        isMonthStart,
        isMondayOrFirst: day === 1 || isMonthStart,
      });
      cursor = new Date(cursor.getTime() + dayMs);
    }
    return marks;
  }, [layout]);

  const todayLeft = daysBetween(layout.min, today) * layout.pxPerDay;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-cream-200 overflow-hidden">
      <div className="flex">
        {/* Sticky levý sloupec se jmény projektů (na mobilu užší) */}
        <div className="w-40 sm:w-72 shrink-0 border-r border-cream-200 bg-cream-50">
          <div className="px-4 py-2.5 text-xs font-semibold text-ink-500 uppercase tracking-wide border-b border-cream-200 h-14 flex items-end pb-2">
            Projekt
          </div>
          {projects.map((p) => (
            <ProjectLabel key={p.id} project={p} />
          ))}
        </div>

        {/* Scrollovací pravá část s časovou osou */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto">
          <div style={{ width: layout.totalWidth, minWidth: '100%' }} className="relative">
            {/* Hlavička – datová osa */}
            <TimeAxis marks={gridMarks} pxPerDay={layout.pxPerDay} />

            {/* Vertikální čára „dnes" – přes celou výšku */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
              style={{ left: todayLeft }}
            >
              <div className="absolute top-1 -translate-x-1/2 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded font-semibold">
                Dnes
              </div>
            </div>

            {/* Slabé vertikální linky pro pondělky/první v měsíci */}
            {gridMarks.filter(m => m.isMondayOrFirst).map((m, i) => (
              <div
                key={i}
                className={`absolute top-14 bottom-0 w-px ${m.isMonthStart ? 'bg-cream-300' : 'bg-cream-200/60'} pointer-events-none`}
                style={{ left: m.left }}
              />
            ))}

            {/* Řádky projektů */}
            <div>
              {projects.map((p, idx) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  layout={layout}
                  colorIdx={idx}
                  forecastEnabled={forecastEnabled}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Legenda */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-cream-200 bg-cream-50 text-[10px] text-ink-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-brand-500" /> Hlavní bar = od začátku do termínu</span>
        <span className="flex items-center gap-1"><span className="w-3 h-1 rounded bg-accent-500" /> Tenká linka = odhad práce ({HOURS_PER_DAY} h/den)</span>
        <span className="flex items-center gap-1"><span className="w-px h-3 bg-red-500" /> Dnes</span>
        <span className="ml-auto">Nejdelší projekt: {layout.longestDays} dní</span>
      </div>
    </div>
  );
}

// ---------- Levý sloupec - label projektu ----------
function ProjectLabel({ project }) {
  const isDone = project.status === 'done';
  const cd = countdown(project.effective_due_date);
  // height 100 + leading-tight → 4 řádky (název + manager + zodpovědnost + countdown)
  // se bezpečně vejdou bez overflow do dalšího řádku.
  return (
    <Link
      to={`/projects/${project.id}`}
      className="block px-4 py-2.5 text-sm border-b border-cream-100 hover:bg-cream-100 transition flex flex-col justify-center leading-tight gap-0.5"
      style={{ height: 100 }}
      title={project.name}
    >
      <div className="font-medium text-ink-800 truncate">{project.name}</div>
      <div className="text-[11px] text-ink-500 truncate">
        <span className="text-ink-400">Manager:</span> {project.manager_name || '—'}
      </div>
      <div className="text-[11px] text-ink-500 truncate">
        <span className="text-ink-400">Zodpovědnost:</span> {project.responsible_name || '—'}
      </div>
      {!isDone ? (
        <div className={`text-[10px] font-semibold ${cd.overdue ? 'text-red-600' : cd.days <= 3 ? 'text-red-500' : cd.days <= 7 ? 'text-accent-600' : 'text-emerald-600'}`}>
          {cd.overdue ? '⚠ ' : '⏱ '}{cd.text}
        </div>
      ) : (
        <div className="text-[10px] text-emerald-600 font-semibold">✅ Hotovo</div>
      )}
    </Link>
  );
}

// ---------- Hlavička s daty ----------
function TimeAxis({ marks, pxPerDay }) {
  // Zobrazujeme labely pouze pro pondělky nebo první v měsíci, ať se neperou
  const labelMarks = marks.filter(m => m.isMondayOrFirst);

  return (
    <div className="relative h-14 border-b border-cream-200 bg-cream-50">
      {/* Měsíční pruh nahoře */}
      <div className="absolute top-0 left-0 right-0 h-7 border-b border-cream-200">
        {marks.filter(m => m.isMonthStart).map((m, i) => (
          <div key={i}
            className="absolute top-0 px-2 py-1 text-xs font-semibold text-brand-500 whitespace-nowrap"
            style={{ left: m.left + 4 }}
          >
            {m.date.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })}
          </div>
        ))}
      </div>
      {/* Týdenní/datovi labely dole */}
      <div className="absolute top-7 left-0 right-0 h-7">
        {labelMarks.map((m, i) => (
          <div key={i}
            className="absolute top-0 px-1 text-[10px] text-ink-500 whitespace-nowrap"
            style={{ left: m.left + 2 }}
          >
            {m.date.getDate()}. {m.date.toLocaleDateString('cs-CZ', { month: 'short' })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Řádek projektu (hlavní bar + linka odhadu + případně forecast linka) ----------
function ProjectRow({ project, layout, colorIdx, forecastEnabled }) {
  const today = todayMid();
  const start = parseDate(project.start_date);
  const due = parseDate(project.effective_due_date);
  const left = daysBetween(layout.min, start) * layout.pxPerDay;
  const width = Math.max(layout.pxPerDay, daysBetween(start, due) * layout.pxPerDay);
  const color = PROJECT_COLORS[colorIdx % PROJECT_COLORS.length];
  const totalDays = daysBetween(start, due);
  const elapsed = Math.max(0, Math.min(totalDays, daysBetween(start, today)));
  const progressPct = totalDays > 0 ? (elapsed / totalDays * 100) : 0;
  const cd = countdown(project.effective_due_date);
  const isDone = project.status === 'done';

  // Hodiny: total (vše), remaining (nedokončené), done = rozdíl.
  // estimated_h_total i estimated_h_remaining jdou z projects.js agregace.
  const totalH = Number(project.estimated_h_total || 0);
  const remH = Number(project.estimated_h_remaining || 0);
  // Když total chybí (0), použij remaining jako fallback (starší projekty).
  const estH = totalH > 0 ? totalH : remH;
  const doneH = Math.max(0, estH - remH);

  // Linka 1 (accent): CELKOVÝ odhad od start_date. Délka = total / 6h.
  const estDays = estH / HOURS_PER_DAY;
  const estWidth = estDays * layout.pxPerDay;
  const estLabel = workdaysLabel(estH);

  // Linka 2: forecast „od dneška + ZBÝVAJÍCÍ odhad" – jen pro teamy s timeline_forecast feature.
  // Pokud délka přesahuje deadline, zbarví se červeně (overcommit).
  // Když je projekt hotový nebo nemá zbývající odhad, nezobrazujeme.
  const showForecast = forecastEnabled && !isDone && remH > 0;
  const todayLeft = daysBetween(layout.min, today) * layout.pxPerDay;
  const forecastLeft = Math.max(todayLeft, left);  // začíná dneškem, nebo startem (cokoliv pozdější)
  const forecastDays = remH / HOURS_PER_DAY;
  const forecastWidthRaw = forecastDays * layout.pxPerDay;
  const forecastWidth = Math.max(4, Math.min(forecastWidthRaw, layout.totalWidth - forecastLeft));
  // Detekce overcommit: dneška + odhad > deadline projektu
  const forecastEndDate = new Date(today.getTime() + forecastDays * dayMs);
  const overcommit = forecastEndDate > due;
  const forecastLabel = workdaysLabel(remH);
  const projectedDateLabel = fmtCs(forecastEndDate);

  return (
    <div className="relative border-b border-cream-100 hover:bg-cream-50/50 transition" style={{ height: 100 }}>
      {/* Hlavní bar */}
      <div
        className="absolute rounded-lg shadow-sm flex items-center px-2 text-xs text-white overflow-hidden"
        style={{
          left, width,
          top: 10, height: 30,
          background: color,
          opacity: isDone ? 0.5 : 1,
        }}
        title={`${fmtCs(start)} – ${fmtCs(due)} · ${cd.text}`}
      >
        {/* progress overlay */}
        <div className="absolute inset-y-0 left-0 bg-black/20" style={{ width: `${progressPct}%` }} />
        {/* obsah – název + countdown chip vpravo */}
        <span className="relative z-10 font-medium truncate flex-1">{project.name}</span>
        {!isDone && (
          <span className={`relative z-10 ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${cd.color} text-white shadow whitespace-nowrap`}>
            {cd.text}
          </span>
        )}
      </div>

      {/* Tenká linka – odhad pracovních dní (od plánovaného startu) */}
      {estH > 0 && (
        <div
          className="absolute"
          style={{ left, top: 44, height: 10 }}
        >
          <div
            className="rounded-full h-1.5 bg-accent-500/80 shadow-sm"
            style={{ width: Math.min(estWidth, layout.totalWidth - left), minWidth: 4 }}
          />
          {estLabel && estWidth > 50 && (
            <div className="text-[9px] text-accent-700 font-medium mt-0.5 whitespace-nowrap">
              celkem: {estLabel} ({estH} h){doneH > 0 ? ` · hotovo ${doneH} h` : ''}
            </div>
          )}
        </div>
      )}

      {/* Forecast linka – od dneška + zbývající odhad. Červená když přesahuje deadline. */}
      {showForecast && (
        <div
          className="absolute"
          style={{ left: forecastLeft, top: 62, height: 12 }}
          title={overcommit
            ? `Overcommit: pokud začneš dnes, zbývající ${remH} h (${forecastLabel}) skončí ${projectedDateLabel} — po deadlinu ${fmtCs(due)}`
            : `Pokud začneš dnes, zbývajících ${remH} h (${forecastLabel}) skončí ${projectedDateLabel} — v termínu`}
        >
          <div
            className={`rounded-full h-1.5 shadow-sm ${overcommit ? 'bg-red-500' : 'bg-blue-500/80'}`}
            style={{ width: forecastWidth, minWidth: 4 }}
          />
          {forecastLabel && forecastWidth > 60 && (
            <div className={`text-[9px] font-medium mt-0.5 whitespace-nowrap ${overcommit ? 'text-red-700' : 'text-blue-700'}`}>
              {overcommit ? '⚠ ' : ''}zbývá od dnes: {forecastLabel} ({remH} h) → {projectedDateLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- "Kdo na čem pracuje" ----------
const ROLE_BADGE = {
  admin:        'bg-purple-100 text-purple-700',
  manager:      'bg-blue-100 text-blue-700',
  senior_dev:   'bg-emerald-100 text-emerald-700',
  external_dev: 'bg-accent-100 text-accent-700',
};
const ROLE_SHORT = { admin: 'Admin', manager: 'PM', senior_dev: 'Senior', external_dev: 'External' };
const STATUS_LABEL = { todo: 'Čeká', in_progress: 'V práci', review: 'Review', done: 'Hotovo' };

function WorkerCard({ worker }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-cream-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Avatar user={{ id: worker.user_id, name: worker.user_name }} size={36} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink-800 truncate">{worker.user_name}</div>
          <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded ${ROLE_BADGE[worker.role]}`}>
            {ROLE_SHORT[worker.role]}
          </span>
        </div>
      </div>
      {worker.tasks.length === 0 ? (
        <div className="text-xs text-ink-400 italic">Žádné aktivní úkoly</div>
      ) : (
        <ul className="space-y-2">
          {worker.tasks.slice(0, 5).map(t => (
            <li key={t.id} className="text-xs">
              <Link to={`/projects/${t.project_id}`} className="block hover:bg-cream-50 -mx-1 px-1 py-1 rounded">
                <div className="font-medium text-ink-700 truncate">{t.title}</div>
                <div className="text-ink-500 flex items-center gap-2 mt-0.5">
                  <span className="truncate">{t.project_name}</span>
                  <span>·</span>
                  <span>{STATUS_LABEL[t.status]}</span>
                </div>
              </Link>
            </li>
          ))}
          {worker.tasks.length > 5 && (
            <li className="text-xs text-ink-400">+ {worker.tasks.length - 5} dalších</li>
          )}
        </ul>
      )}
    </div>
  );
}

function DoneCard({ worker }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-emerald-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Avatar user={{ id: worker.user_id, name: worker.user_name }} size={36} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink-800 truncate">{worker.user_name}</div>
          <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
            ✅ {worker.tasks.length} hotov{worker.tasks.length === 1 ? 'ý' : 'ých'}
          </span>
        </div>
      </div>
      <ul className="space-y-2">
        {worker.tasks.slice(0, 6).map(t => (
          <li key={t.id} className="text-xs">
            <Link to={`/projects/${t.project_id}`} className="block hover:bg-emerald-50 -mx-1 px-1 py-1 rounded">
              <div className="font-medium text-ink-700 truncate line-through decoration-emerald-400">{t.title}</div>
              <div className="text-ink-500 truncate mt-0.5">{t.project_name}</div>
            </Link>
          </li>
        ))}
        {worker.tasks.length > 6 && (
          <li className="text-xs text-ink-400">+ {worker.tasks.length - 6} dalších</li>
        )}
      </ul>
    </div>
  );
}

// ---------- Projekty bez termínu ----------
// Běží na pozadí, není pevný deadline. Pokud se objeví aktivní úkol s termínem,
// projekt se zase objeví v Gantt grafu nahoře.
function UndatedProjects({ projects }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-ink-800 mb-3">
        Bez pevného termínu
        <span className="text-xs text-ink-400 font-normal ml-2">
          ongoing projekty (bez OD–DO ohraničení) nebo ještě bez termínu — jen součet hodin
        </span>
      </h2>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {projects.map(p => (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="bg-white rounded-xl border border-cream-200 hover:shadow-md hover:border-cream-300 transition p-4 block"
          >
            <div className="font-medium text-ink-800 truncate">{p.name}</div>
            <div className="text-[11px] text-ink-500 truncate mt-0.5">
              <span className="text-ink-400">Manager:</span> {p.manager_name || '—'}
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              <span className="text-ink-400">Zodpovědnost:</span> {p.responsible_name || '—'}
            </div>
            <div className="text-[11px] text-ink-500 mt-2 flex gap-3">
              <span>{p.done_count}/{p.task_count} hotovo</span>
              <span>·</span>
              <span>{Number(p.hours_logged || 0).toFixed(1)} h</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
