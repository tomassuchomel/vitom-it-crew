// Scoreboard — per-user statistika dokončování úkolů v rámci current teamu.
// Visible všem členům teamu (gamifikace), čte se podle req.team_id.
//
// Endpoint:
//   GET /api/scoreboard
//   → { users: [{ user_id, name, avatar_updated_at,
//                 total, done_on_time, done_late, done_no_deadline,
//                 overdue, in_progress, success_rate, last_completed_at }] }
//
// Definice:
//   - total: počet úkolů přiřazených uživateli v projektech daného teamu (všechny statuses)
//   - done_on_time: status='done' a completed_at <= due_date
//   - done_late: status='done' a completed_at > due_date
//   - done_no_deadline: status='done' a due_date IS NULL
//   - overdue: status != 'done' a due_date < NOW()
//   - in_progress: status != 'done' a (due_date IS NULL OR due_date >= NOW())
//   - success_rate: done_on_time / (done_on_time + done_late + overdue) v %.
//     Nulový rate když user nemá žádný úkol s deadlinem.
//   - last_completed_at: kdy uživatel naposled něco dokončil (sortable)

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  if (!req.team_id) return res.json({ users: [] });

  const r = await query(`
    WITH team_users AS (
      SELECT u.id, u.name, u.avatar_updated_at, tm.team_role
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND u.active = TRUE
    ),
    user_tasks AS (
      SELECT t.id, t.assignee_id, t.status, t.due_date, t.completed_at
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE p.team_id = $1 AND t.assignee_id IS NOT NULL
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
      tu.id AS user_id,
      tu.name,
      tu.avatar_updated_at,
      tu.team_role,
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
      -- 1) ti s vyšším success_rate jdou nahoru (NULL na konec)
      success_rate DESC NULLS LAST,
      -- 2) tiebreak: víc dokončených on_time
      COALESCE(s.done_on_time, 0) DESC,
      -- 3) abecedně
      tu.name ASC
  `, [req.team_id]);

  res.json({ users: r.rows });
});

export default router;
