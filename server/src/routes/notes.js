// Poznámky – hierarchický strom (množina / podmnožina), team-scoped.
//
//   GET    /api/notes          – všechny poznámky current teamu (flat; FE staví strom)
//   POST   /api/notes          – nová poznámka { title?, content?, parent_id? }
//   PUT    /api/notes/:id      – edit { title?, content?, parent_id?, position? }
//   DELETE /api/notes/:id      – smazat (kaskáda na podpoznámky)
//
// Návrh pro budoucí AI agenta (Fáze 2): title + content jsou strukturovaný
// vstup, parent_id dává hierarchický kontext. AI bude umět načíst celý strom
// a vytvořit z něj úkoly do projektů/teamů s přiřazením a termíny.

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

// List – celý strom current teamu jako flat array (FE poskládá hierarchii).
// Řazení: parent (NULLS first = top-level), pak position, pak created_at.
router.get('/', requireAuth, async (req, res) => {
  if (!req.team_id) return res.json({ notes: [] });
  const r = await query(`
    SELECT n.id, n.team_id, n.parent_id, n.user_id, n.title, n.content,
           n.position, n.ai_processed_at, n.created_at, n.updated_at,
           u.name AS author_name
    FROM notes n
    LEFT JOIN users u ON u.id = n.user_id
    WHERE n.team_id = $1
    ORDER BY n.parent_id NULLS FIRST, n.position ASC, n.created_at ASC
  `, [req.team_id]);
  res.json({ notes: r.rows });
});

// Create – v current teamu. parent_id volitelné (podpoznámka).
router.post('/', requireAuth, async (req, res) => {
  if (!req.team_id) return res.status(400).json({ error: 'no_team_context' });
  const { title, content, parent_id } = req.body || {};

  // Validace parent_id – musí být poznámka ze stejného teamu
  let parentId = null;
  if (parent_id) {
    const p = await query(`SELECT id FROM notes WHERE id = $1 AND team_id = $2`, [Number(parent_id), req.team_id]);
    if (!p.rows[0]) return res.status(400).json({ error: 'invalid_parent' });
    parentId = Number(parent_id);
  }

  // position = max+1 mezi sourozenci
  const posR = await query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM notes
     WHERE team_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [req.team_id, parentId]
  );
  const position = posR.rows[0].next_pos;

  const r = await query(`
    INSERT INTO notes (team_id, parent_id, user_id, title, content, position)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [req.team_id, parentId, req.user.id, (title || 'Nová poznámka').slice(0, 300), content || null, position]);
  res.json({ note: r.rows[0] });
});

// Edit – title / content / parent_id / position. Jen poznámka current teamu.
router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const cur = (await query(`SELECT * FROM notes WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && cur.team_id !== req.team_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Reparent – validuj že nový rodič je ve stejném teamu a není to potomek (cyklus).
  let nextParent = cur.parent_id;
  if ('parent_id' in req.body) {
    const np = req.body.parent_id;
    if (np == null || np === '') {
      nextParent = null;
    } else {
      const npId = Number(np);
      if (npId === id) return res.status(400).json({ error: 'cannot_parent_self' });
      const p = await query(`SELECT id FROM notes WHERE id = $1 AND team_id = $2`, [npId, cur.team_id]);
      if (!p.rows[0]) return res.status(400).json({ error: 'invalid_parent' });
      // Cyklus check – nový rodič nesmí být potomek této poznámky
      const descendants = await collectDescendantIds(id);
      if (descendants.has(npId)) return res.status(400).json({ error: 'would_create_cycle' });
      nextParent = npId;
    }
  }

  const next = {
    title:    'title'    in req.body ? String(req.body.title || '').slice(0, 300) : cur.title,
    content:  'content'  in req.body ? (req.body.content ?? null) : cur.content,
    position: 'position' in req.body ? Number(req.body.position) || 0 : cur.position,
    parent_id: nextParent,
  };

  const r = await query(`
    UPDATE notes SET title = $1, content = $2, position = $3, parent_id = $4, updated_at = NOW()
    WHERE id = $5 RETURNING *
  `, [next.title, next.content, next.position, next.parent_id, id]);
  res.json({ note: r.rows[0] });
});

// Smazat – kaskáda na podpoznámky (FK ON DELETE CASCADE).
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT team_id FROM notes WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && cur.team_id !== req.team_id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await query(`DELETE FROM notes WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// Pomocná: vrátí Set všech ID potomků dané poznámky (rekurzivně) – pro cyklus check.
async function collectDescendantIds(rootId) {
  const set = new Set();
  let frontier = [rootId];
  while (frontier.length) {
    const r = await query(`SELECT id FROM notes WHERE parent_id = ANY($1::int[])`, [frontier]);
    frontier = [];
    for (const row of r.rows) {
      if (!set.has(row.id)) { set.add(row.id); frontier.push(row.id); }
    }
  }
  return set;
}

export default router;
