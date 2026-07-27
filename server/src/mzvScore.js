// Skóre plnění úkolů jednoho uživatele + měsíční trend + seznamy úkolů per
// kategorie (pro drill-down v MZV profilu). Pro MZV profil.
//
// „V termínu" se počítá podle ČASU PŘEDÁNÍ DO REVIEW (review_submitted_at), ne
// podle pozdějšího schválení — pozdní schválení reviewerem neznamená, že úkol
// je pozdě. Fallback na completed_at u úkolů, které review workflow nepoužily.
// `delivered` = COALESCE(review_submitted_at, completed_at).
//
// Definice (drž konzistenci se Scoreboardem):
//   done_on_time: status='done' AND delivered <= due_date + 1 den
//   done_late:    status='done' AND delivered >  due_date + 1 den
//   overdue:      status<>'done' AND due_date < dnes
//   active:       status<>'done' AND (due_date IS NULL OR due_date >= dnes)  ← rozpracované
//   success_rate: done_on_time / (done_on_time + done_late + overdue) v %
//
// Samostatný modul (importuje jen db.js), aby šel testovat bez HTTP/auth vrstvy.
import { query } from './db.js';

// SQL výraz pro „kdy byl úkol reálně předán" (předání do review, jinak dokončení).
const DELIVERED = 'COALESCE(review_submitted_at, completed_at)';

export async function userScore(userId, months = 6) {
  const win = Math.min(Math.max(Number(months) || 6, 1), 24);

  const snapR = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status='done' AND due_date IS NOT NULL AND ${DELIVERED}::date <= due_date + 1) AS done_on_time,
      COUNT(*) FILTER (WHERE status='done' AND due_date IS NOT NULL AND ${DELIVERED}::date >  due_date + 1) AS done_late,
      COUNT(*) FILTER (WHERE status='done' AND due_date IS NULL)                                            AS done_no_deadline,
      COUNT(*) FILTER (WHERE status<>'done' AND due_date IS NOT NULL AND due_date < CURRENT_DATE)           AS overdue,
      COUNT(*) FILTER (WHERE status<>'done' AND (due_date IS NULL OR due_date >= CURRENT_DATE))             AS active
    FROM tasks WHERE assignee_id = $1
  `, [userId]);
  const s = snapR.rows[0];
  const onTime = Number(s.done_on_time);
  const late = Number(s.done_late);
  const overdue = Number(s.overdue);
  const base = onTime + late + overdue;
  const successRate = base > 0 ? Math.round((onTime / base) * 100) : null;

  // Měsíční trend podle completed_at (kdy úkol „padl" jako hotový), on-time dle předání.
  const trendR = await query(`
    SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS ym,
      COUNT(*) FILTER (WHERE ${DELIVERED}::date <= due_date + 1) AS on_time,
      COUNT(*) FILTER (WHERE ${DELIVERED}::date >  due_date + 1) AS late
    FROM tasks
    WHERE assignee_id = $1 AND status = 'done'
      AND completed_at IS NOT NULL AND due_date IS NOT NULL
      AND completed_at >= date_trunc('month', CURRENT_DATE) - (($2 - 1) || ' months')::interval
    GROUP BY 1
  `, [userId, win]);

  const map = new Map(trendR.rows.map(r => [r.ym, { on_time: Number(r.on_time), late: Number(r.late) }]));
  const now = new Date();
  const series = [];
  for (let i = win - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const v = map.get(ym) || { on_time: 0, late: 0 };
    const done = v.on_time + v.late;
    series.push({ ym, on_time: v.on_time, late: v.late, rate: done > 0 ? Math.round((v.on_time / done) * 100) : null });
  }

  // Seznamy úkolů per kategorie (drill-down). Kap na 100 na kategorii.
  const listR = await query(`
    SELECT t.id, t.title, t.status, t.due_date, t.completed_at, p.name AS project_name,
      CASE
        WHEN t.status='done' AND t.due_date IS NOT NULL AND COALESCE(t.review_submitted_at, t.completed_at)::date <= t.due_date + 1 THEN 'on_time'
        WHEN t.status='done' AND t.due_date IS NOT NULL AND COALESCE(t.review_submitted_at, t.completed_at)::date >  t.due_date + 1 THEN 'late'
        WHEN t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE                                              THEN 'overdue'
        WHEN t.status<>'done'                                                                                                       THEN 'active'
      END AS category
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = $1
      AND (t.status <> 'done' OR (t.status = 'done' AND t.due_date IS NOT NULL))
    ORDER BY t.due_date ASC NULLS LAST, t.id
  `, [userId]);

  const tasks = { on_time: [], late: [], overdue: [], active: [] };
  for (const r of listR.rows) {
    if (!tasks[r.category] || tasks[r.category].length >= 100) continue;
    tasks[r.category].push({
      id: r.id, title: r.title, status: r.status,
      due_date: r.due_date, completed_at: r.completed_at, project_name: r.project_name,
    });
  }

  return {
    success_rate: successRate,
    done_on_time: onTime,
    done_late: late,
    done_no_deadline: Number(s.done_no_deadline),
    overdue,
    active: Number(s.active),
    months: series,
    tasks,
  };
}
