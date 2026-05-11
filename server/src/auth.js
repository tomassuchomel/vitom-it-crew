// Autentizace: JWT + Google OAuth + dev login.
// JWT token se ukládá do httpOnly cookie 'tf_token'.
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { query } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_TTL = '14d';

export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_TTL }
  );
}

// Express middleware – ověří cookie, nahraje req.user
export async function requireAuth(req, res, next) {
  const token = req.cookies?.tf_token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // čerstvá data uživatele z DB
    const r = await query(
      'SELECT id, email, name, role, hourly_rate, active FROM users WHERE id = $1',
      [payload.id]
    );
    const user = r.rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Middleware factory – povolí jen vybrané role
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// Pomocné kontroly oprávnění
export const can = {
  manageProjects: (u) => ['admin', 'manager'].includes(u.role),
  createTasks:    (u) => ['admin', 'manager', 'senior_dev'].includes(u.role),
  seeAllHours:    (u) => ['admin', 'manager'].includes(u.role),
  seeCosts:       (u) => ['admin', 'manager'].includes(u.role),
  manageUsers:    (u) => u.role === 'admin',
};

// ---------- Google OAuth (volitelný) ----------
const HAS_GOOGLE = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (HAS_GOOGLE) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/api/auth/google/callback',
    },
    async (accessToken, refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(new Error('Google profil nemá email'));
      try {
        // 1) Match podle google_id
        let r = await query('SELECT * FROM users WHERE google_id = $1', [profile.id]);
        let user = r.rows[0];
        if (user) return done(null, user);

        // 2) Spárování podle emailu
        r = await query('SELECT * FROM users WHERE email = $1', [email]);
        user = r.rows[0];
        if (!user) {
          return done(null, false, { message: 'Uživatel s tímto emailem není v DB. Admin tě musí přidat.' });
        }
        await query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.id, user.id]);
        user.google_id = profile.id;
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));
}

export { HAS_GOOGLE, passport };
