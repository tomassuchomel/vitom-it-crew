import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

// Pole, která logujeme do audit logu (PUT). Manager_id je číslo, name jmenné mapování níže.
const TRACKED_FIELDS = ['name', 'description', 'start_date', 'due_date', 'status', 'manager_id', 'budget', 'repo_url'];

// Human-readable popisky polí (pro audit log v UI)
const FIELD_LABELS = {
  name: 'Název', description: 'Popis',
  start_date: 'Začátek', due_date: 'Termín', status: 'Stav',
  manager_id: 'Manager', budget: 'Rozpočet',
  repo_url: 'GitHub repo URL',
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
  const r = await query(`
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
    FROM projects p
    LEFT JOIN users mu ON mu.id = p.manager_id
    ORDER BY effective_due_date NULLS LAST, p.created_at DESC
  `);
  const projects = r.rows;
  if (!showCosts) projects.forEach(p => { delete p.cost_so_far; delete p.budget; });
  res.json({ projects });
});

// Detail + úkoly
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const pR = await query(`
    SELECT p.*, mu.name AS manager_name,
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
    FROM projects p LEFT JOIN users mu ON mu.id = p.manager_id
    WHERE p.id = $1
  `, [id]);
  const project = pR.rows[0];
  if (!project) return res.status(404).json({ error: 'not_found' });

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

// Vytvoření – admin/manager
router.post('/', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  const { name, description, start_date, due_date, manager_id, budget, repo_url } = req.body || {};
  if (!name || !start_date) return res.status(400).json({ error: 'missing_fields' });
  const repoCheck = validateRepoUrl(repo_url);
  if (!repoCheck.ok) return res.status(400).json({ error: 'invalid_repo_url', message: repoCheck.error });
  const r = await query(`
    INSERT INTO projects (name, description, start_date, due_date, manager_id, budget, repo_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [name, description || null, start_date, due_date || null, manager_id || req.user.id, budget || null, repoCheck.value]);
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
  const r = await query(`
    UPDATE projects SET
      name = $1, description = $2, start_date = $3, due_date = $4,
      status = $5, manager_id = $6, budget = $7, repo_url = $8
    WHERE id = $9
    RETURNING *
  `, [next.name, next.description, next.start_date, nullableDate(next.due_date),
      next.status, next.manager_id || null, nullableNum(next.budget),
      next.repo_url || null, id]);

  // Log každé změny zvlášť
  for (const c of changes) {
    await query(`
      INSERT INTO project_edits (project_id, user_id, action, field, old_value, new_value)
      VALUES ($1, $2, 'update', $3, $4, $5)
    `, [id, req.user.id, c.field, c.old, c.new]);
  }

  res.json({ project: r.rows[0], changes });
});

// Smazání – admin/manager
router.delete('/:id', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  await query('DELETE FROM projects WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

export default router;
