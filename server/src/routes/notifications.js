// User notification preferences (per-user opt-out).
//
//   GET  /me  → vrátí aktuální preference (TRUE pokud řádek neexistuje)
//   PUT  /me  → uloží {email_task_assigned, email_task_returned, ...}

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { getNotificationPrefs, isMailerConfigured } from '../mailer.js';

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  const prefs = await getNotificationPrefs(req.user.id);
  res.json({ prefs, mailer_configured: isMailerConfigured() });
});

router.put('/me', requireAuth, async (req, res) => {
  const { email_task_assigned, email_task_returned, email_task_approved, email_new_question } = req.body || {};
  // Vše booleans, ne-null. Upsert.
  await query(`
    INSERT INTO user_notification_prefs
      (user_id, email_task_assigned, email_task_returned, email_task_approved, email_new_question, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET email_task_assigned = EXCLUDED.email_task_assigned,
          email_task_returned = EXCLUDED.email_task_returned,
          email_task_approved = EXCLUDED.email_task_approved,
          email_new_question  = EXCLUDED.email_new_question,
          updated_at = NOW()
  `, [req.user.id, !!email_task_assigned, !!email_task_returned, !!email_task_approved, !!email_new_question]);
  const prefs = await getNotificationPrefs(req.user.id);
  res.json({ prefs });
});

export default router;
