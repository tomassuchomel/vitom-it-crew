// Přístupová práva Nápadníku. Vytaženo z routes/ideas.js, aby stejnou kontrolu
// mohly použít i přílohy (routes/attachments.js) bez druhé implementace.

import { query } from './db.js';

// Management role = admin globálně NEBO člen týmu se slug='management'.
export async function isManagement(userId, userRole) {
  if (userRole === 'admin') return true;
  const r = await query(
    `SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = $1 AND t.slug = 'management' LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

// PM Nápadníku — vidí Report / Dashboard / Export, edituje metadata,
// posouvá garant-akce (Analýza hotová, Vytvořit projekt, Dokončit).
// NEschvaluje / nezamítá (to Management).
export async function isIdeaPM(userId) {
  const r = await query(`SELECT 1 FROM idea_pms WHERE user_id = $1`, [userId]);
  return r.rows.length > 0;
}

// Middleware: Nápadník smí vidět jen Management nebo PM Nápadníku. Ostatní
// (např. běžný člen IT týmu) dostanou 403 — vč. přístupu k listu nápadů.
export async function requireIdeaAccess(req, res, next) {
  const [mgr, pm] = await Promise.all([
    isManagement(req.user.id, req.user.role),
    isIdeaPM(req.user.id),
  ]);
  if (!mgr && !pm) {
    return res.status(403).json({ error: 'forbidden', message: 'Nápadník je vyhrazený pro Management a PM Nápadníku.' });
  }
  req.ideaPerms = { isManagement: mgr, isIdeaPM: pm };
  next();
}
