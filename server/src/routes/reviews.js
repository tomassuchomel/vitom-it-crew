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
import { sendToUser } from '../push.js';
import { sendMail, buildTaskEmailHtml, getNotificationPrefs } from '../mailer.js';

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

  // Push notifikace assignee — fire-and-forget po response.
  if (task.assignee_id && task.assignee_id !== req.user.id) {
    const url = `/my-tasks?taskId=${id}`;
    const payload = verdict === 'approved'
      ? { title: '✅ Úkol schválen', body: `„${task.title}" v ${task.project_name}`, url, tag: `task-${id}` }
      : { title: '🔄 Úkol vrácen k opravě', body: `„${task.title}": ${cleanComment?.slice(0, 100) || ''}`, url: `/needs-fix?taskId=${id}`, tag: `task-${id}` };
    sendToUser(task.assignee_id, payload).catch(err => console.warn('[push/review]', err.message));

    // Email notifikace (per user opt-in). Liší se text per verdict.
    notifyReviewByEmail({ verdict, task, comment: cleanComment, reviewer: req.user })
      .catch(err => console.warn('[mail/review]', err.message));
  }
});

async function notifyReviewByEmail({ verdict, task, comment, reviewer }) {
  const prefs = await getNotificationPrefs(task.assignee_id);
  const wantsIt = verdict === 'approved' ? prefs.email_task_approved : prefs.email_task_returned;
  if (!wantsIt) return;
  const r = await query(`SELECT email FROM users WHERE id = $1 AND active = TRUE`, [task.assignee_id]);
  const email = r.rows[0]?.email;
  if (!email) return;
  const isApproved = verdict === 'approved';
  const title = isApproved
    ? `✅ Úkol schválen: ${task.title}`
    : `🔄 Úkol vrácen k opravě: ${task.title}`;
  const body = isApproved
    ? `<p><strong>${escapeForBody(reviewer.name || 'Manager')}</strong> schválil tvůj úkol jako hotový. 🎉</p>`
    : `<p><strong>${escapeForBody(reviewer.name || 'Manager')}</strong> ti úkol vrátil k opravě.</p>`
      + (comment ? `<p style="background:#fef3c7;padding:10px;border-radius:6px;font-size:13px;color:#92400e;"><strong>Komentář:</strong><br>${escapeForBody(comment)}</p>` : '');
  const html = buildTaskEmailHtml({
    title,
    body: body + `<p style="color:#5b7177;font-size:12px;">Projekt: ${escapeForBody(task.project_name || '')}</p>`,
    taskId: task.id,
    ctaLabel: isApproved ? 'Zobrazit úkol' : 'Otevřít k opravě',
  });
  await sendMail({
    to: email,
    subject: isApproved ? `VITOM: Úkol schválen — ${task.title}` : `VITOM: Vrácený úkol — ${task.title}`,
    html,
  });
}

function escapeForBody(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

/**
 * Vrátí seznam úkolů ve stavu 'needs_fix', kde je aktuální uživatel
 * asignee (vlastník úkolu) a úkol je v rámci current teamu.
 *
 * Symetrie k /tasks/review-queue: tam manager vidí, co má reviewnout;
 * tady programátor vidí, co mu manager vrátil k opravě.
 *
 * Vrátí task + nejnovější rejected review (komentář + reviewer + datum)
 * + počet příloh (často obsahují screenshot toho, co je špatně).
 */
router.get('/tasks/needs-fix', requireAuth, async (req, res) => {
  // Cross-team default: user vidí vrácené úkoly napříč všemi týmy,
  // kde je členem (assignee_id = user je dostatečná autorizace).
  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.due_date AS project_due_date,
      p.manager_id AS project_manager_id,
      p.team_id AS project_team_id,
      tm.name AS project_team_name,
      tr.comment AS latest_review_comment,
      tr.created_at AS latest_review_at,
      ru.name AS latest_reviewer_name,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count,
      (SELECT COUNT(*) FROM task_reviews trr WHERE trr.task_id = t.id) AS total_reviews
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN teams tm ON tm.id = p.team_id
    LEFT JOIN LATERAL (
      SELECT tr.*
      FROM task_reviews tr
      WHERE tr.task_id = t.id AND tr.verdict = 'rejected'
      ORDER BY tr.created_at DESC
      LIMIT 1
    ) tr ON TRUE
    LEFT JOIN users ru ON ru.id = tr.reviewer_id
    WHERE t.assignee_id = $1
      AND t.status = 'needs_fix'
    ORDER BY
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      t.due_date NULLS LAST,
      tr.created_at DESC NULLS LAST,
      t.id
  `, [req.user.id]);
  res.json({ tasks: r.rows });
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
      p.team_id AS project_team_id,
      tm.name AS project_team_name,
      u.name AS assignee_name,
      (SELECT MAX(created_at) FROM task_reviews tr
        WHERE tr.task_id = t.id AND tr.verdict = 'rejected') AS last_rejected_at,
      (SELECT COUNT(*) FROM task_reviews tr WHERE tr.task_id = t.id) AS review_count,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN teams tm ON tm.id = p.team_id
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

/**
 * Schválit + navázat: schválí úkol (→ done, drží si „dokončeno včas") A ZÁROVEŇ
 * založí navazující úkol s vlastním termínem (continues_task_id). Řeší situaci
 * „úkol je hotový, ale mám k němu další nápad" bez toho, aby se kazilo skóre
 * znovuotevřením. Jen manager projektu / admin.
 */
router.post('/tasks/:id/approve-and-continue', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_task_id' });

  const b = req.body || {};
  const title = String(b.title || '').trim();
  const dueDate = String(b.due_date || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required', message: 'Zadej název navazujícího úkolu.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return res.status(400).json({ error: 'due_date_required', message: 'Zadej termín navazujícího úkolu.' });
  }

  const tr = await query(
    `SELECT t.*, p.manager_id AS project_manager_id, p.name AS project_name
     FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
    [id]
  );
  const task = tr.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (!can.reviewTask(req.user, { manager_id: task.project_manager_id })) {
    return res.status(403).json({ error: 'forbidden', message: 'Pouze vedoucí projektu nebo admin může schválit úkol.' });
  }
  if (task.status !== 'review') {
    return res.status(400).json({ error: 'invalid_state', message: `Úkol je ve stavu „${task.status}", navázat lze jen z review.` });
  }

  // 1) Schválit původní úkol (drží si completed_at / on-time)
  await query(`UPDATE tasks SET status = 'done', completed_at = NOW(), completed_by = $1 WHERE id = $2`, [req.user.id, id]);
  const comment = b.comment ? String(b.comment).trim().slice(0, 5000) : null;
  await query(
    `INSERT INTO task_reviews (task_id, reviewer_id, verdict, comment) VALUES ($1, $2, 'approved', $3)`,
    [id, req.user.id, comment]
  );

  // 2) Založit navazující úkol se samostatným termínem + vazbou na původní
  const assignee = b.assignee_id ? Number(b.assignee_id) : task.assignee_id;
  const description = b.description ? String(b.description) : null;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : (task.priority || 'normal');
  const nt = await query(
    `INSERT INTO tasks (project_id, title, description, assignee_id, status, priority, due_date, continues_task_id)
     VALUES ($1, $2, $3, $4, 'todo', $5, $6, $7) RETURNING *`,
    [task.project_id, title, description, assignee, priority, dueDate, id]
  );

  res.json({ task: { ...task, status: 'done' }, followUp: nt.rows[0] });

  // Push assignee o schválení (fire-and-forget) — stejný vzor jako u review.
  if (task.assignee_id && task.assignee_id !== req.user.id) {
    sendToUser(task.assignee_id, {
      title: '✅ Úkol schválen (a navázán)',
      body: `„${task.title}" → pokračování „${title}"`,
      url: `/my-tasks?taskId=${nt.rows[0].id}`,
      tag: `task-${id}`,
    }).catch(err => console.warn('[push/approve-continue]', err.message));
  }
});

export default router;
