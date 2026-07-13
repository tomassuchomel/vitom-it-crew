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
import { sendMail, buildTaskEmailHtml, getNotificationPrefs } from '../mailer.js';

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
  // ŽÁDNÝ team filter — admin/manager může přiřadit úkol napříč týmy,
  // assignee musí svůj úkol vidět bez ohledu na current team. Bezpečnost:
  // user vidí JEN to, co je jeho (t.assignee_id = userId), ne sourozenecké
  // úkoly toho projektu. Cross-team team_name pro UI badge.
  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.due_date AS project_due_date,
      p.manager_id AS project_manager_id,
      p.team_id AS project_team_id,
      tm.name AS project_team_name,
      cb.name AS created_by_name,
      -- Pro cross-team subtask masking: členství aktuálního usera v projektově teamu
      (EXISTS (SELECT 1 FROM team_members tmc WHERE tmc.user_id = $1 AND tmc.team_id = p.team_id)) AS user_is_team_member,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.to_user_id = $1 AND q.status = 'pending') AS pending_questions_for_me,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id)                          AS attachment_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.task_id = t.id)     AS logged_hours
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN teams tm ON tm.id = p.team_id
    LEFT JOIN users cb ON cb.id = t.created_by
    WHERE t.assignee_id = $2 ${extra}
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'done' THEN 3 END,
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      t.due_date NULLS LAST, t.due_date ASC
  `, params);
  const isAdmin = req.user.role === 'admin';
  const tasks = r.rows.map(t => {
    // Cross-team subtask masking: pokud subtask má parent_hidden=TRUE a
    // aktuální user je jen host assignee (ne admin, ne člen projektově teamu),
    // vymažeme parent + project info, aby řešitel nezjistil origin.
    if (t.parent_id && t.parent_hidden && !isAdmin && !t.user_is_team_member) {
      t.parent_id = null;
      t.project_name = '(mimo tým)';
      t.project_team_name = null;
    }
    delete t.user_is_team_member;
    return t;
  });
  res.json({ tasks });
});

// GET /api/tasks/search – hledání úkolů podle uživatele / týmu / projektu / stavu.
// Autorizace:
//   - Admin: kdokoli, jakýkoli tým (bez omezení)
//   - Ostatní: jen týmy, kterých jsou členem (implicitně)
// Bez ?team_id: non-admin vidí napříč všemi svými týmy; admin cross-team.
// STATICKÁ CESTA — musí být PŘED /:id.
router.get('/search', requireAuth, async (req, res) => {
  const assigneeId = Number(req.query.assignee_id) || null;
  const teamId     = Number(req.query.team_id) || null;
  const projectId  = Number(req.query.project_id) || null;
  const status     = req.query.status || null;
  const isAdmin    = req.user.role === 'admin';

  // Autorizační kontrola cílového týmu (non-admin)
  if (!isAdmin && teamId) {
    const check = await query(`SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2`, [req.user.id, teamId]);
    if (check.rows.length === 0) return res.status(403).json({ error: 'forbidden_team' });
  }

  const params = [];
  const where = [`t.assignee_id IS NOT NULL`];

  if (assigneeId) { params.push(assigneeId); where.push(`t.assignee_id = $${params.length}`); }
  if (teamId)     { params.push(teamId);     where.push(`p.team_id     = $${params.length}`); }
  else if (!isAdmin) {
    // Non-admin bez team filtru → jen mé týmy (implicit multi-team izolace).
    params.push(req.user.id);
    where.push(`p.team_id IN (SELECT team_id FROM team_members WHERE user_id = $${params.length})`);
  }
  if (projectId) { params.push(projectId); where.push(`t.project_id = $${params.length}`); }
  if (status)    { params.push(status);    where.push(`t.status     = $${params.length}`); }

  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.team_id,
      tm.name AS team_name,
      u.name AS assignee_name,
      u.avatar_updated_at AS assignee_avatar_updated_at
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN teams tm ON tm.id = p.team_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN t.status = 'done' THEN 1 ELSE 0 END,
      t.due_date NULLS LAST,
      t.id
    LIMIT 500
  `, params);
  res.json({ tasks: r.rows });
});

// GET /api/tasks/:id – detail jednoho úkolu s computed fields jako u /mine.
// Používá Questions (klik na zdrojový úkol otevře TaskDetailModal inline).
// Cross-team check: admin vidí všechno; člen teamu projektu vidí; ASSIGNEE
// vidí svůj úkol i z jiného teamu (cross-team host přístup) — vidí jen ten
// jeden úkol, ne sourozence / projekt / tým.
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const r = await query(`
    SELECT t.*,
      p.name AS project_name,
      p.due_date AS project_due_date,
      p.manager_id AS project_manager_id,
      p.team_id AS project_team_id,
      tm.name AS project_team_name,
      u.name AS assignee_name,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.to_user_id = $1 AND q.status = 'pending') AS pending_questions_for_me,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.task_id = t.id) AS logged_hours
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN teams tm ON tm.id = p.team_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = $2
  `, [req.user.id, id]);
  const task = r.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });
  // Autorizace: admin nebo členem teamu projektu nebo přímý assignee.
  const isAdmin    = req.user.role === 'admin';
  const isInTeam   = task.project_team_id === req.team_id;
  const isAssignee = task.assignee_id === req.user.id;
  if (!isAdmin && !isInTeam && !isAssignee) {
    return res.status(403).json({ error: 'forbidden', message: 'Úkol patří do jiného teamu' });
  }
  // Skrytí parent info pro cross-team subtask assignee.
  // Když je task subtask (má parent_id), parent_hidden=TRUE a user je JEN
  // subtask assignee (ne parent assignee ani člen týmu, ani admin) →
  // vymažeme parent_id a project_name, aby řešitel nezjistil, z kterého
  // úkolu/projektu podúkol vznikl.
  if (task.parent_id && task.parent_hidden) {
    let isParentAssignee = false;
    if (task.parent_id) {
      const pa = await query('SELECT assignee_id FROM tasks WHERE id = $1', [task.parent_id]);
      isParentAssignee = pa.rows[0]?.assignee_id === req.user.id;
    }
    if (!isAdmin && !isInTeam && !isParentAssignee) {
      // Řešitel podúkolu — parent info se nesmí projevit
      task.parent_id = null;
      task.project_name = '(mimo tým)';
      task.project_team_name = null;
    }
  }
  res.json({ task });
});

// Vytvoření úkolu nebo podúkolu
router.post('/', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  const { project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date, source_note_id, parent_hidden } = req.body || {};
  if (!project_id || !title) return res.status(400).json({ error: 'missing_fields' });

  // Autorizace vytvoření:
  //  a) admin globálně
  //  b) user je členem teamu projektu (běžný případ)
  //  c) SUBTASK: user je assignee parent_id → cross-team podúkol
  //     (Patricia dostane úkol z IT, přidá podúkol pro svůj Management tým)
  if (req.user.role !== 'admin') {
    const memberR = await query(`
      SELECT 1 FROM projects p
      JOIN team_members tm ON tm.team_id = p.team_id
      WHERE p.id = $1 AND tm.user_id = $2
      LIMIT 1
    `, [Number(project_id), req.user.id]);
    const isTeamMember = memberR.rows.length > 0;

    let isParentAssignee = false;
    if (!isTeamMember && parent_id) {
      const pr = await query(
        `SELECT 1 FROM tasks WHERE id = $1 AND assignee_id = $2 LIMIT 1`,
        [Number(parent_id), req.user.id]
      );
      isParentAssignee = pr.rows.length > 0;
    }

    if (!isTeamMember && !isParentAssignee) {
      return res.status(403).json({ error: 'not_team_member', message: 'Nejsi členem teamu tohoto projektu.' });
    }
  }

  // AI agent fields – validuje + filtruje + dopočítá defaulty
  const aiExtract = extractAiFields(req.body || {}, description);
  if (aiExtract.error) return res.status(400).json({ error: aiExtract.error, min: aiExtract.min });
  const ai = aiExtract.fields;

  // Defenzivně: source_note_id + parent_hidden mohly být přidány migrací
  // až po staré INSERT verzi. Fallback bez nich → warning.
  const insertSql = ({ withSource, withHidden }) => `
    INSERT INTO tasks (
      project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date,
      ai_assignee, execution_mode, acceptance_criteria, out_of_scope, scope_paths, ai_status${withSource ? ', source_note_id' : ''}${withHidden ? ', parent_hidden' : ''}
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15${withSource ? `, $${withHidden ? 16 : 16}` : ''}${withHidden ? `, $${withSource ? 17 : 16}` : ''})
    RETURNING *
  `;
  const baseParams = [
    project_id, parent_id || null, title, description || null,
    assignee_id || null, status || 'todo', priority || 'normal',
    estimated_h || null, due_date || null,
    ai.ai_assignee, ai.execution_mode,
    JSON.stringify(ai.acceptance_criteria),
    JSON.stringify(ai.out_of_scope),
    JSON.stringify(ai.scope_paths),
    ai.ai_status,
  ];
  const hiddenVal = parent_hidden === false ? false : true; // default TRUE
  const sourceVal = source_note_id ? Number(source_note_id) : null;
  let r;
  try {
    r = await query(insertSql({ withSource: true, withHidden: true }), [...baseParams, sourceVal, hiddenVal]);
  } catch (err) {
    if (err.code === '42703') {
      // Zkusíme s vypnutými sloupci — kdyby chybělo obé nebo jen jedno
      console.warn('[tasks] optional column missing, falling back:', err.message?.slice(0, 100));
      try {
        r = await query(insertSql({ withSource: true, withHidden: false }), [...baseParams, sourceVal]);
      } catch (err2) {
        if (err2.code === '42703') {
          r = await query(insertSql({ withSource: false, withHidden: false }), baseParams);
        } else { throw err2; }
      }
    } else { throw err; }
  }
  const task = r.rows[0];
  // Ulož zadavatele úkolu (pro workflow "žádost o změnu termínu").
  // Defenzivně — kdyby migrace 2026-07-07 ještě nedoběhla, sloupec neexistuje.
  try {
    await query(`UPDATE tasks SET created_by = $1 WHERE id = $2`, [req.user.id, task.id]);
    task.created_by = req.user.id;
  } catch (err) {
    if (err.code !== '42703') throw err;
    console.warn('[tasks] created_by column not present; skipping');
  }
  // AI odhad na pozadí (neblokuje response)
  kickoffAIEstimate(task);

  // Auto-enqueue + preflight. Pokud něco brání (chybí repo_url, agent disabled, …),
  // vracíme issues spolu s taskem, frontend zobrazí banner.
  const { auto_enqueued, ai_preflight } = await maybeAutoEnqueue(task, req.user.id);
  if (auto_enqueued) task.ai_status = 'queued';
  res.json({ task, auto_enqueued, ai_preflight });

  // Email assignee (fire-and-forget). Jen pokud assignee != creator a má pref ON.
  if (task.assignee_id && task.assignee_id !== req.user.id) {
    notifyTaskAssigned(task, req.user).catch(e => console.warn('[mail/task-assigned]', e.message));
  }
});

async function notifyTaskAssigned(task, creator) {
  console.log(`[mail/task-assigned] hook fired: task=${task.id} assignee=${task.assignee_id} creator=${creator.id}`);
  const prefs = await getNotificationPrefs(task.assignee_id);
  if (!prefs.email_task_assigned) {
    console.log(`[mail/task-assigned] SKIP: user ${task.assignee_id} opted out (email_task_assigned=false)`);
    return;
  }
  const r = await query(`SELECT email, name, active FROM users WHERE id = $1`, [task.assignee_id]);
  const assignee = r.rows[0];
  if (!assignee) {
    console.log(`[mail/task-assigned] SKIP: user ${task.assignee_id} not found in DB`);
    return;
  }
  if (!assignee.active) {
    console.log(`[mail/task-assigned] SKIP: user ${task.assignee_id} (${assignee.name}) is NOT active`);
    return;
  }
  if (!assignee.email) {
    console.log(`[mail/task-assigned] SKIP: user ${task.assignee_id} (${assignee.name}) has NULL email`);
    return;
  }
  console.log(`[mail/task-assigned] proceeding: sending to ${assignee.email}`);
  const projR = await query(`SELECT name FROM projects WHERE id = $1`, [task.project_id]);
  const projectName = projR.rows[0]?.name || '';
  const html = buildTaskEmailHtml({
    title: `✅ Nový úkol: ${task.title}`,
    body: `<p><strong>${escapeForBody(creator.name || 'Někdo')}</strong> ti přiřadil úkol v projektu <strong>${escapeForBody(projectName)}</strong>.</p>`
      + (task.description ? `<p style="background:#f9f6f1;padding:10px;border-radius:6px;font-size:13px;color:#365156;">${escapeForBody(task.description).slice(0, 500)}</p>` : ''),
    taskId: task.id,
  });
  await sendMail({
    to: assignee.email,
    subject: `VITOM: Nový úkol — ${task.title}`,
    html,
  });
}

function escapeForBody(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

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

  // Gate na změnu termínu: přímo mohou creator, admin nebo (fallback pro
  // legacy tasky bez created_by) manager projektu. Ostatní musí přes
  // žádost o změnu termínu → FE zachytí 'requires_due_change_request'
  // a otevře modal.
  if ('due_date' in req.body) {
    const iso = (d) => d ? String(d).slice(0, 10) : null;
    if (iso(req.body.due_date) !== iso(cur.due_date)) {
      const isCreator = cur.created_by && cur.created_by === req.user.id;
      const isAdmin = req.user.role === 'admin';
      let hasDirect = isCreator || isAdmin;
      if (!hasDirect && !cur.created_by) {
        const p = await query('SELECT manager_id FROM projects WHERE id = $1', [cur.project_id]);
        if (p.rows[0]?.manager_id === req.user.id) hasDirect = true;
      }
      if (!hasDirect) {
        return res.status(400).json({
          error: 'requires_due_change_request',
          message: 'Termín tohoto úkolu můžeš posunout jen přes žádost o změnu termínu.',
        });
      }
    }
  }

  if (!can.createTasks(req.user)) {
    // Externí dev / běžný assignee může u VLASTNÍHO úkolu měnit jen status, popis (poznámku) nebo actual_h.
    if (cur.assignee_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    // due_date je zde povolený, protože gate check výše už rozhodl, zda smí projít
    // (creator/admin/manager projektu) nebo musí přes žádost.
    const allowed = ['status', 'description', 'actual_h', 'due_date'];
    const keys = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (keys.length === 0) return res.status(400).json({ error: 'no_allowed_fields' });

    // Self-assigned úkol (created_by = assignee_id = user): review nedává smysl —
    // kdo by ho schvaloval? Přepneme review → done automaticky.
    const isSelfAssigned = cur.created_by && cur.created_by === req.user.id;
    if ('status' in req.body && req.body.status === 'review' && isSelfAssigned) {
      req.body.status = 'done';
    }
    // Assignee NEMŮŽE označit úkol jako 'done' přímo – musí přes review workflow.
    // Výjimka: self-assigned tasky (viz výše).
    if ('status' in req.body && req.body.status === 'done' && !isSelfAssigned) {
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
    if ('due_date' in req.body) { params.push(req.body.due_date || null); sets.push(`due_date = $${params.length}`); }
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
