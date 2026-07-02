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
    email_daily_summary, daily_summary_days, daily_summary_time,
  } = req.body || {};

  // Validace času (HH:MM, 0-23:0-59). Fallback na 08:05.
  const timeStr = /^\d{1,2}:\d{2}$/.test(daily_summary_time || '')
    ? daily_summary_time.padStart(5, '0')
    : '08:05';
  // Validace dnů: pole intů 0-6. Fallback PO-PA. Deduplikace.
  const daysArr = Array.isArray(daily_summary_days)
    ? [...new Set(daily_summary_days.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : [1,2,3,4,5];

  // Try with all fields; fallback per sloupec, který v DB ještě není.
  const upsertFull = () => query(`
    INSERT INTO user_notification_prefs
      (user_id, email_task_assigned, email_task_returned, email_task_approved, email_new_question,
       email_daily_summary, daily_summary_days, daily_summary_time, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET email_task_assigned = EXCLUDED.email_task_assigned,
          email_task_returned = EXCLUDED.email_task_returned,
          email_task_approved = EXCLUDED.email_task_approved,
          email_new_question  = EXCLUDED.email_new_question,
          email_daily_summary = EXCLUDED.email_daily_summary,
          daily_summary_days  = EXCLUDED.daily_summary_days,
          daily_summary_time  = EXCLUDED.daily_summary_time,
          updated_at = NOW()
  `, [req.user.id, !!email_task_assigned, !!email_task_returned, !!email_task_approved, !!email_new_question,
      !!email_daily_summary, JSON.stringify(daysArr), timeStr]);

  const upsertBasic = () => query(`
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

  try {
    await upsertFull();
  } catch (err) {
    if (err.code === '42703') {
      console.warn('[notifications] schedule columns missing, saving basic prefs only');
      await upsertBasic();
    } else { throw err; }
  }

  const prefs = await getNotificationPrefs(req.user.id);
  res.json({ prefs });
});

export default router;
