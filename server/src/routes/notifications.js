// User notification preferences (per-user opt-out).
//
//   GET  /me  → vrátí aktuální preference (TRUE pokud řádek neexistuje)
//   PUT  /me  → uloží {email_task_assigned, email_task_returned, ...}

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { getNotificationPrefs, isMailerConfigured } from '../mailer.js';
import { sendDailySummaryToUser, dailySummaryReadiness } from '../pushCron.js';

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  const prefs = await getNotificationPrefs(req.user.id);
  res.json({ prefs, mailer_configured: isMailerConfigured() });
});

router.put('/me', requireAuth, async (req, res) => {
  const {
    email_task_assigned, email_task_returned, email_task_approved, email_new_question,
    email_daily_summary, daily_summary_days, daily_summary_time,
    email_idea_new, email_idea_approved, email_idea_assigned_garant,
  } = req.body || {};

  // Validace času (HH:MM, 0-23:0-59). Fallback na 08:05.
  const timeStr = /^\d{1,2}:\d{2}$/.test(daily_summary_time || '')
    ? daily_summary_time.padStart(5, '0')
    : '08:05';
  // Validace dnů: pole intů 0-6. Fallback PO-PA. Deduplikace.
  const daysArr = Array.isArray(daily_summary_days)
    ? [...new Set(daily_summary_days.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : [1,2,3,4,5];

  // Try s idea sloupci; fallback bez nich (migrace F4 nedoběhla); pak bez schedule.
  const upsertWithIdeas = () => query(`
    INSERT INTO user_notification_prefs
      (user_id, email_task_assigned, email_task_returned, email_task_approved, email_new_question,
       email_daily_summary, daily_summary_days, daily_summary_time,
       email_idea_new, email_idea_approved, email_idea_assigned_garant, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET email_task_assigned = EXCLUDED.email_task_assigned,
          email_task_returned = EXCLUDED.email_task_returned,
          email_task_approved = EXCLUDED.email_task_approved,
          email_new_question  = EXCLUDED.email_new_question,
          email_daily_summary = EXCLUDED.email_daily_summary,
          daily_summary_days  = EXCLUDED.daily_summary_days,
          daily_summary_time  = EXCLUDED.daily_summary_time,
          email_idea_new              = EXCLUDED.email_idea_new,
          email_idea_approved         = EXCLUDED.email_idea_approved,
          email_idea_assigned_garant  = EXCLUDED.email_idea_assigned_garant,
          updated_at = NOW()
  `, [req.user.id, !!email_task_assigned, !!email_task_returned, !!email_task_approved, !!email_new_question,
      !!email_daily_summary, JSON.stringify(daysArr), timeStr,
      email_idea_new !== false, email_idea_approved !== false, email_idea_assigned_garant !== false]);

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
    await upsertWithIdeas();
  } catch (err) {
    if (err.code !== '42703') throw err;
    console.warn('[notifications] idea columns missing, trying without');
    try {
      await upsertFull();
    } catch (err2) {
      if (err2.code !== '42703') throw err2;
      console.warn('[notifications] schedule columns missing, saving basic prefs only');
      await upsertBasic();
    }
  }

  const prefs = await getNotificationPrefs(req.user.id);
  res.json({ prefs });
});

// Ruční test denního souhrnu — pošle report přihlášenému uživateli HNED (bez
// čekání na ranní rozvrh) a vrátí PŘESNÝ důvod, když to nejde. Diagnostika.
router.post('/me/test-daily-summary', requireAuth, async (req, res) => {
  const ready = dailySummaryReadiness();
  if (!ready.mailer) {
    return res.json({ ok: false, reason: 'mailer_not_configured',
      message: 'Chybí konfigurace M365 mailu (MICROSOFT_CLIENT_ID / _SECRET / _TENANT_ID, MAIL_M365_MAILBOX). Doplň v Admin → Server → Environment a restartuj.' });
  }
  if (!ready.anthropic) {
    return res.json({ ok: false, reason: 'no_anthropic_key',
      message: 'Chybí ANTHROPIC_API_KEY (denní souhrn obsahuje AI shrnutí). Doplň v Admin → Server → Environment a restartuj.' });
  }
  try {
    const ur = await query('SELECT id, email, name FROM users WHERE id = $1', [req.user.id]);
    const u = ur.rows[0];
    if (!u?.email) return res.json({ ok: false, reason: 'no_email', message: 'Tvůj účet nemá e-mail.' });
    const r = await sendDailySummaryToUser(u, process.env.ANTHROPIC_API_KEY.trim());
    if (r?.skipped === 'no_tasks') {
      return res.json({ ok: false, reason: 'no_open_tasks',
        message: 'Nemáš žádné otevřené úkoly — v takovém případě se denní souhrn neposílá (i produkčně).' });
    }
    if (r?.ok) return res.json({ ok: true, message: `Testovací report odeslán na ${u.email}. Když nedorazí, mrkni i do spamu.` });
    return res.json({ ok: false, reason: 'send_failed', message: `Odeslání se nepovedlo${r?.error ? ': ' + r.error : ''}.` });
  } catch (e) {
    return res.json({ ok: false, reason: 'error', message: String(e.message || 'chyba').slice(0, 300) });
  }
});

export default router;
