import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole, can } from '../auth.js';

const router = Router();

// Seznam uživatelů – sazby vidí jen admin/manager
router.get('/', requireAuth, async (req, res) => {
  const showRates = can.seeCosts(req.user);
  const sql = showRates
    ? 'SELECT id, email, name, role, hourly_rate, active FROM users ORDER BY id'
    : 'SELECT id, email, name, role, active FROM users ORDER BY id';
  const r = await query(sql);
  res.json({ users: r.rows });
});

// Vytvoření – jen admin
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, name, role, hourly_rate } = req.body || {};
  if (!email || !name || !role) return res.status(400).json({ error: 'missing_fields' });
  if (!['admin', 'manager', 'senior_dev', 'external_dev'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  try {
    const r = await query(
      `INSERT INTO users (email, name, role, hourly_rate)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, hourly_rate, active`,
      [email.toLowerCase().trim(), name.trim(), role, Number(hourly_rate) || 0]
    );
    res.json({ user: r.rows[0] });
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
  const { name = cur.name, role = cur.role, hourly_rate = cur.hourly_rate, active = cur.active } = req.body || {};
  await query(
    'UPDATE users SET name = $1, role = $2, hourly_rate = $3, active = $4 WHERE id = $5',
    [name, role, Number(hourly_rate) || 0, !!active, id]
  );
  const r = await query(
    'SELECT id, email, name, role, hourly_rate, active FROM users WHERE id = $1',
    [id]
  );
  res.json({ user: r.rows[0] });
});

export default router;
