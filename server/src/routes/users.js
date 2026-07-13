import { Router } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { query, DEFAULT_PASSWORD, PASSWORD_SALT_ROUNDS } from '../db.js';
import { requireAuth, requireRole, can } from '../auth.js';

const router = Router();

const AVATAR_MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const AVATAR_MAX = 2 * 1024 * 1024; // 2 MB
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX },
  fileFilter: (req, file, cb) => {
    if (!AVATAR_MIME_OK.has(file.mimetype)) return cb(new Error('only_images'));
    cb(null, true);
  },
});

// Helper – co posíláme klientovi
function publicUser(u, { includeRate = false } = {}) {
  if (!u) return null;
  const out = {
    id: u.id,
    email: u.email,
    name: u.name,
    first_name: u.first_name,
    last_name: u.last_name,
    role: u.role,
    active: u.active,
    must_change_password: !!u.must_change_password,
    avatar_updated_at: u.avatar_updated_at,
    can_see_all_teams: !!u.can_see_all_teams,
  };
  if (includeRate) out.hourly_rate = u.hourly_rate;
  return out;
}

// Seznam uživatelů.
// Default chování (a všude v běžné app): jen členové aktuálního teamu –
// assignee dropdowny, manager dropdowny, Team page atd. ukazují relevantní lidi.
//
// `?scope=all` (jen admin): všichni useři + jejich team membership.
// Používá se v `/admin` pro globální správu napříč teamy.
//
// Sazby (hourly_rate) vidí jen admin/manager (can.seeCosts).
router.get('/', requireAuth, async (req, res) => {
  const showRates = can.seeCosts(req.user);
  const scopeAll = req.query.scope === 'all';

  // ?scope=my-teams → distinct členové VŠECH týmů, kde je current user členem.
  // Pro cross-team subtask: Patricia (host) přidá podúkol pro svůj Management
  // tým, dropdown assignee ukáže její kolegy napříč jejími týmy.
  if (req.query.scope === 'my-teams') {
    const r = await query(`
      SELECT DISTINCT u.id, u.email, u.name, u.first_name, u.last_name, u.role, u.hourly_rate, u.active,
             u.must_change_password, u.avatar_updated_at
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      WHERE u.active = TRUE
        AND tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)
      ORDER BY u.name
    `, [req.user.id]);
    return res.json({ users: r.rows.map(u => publicUser(u, { includeRate: showRates })) });
  }

  // scope=all = admin přehled napříč teamy
  if (scopeAll) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    // is_idea_pm přes LEFT JOIN idea_pms. Defenzivně: pokud tabulka
    // neexistuje (migrace neběžela), spadne to na fallback bez sloupce.
    let r;
    try {
      r = await query(
        `SELECT u.id, u.email, u.name, u.first_name, u.last_name, u.role, u.hourly_rate, u.active,
                u.must_change_password, u.avatar_updated_at, u.can_see_all_teams,
                (ip.user_id IS NOT NULL) AS is_idea_pm,
                COALESCE(
                  (SELECT json_agg(json_build_object('team_id', tm.team_id, 'team_role', tm.team_role, 'team_name', t.name, 'team_slug', t.slug)
                                   ORDER BY tm.team_id)
                   FROM team_members tm JOIN teams t ON t.id = tm.team_id
                   WHERE tm.user_id = u.id),
                  '[]'::json
                ) AS teams
         FROM users u
         LEFT JOIN idea_pms ip ON ip.user_id = u.id
         ORDER BY u.id`
      );
    } catch (err) {
      if (err.code !== '42P01') throw err;
      r = await query(
        `SELECT u.id, u.email, u.name, u.first_name, u.last_name, u.role, u.hourly_rate, u.active,
                u.must_change_password, u.avatar_updated_at, u.can_see_all_teams,
                FALSE AS is_idea_pm,
                COALESCE(
                  (SELECT json_agg(json_build_object('team_id', tm.team_id, 'team_role', tm.team_role, 'team_name', t.name, 'team_slug', t.slug)
                                   ORDER BY tm.team_id)
                   FROM team_members tm JOIN teams t ON t.id = tm.team_id
                   WHERE tm.user_id = u.id),
                  '[]'::json
                ) AS teams
         FROM users u ORDER BY u.id`
      );
    }
    return res.json({ users: r.rows.map(u => ({ ...publicUser(u, { includeRate: showRates }), teams: u.teams, is_idea_pm: u.is_idea_pm })) });
  }

  // ?team_id=N → členové konkrétního týmu (pro cross-team task creation,
  // kde user vybírá assignee z teamu vybraného projektu).
  // Permission: user musí být členem dané team_id (nebo admin). Bez tohoto
  // by manager mohl vyzkoumat členy jiných týmů.
  const askedTeamId = Number(req.query.team_id);
  let teamFilter = req.team_id;
  if (Number.isInteger(askedTeamId) && askedTeamId > 0) {
    if (req.user.role !== 'admin') {
      const ok = await query(
        `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
        [askedTeamId, req.user.id]
      );
      if (ok.rows.length === 0) return res.status(403).json({ error: 'forbidden' });
    }
    teamFilter = askedTeamId;
  }

  // Default: jen členové current teamu. Bez team kontextu vrátíme prázdno.
  if (!teamFilter) return res.json({ users: [] });
  const r = await query(
    `SELECT u.id, u.email, u.name, u.first_name, u.last_name, u.role, u.hourly_rate, u.active,
            u.must_change_password, u.avatar_updated_at,
            tm.team_role AS current_team_role
     FROM users u
     JOIN team_members tm ON tm.user_id = u.id
     WHERE tm.team_id = $1 AND u.active = TRUE
     ORDER BY u.name`,
    [teamFilter]
  );
  res.json({ users: r.rows.map(u => ({ ...publicUser(u, { includeRate: showRates }), team_role: u.current_team_role })) });
});

// Avatar – binární endpoint. Veřejný v rámci přihlášených uživatelů.
router.get('/:id/avatar', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(
    `SELECT avatar_data, avatar_mime FROM users WHERE id = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row || !row.avatar_data) return res.status(404).end();
  res.setHeader('Content-Type', row.avatar_mime || 'image/jpeg');
  // Krátká cache – stačí pro rychlé renderování, ale po změně se brzo propíše ostatním.
  // Vlastní změny si frontend cache-bustí přes ?v= s timestampem z auth.me.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(row.avatar_data);
});

// Edit vlastního profilu – jméno + příjmení
router.put('/me', requireAuth, async (req, res) => {
  const { first_name, last_name } = req.body || {};
  const first = String(first_name || '').trim();
  const last  = String(last_name || '').trim();
  if (!first || !last) return res.status(400).json({ error: 'missing_name' });
  const name = `${first} ${last}`;
  await query(
    `UPDATE users SET first_name = $1, last_name = $2, name = $3 WHERE id = $4`,
    [first, last, name, req.user.id]
  );
  const r = await query(
    `SELECT id, email, name, first_name, last_name, role, hourly_rate, active,
            must_change_password, avatar_updated_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json({ user: publicUser(r.rows[0], { includeRate: true }) });
});

// Upload vlastního avataru (multipart pole `avatar`)
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  await query(
    `UPDATE users SET avatar_data = $1, avatar_mime = $2, avatar_updated_at = NOW() WHERE id = $3`,
    [req.file.buffer, req.file.mimetype, req.user.id]
  );
  const r = await query(`SELECT avatar_updated_at FROM users WHERE id = $1`, [req.user.id]);
  res.json({ ok: true, avatar_updated_at: r.rows[0].avatar_updated_at });
});

// Smazat vlastní avatar
router.delete('/me/avatar', requireAuth, async (req, res) => {
  await query(
    `UPDATE users SET avatar_data = NULL, avatar_mime = NULL, avatar_updated_at = NOW() WHERE id = $1`,
    [req.user.id]
  );
  res.json({ ok: true });
});

// Vytvoření – jen admin. Pokud klient pošle `password`, použije se a uživatel
// si ho NEmusí měnit. Bez `password` se nastaví DEFAULT_PASSWORD + must_change_password=TRUE.
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, name, first_name, last_name, role, hourly_rate, password } = req.body || {};
  // Backward kompatibilita – pokud klient pošle jen `name`, rozdělíme automaticky
  let first = String(first_name || '').trim();
  let last  = String(last_name || '').trim();
  if ((!first || !last) && name) {
    const parts = String(name).trim().split(/\s+/);
    if (!first) first = parts[0] || '';
    if (!last)  last  = parts.slice(1).join(' ') || '';
  }
  const fullName = (first || last) ? `${first} ${last}`.trim() : String(name || '').trim();

  if (!email || !fullName || !role) return res.status(400).json({ error: 'missing_fields' });
  if (!['admin', 'manager', 'senior_dev', 'external_dev'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  // Pokud admin pošle vlastní heslo, použijeme ho a nevynucujeme změnu.
  const customPwd = typeof password === 'string' ? password.trim() : '';
  if (customPwd && customPwd.length < 6) {
    return res.status(400).json({ error: 'password_too_short', message: 'Heslo musí mít aspoň 6 znaků.' });
  }
  const pwdToHash = customPwd || DEFAULT_PASSWORD;
  const mustChange = customPwd ? false : true;
  try {
    const hash = await bcrypt.hash(pwdToHash, PASSWORD_SALT_ROUNDS);
    const r = await query(
      `INSERT INTO users (email, name, first_name, last_name, role, hourly_rate, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, name, first_name, last_name, role, hourly_rate, active,
                 must_change_password, avatar_updated_at`,
      [email.toLowerCase().trim(), fullName, first, last, role, Number(hourly_rate) || 0, hash, mustChange]
    );
    res.json({
      user: publicUser(r.rows[0], { includeRate: true }),
      // default_password vracíme jen když jsme ho fakt použili (admin neposlal vlastní)
      default_password: customPwd ? null : DEFAULT_PASSWORD,
    });
  } catch (err) {
    if (String(err).includes('unique')) return res.status(409).json({ error: 'email_exists' });
    throw err;
  }
});

// Edit – jen admin
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const curR = await query('SELECT * FROM users WHERE id = $1', [id]);
  const cur = curR.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const {
    name = cur.name,
    first_name = cur.first_name,
    last_name = cur.last_name,
    role = cur.role,
    hourly_rate = cur.hourly_rate,
    active = cur.active,
    can_see_all_teams = cur.can_see_all_teams,
    // Speciální nesloupcový flag: přiřazení role „PM Nápadníku" (tabulka idea_pms).
    // Undefined = neměnit; true/false = toggle.
    is_idea_pm,
  } = req.body || {};

  // Pokud admin pošle first/last, použijeme je a přegenerujeme name
  let first = first_name, last = last_name, newName = name;
  if (req.body?.first_name !== undefined || req.body?.last_name !== undefined) {
    first = String(first_name || '').trim() || cur.first_name || '';
    last  = String(last_name  || '').trim() || cur.last_name  || '';
    newName = `${first} ${last}`.trim() || cur.name;
  }

  await query(
    `UPDATE users SET name = $1, first_name = $2, last_name = $3,
                      role = $4, hourly_rate = $5, active = $6,
                      can_see_all_teams = $7
     WHERE id = $8`,
    [newName, first, last, role, Number(hourly_rate) || 0, !!active, !!can_see_all_teams, id]
  );

  // Toggle PM Nápadníku (tabulka idea_pms). Defenzivně — tabulka mohla
  // ještě nevzniknout, kdyby migrace neběžela.
  if (typeof is_idea_pm === 'boolean') {
    try {
      if (is_idea_pm) {
        await query(`
          INSERT INTO idea_pms (user_id, assigned_by) VALUES ($1, $2)
          ON CONFLICT (user_id) DO NOTHING
        `, [id, req.user.id]);
      } else {
        await query(`DELETE FROM idea_pms WHERE user_id = $1`, [id]);
      }
    } catch (err) {
      if (err.code !== '42P01') throw err; // tabulka neexistuje — nechme být
    }
  }
  const r = await query(
    `SELECT id, email, name, first_name, last_name, role, hourly_rate, active,
            must_change_password, avatar_updated_at, can_see_all_teams
     FROM users WHERE id = $1`,
    [id]
  );
  res.json({ user: publicUser(r.rows[0], { includeRate: true }) });
});

// Smazání uživatele – admin nebo project manager.
// Bezpečnostní pojistky: nelze smazat sám sebe, nelze smazat posledního admina.
// FK kaskáda v DB smaže navázané záznamy (time_entries, questions, attachments, project_edits),
// úkoly mají SET NULL u assignee_id (zůstanou, jen bez přiřazení), projekty mají SET NULL u manager_id.
router.delete('/:id', requireAuth, async (req, res) => {
  if (!can.manageProjects(req.user)) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });

  const r = await query('SELECT id, role FROM users WHERE id = $1', [id]);
  const target = r.rows[0];
  if (!target) return res.status(404).json({ error: 'not_found' });

  if (target.role === 'admin') {
    const adminCount = await query(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND active = TRUE`);
    if (Number(adminCount.rows[0].c) <= 1) {
      return res.status(400).json({ error: 'last_admin', message: 'Nelze smazat posledního aktivního admina.' });
    }
  }

  await query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

// Admin reset hesla – nastaví výchozí heslo a vynutí změnu při příštím loginu
router.post('/:id/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, PASSWORD_SALT_ROUNDS);
  const r = await query(
    `UPDATE users SET password_hash = $1, must_change_password = TRUE
     WHERE id = $2 RETURNING id`,
    [hash, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, default_password: DEFAULT_PASSWORD });
});

// Error handler pro multer (upload avataru)
router.use((err, req, res, next) => {
  if (err?.message === 'only_images') return res.status(400).json({ error: 'only_images', message: 'Povoleny jsou jen obrázky (JPEG, PNG, WebP, GIF).' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'file_too_large', message: 'Avatar > 2 MB.' });
  next(err);
});

export default router;
