// Skóre plnění úkolů jednoho uživatele + měsíční trend — pro MZV profil.
//
// Definice jako Scoreboard (drž konzistenci):
//   done_on_time: status='done' AND completed_at <= due_date + 1 den
//   done_late:    status='done' AND completed_at >  due_date + 1 den
//   overdue:      status<>'done' AND due_date < dnes
//   success_rate: done_on_time / (done_on_time + done_late + overdue) v %
//
// Samostatný modul (importuje jen db.js), aby šel testovat bez HTTP/auth vrstvy.
import { query } from './db.js';

export async function userScore(userId, months = 6) {
  const win = Math.min(Math.max(Number(months) || 6, 1), 24);

  const snapR = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status='done' AND due_date IS NOT NULL AND completed_at::date <= due_date + 1) AS done_on_time,
      COUNT(*) FILTER (WHERE status='done' AND due_date IS NOT NULL AND completed_at::date >  due_date + 1) AS done_late,
      COUNT(*) FILTER (WHERE status='done' AND due_date IS NULL)                                            AS done_no_deadline,
      COUNT(*) FILTER (WHERE status<>'done' AND due_date IS NOT NULL AND due_date < CURRENT_DATE)           AS overdue
    FROM tasks WHERE assignee_id = $1
  `, [userId]);
  const s = snapR.rows[0];
  const onTime = Number(s.done_on_time);
  const late = Number(s.done_late);
  const overdue = Number(s.overdue);
  const base = onTime + late + overdue;
  const successRate = base > 0 ? Math.round((onTime / base) * 100) : null;

  // Měsíční trend podle completed_at (jen dokončené s termínem).
  const trendR = await query(`
    SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS ym,
      COUNT(*) FILTER (WHERE completed_at::date <= due_date + 1) AS on_time,
      COUNT(*) FILTER (WHERE completed_at::date >  due_date + 1) AS late
    FROM tasks
    WHERE assignee_id = $1 AND status = 'done'
      AND completed_at IS NOT NULL AND due_date IS NOT NULL
      AND completed_at >= date_trunc('month', CURRENT_DATE) - (($2 - 1) || ' months')::interval
    GROUP BY 1
  `, [userId, win]);

  // Doplň chybějící měsíce nulami → souvislá řada `win` měsíců (nejstarší → nejnovější).
  const map = new Map(trendR.rows.map(r => [r.ym, { on_time: Number(r.on_time), late: Number(r.late) }]));
  const now = new Date();
  const series = [];
  for (let i = win - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const v = map.get(ym) || { on_time: 0, late: 0 };
    const done = v.on_time + v.late;
    series.push({
      ym,
      on_time: v.on_time,
      late: v.late,
      rate: done > 0 ? Math.round((v.on_time / done) * 100) : null,
    });
  }

  return {
    success_rate: successRate,
    done_on_time: onTime,
    done_late: late,
    done_no_deadline: Number(s.done_no_deadline),
    overdue,
    months: series,
  };
}
