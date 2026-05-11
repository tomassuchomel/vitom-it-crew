import { Router } from 'express';
import { query } from '../db.js';
import { signToken, passport, HAS_GOOGLE, requireAuth } from '../auth.js';

const router = Router();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 14 * 24 * 60 * 60 * 1000,
};

// Aktuálně přihlášený uživatel
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Config – zda je Google OAuth k dispozici
router.get('/config', (req, res) => {
  res.json({ googleEnabled: HAS_GOOGLE });
});

// DEV LOGIN – rychlý start
router.post('/dev-login', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });
  const r = await query(
    'SELECT id, email, name, role, hourly_rate FROM users WHERE id = $1 AND active = TRUE',
    [userId]
  );
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const token = signToken(user);
  res.cookie('tf_token', token, COOKIE_OPTS);
  res.json({ user });
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
