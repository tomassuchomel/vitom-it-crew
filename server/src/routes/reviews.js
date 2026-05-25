// API pro review workflow:
//   POST /api/tasks/:id/review        – schválit nebo vrátit k opravě (jen manager projektu nebo admin)
//   GET  /api/tasks/review-queue      – fronta úkolů ve stavu 'review', kde je current user manager/admin
//   GET  /api/tasks/:id/reviews       – historie review rozhodnutí pro úkol
//
// Workflow:
//   in_progress → review              (programátor: ukládá přes PUT /api/tasks/:id)
//   review      → done                (manager: POST /review s verdict='approved')
//   review      → needs_fix           (manager: POST /review s verdict='rejected' + comment)
//   needs_fix   → in_progress         (programátor: ukládá přes PUT /api/tasks/:id)

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

const VERDICTS = ['approved', 'rejected'];

/**
 * Schválit / vrátit úkol z review. Pouze manager projektu nebo admin.
 * Tělo: { verdict: 'approved'|'rejected', comment?: string }
 * Při rejected je comment doporučený (programátor musí vědět, co opravit).
 */
router.post('/tasks/:id/review', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_task_id' });

  const { verdict, comment } = req.body || {};
  if (!VERDICTS.includes(verdict)) {
    return res.status(400).json({ error: 'invalid_verdict', message: `verdict musí být ${VERDICTS.join(' nebo ')}` });
  }
  if (verdict === 'rejected' && (!comment || !String(comment).trim())) {
    return res.status(400).json({ error: 'comment_required', message: 'Při vrácení k opravě napiš komentář, co je třeba opravit.' });
  }

  // Načti task + project (kvůli manager_id check)
  const tr = await query(
    `SELECT t.*, p.manager_id AS project_manager_id, p.name AS project_name
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1`,
    [id]
  );
  const task = tr.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });

  // Oprávnění – jen manager projektu nebo admin
  const project = { manager_id: task.project_manager_id };
  if (!can.reviewTask(req.user, project)) {
    return res.status(403).json({ error: 'forbidden', message: 'Pouze vedoucí projektu nebo admin může schválit/vrátit úkol.' });
  }

  // Stav musí být 'review' – nelze schvalovat to, co programátor ještě nepředal
  if (task.status !== 'review') {
    return res.status(400).json({
      error: 'invalid_state',
      message: `Úkol je ve stavu „${task.status}", review je možný jen ze stavu „review". Programátor ho musí nejdřív předat k review.`,
    });
  }

  // Aplikuj verdict
  const cleanComment = comment ? String(comment).trim().slice(0, 5000) : null;
  if (verdict === 'approved') {
    await query(
      `UPDATE tasks SET status = 'done', completed_at = NOW(), completed_by = $1 WHERE id = $2`,
      [req.user.id, id]
    );
  } else {
    // rejected → needs_fix. completed_* nediráme (úkol není dokončený).
    await query(
      `UPDATE tasks SET status = 'needs_fix' WHERE id = $1`,
      [id]
    );
  }

  // Záznam do task_reviews
  const rev = await query(
    `INSERT INTO task_reviews (task_id, reviewer_id, verdict, comment)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, req.user.id, verdict, cleanComment]
  );

  // Vrátíme aktualizovaný task + review
  const updR = await query('SELECT * FROM tasks WHERE id = $1', [id]);
  res.json({ task: updR.rows[0], review: rev.rows[0] });
});

/**
 * Vrátí seznam úkolů ve stavu 'review', kde aktuální uživatel
 * – je managerem projektu (project.manager_id = user.id)
 * – NEBO je admin (vidí všechny)
 *
 * Frontend ho používá na stránce /review k zobrazení fronty.
 */
router.get('/tasks/review-queue', requireAuth, async (req, res) => {
  // Admin vidí všechny, manager jen své projekty. Ostatní role frontu nemají.
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !can.manageProjects(req.user)) {
    // Senior dev může mít projekty taky, ale ne v current schema. Bezpečně zakážeme.
    return res.json({ tasks: [] });
  }

  const params = [];
  let where = `t.status = 'review'`;
  if (!isAdmin) {
    params.push(req.user.id);
    where += ` AND p.manager_id = $${params.length}`;
  }

  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.manager_id AS project_manager_id,
      u.name AS assignee_name,
      (SELECT MAX(created_at) FROM task_reviews tr
        WHERE tr.task_id = t.id AND tr.verdict = 'rejected') AS last_rejected_at,
      (SELECT COUNT(*) FROM task_reviews tr WHERE tr.task_id = t.id) AS review_count,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE ${where}
    ORDER BY
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      t.due_date NULLS LAST,
      t.id
  `, params);
  res.json({ tasks: r.rows });
});

/**
 * Vrátí historii review rozhodnutí pro daný úkol.
 * Pomáhá programátorovi vidět, co bylo vráceno a proč.
 */
router.get('/tasks/:id/reviews', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_task_id' });
  const r = await query(
    `SELECT tr.*, u.name AS reviewer_name
     FROM task_reviews tr
     LEFT JOIN users u ON u.id = tr.reviewer_id
     WHERE tr.task_id = $1
     ORDER BY tr.created_at DESC`,
    [id]
  );
  res.json({ reviews: r.rows });
});

export default router;
