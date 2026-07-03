// Dotazy mezi členy týmu k jednotlivým úkolům.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';
import { sendToUser } from '../push.js';
import { sendMail, getNotificationPrefs } from '../mailer.js';

const router = Router();

const SELECT_FULL = `
  SELECT q.*,
    fu.name AS from_user_name,
    tu.name AS to_user_name,
    p.name  AS project_name,
    -- team_id/name z projektu dotazu nebo z projektu úkolu (fallback)
    COALESCE(p.team_id, pt.team_id) AS scope_team_id,
    COALESCE(pteam.name, ptteam.name) AS scope_team_name,
    t.title AS task_title
  FROM questions q
  JOIN users fu ON fu.id = q.from_user_id
  JOIN users tu ON tu.id = q.to_user_id
  LEFT JOIN projects p ON p.id = q.project_id
  LEFT JOIN tasks t ON t.id = q.task_id
  LEFT JOIN projects pt ON pt.id = t.project_id
  LEFT JOIN teams pteam ON pteam.id = p.team_id
  LEFT JOIN teams ptteam ON ptteam.id = pt.team_id
`;

// Seznam dotazů
// Pokud je zadáno ?taskId=, vrátíme všechny dotazy navázané na ten úkol (bez ohledu na box).
router.get('/', requireAuth, async (req, res) => {
  const taskId = req.query.taskId ? Number(req.query.taskId) : null;
  const box = req.query.box || 'mine';
  const status = req.query.status;
  const filters = [];
  const params = [];

  if (taskId) {
    params.push(taskId);
    filters.push(`q.task_id = $${params.length}`);
  } else if (box === 'mine') {
    params.push(req.user.id, req.user.id);
    filters.push(`(q.to_user_id = $${params.length - 1} OR q.from_user_id = $${params.length})`);
  } else if (box === 'inbox') {
    params.push(req.user.id);
    filters.push(`q.to_user_id = $${params.length}`);
  } else if (box === 'sent') {
    params.push(req.user.id);
    filters.push(`q.from_user_id = $${params.length}`);
  } else if (box === 'answered-to-me') {
    // Nová stránka "Odpovědi na dotazy" — odpovědi na moje položené dotazy.
    params.push(req.user.id);
    filters.push(`q.from_user_id = $${params.length} AND q.status = 'answered'`);
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

  // Team scope: default = napříč VŠEMI týmy, kde je user členem
  // (cross-team). Volitelně `?team_id=N` filtruje na konkrétní tým.
  // taskId override (filtr na konkrétní úkol) team scope nepotřebuje —
  // GET /api/tasks/:id už ověří přístup.
  if (!taskId) {
    const askedTeamId = Number(req.query.team_id);
    if (Number.isInteger(askedTeamId) && askedTeamId > 0) {
      // Kontrola členství (bezpečnost: user nemůže filtrovat na cizí tým)
      if (req.user.role !== 'admin') {
        const ok = await query(
          `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
          [askedTeamId, req.user.id]
        );
        if (ok.rows.length === 0) return res.status(403).json({ error: 'forbidden' });
      }
      params.push(askedTeamId);
      filters.push(`(
        EXISTS (SELECT 1 FROM projects pp WHERE pp.id = q.project_id AND pp.team_id = $${params.length})
        OR
        EXISTS (SELECT 1 FROM tasks tt JOIN projects pp2 ON pp2.id = tt.project_id WHERE tt.id = q.task_id AND pp2.team_id = $${params.length})
      )`);
    } else {
      // Cross-team default: pouze dotazy z týmů, kde je user členem (admin vidí vše)
      if (req.user.role !== 'admin') {
        params.push(req.user.id);
        filters.push(`(
          EXISTS (
            SELECT 1 FROM projects pp
            JOIN team_members tmc ON tmc.team_id = pp.team_id
            WHERE pp.id = q.project_id AND tmc.user_id = $${params.length}
          )
          OR EXISTS (
            SELECT 1 FROM tasks tt
            JOIN projects pp2 ON pp2.id = tt.project_id
            JOIN team_members tmc2 ON tmc2.team_id = pp2.team_id
            WHERE tt.id = q.task_id AND tmc2.user_id = $${params.length}
          )
        )`);
      }
      // Admin má stále všechny bez filteru — moje/inbox/sent už omezuje seznam.
    }
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const r = await query(`${SELECT_FULL} ${where} ORDER BY q.status ASC, q.created_at DESC`, params);
  res.json({ questions: r.rows });
});

// Počty
router.get('/counts', requireAuth, async (req, res) => {
  // Defenzivně: pokud sloupec answer_read ještě neexistuje, vrátíme 0.
  let answersUnread = 0;
  try {
    const ar = await query(
      `SELECT COUNT(*)::int AS c FROM questions
       WHERE from_user_id = $1 AND status = 'answered' AND answer_read = FALSE`,
      [req.user.id]
    );
    answersUnread = Number(ar.rows[0]?.c || 0);
  } catch (err) {
    if (err.code !== '42703') throw err;
  }
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
    answersUnread,
  });
});

// Označí VŠECHNY moje answered dotazy za přečtené. Voláno po otevření
// stránky "Odpovědi na dotazy".
router.post('/mark-answers-read', requireAuth, async (req, res) => {
  try {
    await query(
      `UPDATE questions SET answer_read = TRUE
       WHERE from_user_id = $1 AND status = 'answered' AND answer_read = FALSE`,
      [req.user.id]
    );
  } catch (err) {
    if (err.code !== '42703') throw err;
    // Sloupec ještě neexistuje — no-op
  }
  res.json({ ok: true });
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

  // Push notifikace příjemci — fire-and-forget.
  if (Number(to_user_id) !== req.user.id) {
    sendToUser(Number(to_user_id), {
      title: '💬 Nový dotaz',
      body: `${req.user.name || 'Někdo'}: ${String(question).slice(0, 120)}`,
      url: `/questions?questionId=${ins.rows[0].id}`,
      tag: `question-${ins.rows[0].id}`,
    }).catch(err => console.warn('[push/question]', err.message));

    // Email notifikace recipienta (per user opt-in).
    notifyQuestionByEmail({
      toUserId: Number(to_user_id),
      questionText: question,
      asker: req.user,
      taskId: task_id || null,
    }).catch(err => console.warn('[mail/question]', err.message));
  }
});

async function notifyQuestionByEmail({ toUserId, questionText, asker, taskId }) {
  const prefs = await getNotificationPrefs(toUserId);
  if (!prefs.email_new_question) return;
  const r = await query(`SELECT email FROM users WHERE id = $1 AND active = TRUE`, [toUserId]);
  const email = r.rows[0]?.email;
  if (!email) return;
  const base = (process.env.APP_BASE_URL?.trim() || 'https://it.realitniekosystem.cz').replace(/\/$/, '');
  // Adresát dotazu jde rovnou do Questions sekce — tam vidí celý dotaz, kontext
  // úkolu i odpovědní pole. Pro vrácený úkol vede link na /my-tasks?taskId=N.
  const url = `${base}/questions`;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #eee9e4; padding: 24px; color: #1f3a40;">
  <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; padding: 24px;">
    <div style="font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #e72b78; font-weight: bold;">VITOM IT Crew</div>
    <h2 style="margin: 12px 0 8px; color: #0c363e; font-size: 20px;">💬 Nový dotaz</h2>
    <p style="font-size: 14px;"><strong>${esc(asker.name || 'Někdo')}</strong> se tě ptá${taskId ? ' k úkolu' : ''}:</p>
    <p style="background:#f9f6f1;padding:12px;border-radius:6px;font-size:14px;color:#365156;border-left:3px solid #e72b78;">${esc(questionText)}</p>
    <a href="${url}" style="display: inline-block; background: #0c363e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Odpovědět →</a>
    <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2dcd3; font-size: 11px; color: #8a9b9f;">
      Tyto notifikace si můžeš vypnout v profilu → Notifikace.
    </div>
  </div>
</body></html>`;
  await sendMail({
    to: email,
    subject: `VITOM: Nový dotaz od ${asker.name || 'kolegy'}`,
    html,
  });
}

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
  // answer_read=FALSE → v "Odpovědi na dotazy" se ukáže jako unread
  await query(`UPDATE questions SET answer = $1, status = 'answered', answered_at = NOW(), answer_read = FALSE WHERE id = $2`,
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
  await query(`UPDATE questions SET status = 'pending', answered_at = NULL, answer_read = FALSE WHERE id = $1`, [id]);
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
