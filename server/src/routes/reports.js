import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

router.get('/summary', requireAuth, async (req, res) => {
  if (!can.seeAllHours(req.user)) return res.status(403).json({ error: 'forbidden' });

  const { from, to, groupBy = 'project' } = req.query;
  const params = [];
  const filters = [];
  if (from) { params.push(from); filters.push(`te.date >= $${params.length}`); }
  if (to)   { params.push(to);   filters.push(`te.date <= $${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  let groupSql, labelSql;
  switch (groupBy) {
    case 'user':    groupSql = 'u.id'; labelSql = 'u.name AS label, u.id::TEXT AS key_id'; break;
    case 'project': groupSql = 'p.id'; labelSql = 'p.name AS label, p.id::TEXT AS key_id'; break;
    case 'day':     groupSql = "te.date";                          labelSql = "te.date::TEXT AS label, te.date::TEXT AS key_id"; break;
    case 'week':    groupSql = "to_char(te.date, 'IYYY-\"W\"IW')"; labelSql = "to_char(te.date, 'IYYY-\"W\"IW') AS label, to_char(te.date, 'IYYY-\"W\"IW') AS key_id"; break;
    case 'month':   groupSql = "to_char(te.date, 'YYYY-MM')";       labelSql = "to_char(te.date, 'YYYY-MM') AS label, to_char(te.date, 'YYYY-MM') AS key_id"; break;
    default: return res.status(400).json({ error: 'invalid_group_by' });
  }

  const r = await query(`
    SELECT
      ${labelSql},
      SUM(te.hours) AS hours,
      SUM(te.hours * u.hourly_rate) AS cost
    FROM time_entries te
    JOIN users u ON u.id = te.user_id
    JOIN projects p ON p.id = te.project_id
    ${where}
    GROUP BY ${groupSql}, label, key_id
    ORDER BY label ASC
  `, params);

  const totalR = await query(`
    SELECT
      COALESCE(SUM(te.hours), 0) AS total_hours,
      COALESCE(SUM(te.hours * u.hourly_rate), 0) AS total_cost
    FROM time_entries te
    JOIN users u ON u.id = te.user_id
    JOIN projects p ON p.id = te.project_id
    ${where}
  `, params);

  res.json({
    rows: r.rows.map(x => ({ ...x, hours: Number(x.hours), cost: Number(x.cost) })),
    total_hours: Number(totalR.rows[0].total_hours),
    total_cost: Number(totalR.rows[0].total_cost),
  });
});

router.get('/projects-cost', requireAuth, async (req, res) => {
  if (!can.seeCosts(req.user)) return res.status(403).json({ error: 'forbidden' });
  const r = await query(`
    SELECT
      p.id, p.name, p.budget, p.status, p.start_date, p.due_date,
      COALESCE(SUM(te.hours), 0) AS hours,
      COALESCE(SUM(te.hours * u.hourly_rate), 0) AS cost
    FROM projects p
    LEFT JOIN time_entries te ON te.project_id = p.id
    LEFT JOIN users u ON u.id = te.user_id
    GROUP BY p.id
    ORDER BY p.due_date ASC
  `);
  res.json({ rows: r.rows.map(x => ({ ...x, hours: Number(x.hours), cost: Number(x.cost) })) });
});

router.get('/who-works-on-what', requireAuth, async (req, res) => {
  const r = await query(`
    SELECT u.id AS user_id, u.name AS user_name, u.role,
           t.id AS task_id, t.title, t.status, t.priority, t.due_date,
           p.id AS project_id, p.name AS project_name
    FROM users u
    LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status IN ('todo', 'in_progress', 'review')
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE u.active = TRUE
    ORDER BY u.name,
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      t.due_date ASC
  `);

  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.user_id)) {
      map.set(row.user_id, { user_id: row.user_id, user_name: row.user_name, role: row.role, tasks: [] });
    }
    if (row.task_id) {
      map.get(row.user_id).tasks.push({
        id: row.task_id, title: row.title, status: row.status, priority: row.priority, due_date: row.due_date,
        project_id: row.project_id, project_name: row.project_name,
      });
    }
  }
  res.json({ workers: Array.from(map.values()) });
});

router.get('/who-completed-what', requireAuth, async (req, res) => {
  const days = Number(req.query.days) || 14;
  const r = await query(`
    SELECT u.id AS user_id, u.name AS user_name, u.role,
           t.id AS task_id, t.title, t.priority, t.due_date, t.created_at,
           p.id AS project_id, p.name AS project_name
    FROM users u
    JOIN tasks t ON t.assignee_id = u.id AND t.status = 'done'
    JOIN projects p ON p.id = t.project_id
    WHERE u.active = TRUE
      AND t.created_at >= NOW() - ($1 || ' days')::INTERVAL
    ORDER BY u.name, t.created_at DESC
  `, [String(days)]);

  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.user_id)) {
      map.set(row.user_id, { user_id: row.user_id, user_name: row.user_name, role: row.role, tasks: [] });
    }
    map.get(row.user_id).tasks.push({
      id: row.task_id, title: row.title, priority: row.priority, due_date: row.due_date, created_at: row.created_at,
      project_id: row.project_id, project_name: row.project_name,
    });
  }
  res.json({ done_by: Array.from(map.values()) });
});

export default router;
