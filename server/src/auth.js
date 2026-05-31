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

// Express middleware – ověří cookie, nahraje req.user + req.team_id + req.team_role.
//
// Team kontext:
//   1. Pokud klient pošle X-Team-Id header, ověříme, že user je členem daného teamu,
//      a nastavíme req.team_id + req.team_role na hodnotu z team_members.
//   2. Pokud header chybí nebo user není v teamu, default: první team (ORDER BY team_id ASC).
//   3. Pokud user není členem ŽÁDNÉHO teamu (nemělo by se stávat po migraci),
//      req.team_id zůstane undefined a routes se zachovají podle starého chování.
export async function requireAuth(req, res, next) {
  const token = req.cookies?.tf_token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // čerstvá data uživatele z DB
    const r = await query(
      `SELECT id, email, name, first_name, last_name, role, hourly_rate, active,
              must_change_password, avatar_updated_at, can_see_all_teams
       FROM users WHERE id = $1`,
      [payload.id]
    );
    const user = r.rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;

    // Načti team kontext – nejdřív zkus X-Team-Id z hlavičky.
    // POZOR: pokud klient požaduje konkrétní team, ALE user není jeho členem,
    // VRÁTÍME team_id=undefined (ne fallback na první team). Frontend by jinak
    // viděl data z jiného teamu, než si myslel — ošklivý silent bug.
    // Endpointy si poradí přes `if (!req.team_id) return res.json({...prázdné})`.
    const requestedTeamId = Number(req.header('X-Team-Id'));
    const hasRequestedHeader = Number.isInteger(requestedTeamId) && requestedTeamId > 0;
    if (hasRequestedHeader) {
      const tm = await query(
        `SELECT team_id, team_role FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [requestedTeamId, user.id]
      );
      if (tm.rows[0]) {
        req.team_id   = tm.rows[0].team_id;
        req.team_role = tm.rows[0].team_role;
      }
      // ← žádný fallback. team_id zůstává undefined.
    } else {
      // Žádný header → default první team uživatele (legacy / first load).
      const tm = await query(
        `SELECT team_id, team_role FROM team_members WHERE user_id = $1 ORDER BY team_id ASC LIMIT 1`,
        [user.id]
      );
      if (tm.rows[0]) {
        req.team_id   = tm.rows[0].team_id;
        req.team_role = tm.rows[0].team_role;
      }
    }
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
  // Review task (schválit/vrátit z review do done/needs_fix):
  // smí vedoucí projektu daného úkolu NEBO admin. Vyžaduje project objekt
  // (s manager_id) – kontrola se dělá per-task v API endpointu.
  reviewTask:     (u, project) => u.role === 'admin' || (project && project.manager_id === u.id),
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
