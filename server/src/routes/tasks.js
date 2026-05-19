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
      p.due_date AS project_due_date,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.to_user_id = $1 AND q.status = 'pending') AS pending_questions_for_me,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id)                          AS attachment_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.task_id = t.id)     AS logged_hours
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

// Pomocná funkce: spočítá hodnoty completed_at / completed_by / actual_h podle změny stavu.
// - Přechod na 'done': nastav completed_at = NOW(), completed_by = aktuální user, actual_h = body.actual_h (může být null = "neznámo")
// - Přechod ZE 'done' jinam (znovuotevření): vynuluj completed_at + completed_by, actual_h ponecháme jako historický záznam
function completionFields({ curStatus, nextStatus, bodyActualH, userId }) {
  const goingDone = nextStatus === 'done' && curStatus !== 'done';
  const leavingDone = curStatus === 'done' && nextStatus !== 'done';
  const out = {};
  if (goingDone) {
    out.actual_h = (bodyActualH === '' || bodyActualH == null) ? null : Number(bodyActualH);
    out.completed_at = new Date();
    out.completed_by = userId;
  } else if (leavingDone) {
    out.completed_at = null;
    out.completed_by = null;
    // actual_h ponecháme – uživatel může nahradit při příštím dokončení
  } else if (bodyActualH !== undefined) {
    // Explicitní oprava skutečného času bez změny stavu
    out.actual_h = (bodyActualH === '' || bodyActualH == null) ? null : Number(bodyActualH);
  }
  return out;
}

// Update – ext.dev jen status / poznámka / actual_h na vlastním úkolu
router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM tasks WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });

  if (!can.createTasks(req.user)) {
    // Externí dev / běžný assignee může u VLASTNÍHO úkolu měnit jen status, popis (poznámku) nebo actual_h.
    if (cur.assignee_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    const allowed = ['status', 'description', 'actual_h'];
    const keys = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (keys.length === 0) return res.status(400).json({ error: 'no_allowed_fields' });

    const nextStatus = 'status' in req.body ? req.body.status : cur.status;
    const comp = completionFields({
      curStatus: cur.status, nextStatus,
      bodyActualH: req.body.actual_h, userId: req.user.id,
    });

    const sets = [];
    const params = [];
    if ('status' in req.body) { params.push(req.body.status); sets.push(`status = $${params.length}`); }
    if ('description' in req.body) { params.push(req.body.description ?? null); sets.push(`description = $${params.length}`); }
    if ('actual_h' in comp)     { params.push(comp.actual_h);     sets.push(`actual_h = $${params.length}`); }
    if ('completed_at' in comp) { params.push(comp.completed_at); sets.push(`completed_at = $${params.length}`); }
    if ('completed_by' in comp) { params.push(comp.completed_by); sets.push(`completed_by = $${params.length}`); }
    params.push(id);
    await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const r = await query('SELECT * FROM tasks WHERE id = $1', [id]);
    return res.json({ task: r.rows[0] });
  }

  const next = { ...cur, ...req.body };
  const comp = completionFields({
    curStatus: cur.status, nextStatus: next.status,
    bodyActualH: req.body.actual_h, userId: req.user.id,
  });
  const newActualH    = 'actual_h' in comp     ? comp.actual_h     : cur.actual_h;
  const newCompletedAt = 'completed_at' in comp ? comp.completed_at : cur.completed_at;
  const newCompletedBy = 'completed_by' in comp ? comp.completed_by : cur.completed_by;

  const r = await query(`
    UPDATE tasks SET
      title = $1, description = $2, assignee_id = $3, status = $4,
      priority = $5, estimated_h = $6, due_date = $7, parent_id = $8,
      actual_h = $9, completed_at = $10, completed_by = $11
    WHERE id = $12
    RETURNING *
  `, [next.title, next.description, next.assignee_id, next.status,
      next.priority, next.estimated_h, next.due_date, next.parent_id,
      newActualH, newCompletedAt, newCompletedBy, id]);

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
