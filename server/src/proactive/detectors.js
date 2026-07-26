// Proaktivní detektory — rule-based signály nad úkoly/hodinami týmu.
//
// Záměrně BEZ AI: levné, deterministické SQL, snadno testovatelné. Každý
// detektor vrací pole "signálů" s odkazem na konkrétní úkol/uživatele —
// to je grounding, ze kterého pozdější AI vrstva (fáze 2) napíše lidský
// souhrn. Bez signálů se AI vůbec nevolá (šetří tokeny i pozornost).
//
// Vše je team-scoped přes projects.team_id — funguje pro libovolný tým,
// ne jen IT. Dotazy jsou parametrizované.
//
// Signál (jednotný tvar):
//   { type, severity: 'high'|'medium'|'low', team_id,
//     task_id?, project_id?, project_name?, title?,
//     user_id?, user_name?, meta: {...}, label }
// `label` je krátký faktický popis česky (použitelný i bez AI).

import { query } from '../db.js';

// Aktivní = ještě není dokončený (řešitel na něm může/má pracovat).
const ACTIVE_STATUSES = ['todo', 'in_progress', 'review', 'needs_fix'];

// ── 1) Skluz: úkoly po termínu, ještě nedokončené ─────────────────────────
export async function overdueTasks(teamId) {
  const r = await query(
    `SELECT t.id, t.title, t.project_id, p.name AS project_name,
            t.assignee_id, u.name AS assignee_name,
            t.due_date, (CURRENT_DATE - t.due_date) AS days_overdue
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE p.team_id = $1
        AND t.due_date IS NOT NULL
        AND t.due_date < CURRENT_DATE
        AND t.status <> 'done'
      ORDER BY t.due_date ASC`,
    [teamId]
  );
  return r.rows.map((x) => ({
    type: 'overdue',
    severity: x.days_overdue >= 7 ? 'high' : x.days_overdue >= 2 ? 'medium' : 'low',
    team_id: teamId,
    task_id: x.id,
    project_id: x.project_id,
    project_name: x.project_name,
    title: x.title,
    user_id: x.assignee_id,
    user_name: x.assignee_name,
    meta: { due_date: x.due_date, days_overdue: x.days_overdue },
    label: `„${x.title}" je ${x.days_overdue} dní po termínu (${x.project_name}).`,
  }));
}

// ── 2) Blížící se deadline: termín do `days` dní, nedokončené ──────────────
export async function upcomingDeadlines(teamId, days = 3) {
  const r = await query(
    `SELECT t.id, t.title, t.project_id, p.name AS project_name,
            t.assignee_id, u.name AS assignee_name,
            t.due_date, (t.due_date - CURRENT_DATE) AS days_left
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE p.team_id = $1
        AND t.due_date IS NOT NULL
        AND t.due_date >= CURRENT_DATE
        AND t.due_date <= CURRENT_DATE + ($2 || ' days')::interval
        AND t.status <> 'done'
      ORDER BY t.due_date ASC`,
    [teamId, days]
  );
  return r.rows.map((x) => ({
    type: 'upcoming_deadline',
    severity: x.days_left <= 1 ? 'high' : 'medium',
    team_id: teamId,
    task_id: x.id,
    project_id: x.project_id,
    project_name: x.project_name,
    title: x.title,
    user_id: x.assignee_id,
    user_name: x.assignee_name,
    meta: { due_date: x.due_date, days_left: x.days_left },
    label: `„${x.title}" má termín za ${x.days_left} dní (${x.project_name}).`,
  }));
}

// ── 3) Úkol bez pohybu: aktivní, ale žádná aktivita déle než `days` dní ────
// "Poslední pohyb" = nejnovější z: založení úkolu, poslední zápis hodin,
// poslední review. tasks nemá vlastní updated_at, tak ho skládáme.
export async function stalledTasks(teamId, days = 7) {
  const r = await query(
    `SELECT t.id, t.title, t.project_id, p.name AS project_name,
            t.assignee_id, u.name AS assignee_name,
            GREATEST(
              t.created_at,
              COALESCE((SELECT MAX(te.date)::timestamptz FROM time_entries te WHERE te.task_id = t.id), t.created_at),
              COALESCE((SELECT MAX(tr.created_at) FROM task_reviews tr WHERE tr.task_id = t.id), t.created_at)
            ) AS last_activity
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE p.team_id = $1
        AND t.status = ANY($2)
      ORDER BY last_activity ASC`,
    [teamId, ACTIVE_STATUSES]
  );
  const cutoffMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return r.rows
    .filter((x) => now - new Date(x.last_activity).getTime() >= cutoffMs)
    .map((x) => {
      const idleDays = Math.floor((now - new Date(x.last_activity).getTime()) / 86400000);
      return {
        type: 'stalled',
        severity: idleDays >= 21 ? 'high' : idleDays >= 14 ? 'medium' : 'low',
        team_id: teamId,
        task_id: x.id,
        project_id: x.project_id,
        project_name: x.project_name,
        title: x.title,
        user_id: x.assignee_id,
        user_name: x.assignee_name,
        meta: { last_activity: x.last_activity, idle_days: idleDays },
        label: `„${x.title}" se nehnul ${idleDays} dní (${x.project_name}).`,
      };
    });
}

// ── 4) Nezapsané hodiny: řešitel aktivních úkolů bez zápisu za `days` dní ──
export async function unloggedHours(teamId, days = 7) {
  const r = await query(
    `SELECT DISTINCT u.id AS user_id, u.name AS user_name,
            COUNT(t.id) OVER (PARTITION BY u.id) AS active_tasks
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN users u ON u.id = t.assignee_id
      WHERE p.team_id = $1
        AND t.status = ANY($2)
        AND u.active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM time_entries te
           WHERE te.user_id = u.id
             AND te.date >= (CURRENT_DATE - ($3 || ' days')::interval)
        )
      ORDER BY u.name`,
    [teamId, ACTIVE_STATUSES, days]
  );
  return r.rows.map((x) => ({
    type: 'unlogged_hours',
    severity: 'medium',
    team_id: teamId,
    user_id: x.user_id,
    user_name: x.user_name,
    meta: { active_tasks: Number(x.active_tasks), days },
    label: `${x.user_name} nemá ${days} dní zapsané žádné hodiny, přitom má ${x.active_tasks} aktivních úkolů.`,
  }));
}

// ── 5) Efektivita: dokončené úkoly, kde realita výrazně přerostla odhad ────
// factor = kolikrát smí actual přesáhnout estimate, než to hlásíme (1.5 = +50 %).
// windowDays = jen nedávno dokončené, ať je to akční.
export async function estimateOverruns(teamId, factor = 1.5, windowDays = 30) {
  const r = await query(
    `SELECT t.id, t.title, t.project_id, p.name AS project_name,
            t.assignee_id, u.name AS assignee_name,
            t.estimated_h, t.actual_h,
            ROUND((t.actual_h / NULLIF(t.estimated_h, 0))::numeric, 2) AS ratio
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE p.team_id = $1
        AND t.status = 'done'
        AND t.estimated_h IS NOT NULL AND t.estimated_h > 0
        AND t.actual_h IS NOT NULL
        AND t.actual_h >= t.estimated_h * $2
        AND t.completed_at IS NOT NULL
        AND t.completed_at >= NOW() - ($3 || ' days')::interval
      ORDER BY ratio DESC`,
    [teamId, factor, windowDays]
  );
  return r.rows.map((x) => ({
    type: 'estimate_overrun',
    severity: Number(x.ratio) >= 2 ? 'high' : 'medium',
    team_id: teamId,
    task_id: x.id,
    project_id: x.project_id,
    project_name: x.project_name,
    title: x.title,
    user_id: x.assignee_id,
    user_name: x.assignee_name,
    meta: { estimated_h: x.estimated_h, actual_h: x.actual_h, ratio: Number(x.ratio) },
    label: `„${x.title}" trval ${x.actual_h} h oproti odhadu ${x.estimated_h} h (${x.ratio}×).`,
  }));
}

// Spustí všechny detektory pro tým a vrátí ploché pole signálů.
// Volitelně přepiš prahy přes `opts` (dny, factor). AI vrstva pak dostane
// jen tohle — když je pole prázdné, nevolá se vůbec.
export async function detectAll(teamId, opts = {}) {
  const [overdue, upcoming, stalled, unlogged, overruns] = await Promise.all([
    overdueTasks(teamId),
    upcomingDeadlines(teamId, opts.upcomingDays ?? 3),
    stalledTasks(teamId, opts.stalledDays ?? 7),
    unloggedHours(teamId, opts.unloggedDays ?? 7),
    estimateOverruns(teamId, opts.overrunFactor ?? 1.5, opts.overrunWindowDays ?? 30),
  ]);
  return [...overdue, ...upcoming, ...stalled, ...unlogged, ...overruns];
}
