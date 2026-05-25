import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';
import { estimateTask, HAS_AI } from '../ai.js';
import {
  AI_TASK_DEFAULTS,
  validateAiStatus,
  validateExecutionMode,
  normalizeJsonArray,
} from '../taskModel.js';
import { preflightTask } from '../aiAgent/preflight.js';

// Minimální délka popisu, pokud je úkol přiřazen AI agentovi.
// Bez kontextu agent nemůže rozumně pracovat.
const AI_DESCRIPTION_MIN = 30;

// Vytáhne AI agent pole z těla requestu a vrátí buď
// { fields, error }. Pokud error není null, fields by se neměl použít.
// Validuje:
//   - povolené hodnoty execution_mode + ai_status
//   - JSON arrays
//   - pokud ai_assignee=true: aspoň 1 acceptance criterion + popis ≥ 30 znaků
function extractAiFields(body, description) {
  const out = { ...AI_TASK_DEFAULTS };
  if ('ai_assignee' in body) out.ai_assignee = !!body.ai_assignee;
  if ('execution_mode' in body) {
    const err = validateExecutionMode(body.execution_mode);
    if (err) return { error: err };
    out.execution_mode = body.execution_mode || 'manual';
  }
  if ('ai_status' in body) {
    const err = validateAiStatus(body.ai_status);
    if (err) return { error: err };
    out.ai_status = body.ai_status || 'idle';
  }
  try {
    if ('acceptance_criteria' in body) out.acceptance_criteria = normalizeJsonArray(body.acceptance_criteria, 'acceptance_criteria');
    if ('out_of_scope'        in body) out.out_of_scope        = normalizeJsonArray(body.out_of_scope, 'out_of_scope');
    if ('scope_paths'         in body) out.scope_paths         = normalizeJsonArray(body.scope_paths, 'scope_paths');
  } catch (err) {
    return { error: err.message };
  }
  // Vyfiltrujeme prázdné stringy (uživatel může nechat prázdný řádek v dynamickém listu)
  out.acceptance_criteria = out.acceptance_criteria.map(s => String(s).trim()).filter(Boolean);
  out.out_of_scope        = out.out_of_scope.map(s => String(s).trim()).filter(Boolean);
  out.scope_paths         = out.scope_paths.map(s => String(s).trim()).filter(Boolean);

  // Validace business pravidel jen pokud je AI agent zapnutý
  if (out.ai_assignee) {
    if (out.acceptance_criteria.length === 0) {
      return { error: 'ai_assignee_requires_acceptance_criteria' };
    }
    if (!description || String(description).trim().length < AI_DESCRIPTION_MIN) {
      return { error: 'ai_assignee_requires_description', min: AI_DESCRIPTION_MIN };
    }
  }
  return { fields: out };
}

// Po uložení tasku zkusíme spustit AI agenta:
//   - když je ai_assignee=true && execution_mode='auto' && ai_status='idle'
//   - když preflight projde, přepneme ai_status idle→queued (worker si task vyzvedne)
//   - když preflight neprojde, vracíme issues v response, frontend je ukáže banner
// Vrátí { auto_enqueued: bool, ai_preflight: { issues, can_enqueue } | null }
//
// IMPORTANT: NIKDY nesmí throw – save tasku má vždy projít. Když preflight selže
// (např. chybí migrace projects.repo_url), zalogujeme a vrátíme generic issue,
// místo aby spadl celý POST/PUT. Express 4 nemá async error catching, takže
// neošetřená výjimka by request nechala viset = "flicker a nic se nestane".
async function maybeAutoEnqueue(task, userId) {
  if (!task.ai_assignee) return { auto_enqueued: false, ai_preflight: null };
  try {
    const pf = await preflightTask(task.id);
    if (pf.status === 404) return { auto_enqueued: false, ai_preflight: null };
    const result = {
      auto_enqueued: false,
      ai_preflight: { can_enqueue: pf.ok, issues: pf.issues },
    };
    // Auto-enqueue jen pro execution_mode='auto'. Pro 'manual' user musí kliknout
    // na „Spustit Claude" – preflight ale vrátíme, aby user viděl případné problémy.
    if (task.execution_mode !== 'auto') return result;
    if (!pf.ok) return result;
    if (task.ai_status !== 'idle') return result;

    await query(`UPDATE tasks SET ai_status = 'queued' WHERE id = $1`, [task.id]);
    await query(
      `INSERT INTO ai_agent_activity (task_id, action, details)
       VALUES ($1, 'enqueued_auto', $2::jsonb)`,
      [task.id, JSON.stringify({ user_id: userId, reason: 'task_saved_with_auto_mode' })]
    );
    result.auto_enqueued = true;
    return result;
  } catch (err) {
    // Typicky: migrace 2026-05-20-projects-repo-url.sql ještě neproběhla
    // (PG: column "repo_url" does not exist). Save tasku ale chceme zachovat,
    // jen uživateli ukážeme srozumitelné varování.
    console.error('[maybeAutoEnqueue]', err.message);
    return {
      auto_enqueued: false,
      ai_preflight: {
        can_enqueue: false,
        issues: [{
          severity: 'error',
          code: 'preflight_internal_error',
          message: `Preflight kontrola selhala (${err.code === '42703' ? 'chybí migrace projects.repo_url – restartuj server' : err.message}). Úkol byl uložen, ale agent se nespustil.`,
        }],
      },
    };
  }
}

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
    extra += ` AND t.status = $${params.length}`;
  }
  // Filter na current team – „Moje úkoly" ukazuje jen tasky z teamu, ve kterém právě jsem.
  // Pokud user není v žádném teamu (req.team_id chybí), vrátíme prázdno.
  if (!req.team_id) return res.json({ tasks: [] });
  params.push(req.team_id);
  const teamFilter = ` AND p.team_id = $${params.length}`;
  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.due_date AS project_due_date,
      p.manager_id AS project_manager_id,
      p.team_id AS project_team_id,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.to_user_id = $1 AND q.status = 'pending') AS pending_questions_for_me,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id)                          AS attachment_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.task_id = t.id)     AS logged_hours
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = $2 ${extra}${teamFilter}
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'done' THEN 3 END,
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      t.due_date NULLS LAST, t.due_date ASC
  `, params);
  res.json({ tasks: r.rows });
});

// GET /api/tasks/:id – detail jednoho úkolu s computed fields jako u /mine.
// Používá Questions (klik na zdrojový úkol otevře TaskDetailModal inline).
// Cross-team check: admin vidí všechno, jinak musí být task v current teamu.
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.due_date AS project_due_date,
      p.manager_id AS project_manager_id,
      p.team_id AS project_team_id,
      u.name AS assignee_name,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.to_user_id = $1 AND q.status = 'pending') AS pending_questions_for_me,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.task_id = t.id) AS logged_hours
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = $2
  `, [req.user.id, id]);
  const task = r.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });
  // Cross-team protection: jen admin nebo členové teamu projektu.
  if (req.user.role !== 'admin' && task.project_team_id !== req.team_id) {
    return res.status(403).json({ error: 'forbidden', message: 'Úkol patří do jiného teamu' });
  }
  res.json({ task });
});

// Vytvoření úkolu nebo podúkolu
router.post('/', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  const { project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date } = req.body || {};
  if (!project_id || !title) return res.status(400).json({ error: 'missing_fields' });

  // AI agent fields – validuje + filtruje + dopočítá defaulty
  const aiExtract = extractAiFields(req.body || {}, description);
  if (aiExtract.error) return res.status(400).json({ error: aiExtract.error, min: aiExtract.min });
  const ai = aiExtract.fields;

  const r = await query(`
    INSERT INTO tasks (
      project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date,
      ai_assignee, execution_mode, acceptance_criteria, out_of_scope, scope_paths, ai_status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15)
    RETURNING *
  `, [
    project_id, parent_id || null, title, description || null,
    assignee_id || null, status || 'todo', priority || 'normal',
    estimated_h || null, due_date || null,
    ai.ai_assignee, ai.execution_mode,
    JSON.stringify(ai.acceptance_criteria),
    JSON.stringify(ai.out_of_scope),
    JSON.stringify(ai.scope_paths),
    ai.ai_status,
  ]);
  const task = r.rows[0];
  // AI odhad na pozadí (neblokuje response)
  kickoffAIEstimate(task);

  // Auto-enqueue + preflight. Pokud něco brání (chybí repo_url, agent disabled, …),
  // vracíme issues spolu s taskem, frontend zobrazí banner.
  const { auto_enqueued, ai_preflight } = await maybeAutoEnqueue(task, req.user.id);
  if (auto_enqueued) task.ai_status = 'queued';
  res.json({ task, auto_enqueued, ai_preflight });
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

    // Assignee NEMŮŽE označit úkol jako 'done' přímo – musí přes review workflow.
    // Místo toho posílá in_progress → review. Schválit/vrátit pak manager.
    if ('status' in req.body && req.body.status === 'done') {
      return res.status(403).json({ error: 'must_go_via_review', message: 'Úkol nelze ukončit přímo. Předej ho k review tlačítkem „Předat k review", manager ho schválí.' });
    }

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

  // AI agent fields – pokud body nějaké posílá, validuj a aplikuj.
  // Pokud body žádné neposílá, ponecháme z DB (cur). Validace popisu / kritérií běží
  // proti finální podobě úkolu (kombinace cur + body).
  const aiTouched = ['ai_assignee','execution_mode','acceptance_criteria','out_of_scope','scope_paths','ai_status']
    .some(k => k in req.body);
  let newAi;
  if (aiTouched) {
    const aiExtract = extractAiFields(req.body, next.description);
    if (aiExtract.error) return res.status(400).json({ error: aiExtract.error, min: aiExtract.min });
    newAi = aiExtract.fields;
  } else {
    newAi = {
      ai_assignee: cur.ai_assignee,
      execution_mode: cur.execution_mode,
      acceptance_criteria: cur.acceptance_criteria,
      out_of_scope: cur.out_of_scope,
      scope_paths: cur.scope_paths,
      ai_status: cur.ai_status,
    };
  }

  // Prázdné stringy z UI převedeme na NULL pro DATE / FK / numeric sloupce.
  // Bez tohohle PG odmítne s "invalid input syntax for type date" apod.
  const nullableDate = (v) => (v === '' || v === undefined) ? null : v;
  const nullableNum  = (v) => (v === '' || v === undefined || v === null) ? null : Number(v);
  const nullableInt  = (v) => (v === '' || v === undefined || v === null) ? null : Number(v);

  const r = await query(`
    UPDATE tasks SET
      title = $1, description = $2, assignee_id = $3, status = $4,
      priority = $5, estimated_h = $6, due_date = $7, parent_id = $8,
      actual_h = $9, completed_at = $10, completed_by = $11,
      ai_assignee = $12, execution_mode = $13,
      acceptance_criteria = $14::jsonb, out_of_scope = $15::jsonb, scope_paths = $16::jsonb,
      ai_status = $17
    WHERE id = $18
    RETURNING *
  `, [next.title, next.description, nullableInt(next.assignee_id), next.status,
      next.priority, nullableNum(next.estimated_h), nullableDate(next.due_date), nullableInt(next.parent_id),
      newActualH, newCompletedAt, newCompletedBy,
      newAi.ai_assignee, newAi.execution_mode,
      JSON.stringify(newAi.acceptance_criteria),
      JSON.stringify(newAi.out_of_scope),
      JSON.stringify(newAi.scope_paths),
      newAi.ai_status,
      id]);

  // Pokud se změnil název nebo popis, re-spustíme AI odhad
  const titleChanged = req.body.title !== undefined && req.body.title !== cur.title;
  const descChanged  = req.body.description !== undefined && req.body.description !== cur.description;
  if (titleChanged || descChanged) {
    kickoffAIEstimate(r.rows[0]);
  }

  // Auto-enqueue + preflight – jen pokud se ai_assignee právě zapnul nebo
  // ai_status je 'idle' (užitečné, když user opraví popis a chce znovu spustit).
  const updated = r.rows[0];
  const aiJustEnabled = !cur.ai_assignee && updated.ai_assignee;
  const aiIdle = updated.ai_status === 'idle';
  let auto_enqueued = false;
  let ai_preflight = null;
  if (updated.ai_assignee && (aiJustEnabled || aiIdle)) {
    const r2 = await maybeAutoEnqueue(updated, req.user.id);
    auto_enqueued = r2.auto_enqueued;
    ai_preflight = r2.ai_preflight;
    if (auto_enqueued) updated.ai_status = 'queued';
  }

  res.json({ task: updated, auto_enqueued, ai_preflight });
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
