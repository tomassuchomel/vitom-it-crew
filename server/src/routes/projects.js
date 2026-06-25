import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

// Pole, která logujeme do audit logu (PUT). Manager_id je číslo, name jmenné mapování níže.
const TRACKED_FIELDS = ['name', 'description', 'start_date', 'due_date', 'status', 'manager_id',
                        'responsible_id', 'budget', 'repo_url', 'no_timeline', 'hidden_from_timeline'];

// Human-readable popisky polí (pro audit log v UI)
const FIELD_LABELS = {
  name: 'Název', description: 'Popis',
  start_date: 'Začátek', due_date: 'Termín', status: 'Stav',
  manager_id: 'Manager', responsible_id: 'Zodpovědnost', budget: 'Rozpočet',
  repo_url: 'GitHub repo URL',
  no_timeline: 'Bez časového ohraničení',
  hidden_from_timeline: 'Skryto v Timeline',
};

// Validace repo_url – základní sanitka: HTTPS GitHub URL, žádné podivnosti.
// Detailnější ověření (existence repa, scope tokenu) řeší až worker při preflight.
function validateRepoUrl(v) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'repo_url musí být string' };
  const trimmed = v.trim();
  if (trimmed.length > 500) return { ok: false, error: 'repo_url je příliš dlouhý' };
  // GitHub HTTPS nebo SSH formát
  const ok = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/i.test(trimmed)
    || /^git@github\.com:[\w.-]+\/[\w.-]+\.git$/i.test(trimmed);
  if (!ok) return { ok: false, error: 'repo_url musí být GitHub URL (https://github.com/owner/repo nebo git@github.com:owner/repo.git)' };
  return { ok: true, value: trimmed.replace(/\/$/, '') };
}

// Seznam projektů s agregacemi (+ estimated_h_total pro Timeline)
//
// effective_due_date: pokud projekt nemá svůj termín, použije se nejbližší termín
// AKTIVNÍHO úkolu (status != 'done', due_date IS NOT NULL). Jakmile úkol skončí,
// termín se zase ztratí a projekt spadne na konec seznamu.
router.get('/', requireAuth, async (req, res) => {
  const showCosts = can.seeCosts(req.user);
  const scopeAll = req.query.scope === 'all';

  // Cross-team scope: admin/manager/senior_dev (= can.createTasks) může vidět
  // projekty napříč VŠEMI týmy, kde je členem (admin globálně). Pro výběr
  // projektu při zakládání úkolu — user.role je už ověřena dál v POST /tasks.
  if (scopeAll) {
    if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
    const isAdmin = req.user.role === 'admin';
    const r = await query(`
      SELECT p.id, p.name, p.team_id, p.status, p.due_date,
             t.name AS team_name,
             mu.name AS manager_name
      FROM projects p
      JOIN teams t ON t.id = p.team_id
      LEFT JOIN users mu ON mu.id = p.manager_id
      ${isAdmin ? '' : 'JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = $1'}
      WHERE p.status = 'active'
      ORDER BY t.name, p.name
    `, isAdmin ? [] : [req.user.id]);
    return res.json({ projects: r.rows });
  }

  // Default: filter na current team. Bez team kontextu (user není v žádném teamu) vrátíme prázdno.
  if (!req.team_id) return res.json({ projects: [] });

  // Hlavní query s responsible_name. Pokud sloupec ještě neexistuje
  // (migrace nedoběhla), zachytíme PostgreSQL 42703 a zkusíme fallback.
  const buildQuery = (withResponsible) => `
    SELECT p.*,
      COALESCE(p.due_date,
        (SELECT MIN(t.due_date) FROM tasks t
          WHERE t.project_id = p.id AND t.status != 'done' AND t.due_date IS NOT NULL)
      ) AS effective_due_date,
      CASE
        WHEN p.due_date IS NOT NULL THEN 'project'
        WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.status != 'done' AND t.due_date IS NOT NULL) THEN 'task'
        ELSE NULL
      END AS due_source,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.project_id = p.id) AS hours_logged,
      (SELECT COALESCE(SUM(t.estimated_h), 0) FROM tasks t WHERE t.project_id = p.id) AS estimated_h_total,
      (SELECT COALESCE(SUM(t.estimated_h), 0) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS estimated_h_remaining,
      (SELECT COALESCE(SUM(te.hours * u.hourly_rate), 0)
         FROM time_entries te JOIN users u ON u.id = te.user_id
         WHERE te.project_id = p.id) AS cost_so_far,
      mu.name AS manager_name
      ${withResponsible ? ', ru.name AS responsible_name' : ''}
    FROM projects p
    LEFT JOIN users mu ON mu.id = p.manager_id
    ${withResponsible ? 'LEFT JOIN users ru ON ru.id = p.responsible_id' : ''}
    WHERE p.team_id = $1
    ORDER BY effective_due_date NULLS LAST, p.created_at DESC
  `;

  let r;
  try {
    r = await query(buildQuery(true), [req.team_id]);
  } catch (err) {
    // 42703 = undefined_column. Migrace responsible_id ještě nedoběhla — fallback.
    if (err.code === '42703') {
      console.warn('[projects] responsible_id column missing, falling back without it');
      r = await query(buildQuery(false), [req.team_id]);
    } else {
      throw err;
    }
  }
  const projects = r.rows;
  if (!showCosts) projects.forEach(p => { delete p.cost_so_far; delete p.budget; });
  res.json({ projects });
});

// Detail + úkoly
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  // Defenzivně proti scénáři, kdy migrace responsible_id nedoběhla.
  const buildDetailQuery = (withResp) => `
    SELECT p.*, mu.name AS manager_name${withResp ? ', ru.name AS responsible_name' : ''},
      COALESCE(p.due_date,
        (SELECT MIN(t.due_date) FROM tasks t
          WHERE t.project_id = p.id AND t.status != 'done' AND t.due_date IS NOT NULL)
      ) AS effective_due_date,
      CASE
        WHEN p.due_date IS NOT NULL THEN 'project'
        WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.status != 'done' AND t.due_date IS NOT NULL) THEN 'task'
        ELSE NULL
      END AS due_source,
      (SELECT COALESCE(SUM(t.estimated_h), 0) FROM tasks t WHERE t.project_id = p.id) AS estimated_h_total
    FROM projects p
    LEFT JOIN users mu ON mu.id = p.manager_id
    ${withResp ? 'LEFT JOIN users ru ON ru.id = p.responsible_id' : ''}
    WHERE p.id = $1
  `;
  let pR;
  try {
    pR = await query(buildDetailQuery(true), [id]);
  } catch (err) {
    if (err.code === '42703') {
      console.warn('[projects/:id] responsible_id column missing, falling back');
      pR = await query(buildDetailQuery(false), [id]);
    } else {
      throw err;
    }
  }
  const project = pR.rows[0];
  if (!project) return res.status(404).json({ error: 'not_found' });
  // Cross-team access: user musí být členem teamu, do kterého projekt patří.
  // Admin (globální) může všechno, jinak vyžadujeme team membership.
  if (req.user.role !== 'admin' && project.team_id !== req.team_id) {
    return res.status(403).json({ error: 'forbidden', message: 'Projekt patří do jiného teamu' });
  }

  const tR = await query(`
    SELECT t.*,
      u.name AS assignee_name,
      $2::int AS project_manager_id,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'pending')  AS pending_q,
      (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id AND q.status = 'answered') AS answered_q,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count,
      (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.task_id = t.id) AS logged_hours
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = $1
    ORDER BY COALESCE(t.parent_id, t.id), t.id
  `, [id, project.manager_id]);

  if (!can.seeCosts(req.user)) { delete project.budget; }
  res.json({ project, tasks: tR.rows });
});

// Historie změn projektu
router.get('/:id/edits', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`
    SELECT pe.*, u.name AS user_name
    FROM project_edits pe
    JOIN users u ON u.id = pe.user_id
    WHERE pe.project_id = $1
    ORDER BY pe.created_at DESC
    LIMIT 100
  `, [id]);
  // doplníme čitelný label pole
  const edits = r.rows.map(e => ({ ...e, field_label: e.field ? (FIELD_LABELS[e.field] || e.field) : null }));
  res.json({ edits });
});

// Vytvoření – admin/manager. Projekt vznikne v aktuálně přepnutém teamu (req.team_id).
router.post('/', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  if (!req.team_id) return res.status(400).json({ error: 'no_team_context', message: 'Pro vytvoření projektu musíš být členem nějakého teamu.' });
  const {
    name, description, start_date, due_date, manager_id, responsible_id, budget, repo_url,
    no_timeline, hidden_from_timeline,
  } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_fields' });
  // start_date je povinné JEN pokud projekt má časové ohraničení (no_timeline = false).
  const noTimeline = !!no_timeline;
  if (!noTimeline && !start_date) {
    return res.status(400).json({ error: 'missing_start_date', message: 'Projekt s časovým ohraničením musí mít začátek.' });
  }
  const repoCheck = validateRepoUrl(repo_url);
  if (!repoCheck.ok) return res.status(400).json({ error: 'invalid_repo_url', message: repoCheck.error });
  const r = await query(`
    INSERT INTO projects (name, description, start_date, due_date, manager_id, responsible_id, budget, repo_url, team_id,
                          no_timeline, hidden_from_timeline)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [
    name, description || null,
    // Pokud no_timeline, start/due ignorujeme (uložíme NULL)
    noTimeline ? null : start_date,
    noTimeline ? null : (due_date || null),
    manager_id || req.user.id,
    responsible_id || null,
    budget || null, repoCheck.value, req.team_id,
    noTimeline, !!hidden_from_timeline,
  ]);
  const project = r.rows[0];
  // log create
  await query(`INSERT INTO project_edits (project_id, user_id, action, note) VALUES ($1, $2, 'create', $3)`,
    [project.id, req.user.id, `Vytvořen projekt "${project.name}"`]);
  res.json({ project });
});

// Edit – admin/manager. Loguje každé změněné pole zvlášť.
router.put('/:id', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM projects WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  // Cross-team protection: jen admin nebo členové teamu projektu.
  if (req.user.role !== 'admin' && cur.team_id !== req.team_id) {
    return res.status(403).json({ error: 'forbidden', message: 'Projekt patří do jiného teamu' });
  }

  // Detekce změněných polí
  const next = { ...cur };
  const changes = [];
  for (const f of TRACKED_FIELDS) {
    if (!(f in req.body)) continue;
    let newVal = req.body[f];
    // normalizace: datumy přijdou jako 'YYYY-MM-DD', v DB jsou jako Date objekt
    let oldVal = cur[f];
    if (oldVal instanceof Date) oldVal = oldVal.toISOString().slice(0, 10);
    // hodnoty jako různé typy → porovnáme jako string
    const oldS = oldVal === null || oldVal === undefined ? '' : String(oldVal);
    const newS = newVal === null || newVal === undefined ? '' : String(newVal);
    if (oldS !== newS) {
      changes.push({ field: f, old: oldS, new: newS });
      next[f] = newVal;
    }
  }

  if (changes.length === 0) {
    return res.json({ project: cur, edits: [] });
  }

  // Validace repo_url pokud se mění
  if ('repo_url' in req.body) {
    const rc = validateRepoUrl(req.body.repo_url);
    if (!rc.ok) return res.status(400).json({ error: 'invalid_repo_url', message: rc.error });
    next.repo_url = rc.value;
  }

  // Update v DB. Prázdný string z UI převedeme na NULL pro DATE / FK sloupce.
  const nullableDate = (v) => (v === '' || v === undefined) ? null : v;
  const nullableNum  = (v) => (v === '' || v === undefined || v === null) ? null : Number(v);

  // Pokud projekt teď nemá časové ohraničení (no_timeline = true), nulujeme
  // start_date i due_date — drží nás to v konzistentním stavu (jinak by tam
  // mohlo zůstat staré datum z dřívější editace).
  const noTimeline = !!next.no_timeline;
  const finalStartDate = noTimeline ? null : nullableDate(next.start_date);
  const finalDueDate   = noTimeline ? null : nullableDate(next.due_date);

  const r = await query(`
    UPDATE projects SET
      name = $1, description = $2, start_date = $3, due_date = $4,
      status = $5, manager_id = $6, responsible_id = $7, budget = $8, repo_url = $9,
      no_timeline = $10, hidden_from_timeline = $11
    WHERE id = $12
    RETURNING *
  `, [next.name, next.description, finalStartDate, finalDueDate,
      next.status, next.manager_id || null, next.responsible_id || null, nullableNum(next.budget),
      next.repo_url || null, noTimeline, !!next.hidden_from_timeline, id]);

  // Log každé změny zvlášť
  for (const c of changes) {
    await query(`
      INSERT INTO project_edits (project_id, user_id, action, field, old_value, new_value)
      VALUES ($1, $2, 'update', $3, $4, $5)
    `, [id, req.user.id, c.field, c.old, c.new]);
  }

  res.json({ project: r.rows[0], changes });
});

// Smazání – admin/manager + jen v rámci current teamu (nebo admin globálně)
router.delete('/:id', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  const r = await query('SELECT team_id FROM projects WHERE id = $1', [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && r.rows[0].team_id !== req.team_id) {
    return res.status(403).json({ error: 'forbidden', message: 'Projekt patří do jiného teamu' });
  }
  await query('DELETE FROM projects WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
