// Scoreboard — per-user statistika dokončování úkolů.
//
// Endpointy:
//   GET /api/scoreboard[?team_id=N]
//     → { users: [{ user_id, name, avatar_updated_at, team_id, team_name,
//                   total, done_on_time, done_late, done_no_deadline,
//                   overdue, in_progress, success_rate, last_completed_at }] }
//     Default: req.team_id (současný tým). Admin může přepnout team_id nebo
//     poslat team_id=0 pro všechny týmy (agregace přes uživatele).
//
//   GET /api/scoreboard/history?months=6[&team_id=N]
//     → { series: [{ user_id, name, months: [{ ym: 'YYYY-MM', on_time, late }] }],
//         months_axis: ['YYYY-MM', ...] }
//     Trend měsíčně dle completed_at. Admin může team_id=0.
//
//   GET /api/scoreboard/teams-overview  (admin only)
//     → { teams: [{ team_id, team_name, users_active, done_on_time, done_late,
//                   overdue, success_rate }], total: {...} }
//
// Definice (jako dřív):
//   - done_on_time: status='done' AND completed_at <= due_date + 1d
//   - done_late:    status='done' AND completed_at >  due_date + 1d
//   - done_no_deadline: status='done' AND due_date IS NULL
//   - overdue:      status!='done' AND due_date < CURRENT_DATE
//   - in_progress:  status!='done' AND (due_date IS NULL OR due_date >= CURRENT_DATE)
//   - success_rate: done_on_time / (done_on_time + done_late + overdue) v %

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

// Vypočítá start date pro time filter. months=1 = aktuální kalendářní měsíc
// (od 1. dne měsíce). months=N>1 = 1. den měsíce před (N-1) měsíci. null = bez filtru.
function resolveStartDate(months) {
  if (!months) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  if (months > 1) d.setMonth(d.getMonth() - (months - 1));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Vyhodnoť team scope pro request. Admin může poslat team_id=0 (=všechny týmy).
// Non-admin je omezen na svůj req.team_id — pokud pošle jiný, 403.
async function resolveTeamScope(req) {
  const isAdmin = req.user.role === 'admin';
  const requested = req.query.team_id != null ? Number(req.query.team_id) : null;
  if (requested === 0 && isAdmin) return { mode: 'all' };
  const tid = requested ?? req.team_id;
  if (!tid) return { mode: 'none' };
  if (!isAdmin && tid !== req.team_id) return { mode: 'forbidden' };
  return { mode: 'team', teamId: tid };
}

// Aktuální snapshot — hlavní tabulka Scoreboardu.
router.get('/', requireAuth, async (req, res) => {
  const scope = await resolveTeamScope(req);
  if (scope.mode === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (scope.mode === 'none') return res.json({ users: [] });

  // team_id filter: buď WHERE p.team_id = $X, nebo prázdné (všechny týmy).
  // Kdo přispěje do team_users: v scope=all bereme unikátní assignee_id
  // v projektech všech týmů; v scope=team jen členové daného týmu.
  const params = [];
  let teamFilter = '';
  let teamUsersCTE;

  if (scope.mode === 'team') {
    params.push(scope.teamId);
    teamFilter = `AND p.team_id = $1`;
    teamUsersCTE = `
      team_users AS (
        SELECT u.id, u.name, u.avatar_updated_at,
               $1::int AS team_id, tt.name AS team_name
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id
        JOIN teams tt ON tt.id = tm.team_id
        WHERE tm.team_id = $1 AND u.active = TRUE
      )
    `;
  } else {
    // scope=all: unikátní assignee napříč VŠEMI projekty; team_id nemá smysl
    // (uživatel patří do víc týmů), vypíšeme primární tým dle prvního membershipu.
    teamUsersCTE = `
      team_users AS (
        SELECT DISTINCT u.id, u.name, u.avatar_updated_at,
               NULL::int AS team_id, NULL::text AS team_name
        FROM users u
        WHERE u.active = TRUE
          AND EXISTS (SELECT 1 FROM tasks t2 WHERE t2.assignee_id = u.id)
      )
    `;
  }

  // Time filter (volitelný): úkoly relevantní pro dané období = dokončené v období
  // NEBO měly deadline v období NEBO jsou aktuálně otevřené (relevant kontext).
  const months = req.query.months ? Number(req.query.months) : null;
  const startDate = resolveStartDate(months);
  let timeFilter = '';
  if (startDate) {
    params.push(startDate);
    const p = `$${params.length}::date`;
    timeFilter = `AND (
      (t.completed_at IS NOT NULL AND t.completed_at >= ${p})
      OR (t.due_date IS NOT NULL AND t.due_date >= ${p})
      OR (t.status != 'done')
    )`;
  }

  const sql = `
    WITH ${teamUsersCTE},
    user_tasks AS (
      SELECT t.id, t.assignee_id, t.status, t.due_date, t.completed_at
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id IS NOT NULL ${teamFilter} ${timeFilter}
    ),
    stats AS (
      SELECT
        ut.assignee_id AS user_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ut.status = 'done' AND ut.due_date IS NOT NULL AND ut.completed_at <= (ut.due_date + INTERVAL '1 day'))::int AS done_on_time,
        COUNT(*) FILTER (WHERE ut.status = 'done' AND ut.due_date IS NOT NULL AND ut.completed_at >  (ut.due_date + INTERVAL '1 day'))::int AS done_late,
        COUNT(*) FILTER (WHERE ut.status = 'done' AND ut.due_date IS NULL)::int AS done_no_deadline,
        COUNT(*) FILTER (WHERE ut.status != 'done' AND ut.due_date IS NOT NULL AND ut.due_date < CURRENT_DATE)::int AS overdue,
        COUNT(*) FILTER (WHERE ut.status != 'done' AND (ut.due_date IS NULL OR ut.due_date >= CURRENT_DATE))::int AS in_progress,
        MAX(ut.completed_at) FILTER (WHERE ut.status = 'done') AS last_completed_at
      FROM user_tasks ut
      GROUP BY ut.assignee_id
    )
    SELECT
      tu.id AS user_id, tu.name, tu.avatar_updated_at, tu.team_id, tu.team_name,
      COALESCE(s.total, 0)            AS total,
      COALESCE(s.done_on_time, 0)     AS done_on_time,
      COALESCE(s.done_late, 0)        AS done_late,
      COALESCE(s.done_no_deadline, 0) AS done_no_deadline,
      COALESCE(s.overdue, 0)          AS overdue,
      COALESCE(s.in_progress, 0)      AS in_progress,
      s.last_completed_at,
      CASE
        WHEN COALESCE(s.done_on_time, 0) + COALESCE(s.done_late, 0) + COALESCE(s.overdue, 0) = 0 THEN NULL
        ELSE ROUND(
          100.0 * COALESCE(s.done_on_time, 0) /
          (COALESCE(s.done_on_time, 0) + COALESCE(s.done_late, 0) + COALESCE(s.overdue, 0))
        )::int
      END AS success_rate
    FROM team_users tu
    LEFT JOIN stats s ON s.user_id = tu.id
    ORDER BY
      success_rate DESC NULLS LAST,
      COALESCE(s.done_on_time, 0) DESC,
      tu.name ASC
  `;
  const r = await query(sql, params);
  res.json({ users: r.rows });
});

// Historie: měsíční per user (on_time / late) za posledních N měsíců.
router.get('/history', requireAuth, async (req, res) => {
  const scope = await resolveTeamScope(req);
  if (scope.mode === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (scope.mode === 'none') return res.json({ series: [], months_axis: [] });

  // Rozšíření: months=1 = aktuální kalendářní měsíc. Ostatní = posledních N.
  const months = Math.max(1, Math.min(24, Number(req.query.months) || 6));

  const params = [months];
  let teamFilter = '';
  if (scope.mode === 'team') {
    params.push(scope.teamId);
    teamFilter = `AND p.team_id = $2`;
  }

  const sql = `
    WITH month_series AS (
      SELECT to_char(date_trunc('month', CURRENT_DATE) - (i || ' months')::interval, 'YYYY-MM') AS ym
      FROM generate_series(0, $1 - 1) AS i
    ),
    completed AS (
      SELECT t.assignee_id AS user_id, u.name,
             to_char(date_trunc('month', t.completed_at), 'YYYY-MM') AS ym,
             (t.due_date IS NOT NULL AND t.completed_at <= (t.due_date + INTERVAL '1 day')) AS on_time
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      JOIN users u ON u.id = t.assignee_id
      WHERE t.status = 'done'
        AND t.completed_at >= date_trunc('month', CURRENT_DATE) - ($1 || ' months')::interval
        ${teamFilter}
    )
    SELECT c.user_id, c.name, c.ym,
      COUNT(*) FILTER (WHERE c.on_time)::int AS on_time,
      COUNT(*) FILTER (WHERE NOT c.on_time)::int AS late
    FROM completed c
    GROUP BY c.user_id, c.name, c.ym
    ORDER BY c.name, c.ym
  `;
  const [rowsR, axisR] = await Promise.all([
    query(sql, params),
    query(`
      SELECT to_char(date_trunc('month', CURRENT_DATE) - (i || ' months')::interval, 'YYYY-MM') AS ym
      FROM generate_series($1 - 1, 0, -1) AS i
    `, [months]),
  ]);

  // Regrouping: user_id → months array
  const byUser = new Map();
  for (const row of rowsR.rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, { user_id: row.user_id, name: row.name, months: [] });
    byUser.get(row.user_id).months.push({ ym: row.ym, on_time: row.on_time, late: row.late });
  }
  res.json({
    series: Array.from(byUser.values()),
    months_axis: axisR.rows.map(r => r.ym),
  });
});

// Drill-down: seznam konkrétních úkolů pro daného usera + kategorii.
// Volaný z klikatelných KPI karet ve Scoreboardu.
// Kategorie:
//   celkem      — všechny přiřazené úkoly
//   hotove      — status='done' (všechny včas + pozdě + bez termínu)
//   pozde       — status='done' AND completed_at > due_date+1d
//   po_terminu  — status!='done' AND due_date < CURRENT_DATE
router.get('/tasks', requireAuth, async (req, res) => {
  const userId = Number(req.query.user_id);
  const category = String(req.query.category || 'celkem');
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'invalid_user_id' });
  if (!['celkem', 'hotove', 'pozde', 'po_terminu'].includes(category)) return res.status(400).json({ error: 'invalid_category' });

  const scope = await resolveTeamScope(req);
  if (scope.mode === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (scope.mode === 'none') return res.json({ tasks: [] });

  const params = [userId];
  let teamFilter = '';
  if (scope.mode === 'team') {
    params.push(scope.teamId);
    teamFilter = `AND p.team_id = $${params.length}`;
  }

  let statusFilter = '';
  if (category === 'hotove') {
    statusFilter = `AND t.status = 'done'`;
  } else if (category === 'pozde') {
    statusFilter = `AND t.status = 'done' AND t.due_date IS NOT NULL AND t.completed_at > (t.due_date + INTERVAL '1 day')`;
  } else if (category === 'po_terminu') {
    statusFilter = `AND t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE`;
  }

  // Time filter dle months — konzistentní s hlavním /scoreboard.
  const months = req.query.months ? Number(req.query.months) : null;
  const startDate = resolveStartDate(months);
  let timeFilter = '';
  if (startDate) {
    params.push(startDate);
    const p = `$${params.length}::date`;
    timeFilter = `AND (
      (t.completed_at IS NOT NULL AND t.completed_at >= ${p})
      OR (t.due_date IS NOT NULL AND t.due_date >= ${p})
      OR (t.status != 'done')
    )`;
  }

  const r = await query(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.completed_at,
           p.id AS project_id, p.name AS project_name, p.team_id, tm.name AS team_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN teams tm ON tm.id = p.team_id
    WHERE t.assignee_id = $1 ${teamFilter} ${statusFilter} ${timeFilter}
    ORDER BY
      CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
      t.due_date ASC NULLS LAST,
      t.id
  `, params);
  res.json({ tasks: r.rows });
});

// Score docházky — aggreguje meetings.attendees per user (byl / pozdě / nepřišel).
// Rate = (present + 0.5 × late) / (present + late + missed) × 100.
// Zpětná kompatibilita: staré záznamy s present: true → 'present', false → 'missed'.
router.get('/attendance', requireAuth, async (req, res) => {
  const scope = await resolveTeamScope(req);
  if (scope.mode === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (scope.mode === 'none') return res.json({ users: [] });

  const months = req.query.months ? Number(req.query.months) : null;
  const startDate = resolveStartDate(months);

  const params = [];
  let teamFilter = '';
  if (scope.mode === 'team') {
    params.push(scope.teamId);
    teamFilter = `AND t.team_id = $${params.length}`;
  }
  let dateFilter = '';
  if (startDate) {
    params.push(startDate);
    dateFilter = `AND m.meeting_date >= $${params.length}::date`;
  }

  // Defenzivně: pokud tabulka meetings neexistuje, vrátíme prázdno.
  try {
    // Rozvineme attendees JSONB pole a group by user_id.
    // Backward-compat: status IS NULL a present::boolean = TRUE → 'present';
    // status IS NULL a present::boolean = FALSE → 'missed'.
    const r = await query(`
      WITH att AS (
        SELECT
          (a->>'user_id')::int AS user_id,
          COALESCE(
            a->>'status',
            CASE WHEN (a->>'present')::boolean = TRUE THEN 'present'
                 WHEN (a->>'present')::boolean = FALSE THEN 'missed'
                 ELSE NULL END
          ) AS status,
          m.id AS meeting_id
        FROM meetings m
        JOIN meeting_types t ON t.id = m.type_id
        CROSS JOIN LATERAL jsonb_array_elements(m.attendees) a
        WHERE (a->>'user_id') IS NOT NULL
          ${teamFilter} ${dateFilter}
      ),
      stats AS (
        SELECT user_id,
          COUNT(*) FILTER (WHERE status = 'present')::int AS present,
          COUNT(*) FILTER (WHERE status = 'late')::int    AS late,
          COUNT(*) FILTER (WHERE status = 'missed')::int  AS missed,
          COUNT(*) FILTER (WHERE status = 'excused')::int AS excused,
          COUNT(DISTINCT meeting_id)::int                 AS meetings_count
        FROM att
        WHERE status IS NOT NULL
        GROUP BY user_id
      )
      SELECT s.user_id, u.name, u.avatar_updated_at,
        s.present, s.late, s.missed, s.excused, s.meetings_count,
        (s.present + s.late + s.missed) AS total,
        CASE
          WHEN (s.present + s.late + s.missed) = 0 THEN NULL
          ELSE ROUND(100.0 * (s.present + 0.5 * s.late) / (s.present + s.late + s.missed))::int
        END AS rate
      FROM stats s
      JOIN users u ON u.id = s.user_id
      ORDER BY rate DESC NULLS LAST, s.present DESC, u.name ASC
    `, params);
    res.json({ users: r.rows });
  } catch (err) {
    if (err.code === '42P01') return res.json({ users: [] });
    throw err;
  }
});

// Přehled per tým — jen admin.
router.get('/teams-overview', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const r = await query(`
    WITH tasks_by_team AS (
      SELECT p.team_id, t.status, t.due_date, t.completed_at, t.assignee_id
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id IS NOT NULL
    ),
    per_team AS (
      SELECT tb.team_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE tb.status = 'done' AND tb.due_date IS NOT NULL AND tb.completed_at <= (tb.due_date + INTERVAL '1 day'))::int AS done_on_time,
        COUNT(*) FILTER (WHERE tb.status = 'done' AND tb.due_date IS NOT NULL AND tb.completed_at >  (tb.due_date + INTERVAL '1 day'))::int AS done_late,
        COUNT(*) FILTER (WHERE tb.status != 'done' AND tb.due_date IS NOT NULL AND tb.due_date < CURRENT_DATE)::int AS overdue,
        COUNT(DISTINCT tb.assignee_id)::int AS users_active
      FROM tasks_by_team tb
      GROUP BY tb.team_id
    )
    SELECT tt.id AS team_id, tt.name AS team_name,
      COALESCE(pt.users_active, 0)  AS users_active,
      COALESCE(pt.done_on_time, 0)  AS done_on_time,
      COALESCE(pt.done_late, 0)     AS done_late,
      COALESCE(pt.overdue, 0)       AS overdue,
      CASE
        WHEN COALESCE(pt.done_on_time, 0) + COALESCE(pt.done_late, 0) + COALESCE(pt.overdue, 0) = 0 THEN NULL
        ELSE ROUND(100.0 * pt.done_on_time / (pt.done_on_time + pt.done_late + pt.overdue))::int
      END AS success_rate
    FROM teams tt
    LEFT JOIN per_team pt ON pt.team_id = tt.id
    ORDER BY tt.name ASC
  `);
  res.json({ teams: r.rows });
});

export default router;
