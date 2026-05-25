// API pro multi-team support:
//   GET    /api/teams              – seznam teamů, ve kterých je current user. Admin vidí všechny.
//   GET    /api/teams/:id          – detail teamu + členové (jen pro členy nebo admina)
//   GET    /api/teams/:id/members  – jen členové
//   POST   /api/teams              – vytvořit nový team (jen admin)
//   PUT    /api/teams/:id          – přejmenovat, edit features (jen admin nebo lead/admin v teamu)
//   POST   /api/teams/:id/members  – přidat člena { user_id, team_role }
//   DELETE /api/teams/:id/members/:userId – odebrat člena
//
// Návrh: team_role je libovolný string per team (např. 'reditel', 'manager',
// 'lead', 'dev'). Validace business pravidel je responsibility frontendu /
// admin UI – tady jen ukládáme/čteme.

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

// Slug validation – jen lowercase písmena/číslice + pomlčky, 2–32 znaků.
function isValidSlug(s) {
  return typeof s === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(s);
}

/**
 * Seznam teamů, ve kterých je aktuální user členem.
 * Admin vidí všechny.
 * Vrací array s každým teamem + `current_user_role` (jeho role v teamu).
 */
router.get('/', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = isAdmin
    ? await query(`
        SELECT t.*,
          COALESCE(tm.team_role, NULL) AS current_user_role,
          (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
        FROM teams t
        LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
        ORDER BY t.id ASC
      `, [req.user.id])
    : await query(`
        SELECT t.*,
          tm.team_role AS current_user_role,
          (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
        FROM teams t
        JOIN team_members tm ON tm.team_id = t.id
        WHERE tm.user_id = $1
        ORDER BY t.id ASC
      `, [req.user.id]);
  res.json({ teams: rows.rows, current_team_id: req.team_id || null });
});

/**
 * Detail teamu + členy. Jen pro členy teamu nebo admina.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

  const tR = await query(`SELECT * FROM teams WHERE id = $1`, [id]);
  const team = tR.rows[0];
  if (!team) return res.status(404).json({ error: 'not_found' });

  // Authorization – člen teamu nebo admin
  const memberR = await query(
    `SELECT team_role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [id, req.user.id]
  );
  const isMember = memberR.rows.length > 0;
  if (!isMember && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const mR = await query(`
    SELECT tm.team_id, tm.user_id, tm.team_role, tm.joined_at,
           u.name, u.email, u.role AS global_role, u.active, u.avatar_updated_at
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1
    ORDER BY tm.joined_at ASC
  `, [id]);

  res.json({ team, members: mR.rows, current_user_role: memberR.rows[0]?.team_role || null });
});

/**
 * Vytvořit nový team. Jen admin.
 */
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { name, slug, description, features } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'missing_fields' });
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'invalid_slug', message: 'Slug musí být lowercase, písmena/číslice/pomlčky, 2–32 znaků.' });
  try {
    const r = await query(`
      INSERT INTO teams (name, slug, description, features)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING *
    `, [name, slug, description || null, JSON.stringify(features || {})]);
    res.json({ team: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    throw err;
  }
});

/**
 * Edit teamu (name, description, features). Jen admin globálně, nebo
 * admin v rámci teamu (team_role = 'admin'). Slug se neměnit – je v URL.
 */
router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

  // Authorization
  const isGlobalAdmin = req.user.role === 'admin';
  let isTeamAdmin = false;
  if (!isGlobalAdmin) {
    const r = await query(`SELECT team_role FROM team_members WHERE team_id = $1 AND user_id = $2`, [id, req.user.id]);
    isTeamAdmin = r.rows[0]?.team_role === 'admin';
  }
  if (!isGlobalAdmin && !isTeamAdmin) return res.status(403).json({ error: 'forbidden' });

  const cur = (await query(`SELECT * FROM teams WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });

  const next = {
    name:        req.body?.name        ?? cur.name,
    description: req.body?.description ?? cur.description,
    features:    req.body?.features    ?? cur.features,
  };
  const r = await query(`
    UPDATE teams SET name = $1, description = $2, features = $3::jsonb
    WHERE id = $4 RETURNING *
  `, [next.name, next.description, JSON.stringify(next.features), id]);
  res.json({ team: r.rows[0] });
});

/**
 * Přidat člena do teamu. Jen globální admin nebo team_role='admin' v daném teamu.
 * Tělo: { user_id, team_role }
 */
router.post('/:id/members', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { user_id, team_role } = req.body || {};
  if (!Number.isInteger(Number(user_id))) return res.status(400).json({ error: 'invalid_user_id' });
  if (!team_role) return res.status(400).json({ error: 'missing_team_role' });

  const isGlobalAdmin = req.user.role === 'admin';
  if (!isGlobalAdmin) {
    const r = await query(`SELECT team_role FROM team_members WHERE team_id = $1 AND user_id = $2`, [id, req.user.id]);
    if (r.rows[0]?.team_role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  }

  const r = await query(`
    INSERT INTO team_members (team_id, user_id, team_role)
    VALUES ($1, $2, $3)
    ON CONFLICT (team_id, user_id) DO UPDATE SET team_role = EXCLUDED.team_role
    RETURNING *
  `, [id, Number(user_id), String(team_role)]);
  res.json({ member: r.rows[0] });
});

/**
 * Odebrat člena z teamu.
 */
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);

  const isGlobalAdmin = req.user.role === 'admin';
  if (!isGlobalAdmin) {
    const r = await query(`SELECT team_role FROM team_members WHERE team_id = $1 AND user_id = $2`, [id, req.user.id]);
    if (r.rows[0]?.team_role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  }

  // Nesmí odstranit posledního admina (bezpečnostní pojistka)
  const adminCount = await query(
    `SELECT COUNT(*)::int AS c FROM team_members WHERE team_id = $1 AND team_role IN ('admin','reditel')`,
    [id]
  );
  const targetRole = await query(
    `SELECT team_role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (adminCount.rows[0].c <= 1 && ['admin', 'reditel'].includes(targetRole.rows[0]?.team_role)) {
    return res.status(400).json({ error: 'last_admin', message: 'Nelze odebrat posledního adminstratora teamu.' });
  }

  await query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [id, userId]);
  res.json({ ok: true });
});

export default router;
