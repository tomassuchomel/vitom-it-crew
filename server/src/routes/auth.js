import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, PASSWORD_SALT_ROUNDS } from '../db.js';
import { signToken, passport, HAS_GOOGLE, requireAuth } from '../auth.js';

const router = Router();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 14 * 24 * 60 * 60 * 1000,
};

// Helper – co posíláme klientovi jako "user"
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    first_name: u.first_name,
    last_name: u.last_name,
    role: u.role,
    hourly_rate: u.hourly_rate,
    must_change_password: !!u.must_change_password,
    avatar_updated_at: u.avatar_updated_at,
  };
}

// Aktuálně přihlášený uživatel
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Config – co je aktivní (Google OAuth)
router.get('/config', (req, res) => {
  res.json({ googleEnabled: HAS_GOOGLE });
});

// PASSWORD LOGIN – primární cesta
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });

  const r = await query(
    `SELECT id, email, name, first_name, last_name, role, hourly_rate, active,
            password_hash, must_change_password, avatar_updated_at
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [String(email).trim()]
  );
  const user = r.rows[0];
  // Nerozlišujeme "user_not_found" vs "bad_password" – stejné chování proti enumeraci
  if (!user || !user.active || !user.password_hash) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signToken(user);
  res.cookie('tf_token', token, COOKIE_OPTS);
  res.json({ user: publicUser(user) });
});

// CHANGE PASSWORD – přihlášený uživatel mění své heslo
// Při must_change_password=TRUE (první přihlášení / reset adminem) stačí jen nové heslo.
// Jinak je vyžadováno současné heslo.
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'weak_password', message: 'Heslo musí mít alespoň 6 znaků.' });
  }

  const r = await query(`SELECT password_hash, must_change_password FROM users WHERE id = $1`, [req.user.id]);
  const cur = r.rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });

  // Pokud uživatel nemá must_change_password, musí potvrdit současné heslo
  if (!cur.must_change_password) {
    if (!currentPassword) return res.status(400).json({ error: 'missing_current_password' });
    const ok = cur.password_hash ? await bcrypt.compare(currentPassword, cur.password_hash) : false;
    if (!ok) return res.status(401).json({ error: 'invalid_current_password' });
  }

  const hash = await bcrypt.hash(String(newPassword), PASSWORD_SALT_ROUNDS);
  await query(
    `UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`,
    [hash, req.user.id]
  );
  res.json({ ok: true });
});

// DEV LOGIN – ponecháno pro rychlé testování bez hesla
router.post('/dev-login', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });
  const r = await query(
    `SELECT id, email, name, first_name, last_name, role, hourly_rate, active,
            must_change_password, avatar_updated_at
     FROM users WHERE id = $1 AND active = TRUE`,
    [userId]
  );
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const token = signToken(user);
  res.cookie('tf_token', token, COOKIE_OPTS);
  res.json({ user: publicUser(user) });
});

// Seznam pro dev-login dropdown
router.get('/dev-users', async (req, res) => {
  const r = await query('SELECT id, name, email, role FROM users WHERE active = TRUE ORDER BY id');
  res.json({ users: r.rows });
});

// LOGOUT
router.post('/logout', (req, res) => {
  res.clearCookie('tf_token', COOKIE_OPTS);
  res.json({ ok: true });
});

// GOOGLE OAUTH
if (HAS_GOOGLE) {
  router.get('/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })
  );
  router.get('/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/?error=google' }),
    (req, res) => {
      const token = signToken(req.user);
      res.cookie('tf_token', token, COOKIE_OPTS);
      const redirect = process.env.CLIENT_URL || 'http://localhost:5173';
      res.redirect(redirect + '/');
    }
  );
}

export default router;
