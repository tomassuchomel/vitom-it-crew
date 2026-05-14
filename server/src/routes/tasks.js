import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';
import { estimateTask, HAS_AI } from '../ai.js';

const router = Router();

// Spustí AI odhad na pozadí, výsledek uloží do tasks.
// Fire-and-forget – nikdy nehází chybu nahoru.
function kickoffAIEstimate(task) {
  if (!HAS_AI) return;
  // Označíme status jako pending, ať frontend ví, že běží
  query(`UPDATE tasks SET ai_estimate_status = 'pending' WHERE id = $1`, [task.id]).catch(() => {});
  // Spustíme async, neblokujeme response
  setImmediate(async () => {
    try {
      const result = await estimateTask(task);
      if (result.error) {
        await query(
          `UPDATE tasks SET ai_estimate_status = 'error', ai_estimate_note = $1, ai_estimate_at = NOW() WHERE id = $2`,
          [String(result.message || result.error).slice(0, 300), task.id]
        );
        console.warn('[ai estimate]', task.id, result.error);
        return;
      }
      await query(
        `UPDATE tasks SET ai_estimated_h = $1, ai_estimate_note = $2,
                          ai_estimate_status = 'done', ai_estimate_at = NOW()
         WHERE id = $3`,
        [result.estimated_h || null, result.note || null, task.id]
      );
      console.log(`[ai estimate] úkol #${task.id}: ${result.estimated_h}h – ${result.note}`);
    } catch (err) {
      console.error('[ai estimate] selhal:', err);
      await query(
        `UPDATE tasks SET ai_estimate_status = 'error', ai_estimate_at = NOW() WHERE id = $1`,
        [task.id]
      ).catch(() => {});
    }
  });
}

// Moje úkoly
router.get('/mine', requireAuth, async (req, res) => {
  let userId = req.user.id;
  if (req.query.userId) {
    if (!can.seeAllHours(req.user) && Number(req.query.userId) !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    userId = Number(req.query.userId);
  }
  const status = req.query.status;
  const params = [req.user.id, userId];
  let extra = '';
  if (status) {
    params.push(status);
    extra = ` AND t.status = $${params.length}`;
  }
  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.client AS project_client,
      p.due_date AS project_due_date,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.to_user_id = $1 AND q.status = 'pending') AS pending_questions_for_me,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = $2 ${extra}
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'done' THEN 3 END,
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      t.due_date NULLS LAST, t.due_date ASC
  `, params);
  res.json({ tasks: r.rows });
});

// Vytvoření úkolu nebo podúkolu
router.post('/', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  const { project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date } = req.body || {};
  if (!project_id || !title) return res.status(400).json({ error: 'missing_fields' });
  const r = await query(`
    INSERT INTO tasks (project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    project_id, parent_id || null, title, description || null,
    assignee_id || null, status || 'todo', priority || 'normal',
    estimated_h || null, due_date || null,
  ]);
  const task = r.rows[0];
  // AI odhad na pozadí (neblokuje response)
  kickoffAIEstimate(task);
  res.json({ task });
});

// Update – ext.dev jen status na vlastním úkolu
router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM tasks WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });

  if (!can.createTasks(req.user)) {
    if (cur.assignee_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'only_status_allowed' });
    await query('UPDATE tasks SET status = $1 WHERE id = $2', [status, id]);
    const r = await query('SELECT * FROM tasks WHERE id = $1', [id]);
    return res.json({ task: r.rows[0] });
  }

  const next = { ...cur, ...req.body };
  const r = await query(`
    UPDATE tasks SET
      title = $1, description = $2, assignee_id = $3, status = $4,
      priority = $5, estimated_h = $6, due_date = $7, parent_id = $8
    WHERE id = $9
    RETURNING *
  `, [next.title, next.description, next.assignee_id, next.status,
      next.priority, next.estimated_h, next.due_date, next.parent_id, id]);

  // Pokud se změnil název nebo popis, re-spustíme AI odhad
  const titleChanged = req.body.title !== undefined && req.body.title !== cur.title;
  const descChanged  = req.body.description !== undefined && req.body.description !== cur.description;
  if (titleChanged || descChanged) {
    kickoffAIEstimate(r.rows[0]);
  }

  res.json({ task: r.rows[0] });
});

// Manuální spuštění AI odhadu pro konkrétní úkol
router.post('/:id/estimate', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  const t = await query('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!t.rows[0]) return res.status(404).json({ error: 'not_found' });
  kickoffAIEstimate(t.rows[0]);
  res.json({ ok: true, status: 'pending' });
});

// Smazání
router.delete('/:id', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  await query('DELETE FROM tasks WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

export default router;
