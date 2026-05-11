// Dotazy mezi členy týmu k jednotlivým úkolům.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

const SELECT_FULL = `
  SELECT q.*,
    fu.name AS from_user_name,
    tu.name AS to_user_name,
    p.name  AS project_name,
    t.title AS task_title
  FROM questions q
  JOIN users fu ON fu.id = q.from_user_id
  JOIN users tu ON tu.id = q.to_user_id
  LEFT JOIN projects p ON p.id = q.project_id
  LEFT JOIN tasks t ON t.id = q.task_id
`;

// Seznam dotazů
router.get('/', requireAuth, async (req, res) => {
  const box = req.query.box || 'mine';
  const status = req.query.status;
  const filters = [];
  const params = [];

  if (box === 'mine') {
    params.push(req.user.id, req.user.id);
    filters.push(`(q.to_user_id = $${params.length - 1} OR q.from_user_id = $${params.length})`);
  } else if (box === 'inbox') {
    params.push(req.user.id);
    filters.push(`q.to_user_id = $${params.length}`);
  } else if (box === 'sent') {
    params.push(req.user.id);
    filters.push(`q.from_user_id = $${params.length}`);
  } else if (box === 'all') {
    if (!can.seeAllHours(req.user)) return res.status(403).json({ error: 'forbidden' });
  } else {
    return res.status(400).json({ error: 'invalid_box' });
  }

  if (status) {
    if (!['pending', 'answered'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    params.push(status);
    filters.push(`q.status = $${params.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const r = await query(`${SELECT_FULL} ${where} ORDER BY q.status ASC, q.created_at DESC`, params);
  res.json({ questions: r.rows });
});

// Počty
router.get('/counts', requireAuth, async (req, res) => {
  const r = await query(`
    SELECT
      (SELECT COUNT(*) FROM questions WHERE to_user_id = $1 AND status = 'pending')   AS inbox_pending,
      (SELECT COUNT(*) FROM questions WHERE from_user_id = $1 AND status = 'pending') AS sent_pending,
      (SELECT COUNT(*) FROM questions WHERE to_user_id = $1)                          AS inbox_total,
      (SELECT COUNT(*) FROM questions WHERE from_user_id = $1)                        AS sent_total,
      (SELECT COUNT(*) FROM questions WHERE to_user_id = $1 OR from_user_id = $1)     AS mine_total
  `, [req.user.id]);
  const row = r.rows[0];
  res.json({
    inboxPending: Number(row.inbox_pending),
    sentPending:  Number(row.sent_pending),
    inboxTotal:   Number(row.inbox_total),
    sentTotal:    Number(row.sent_total),
    mineTotal:    Number(row.mine_total),
  });
});

// Vytvoření dotazu
router.post('/', requireAuth, async (req, res) => {
  const { task_id, to_user_id, question } = req.body || {};
  if (!to_user_id || !question?.trim()) return res.status(400).json({ error: 'missing_fields' });

  let project_id = null;
  if (task_id) {
    const tR = await query('SELECT project_id FROM tasks WHERE id = $1', [Number(task_id)]);
    if (!tR.rows[0]) return res.status(404).json({ error: 'task_not_found' });
    project_id = tR.rows[0].project_id;
  }

  const ins = await query(`
    INSERT INTO questions (task_id, project_id, from_user_id, to_user_id, question)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [task_id || null, project_id, req.user.id, Number(to_user_id), question.trim()]);

  const r = await query(`${SELECT_FULL} WHERE q.id = $1`, [ins.rows[0].id]);
  res.json({ question: r.rows[0] });
});

// Odpověď
router.post('/:id/answer', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM questions WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.to_user_id !== req.user.id && !can.seeAllHours(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { answer } = req.body || {};
  if (!answer?.trim()) return res.status(400).json({ error: 'missing_answer' });
  await query(`UPDATE questions SET answer = $1, status = 'answered', answered_at = NOW() WHERE id = $2`,
    [answer.trim(), id]);
  const r = await query(`${SELECT_FULL} WHERE q.id = $1`, [id]);
  res.json({ question: r.rows[0] });
});

// Reopen
router.post('/:id/reopen', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM questions WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.from_user_id !== req.user.id && cur.to_user_id !== req.user.id && !can.seeAllHours(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await query(`UPDATE questions SET status = 'pending', answered_at = NULL WHERE id = $1`, [id]);
  const r = await query(`${SELECT_FULL} WHERE q.id = $1`, [id]);
  res.json({ question: r.rows[0] });
});

// Smazání
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM questions WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.from_user_id !== req.user.id && !can.manageUsers(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await query('DELETE FROM questions WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
