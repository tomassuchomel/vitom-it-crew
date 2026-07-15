// Scoreboard — přehled úspěšnosti dokončování úkolů v termínu.
//
// Struktura:
//   1) Filter panel: [Team dropdown | months=6/12/24 chip]
//      Admin: k dropdown přidán "Všechny týmy (celkem)".
//   2) KPI karty (celkem: on_time / late / overdue / success_rate).
//   3) Měsíční trend — line chart úspěšnost týmu za posledních N měsíců (Recharts).
//   4) Karty per user: mini bar (objem + úspěšnost) + sparkline za N měsíců.
//   5) Detailní tabulka žebříčku (jako dřív, řazená dle success_rate).
//   6) Admin only: přehled per tým (počty a úspěšnost).

import { useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import { useAuth } from '../auth.jsx';
import { useTeams } from '../teams.jsx';
import { scoreboard as scoreboardApi, tasks as tasksApi } from '../api.js';

const MEDAL = ['🥇', '🥈', '🥉'];

function rateClass(rate) {
  if (rate == null) return 'bg-slate-100 text-slate-500';
  if (rate >= 90)   return 'bg-emerald-100 text-emerald-800';
  if (rate >= 70)   return 'bg-brand-100 text-brand-700';
  if (rate >= 50)   return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-700';
}

export default function Scoreboard() {
  const { user } = useAuth();
  const { currentTeam, teams } = useTeams();
  const isAdmin = user?.role === 'admin';

  // Filter: default = current team; admin může přepnout na jiný tým nebo 0 (celkem).
  const [teamId, setTeamId] = useState(null); // null = default (current team)
  const [months, setMonths] = useState(6);

  const [users, setUsers] = useState([]);
  const [history, setHistory] = useState({ series: [], months_axis: [] });
  const [teamsOverview, setTeamsOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  // Tab: 'tasks' | 'attendance'
  const [tab, setTab] = useState('tasks');
  // null = celý tým (agregát), jinak trend jednoho uživatele.
  const [selectedUserId, setSelectedUserId] = useState(null);
  const trendRef = useRef(null);
  // Drill-down modal: klik na KPI kartu → seznam úkolů dané kategorie.
  const [drilldown, setDrilldown] = useState(null); // { user, category } | null
  const [detailTask, setDetailTask] = useState(null); // klik na řádek v modalu

  // Klik na kartu → přepne trend na daného usera a odscrolluje na graf.
  const selectUser = (uid) => {
    setSelectedUserId(uid);
    // Malinké prodlení, aby chart re-renderl, než začneme scrollovat.
    setTimeout(() => trendRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };

  const effectiveTeamId = teamId; // null / 0 / concrete
  const isAllTeams = teamId === 0;

  useEffect(() => {
    setLoading(true);
    const load = async () => {
      const [snap, hist] = await Promise.all([
        // Snapshot je time-filtered stejným months jako trend → karty se přepočítají.
        scoreboardApi.list(effectiveTeamId, months).catch(() => ({ users: [] })),
        scoreboardApi.history(effectiveTeamId, months).catch(() => ({ series: [], months_axis: [] })),
      ]);
      setUsers(snap.users || []);
      setHistory(hist);
    };
    load().finally(() => setLoading(false));
  }, [effectiveTeamId, months, isAdmin, currentTeam?.id]);

  // Admin: přehled per tým — jen když je zvolen "Všechny týmy".
  useEffect(() => {
    if (!isAdmin || !isAllTeams) { setTeamsOverview(null); return; }
    scoreboardApi.teamsOverview().then(setTeamsOverview).catch(() => setTeamsOverview(null));
  }, [isAdmin, isAllTeams]);

  // Souhrn (KPI) přes všechny users v snapshot
  const totals = useMemo(() => {
    const t = { on_time: 0, late: 0, overdue: 0, in_progress: 0, done_no_deadline: 0 };
    for (const u of users) {
      t.on_time += u.done_on_time || 0;
      t.late    += u.done_late || 0;
      t.overdue += u.overdue || 0;
      t.in_progress += u.in_progress || 0;
      t.done_no_deadline += u.done_no_deadline || 0;
    }
    const denom = t.on_time + t.late + t.overdue;
    t.success_rate = denom > 0 ? Math.round((t.on_time / denom) * 100) : null;
    return t;
  }, [users]);

  // Trend chart data. Když selectedUserId != null, agregujeme jen jeho měsíce.
  // Jinak sečteme přes všechny users.
  const trendData = useMemo(() => {
    const axis = history.months_axis || [];
    const source = selectedUserId
      ? (history.series || []).filter(s => s.user_id === selectedUserId)
      : (history.series || []);
    return axis.map(ym => {
      let on = 0, late = 0;
      for (const s of source) {
        const m = s.months.find(x => x.ym === ym);
        if (m) { on += m.on_time; late += m.late; }
      }
      const total = on + late;
      return {
        ym,
        on_time: on,
        late,
        success_rate: total > 0 ? Math.round((on / total) * 100) : null,
      };
    });
  }, [history, selectedUserId]);

  const selectedUserName = selectedUserId
    ? (users.find(u => u.user_id === selectedUserId)?.name || 'Uživatel')
    : 'Celý tým';

  const scopeLabel = isAllTeams ? 'Všechny týmy' : (users[0]?.team_name || currentTeam?.name || '');

  return (
    <div>
      <PageHeader
        title="🏆 Skóre"
        subtitle={`Úspěšnost dokončování úkolů v termínu — ${scopeLabel}`}
      />

      {/* Tab lišta */}
      <div className="px-4 sm:px-6 pt-3 flex gap-2 border-b border-cream-200">
        <button onClick={() => setTab('tasks')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
            tab === 'tasks' ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-500 hover:text-ink-700'
          }`}>✅ Úkoly</button>
        <button onClick={() => setTab('attendance')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
            tab === 'attendance' ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-500 hover:text-ink-700'
          }`}>👥 Docházka</button>
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        {/* Filter */}
        <div className="flex flex-wrap items-center gap-3">
          {isAdmin && (
            <label className="text-sm text-ink-600 flex items-center gap-2">
              Tým:
              <select
                value={teamId ?? currentTeam?.id ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  setTeamId(v === '0' ? 0 : (v === '' ? null : Number(v)));
                }}
                className="border border-ink-300 rounded px-2 py-1 text-sm"
              >
                {(teams || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="0">Všechny týmy (celkem)</option>
              </select>
            </label>
          )}
          <div className="flex gap-1">
            {/* 1 měs = aktuální kalendářní měsíc (od 1. dne); ostatní = posledních N */}
            {[1, 3, 6, 12, 24].map(m => (
              <button key={m} onClick={() => setMonths(m)}
                title={m === 1 ? 'Aktuální kalendářní měsíc' : `Posledních ${m} kalendářních měsíců`}
                className={`px-2 py-1 text-xs rounded border transition ${
                  months === m ? 'bg-brand-500 text-white border-brand-500'
                               : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
                }`}>{m} měs</button>
            ))}
          </div>
        </div>

        {tab === 'attendance' ? (
          <AttendancePanel teamId={effectiveTeamId} months={months} />
        ) : loading ? (
          <div className="text-ink-500">Načítám…</div>
        ) : users.length === 0 ? (
          <div className="text-ink-400 italic">
            V tomto scope zatím není dost dat. Zadejte úkoly s termíny a skóre uvidíte.
          </div>
        ) : (
          <>
            {/* KPI karty */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi label="Včas" value={totals.on_time} color="text-emerald-700" />
              <Kpi label="Pozdě" value={totals.late} color="text-red-600" />
              <Kpi label="Po termínu (nedokončené)" value={totals.overdue} color="text-amber-700" />
              <Kpi label="Úspěšnost" value={totals.success_rate == null ? '—' : `${totals.success_rate}%`} color="text-brand-600" />
            </div>

            {/* Měsíční trend */}
            <div ref={trendRef} className="bg-white border border-cream-200 rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
                  📈 Měsíční trend — úspěšnost {selectedUserName}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-ink-500">Uživatel:</label>
                  <select
                    value={selectedUserId ?? ''}
                    onChange={e => setSelectedUserId(e.target.value ? Number(e.target.value) : null)}
                    className="text-xs border border-ink-300 rounded px-2 py-1"
                  >
                    <option value="">Celý tým</option>
                    {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
                  </select>
                  {selectedUserId != null && (
                    <button type="button" onClick={() => setSelectedUserId(null)}
                      className="text-xs text-ink-500 hover:text-ink-700 underline">reset</button>
                  )}
                </div>
              </div>
              {trendData.length === 0 ? (
                <div className="text-ink-400 text-sm italic">Žádná data.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={trendData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid stroke="#eee9e4" strokeDasharray="3 3" />
                    <XAxis dataKey="ym" tick={{ fill: '#5b7177', fontSize: 11 }} />
                    <YAxis yAxisId="rate" domain={[0, 100]} tick={{ fill: '#5b7177', fontSize: 11 }} tickFormatter={v => `${v}%`} />
                    <YAxis yAxisId="count" orientation="right" tick={{ fill: '#5b7177', fontSize: 11 }} />
                    <Tooltip
                      formatter={(v, k) => k === 'success_rate' ? `${v ?? '—'}%` : v}
                      contentStyle={{ border: '1px solid #e2dcd3', borderRadius: 6, fontSize: 12 }}
                    />
                    <Line yAxisId="rate" type="monotone" dataKey="success_rate" stroke="#e72b78" strokeWidth={2} dot />
                    <Line yAxisId="count" type="monotone" dataKey="on_time" stroke="#10b981" strokeWidth={1.5} dot={false} />
                    <Line yAxisId="count" type="monotone" dataKey="late"    stroke="#f59e0b" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
              <div className="text-[11px] text-ink-500 flex gap-3 mt-1">
                <span><span className="inline-block w-3 h-1 bg-accent-500 align-middle mr-1"></span>Úspěšnost (%)</span>
                <span><span className="inline-block w-3 h-1 bg-emerald-500 align-middle mr-1"></span>Včas (počet)</span>
                <span><span className="inline-block w-3 h-1 bg-amber-500 align-middle mr-1"></span>Pozdě (počet)</span>
              </div>
            </div>

            {/* Per user karty s vlastním sparklinem. Klik na kartu → trend; klik na KPI → drill-down. */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {users.map(u => (
                <UserCard
                  key={u.user_id}
                  u={u}
                  isMe={u.user_id === user?.id}
                  isSelected={selectedUserId === u.user_id}
                  onSelect={() => selectUser(u.user_id)}
                  onKpiClick={(category) => setDrilldown({ user: u, category })}
                  seriesMonths={history.series?.find(s => s.user_id === u.user_id)?.months || []}
                  axis={history.months_axis || []}
                />
              ))}
            </div>

            {/* Detailní žebříček */}
            <div className="bg-white border border-cream-200 rounded-xl overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead className="bg-cream-100 text-xs uppercase tracking-wide text-ink-600">
                  <tr>
                    <th className="px-3 py-2 text-left w-12">#</th>
                    <th className="px-3 py-2 text-left">Uživatel</th>
                    <th className="px-3 py-2 text-center">Úspěšnost</th>
                    <th className="px-3 py-2 text-center">✅ Včas</th>
                    <th className="px-3 py-2 text-center">⏰ Pozdě</th>
                    <th className="px-3 py-2 text-center">🔥 Po termínu</th>
                    <th className="px-3 py-2 text-center">🛠 Pracuje</th>
                    <th className="px-3 py-2 text-center">📦 Bez termínu</th>
                    <th className="px-3 py-2 text-center">Celkem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cream-100">
                  {users.map((u, i) => (
                    <tr key={u.user_id} className={i < 3 ? 'bg-amber-50/30' : (u.user_id === user?.id ? 'bg-accent-50/40' : 'hover:bg-cream-50')}>
                      <td className="px-3 py-3 text-center">
                        {i < 3 ? <span className="text-xl">{MEDAL[i]}</span> : <span className="text-ink-400">{i + 1}.</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Avatar user={{ id: u.user_id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={32} />
                          <div className="font-medium text-ink-800">{u.name}</div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-block px-3 py-1 rounded-full font-bold text-sm ${rateClass(u.success_rate)}`}>
                          {u.success_rate == null ? '—' : `${u.success_rate}%`}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center font-semibold text-emerald-700">{u.done_on_time}</td>
                      <td className="px-3 py-3 text-center font-semibold text-red-600">{u.done_late}</td>
                      <td className="px-3 py-3 text-center font-semibold text-amber-700">{u.overdue}</td>
                      <td className="px-3 py-3 text-center text-blue-600">{u.in_progress}</td>
                      <td className="px-3 py-3 text-center text-ink-500">{u.done_no_deadline}</td>
                      <td className="px-3 py-3 text-center font-medium text-ink-700">{u.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Admin: přehled per tým — jen když je zvolen "Všechny týmy" */}
            {isAdmin && isAllTeams && teamsOverview && (
              <div className="bg-white border border-cream-200 rounded-xl overflow-x-auto">
                <div className="px-4 pt-3 text-xs font-semibold text-ink-500 uppercase tracking-wide">
                  Přehled per tým
                </div>
                <table className="w-full min-w-[600px]">
                  <thead className="bg-cream-100 text-xs uppercase tracking-wide text-ink-600">
                    <tr>
                      <th className="px-3 py-2 text-left">Tým</th>
                      <th className="px-3 py-2 text-center">Úspěšnost</th>
                      <th className="px-3 py-2 text-center">✅ Včas</th>
                      <th className="px-3 py-2 text-center">⏰ Pozdě</th>
                      <th className="px-3 py-2 text-center">🔥 Po termínu</th>
                      <th className="px-3 py-2 text-center">Aktivních lidí</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cream-100">
                    {(teamsOverview.teams || []).map(t => (
                      <tr key={t.team_id}>
                        <td className="px-3 py-2 font-medium text-ink-800">{t.team_name}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded font-semibold text-xs ${rateClass(t.success_rate)}`}>
                            {t.success_rate == null ? '—' : `${t.success_rate}%`}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center text-emerald-700">{t.done_on_time}</td>
                        <td className="px-3 py-2 text-center text-red-600">{t.done_late}</td>
                        <td className="px-3 py-2 text-center text-amber-700">{t.overdue}</td>
                        <td className="px-3 py-2 text-center text-ink-500">{t.users_active}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {drilldown && (
        <TaskListModal
          user={drilldown.user}
          category={drilldown.category}
          teamId={effectiveTeamId}
          months={months}
          onClose={() => setDrilldown(null)}
          onOpenTask={async (taskId) => {
            try {
              const d = await tasksApi.get(taskId);
              setDetailTask(d.task);
            } catch { /* ignore */ }
          }}
        />
      )}
      {detailTask && (
        <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} onUpdate={() => {}} />
      )}
    </div>
  );
}

function Kpi({ label, value, color }) {
  return (
    <div className="bg-white border border-cream-200 rounded-lg p-3">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-ink-500">{label}</div>
    </div>
  );
}

// Karta per uživatel — bar (objem + úspěšnost) + sparkline trend úspěšnosti.
// Klik na kartu → nadřazený scoreboard přepne velký trend graf na tohoto usera.
// Klik na mini-KPI → nadřazený scoreboard otevře drill-down modal.
function UserCard({ u, isMe, isSelected, onSelect, onKpiClick, seriesMonths, axis }) {
  const doneAll  = (u.done_on_time || 0) + (u.done_late || 0) + (u.done_no_deadline || 0);
  const withDeadline = (u.done_on_time || 0) + (u.done_late || 0);
  const onPct   = withDeadline > 0 ? (u.done_on_time / withDeadline) * 100 : 0;
  const latePct = withDeadline > 0 ? (u.done_late    / withDeadline) * 100 : 0;

  const spark = axis.map(ym => {
    const m = seriesMonths.find(x => x.ym === ym);
    if (!m || (m.on_time + m.late) === 0) return { ym, rate: null };
    return { ym, rate: Math.round((m.on_time / (m.on_time + m.late)) * 100) };
  });

  const cardCls = isSelected
    ? 'bg-brand-50 border-brand-400 ring-2 ring-brand-300'
    : isMe
      ? 'bg-accent-50 border-accent-200 hover:border-accent-300'
      : 'bg-white border-cream-200 hover:border-cream-300';

  return (
    <div
      onClick={onSelect}
      className={`rounded-xl border p-3 cursor-pointer transition ${cardCls}`}
      title="Klik zobrazí měsíční trend tohoto uživatele nahoře"
    >
      <div className="flex items-center gap-3 mb-2">
        <Avatar user={{ id: u.user_id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={36} />
        <div className="flex-1 min-w-0">
          <div className={`font-medium truncate ${isMe ? 'text-accent-700' : 'text-ink-800'}`}>
            {u.name}{isMe && <span className="ml-1 text-[10px] text-accent-500">(já)</span>}
          </div>
          <div className="text-[11px] text-ink-500 truncate">
            Klikni pro trend →
          </div>
        </div>
        <div className={`text-lg font-bold ${
          u.success_rate == null ? 'text-ink-400'
            : u.success_rate >= 90 ? 'text-emerald-600'
            : u.success_rate >= 70 ? 'text-brand-600'
            : u.success_rate >= 50 ? 'text-amber-700'
            : 'text-red-600'
        }`}>
          {u.success_rate == null ? '—' : `${u.success_rate}%`}
        </div>
      </div>

      {/* 4 čísla: celkem / hotové / hotové po termínu (pozdě) / nehotové po termínu.
          Klikatelné — otevřou modal se seznamem úkolů. stopPropagation aby klik
          nespustil card-level onSelect (výběr trendu). */}
      <div className="grid grid-cols-4 gap-1 text-[11px] mb-2">
        <KpiTile label="celkem"   value={u.total || 0}       cls="bg-cream-50 hover:bg-cream-100 text-ink-700"
                 onClick={(e) => { e.stopPropagation(); onKpiClick?.('celkem'); }} />
        <KpiTile label="hotové"   value={doneAll}            cls="bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                 onClick={(e) => { e.stopPropagation(); onKpiClick?.('hotove'); }} />
        <KpiTile label="pozdě"    value={u.done_late || 0}   cls="bg-amber-50 hover:bg-amber-100 text-amber-700"
                 onClick={(e) => { e.stopPropagation(); onKpiClick?.('pozde'); }} />
        <KpiTile label="po term." value={u.overdue || 0}     cls="bg-red-50 hover:bg-red-100 text-red-600"
                 onClick={(e) => { e.stopPropagation(); onKpiClick?.('po_terminu'); }} />
      </div>

      {/* Bar úspěšnosti (jen dokončené úkoly s termínem — vizualizuje poměr včas/pozdě) */}
      {withDeadline > 0 && (
        <div className="h-2 bg-cream-100 rounded overflow-hidden flex mb-2">
          {onPct   > 0 && <div className="h-full bg-emerald-500" style={{ width: `${onPct}%`   }} />}
          {latePct > 0 && <div className="h-full bg-amber-500"   style={{ width: `${latePct}%` }} />}
        </div>
      )}

      {/* Sparkline trend úspěšnosti — jen když je co ukázat */}
      {spark.some(s => s.rate != null) && (
        <ResponsiveContainer width="100%" height={40}>
          <LineChart data={spark} margin={{ top: 2, right: 4, left: 0, bottom: 2 }}>
            <YAxis domain={[0, 100]} hide />
            <Line type="monotone" dataKey="rate" stroke="#e72b78" strokeWidth={1.5} dot={false} connectNulls />
            <Tooltip
              formatter={v => v == null ? '—' : `${v}%`}
              labelFormatter={l => l}
              contentStyle={{ border: '1px solid #e2dcd3', borderRadius: 6, fontSize: 11, padding: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// Malá klikatelná KPI dlaždice.
function KpiTile({ label, value, cls, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded px-1.5 py-1 text-center transition cursor-pointer ${cls}`}
      title={`Zobrazit úkoly (${label})`}>
      <div className="font-bold tabular-nums">{value}</div>
      <div className="text-[10px] opacity-70">{label}</div>
    </button>
  );
}

// Modal se seznamem úkolů jedné kategorie pro daného uživatele.
// Klik na řádek otevře plný TaskDetailModal (v Scoreboard state detailTask).
const CATEGORY_LABEL = {
  celkem:     'Všechny úkoly',
  hotove:     'Hotové úkoly',
  pozde:      'Hotové po termínu',
  po_terminu: 'Nedokončené po termínu',
};

function TaskListModal({ user, category, teamId, months, onClose, onOpenTask }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    scoreboardApi.tasks(user.user_id, category, teamId, months)
      .then(d => setTasks(d.tasks || []))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [user.user_id, category, teamId, months]);

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '—';
  const title = `${CATEGORY_LABEL[category]} — ${user.name}`;

  return (
    <Modal open={true} onClose={onClose} title={title}>
      {loading ? (
        <div className="text-ink-500 text-sm">Načítám…</div>
      ) : tasks.length === 0 ? (
        <div className="text-ink-400 text-sm italic">Žádné úkoly v této kategorii.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-500 uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 pr-3">Úkol</th>
                <th className="text-left py-2 pr-3">Projekt</th>
                <th className="text-center py-2 px-2">Termín</th>
                <th className="text-center py-2 px-2">Dokončeno</th>
                <th className="text-center py-2 pl-2">Stav</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-100">
              {tasks.map(t => (
                <tr key={t.id}
                  onClick={() => onOpenTask?.(t.id)}
                  className="cursor-pointer hover:bg-cream-50">
                  <td className="py-2 pr-3 text-ink-800">{t.title}</td>
                  <td className="py-2 pr-3 text-ink-600 text-xs">
                    {t.project_name}
                    {t.team_name && <span className="text-ink-400"> · {t.team_name}</span>}
                  </td>
                  <td className="py-2 px-2 text-center text-xs tabular-nums">{fmtDate(t.due_date)}</td>
                  <td className="py-2 px-2 text-center text-xs tabular-nums">{fmtDate(t.completed_at)}</td>
                  <td className="py-2 pl-2 text-center">
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${
                      t.status === 'done' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : t.status === 'in_progress' ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : t.status === 'needs_fix' ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : t.status === 'review' ? 'bg-purple-50 text-purple-700 border-purple-200'
                        : 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}>{t.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-ink-400 mt-2">Klikni na řádek pro plný detail úkolu.</div>
        </div>
      )}
    </Modal>
  );
}

// ==================== Docházka ====================
//
// Aggreguje meetings.attendees per user: byl / pozdě / nepřišel.
// Rate = (byl + 0.5 × pozdě) / celkem × 100. Použije stejné months + team filter.
function AttendancePanel({ teamId, months }) {
  const [data, setData] = useState({ users: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    scoreboardApi.attendance(teamId, months)
      .then(d => setData(d))
      .catch(() => setData({ users: [] }))
      .finally(() => setLoading(false));
  }, [teamId, months]);

  if (loading) return <div className="text-ink-500">Načítám…</div>;
  if (data.users.length === 0) {
    return (
      <div className="text-ink-400 italic">
        Zatím žádná data o docházce. Zaznamenej prezenci u porad — tady se pak zobrazí skóre.
      </div>
    );
  }

  const totals = data.users.reduce((acc, u) => {
    acc.present += u.present || 0;
    acc.late    += u.late || 0;
    acc.missed  += u.missed || 0;
    return acc;
  }, { present: 0, late: 0, missed: 0 });
  const denom = totals.present + totals.late + totals.missed;
  const totalRate = denom > 0 ? Math.round(100 * (totals.present + 0.5 * totals.late) / denom) : null;

  return (
    <div className="space-y-6">
      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Přítomni (včas)" value={totals.present} color="text-emerald-700" />
        <Kpi label="Pozdě" value={totals.late} color="text-amber-700" />
        <Kpi label="Nepřišli" value={totals.missed} color="text-red-600" />
        <Kpi label="Průměrná docházka" value={totalRate == null ? '—' : `${totalRate}%`} color="text-brand-600" />
      </div>

      {/* Žebříček */}
      <div className="bg-white border border-cream-200 rounded-xl overflow-x-auto">
        <table className="w-full min-w-[600px]">
          <thead className="bg-cream-100 text-xs uppercase tracking-wide text-ink-600">
            <tr>
              <th className="px-3 py-2 text-left">Uživatel</th>
              <th className="px-3 py-2 text-center">Docházka</th>
              <th className="px-3 py-2 text-center">✅ Byl</th>
              <th className="px-3 py-2 text-center">⏰ Pozdě</th>
              <th className="px-3 py-2 text-center">❌ Nepřišel</th>
              <th className="px-3 py-2 text-center">Porady</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-100">
            {data.users.map((u, i) => (
              <tr key={u.user_id} className="hover:bg-cream-50">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar user={{ id: u.user_id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={28} />
                    <div className="font-medium text-ink-800">{u.name}</div>
                  </div>
                </td>
                <td className="px-3 py-3 text-center">
                  <span className={`inline-block px-3 py-1 rounded-full font-bold text-sm ${
                    u.rate == null ? 'bg-slate-100 text-slate-500'
                      : u.rate >= 90 ? 'bg-emerald-100 text-emerald-800'
                      : u.rate >= 70 ? 'bg-brand-100 text-brand-700'
                      : u.rate >= 50 ? 'bg-amber-100 text-amber-800'
                      : 'bg-red-100 text-red-700'
                  }`}>{u.rate == null ? '—' : `${u.rate}%`}</span>
                </td>
                <td className="px-3 py-3 text-center font-semibold text-emerald-700">{u.present}</td>
                <td className="px-3 py-3 text-center font-semibold text-amber-700">{u.late}</td>
                <td className="px-3 py-3 text-center font-semibold text-red-600">{u.missed}</td>
                <td className="px-3 py-3 text-center text-ink-500">{u.meetings_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-ink-500 bg-cream-50 border border-cream-200 rounded p-3">
        <strong>Jak se počítá docházka?</strong> (byl + 0,5 × pozdě) / (byl + pozdě + nepřišel).
        Pozdní příchod je 50 % bodu. Do statistiky se počítají jen porady, kde tě někdo označil (Byl / Pozdě / Nepřišel).
      </div>
    </div>
  );
}

