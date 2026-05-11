import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const filters = [];
  const params = [];

  let userIdFilter = null;
  if (req.query.userId) {
    if (!can.seeAllHours(req.user) && Number(req.query.userId) !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    userIdFilter = Number(req.query.userId);
  } else if (!can.seeAllHours(req.user)) {
    userIdFilter = req.user.id;
  }

  if (userIdFilter) { params.push(userIdFilter); filters.push(`te.user_id = $${params.length}`); }
  if (req.query.projectId) { params.push(Number(req.query.projectId)); filters.push(`te.project_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); filters.push(`te.date >= $${params.length}`); }
  if (req.query.to)   { params.push(req.query.to);   filters.push(`te.date <= $${params.length}`); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const showCosts = can.seeCosts(req.user);

  const r = await query(`
    SELECT te.*, u.name AS user_name, u.hourly_rate, p.name AS project_name, t.title AS task_title
      ${showCosts ? ', (te.hours * u.hourly_rate) AS cost' : ''}
    FROM time_entries te
    JOIN users u ON u.id = te.user_id
    JOIN projects p ON p.id = te.project_id
    LEFT JOIN tasks t ON t.id = te.task_id
    ${where}
    ORDER BY te.date DESC, te.id DESC
  `, params);

  const rows = r.rows;
  if (!showCosts) rows.forEach(r => { delete r.hourly_rate; });
  res.json({ entries: rows });
});

router.post('/', requireAuth, async (req, res) => {
  const { project_id, task_id, date, hours, description } = req.body || {};
  if (!project_id || !date || !hours) return res.status(400).json({ error: 'missing_fields' });
  const r = await query(`
    INSERT INTO time_entries (user_id, project_id, task_id, date, hours, description)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [req.user.id, project_id, task_id || null, date, Number(hours), description || null]);
  res.json({ entry: r.rows[0] });
});

router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM time_entries WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.user_id !== req.user.id && !can.seeAllHours(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const next = { ...cur, ...req.body };
  const r = await query(`
    UPDATE time_entries SET project_id = $1, task_id = $2, date = $3, hours = $4, description = $5
    WHERE id = $6 RETURNING *
  `, [next.project_id, next.task_id, next.date, next.hours, next.description, id]);
  res.json({ entry: r.rows[0] });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM time_entries WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.user_id !== req.user.id && !can.seeAllHours(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await query('DELETE FROM time_entries WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
