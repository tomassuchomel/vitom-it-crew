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
  const {
    email_task_assigned, email_task_returned, email_task_approved, email_new_question,
    email_daily_summary,
  } = req.body || {};
  // Defenzivně: kdyby sloupec email_daily_summary ještě neexistoval, padne na fallback.
  const tryWithSummary = async () => query(`
    INSERT INTO user_notification_prefs
      (user_id, email_task_assigned, email_task_returned, email_task_approved, email_new_question, email_daily_summary, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET email_task_assigned = EXCLUDED.email_task_assigned,
          email_task_returned = EXCLUDED.email_task_returned,
          email_task_approved = EXCLUDED.email_task_approved,
          email_new_question  = EXCLUDED.email_new_question,
          email_daily_summary = EXCLUDED.email_daily_summary,
          updated_at = NOW()
  `, [req.user.id, !!email_task_assigned, !!email_task_returned, !!email_task_approved, !!email_new_question, !!email_daily_summary]);
  try {
    await tryWithSummary();
  } catch (err) {
    if (err.code === '42703') {
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
    } else { throw err; }
  }
  const prefs = await getNotificationPrefs(req.user.id);
  res.json({ prefs });
});

export default router;
