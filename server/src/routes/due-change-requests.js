// Žádosti o změnu termínu úkolu.
//
// Workflow:
//   1) Assignee (co nezadal úkol) posune termín → místo přímé změny se vytvoří
//      pending žádost. Reviewer = tasks.created_by (fallback: projekt.manager_id).
//   2) Reviewer žádost buď approve (s user's termínem NEBO s counter_due),
//      nebo reject.
//   3) Po approve se úkolu updatuje due_date.
//
// Endpointy:
//   GET  /                    ?box=inbox|sent  → seznam
//   POST /                    { task_id, requested_due, requester_note }
//   POST /:id/approve         { counter_due? , reviewer_note? }
//   POST /:id/reject          { reviewer_note? }
//   POST /mark-seen           — requester označí své zamítnuté/schválené za přečtené

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const router = Router();

const SELECT_FULL = `
  SELECT r.*,
    t.title AS task_title,
    t.due_date AS task_current_due,
    t.project_id,
    p.name AS project_name,
    p.team_id,
    tm.name AS team_name,
    ru.name AS requester_name,
    rv.name AS reviewer_name
  FROM task_due_change_requests r
  JOIN tasks t   ON t.id = r.task_id
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN teams tm ON tm.id = p.team_id
  JOIN users ru  ON ru.id = r.requester_id
  JOIN users rv  ON rv.id = r.reviewer_id
`;

// Kdo je zadavatel: tasks.created_by, fallback projects.manager_id, fallback assignee.
// Když assignee == creator (self-assign), user může měnit termín přímo — bez requestu.
async function resolveReviewerFor(task) {
  if (task.created_by && task.created_by !== task.assignee_id) return task.created_by;
  // Fallback: manager projektu (pro legacy tasky bez created_by)
  const p = await query(`SELECT manager_id FROM projects WHERE id = $1`, [task.project_id]);
  const mgr = p.rows[0]?.manager_id;
  if (mgr && mgr !== task.assignee_id) return mgr;
  return null; // self-assign nebo neexistující manager → žádný reviewer, změna přímo
}

// GET / ?box=inbox|sent
// inbox: já jsem reviewer, status='pending' (co mám schválit)
// sent: já jsem requester (moje žádosti, všechny stavy)
router.get('/', requireAuth, async (req, res) => {
  const box = String(req.query.box || 'inbox');
  const params = [req.user.id];
  let where;
  if (box === 'inbox') {
    where = `WHERE r.reviewer_id = $1 AND r.status = 'pending'`;
  } else if (box === 'sent') {
    where = `WHERE r.requester_id = $1`;
  } else {
    return res.status(400).json({ error: 'invalid_box' });
  }
  const r = await query(`${SELECT_FULL} ${where} ORDER BY r.created_at DESC`, params);
  res.json({ requests: r.rows });
});

// Počty pro badge — inbox pending (mám schválit) + moje unseen zamítnuté/schválené.
router.get('/counts', requireAuth, async (req, res) => {
  const r = await query(`
    SELECT
      (SELECT COUNT(*) FROM task_due_change_requests
        WHERE reviewer_id = $1 AND status = 'pending')::int AS inbox_pending,
      (SELECT COUNT(*) FROM task_due_change_requests
        WHERE requester_id = $1 AND status != 'pending' AND seen_by_requester = FALSE)::int AS sent_unseen
  `, [req.user.id]);
  res.json(r.rows[0] || { inbox_pending: 0, sent_unseen: 0 });
});

// POST / — vytvoř žádost. Volá se z FE, když user (assignee) chce změnit termín
// a není tvůrcem úkolu.
router.post('/', requireAuth, async (req, res) => {
  const taskId = Number(req.body?.task_id);
  const requestedDue = String(req.body?.requested_due || '').slice(0, 10);
  const note = req.body?.requester_note ? String(req.body.requester_note).trim().slice(0, 5000) : null;

  if (!Number.isInteger(taskId) || taskId <= 0) return res.status(400).json({ error: 'invalid_task' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDue)) return res.status(400).json({ error: 'invalid_due' });

  const tR = await query(`SELECT id, assignee_id, created_by, project_id, due_date FROM tasks WHERE id = $1`, [taskId]);
  const task = tR.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (task.assignee_id !== req.user.id) return res.status(403).json({ error: 'forbidden', message: 'Termín může požádat změnit jen assignee úkolu.' });

  const reviewerId = await resolveReviewerFor(task);
  if (!reviewerId) {
    // Self-assign nebo bez managera — user může měnit termín přímo, request nedává smysl.
    return res.status(400).json({ error: 'no_reviewer', message: 'Nemáš k tomuto úkolu zadavatele — změň termín přímo.' });
  }

  const ins = await query(`
    INSERT INTO task_due_change_requests
      (task_id, requester_id, reviewer_id, original_due, requested_due, requester_note)
    VALUES ($1, $2, $3, $4, $5::date, $6)
    RETURNING id
  `, [taskId, req.user.id, reviewerId, task.due_date, requestedDue, note]);
  res.status(201).json({ ok: true, id: ins.rows[0].id });
});

// Approve — case: user's termín NEBO counter_due (reviewer navrhne vlastní).
router.post('/:id/approve', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const counterDue = req.body?.counter_due ? String(req.body.counter_due).slice(0, 10) : null;
  const note = req.body?.reviewer_note ? String(req.body.reviewer_note).trim().slice(0, 5000) : null;
  if (counterDue && !/^\d{4}-\d{2}-\d{2}$/.test(counterDue)) return res.status(400).json({ error: 'invalid_counter_due' });

  const r = await query(`SELECT * FROM task_due_change_requests WHERE id = $1`, [id]);
  const req_ = r.rows[0];
  if (!req_) return res.status(404).json({ error: 'not_found' });
  if (req_.reviewer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req_.status !== 'pending') return res.status(400).json({ error: 'already_resolved' });

  const finalDue = counterDue || req_.requested_due;

  await query(`
    UPDATE task_due_change_requests
    SET status = 'approved', counter_due = $1::date, reviewer_note = $2,
        resolved_at = NOW(), seen_by_requester = FALSE
    WHERE id = $3
  `, [counterDue, note, id]);

  await query(`UPDATE tasks SET due_date = $1::date WHERE id = $2`, [finalDue, req_.task_id]);

  res.json({ ok: true, final_due: finalDue });
});

router.post('/:id/reject', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const note = req.body?.reviewer_note ? String(req.body.reviewer_note).trim().slice(0, 5000) : null;

  const r = await query(`SELECT * FROM task_due_change_requests WHERE id = $1`, [id]);
  const req_ = r.rows[0];
  if (!req_) return res.status(404).json({ error: 'not_found' });
  if (req_.reviewer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req_.status !== 'pending') return res.status(400).json({ error: 'already_resolved' });

  await query(`
    UPDATE task_due_change_requests
    SET status = 'rejected', reviewer_note = $1,
        resolved_at = NOW(), seen_by_requester = FALSE
    WHERE id = $2
  `, [note, id]);
  res.json({ ok: true });
});

// Označí všechny mé vyřešené (schválené/zamítnuté) žádosti jako přečtené.
router.post('/mark-seen', requireAuth, async (req, res) => {
  await query(`
    UPDATE task_due_change_requests
    SET seen_by_requester = TRUE
    WHERE requester_id = $1 AND status != 'pending'
  `, [req.user.id]);
  res.json({ ok: true });
});

export { resolveReviewerFor };
export default router;
