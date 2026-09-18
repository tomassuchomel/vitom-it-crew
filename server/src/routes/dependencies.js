// Návaznosti mezi úkoly (sekce 15 zadání).
//
//   GET    /dependencies/task/:taskId   – { waiting_on, blocking }
//   POST   /dependencies/task/:taskId   – { depends_on_id } → úkol začne čekat
//   DELETE /dependencies/:id            – zrušit vazbu
//
// Směr vazby: task_id ČEKÁ NA depends_on_id. „Blokuje" je tentýž řádek
// čtený z druhé strany.

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

// Načte úkol + práva uživatele k němu. Vazby se smí měnit v rámci týmu,
// do kterého úkol patří — jinak by šlo propojovat úkoly napříč týmy.
async function loadTaskAccess(taskId, user, teamId) {
  const t = (await query(`
    SELECT t.id, t.title, t.project_id, p.team_id, p.manager_id
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = $1
  `, [taskId])).rows[0];
  if (!t) return null;

  const isAdmin = user.role === 'admin';
  // Bez platného team kontextu nepracujeme. req.team_id je undefined i když
  // klient pošle X-Team-Id týmu, kde není členem — podmiňovat kontrolu jeho
  // existencí by tu díru otevřelo dokořán.
  if (!isAdmin && (!teamId || t.team_id !== teamId)) {
    return { task: t, isMember: false, canEdit: false };
  }
  let isMember = isAdmin;
  if (!isMember) {
    const m = await query(
      'SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1',
      [user.id, t.team_id]
    );
    isMember = m.rows.length > 0;
  }
  const canEdit = isAdmin || t.manager_id === user.id || (can.createTasks(user) && isMember);
  return { task: t, isMember, canEdit };
}

// Vznikl by přidáním vazby cyklus? Jdeme od budoucího blokujícího úkolu po
// jeho vlastních závislostech — když mezi nimi najdeme blokovaný úkol,
// vazba by kruh uzavřela (A→B, B→C, C→A).
async function wouldCreateCycle(taskId, dependsOnId) {
  const r = await query(`
    WITH RECURSIVE chain AS (
      SELECT depends_on_id AS node FROM task_dependencies WHERE task_id = $1
      UNION
      SELECT d.depends_on_id
      FROM task_dependencies d
      JOIN chain c ON d.task_id = c.node
    )
    SELECT 1 FROM chain WHERE node = $2 LIMIT 1
  `, [dependsOnId, taskId]);
  return r.rows.length > 0;
}

const SELECT_DEP = `
  SELECT d.id, d.task_id, d.depends_on_id, d.created_at,
         t.title, t.status, t.due_date::text AS due_date,
         u.name AS assignee_name,
         p.name AS project_name
  FROM task_dependencies d
  JOIN tasks t ON t.id = %OTHER%
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN projects p ON p.id = t.project_id
`;

router.get('/task/:taskId', requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const acc = await loadTaskAccess(taskId, req.user, req.team_id);
  if (!acc) return res.status(404).json({ error: 'not_found' });
  if (!acc.isMember) return res.status(403).json({ error: 'forbidden' });

  // „Čeká na" = řádky, kde je úkol tím blokovaným; zobrazujeme protistranu.
  // Filtr na tým i u protistrany: kdyby cross-team vazba přesto vznikla
  // (admin ji založit může), nesmí přes ni prosáknout název cizího úkolu.
  const teamGuard = req.user.role === 'admin' ? '' : 'AND p.team_id = $2';
  const params = req.user.role === 'admin' ? [taskId] : [taskId, acc.task.team_id];
  const waitingOn = await query(
    `${SELECT_DEP.replace('%OTHER%', 'd.depends_on_id')} WHERE d.task_id = $1 ${teamGuard} ORDER BY d.id`,
    params
  );
  const blocking = await query(
    `${SELECT_DEP.replace('%OTHER%', 'd.task_id')} WHERE d.depends_on_id = $1 ${teamGuard} ORDER BY d.id`,
    params
  );
  res.json({ waiting_on: waitingOn.rows, blocking: blocking.rows, can_edit: acc.canEdit });
});

router.post('/task/:taskId', requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const rawDep = req.body?.depends_on_id;
  const dependsOnId = (typeof rawDep === 'number' || typeof rawDep === 'string') ? Number(rawDep) : NaN;
  if (!Number.isInteger(taskId) || !Number.isInteger(dependsOnId)) {
    return res.status(400).json({ error: 'validation', message: 'Neplatné ID úkolu.' });
  }
  if (taskId === dependsOnId) {
    return res.status(400).json({ error: 'self_dependency', message: 'Úkol nemůže čekat sám na sebe.' });
  }

  const acc = await loadTaskAccess(taskId, req.user, req.team_id);
  if (!acc) return res.status(404).json({ error: 'not_found' });
  if (!acc.canEdit) return res.status(403).json({ error: 'forbidden' });

  // I druhý úkol musí být v dosahu uživatele, jinak by šlo přes vazbu
  // vytáhnout názvy úkolů z cizího týmu.
  const other = await loadTaskAccess(dependsOnId, req.user, req.team_id);
  if (!other) return res.status(404).json({ error: 'not_found', message: 'Druhý úkol neexistuje.' });
  if (!other.isMember) return res.status(403).json({ error: 'forbidden', message: 'Na úkol z jiného týmu navázat nelze.' });

  if (await wouldCreateCycle(taskId, dependsOnId)) {
    return res.status(400).json({
      error: 'cycle',
      message: 'Tahle vazba by vytvořila kruh — úkoly by na sebe čekaly navzájem.',
    });
  }

  try {
    const r = await query(`
      INSERT INTO task_dependencies (task_id, depends_on_id, created_by)
      VALUES ($1, $2, $3) RETURNING id
    `, [taskId, dependsOnId, req.user.id]);
    const out = await query(
      `${SELECT_DEP.replace('%OTHER%', 'd.depends_on_id')} WHERE d.id = $1`,
      [r.rows[0].id]
    );
    res.status(201).json({ dependency: out.rows[0] });
  } catch (err) {
    // 23505 = unique_violation → vazba už existuje.
    if (err.code === '23505') {
      return res.status(400).json({ error: 'duplicate', message: 'Tahle návaznost už existuje.' });
    }
    throw err;
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const dep = (await query('SELECT task_id FROM task_dependencies WHERE id = $1', [id])).rows[0];
  if (!dep) return res.status(404).json({ error: 'not_found' });

  const acc = await loadTaskAccess(dep.task_id, req.user, req.team_id);
  if (!acc?.canEdit) return res.status(403).json({ error: 'forbidden' });

  await query('DELETE FROM task_dependencies WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
