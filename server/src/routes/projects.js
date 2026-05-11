import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

// Seznam projektů s agregacemi
router.get('/', requireAuth, async (req, res) => {
  const showCosts = can.seeCosts(req.user);
  const r = await query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.project_id = p.id) AS hours_logged,
      (SELECT COALESCE(SUM(te.hours * u.hourly_rate), 0)
         FROM time_entries te JOIN users u ON u.id = te.user_id
         WHERE te.project_id = p.id) AS cost_so_far,
      mu.name AS manager_name
    FROM projects p
    LEFT JOIN users mu ON mu.id = p.manager_id
    ORDER BY p.due_date ASC
  `);
  const projects = r.rows;
  if (!showCosts) projects.forEach(p => { delete p.cost_so_far; delete p.budget; });
  res.json({ projects });
});

// Detail + úkoly
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const pR = await query(`
    SELECT p.*, mu.name AS manager_name
    FROM projects p LEFT JOIN users mu ON mu.id = p.manager_id
    WHERE p.id = $1
  `, [id]);
  const project = pR.rows[0];
  if (!project) return res.status(404).json({ error: 'not_found' });

  const tR = await query(`
    SELECT t.*,
      u.name AS assignee_name,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = $1
    ORDER BY COALESCE(t.parent_id, t.id), t.id
  `, [id]);

  if (!can.seeCosts(req.user)) { delete project.budget; }
  res.json({ project, tasks: tR.rows });
});

// Vytvoření – admin/manager
router.post('/', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  const { name, description, client, start_date, due_date, manager_id, budget } = req.body || {};
  if (!name || !start_date || !due_date) return res.status(400).json({ error: 'missing_fields' });
  const r = await query(`
    INSERT INTO projects (name, description, client, start_date, due_date, manager_id, budget)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [name, description || null, client || null, start_date, due_date, manager_id || req.user.id, budget || null]);
  res.json({ project: r.rows[0] });
});

// Edit – admin/manager
router.put('/:id', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM projects WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const next = { ...cur, ...req.body };
  const r = await query(`
    UPDATE projects SET
      name = $1, description = $2, client = $3, start_date = $4, due_date = $5,
      status = $6, manager_id = $7, budget = $8
    WHERE id = $9
    RETURNING *
  `, [next.name, next.description, next.client, next.start_date, next.due_date,
      next.status, next.manager_id, next.budget, id]);
  res.json({ project: r.rows[0] });
});

// Smazání – admin/manager
router.delete('/:id', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  await query('DELETE FROM projects WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

export default router;
