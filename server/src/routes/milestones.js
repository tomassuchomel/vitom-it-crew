// Projektové milníky (sekce 4 zadání) — části projektu s vlastním termínem.
//
//   GET    /milestones/project/:projectId          – seznam
//   POST   /milestones/project/:projectId          – přidat
//   PATCH  /milestones/:id                         – upravit (název, termín, vazba na úkol)
//   DELETE /milestones/:id                         – smazat
//   PUT    /milestones/project/:projectId/reorder  – přeuspořádat
//
// Číst smí člen týmu projektu, měnit vedoucí projektu / manager / admin.

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const router = Router();

const trim = (v) => String(v || '').trim();

// Datum: prázdné → null (milník bez termínu je v pořádku), platné → string,
// nesmysl → undefined. Rozlišujeme to, protože tvar „2026-02-31" projde
// regexem, ale PostgreSQL na něm spadne — a my chceme vrátit 400, ne 500.
const DATE_INVALID = undefined;
function asDate(v) {
  const s = trim(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return DATE_INVALID;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return DATE_INVALID;
  return s;
}

// task_id: prázdné → null, celé číslo → číslo, cokoli jiného → undefined.
// Bez kontroly na celé číslo by "1.5" propadlo do dotazu a shodilo ho.
const ID_INVALID = undefined;
function asTaskId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : ID_INVALID;
}

// Načte projekt + práva aktuálního uživatele k němu.
// Vrací null, když projekt neexistuje.
async function loadProjectAccess(projectId, user, teamId) {
  const p = (await query('SELECT id, team_id, manager_id FROM projects WHERE id = $1', [projectId])).rows[0];
  if (!p) return null;
  const isAdmin = user.role === 'admin';
  // Stejné pravidlo jako ve zbytku repa (projects.js): mimo aktuálně zvolený
  // tým se na projekt nesahá, i kdyby v něm uživatel byl členem.
  if (!isAdmin && teamId && p.team_id !== teamId) return { project: p, isMember: false, canEdit: false };
  let isMember = isAdmin;
  if (!isMember) {
    const m = await query(
      'SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1',
      [user.id, p.team_id]
    );
    isMember = m.rows.length > 0;
  }
  // Měnit milníky smí vedoucí projektu (Project Manager), manager týmu, admin.
  const canEdit = isAdmin || p.manager_id === user.id || (can.manageProjects(user) && isMember);
  return { project: p, isMember, canEdit };
}

// Milník i úkol musí patřit témuž projektu, jinak by šlo provázat napříč týmy.
async function taskBelongsToProject(taskId, projectId) {
  const r = await query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2 LIMIT 1', [taskId, projectId]);
  return r.rows.length > 0;
}

const SELECT_FULL = `
  SELECT m.id, m.project_id, m.name, m.deadline::text AS deadline, m.position,
         m.task_id, m.created_by, m.created_at, m.updated_at,
         t.title AS task_title, t.status AS task_status,
         u.name AS created_by_name
  FROM project_milestones m
  LEFT JOIN tasks t ON t.id = m.task_id
  LEFT JOIN users u ON u.id = m.created_by
`;

router.get('/project/:projectId', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const acc = await loadProjectAccess(projectId, req.user, req.team_id);
  if (!acc) return res.status(404).json({ error: 'not_found' });
  if (!acc.isMember) return res.status(403).json({ error: 'forbidden' });

  const r = await query(`${SELECT_FULL} WHERE m.project_id = $1 ORDER BY m.position, m.id`, [projectId]);
  res.json({ milestones: r.rows, can_edit: acc.canEdit });
});

router.post('/project/:projectId', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const acc = await loadProjectAccess(projectId, req.user, req.team_id);
  if (!acc) return res.status(404).json({ error: 'not_found' });
  if (!acc.canEdit) return res.status(403).json({ error: 'forbidden' });

  const name = trim(req.body?.name);
  if (!name) return res.status(400).json({ error: 'validation', fields: { name: 'Vyplň název milníku.' } });
  if (name.length > 300) {
    return res.status(400).json({ error: 'validation', fields: { name: 'Název je delší než 300 znaků.' } });
  }

  const deadline = asDate(req.body?.deadline);
  if (deadline === DATE_INVALID) {
    return res.status(400).json({ error: 'validation', fields: { deadline: 'Neplatné datum. Použij formát RRRR-MM-DD.' } });
  }

  const taskId = asTaskId(req.body?.task_id);
  if (taskId === ID_INVALID) {
    return res.status(400).json({ error: 'validation', fields: { task_id: 'Neplatný úkol.' } });
  }
  if (taskId && !await taskBelongsToProject(taskId, projectId)) {
    return res.status(400).json({ error: 'validation', fields: { task_id: 'Úkol nepatří do tohoto projektu.' } });
  }

  // Nový milník jde na konec seznamu.
  const pos = (await query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM project_milestones WHERE project_id = $1',
    [projectId]
  )).rows[0].next;

  const r = await query(`
    INSERT INTO project_milestones (project_id, name, deadline, position, task_id, created_by)
    VALUES ($1, $2, $3::date, $4, $5, $6) RETURNING id
  `, [projectId, name, deadline, pos, taskId, req.user.id]);

  const out = await query(`${SELECT_FULL} WHERE m.id = $1`, [r.rows[0].id]);
  res.status(201).json({ milestone: out.rows[0] });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const cur = (await query('SELECT * FROM project_milestones WHERE id = $1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const acc = await loadProjectAccess(cur.project_id, req.user, req.team_id);
  if (!acc?.canEdit) return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };

  if ('name' in b) {
    const name = trim(b.name);
    if (!name) return res.status(400).json({ error: 'validation', fields: { name: 'Vyplň název milníku.' } });
    if (name.length > 300) {
      return res.status(400).json({ error: 'validation', fields: { name: 'Název je delší než 300 znaků.' } });
    }
    push('name', name);
  }
  if ('deadline' in b) {
    const deadline = asDate(b.deadline);
    if (deadline === DATE_INVALID) {
      return res.status(400).json({ error: 'validation', fields: { deadline: 'Neplatné datum. Použij formát RRRR-MM-DD.' } });
    }
    push('deadline', deadline, '::date');
  }
  if ('task_id' in b) {
    const taskId = asTaskId(b.task_id);
    if (taskId === ID_INVALID) {
      return res.status(400).json({ error: 'validation', fields: { task_id: 'Neplatný úkol.' } });
    }
    if (taskId && !await taskBelongsToProject(taskId, cur.project_id)) {
      return res.status(400).json({ error: 'validation', fields: { task_id: 'Úkol nepatří do tohoto projektu.' } });
    }
    push('task_id', taskId);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'validation', message: 'Nepřišla žádná změna.' });

  sets.push('updated_at = NOW()');
  params.push(id);
  await query(`UPDATE project_milestones SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  const out = await query(`${SELECT_FULL} WHERE m.id = $1`, [id]);
  res.json({ milestone: out.rows[0] });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const cur = (await query('SELECT project_id FROM project_milestones WHERE id = $1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const acc = await loadProjectAccess(cur.project_id, req.user, req.team_id);
  if (!acc?.canEdit) return res.status(403).json({ error: 'forbidden' });

  await query('DELETE FROM project_milestones WHERE id = $1', [id]);
  res.json({ ok: true });
});

// Přeuspořádání — klient pošle pole id ve výsledném pořadí.
router.put('/project/:projectId/reorder', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'validation', message: 'Neplatné ID.' });
  const acc = await loadProjectAccess(projectId, req.user, req.team_id);
  if (!acc) return res.status(404).json({ error: 'not_found' });
  if (!acc.canEdit) return res.status(403).json({ error: 'forbidden' });

  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number).filter(Number.isInteger) : [];
  if (order.length === 0) return res.status(400).json({ error: 'validation', fields: { order: 'Chybí pořadí.' } });

  // Jedním dotazem — cyklus po jednom by při chybě uprostřed nechal pořadí
  // rozbité napůl. WHERE project_id hlídá, že klient nepřepíše cizí milníky.
  await query(`
    UPDATE project_milestones m
    SET position = o.ord - 1, updated_at = NOW()
    FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord)
    WHERE m.id = o.id AND m.project_id = $2
  `, [order, projectId]);
  const r = await query(`${SELECT_FULL} WHERE m.project_id = $1 ORDER BY m.position, m.id`, [projectId]);
  res.json({ milestones: r.rows });
});

export default router;
