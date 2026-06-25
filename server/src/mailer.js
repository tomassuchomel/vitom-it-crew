// Email helper přes Resend API (https://resend.com).
// Když chybí RESEND_API_KEY, email se jen zaloguje (graceful degradation).
//
// Env:
//   RESEND_API_KEY  — API klíč z Resend dashboardu (začíná re_...)
//   MAIL_FROM       — odesílatel, např. "VITOM <noreply@vitom.cz>"
//                     Domain musí být ověřená v Resend, jinak Resend hodí 403.
//   APP_BASE_URL    — public URL appky (pro odkazy v emailu),
//                     např. "https://it.realitniekosystem.cz"

import { query } from './db.js';

const RESEND_API = 'https://api.resend.com/emails';

function cfg() {
  return {
    apiKey: process.env.RESEND_API_KEY?.trim(),
    from:   process.env.MAIL_FROM?.trim() || 'VITOM <onboarding@resend.dev>',
    base:   (process.env.APP_BASE_URL?.trim() || 'https://it.realitniekosystem.cz').replace(/\/$/, ''),
  };
}

export function isMailerConfigured() {
  return !!cfg().apiKey;
}

// Odeslání jednoho emailu. Vrací { ok, id?, error? }.
// Nikdy nethrow — caller (hooks v routes) je fire-and-forget.
export async function sendMail({ to, subject, html, text }) {
  const { apiKey, from } = cfg();
  if (!apiKey) {
    console.log(`[mail] (no key) by sent: to=${to} subject=${subject}`);
    return { ok: false, error: 'no_api_key' };
  }
  if (!to) return { ok: false, error: 'no_recipient' };
  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from, to: [to], subject,
        html: html || `<pre>${text || ''}</pre>`,
        text: text || stripHtml(html || ''),
      }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.warn(`[mail] Resend ${r.status}: ${errBody.slice(0, 300)}`);
      return { ok: false, error: `resend_${r.status}` };
    }
    const d = await r.json();
    return { ok: true, id: d.id };
  } catch (err) {
    console.warn('[mail] send failed', err.message);
    return { ok: false, error: 'fetch_failed' };
  }
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Načti preference uživatele. Pokud řádek neexistuje, vrátíme všechny TRUE
// (= migrace default).
export async function getNotificationPrefs(userId) {
  // Defenzivně: kdyby email_daily_summary sloupec ještě neexistoval (migrace
  // nedoběhla), spadneme na query bez něj a default TRUE.
  try {
    const r = await query(
      `SELECT email_task_assigned, email_task_returned, email_task_approved, email_new_question,
              email_daily_summary
       FROM user_notification_prefs WHERE user_id = $1`,
      [userId]
    );
    if (r.rows[0]) return r.rows[0];
  } catch (err) {
    if (err.code === '42703') {
      const r = await query(
        `SELECT email_task_assigned, email_task_returned, email_task_approved, email_new_question
         FROM user_notification_prefs WHERE user_id = $1`,
        [userId]
      );
      if (r.rows[0]) return { ...r.rows[0], email_daily_summary: true };
    } else { throw err; }
  }
  return {
    email_task_assigned: true,
    email_task_returned: true,
    email_task_approved: true,
    email_new_question:  true,
    email_daily_summary: true,
  };
}

// Pomocný builder pro HTML šablonu. Centralizovaný — jeden look pro všechny.
// Link otevře appku s otevřeným úkolem (TaskDetailModal přes ?taskId=N).
export function buildTaskEmailHtml({ title, body, taskId, ctaLabel = 'Otevřít úkol' }) {
  const { base } = cfg();
  // Cíl: stránka MyTasks s query ?taskId=N → frontend modal se sám otevře
  // (TaskDetailModal handler v MyTasks už podobnou logiku má).
  const url = `${base}/my-tasks?taskId=${taskId}`;
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #eee9e4; padding: 24px; color: #1f3a40;">
  <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <div style="font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #e72b78; font-weight: bold;">VITOM IT Crew</div>
    <h2 style="margin: 12px 0 8px; color: #0c363e; font-size: 20px;">${escapeHtml(title)}</h2>
    <div style="font-size: 14px; line-height: 1.5; color: #1f3a40; margin-bottom: 20px;">${body}</div>
    <a href="${url}" style="display: inline-block; background: #0c363e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">${escapeHtml(ctaLabel)} →</a>
    <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2dcd3; font-size: 11px; color: #8a9b9f;">
      Odkaz: <a href="${url}" style="color: #0c363e;">${url}</a><br />
      Tyto notifikace si můžeš vypnout v profilu → Notifikace.
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
