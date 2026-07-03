// Email helper přes Microsoft Graph API (Client Credentials Flow).
// Server se přihlásí sám sebe (žádný per-user OAuth) a posílá z konkrétní
// mailbox v M365 tenantu.
//
// Vyžadované Azure App registration permissions (Application, ne Delegated):
//   - Mail.Send  (admin consent granted)
// Doporučeno: Application Access Policy v M365 PowerShell, aby aplikace mohla
// posílat JEN z MAIL_M365_MAILBOX, ne ze všech schránek.
//
// Env:
//   MICROSOFT_CLIENT_ID      — Azure App ID (sdílí s Email C OAuth)
//   MICROSOFT_CLIENT_SECRET  — Azure App secret
//   MICROSOFT_TENANT_ID      — Azure tenant GUID
//   MAIL_M365_MAILBOX        — odesílatel, např. "notifikace@vitom.cz"
//   APP_BASE_URL             — public URL appky (pro odkazy v emailu)

import { query } from './db.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function cfg() {
  return {
    clientId:     process.env.MICROSOFT_CLIENT_ID?.trim(),
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET?.trim(),
    tenantId:     process.env.MICROSOFT_TENANT_ID?.trim(),
    mailbox:      process.env.MAIL_M365_MAILBOX?.trim(),
    base:         (process.env.APP_BASE_URL?.trim() || 'https://it.realitniekosystem.cz').replace(/\/$/, ''),
  };
}

export function isMailerConfigured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.tenantId && c.mailbox);
}

// Volá se ze startu serveru — log + early sanity check.
export function describeMailerConfig() {
  const c = cfg();
  return {
    has_client_id:     !!c.clientId,
    has_client_secret: !!c.clientSecret,
    has_tenant_id:     !!c.tenantId,
    has_mailbox:       !!c.mailbox,
    mailbox:           c.mailbox || '(not set)',
  };
}

// Token cache — Graph access token žije ~60 min. Žádný retry, při expiry
// se sám refreshne při dalším volání.
let tokenCache = { token: null, exp: 0 };

async function getAppAccessToken() {
  const c = cfg();
  if (!isMailerConfigured()) return null;
  // 60s buffer před expirací, ať nepošleme s right-on-edge tokenem.
  if (tokenCache.token && tokenCache.exp - 60_000 > Date.now()) {
    return tokenCache.token;
  }
  const r = await fetch(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    console.warn(`[mail] token request failed ${r.status}: ${txt.slice(0, 300)}`);
    return null;
  }
  const d = await r.json();
  const expiresMs = (Number(d.expires_in) || 3600) * 1000;
  tokenCache = { token: d.access_token, exp: Date.now() + expiresMs };
  return d.access_token;
}

// Odeslání jednoho emailu přes Graph /users/{mailbox}/sendMail.
// Vrací { ok, error? }. Nikdy nethrow — caller (hooks v routes) je fire-and-forget.
export async function sendMail({ to, subject, html, text }) {
  const c = cfg();
  if (!isMailerConfigured()) {
    console.log(`[mail] (no config) by sent: to=${to} subject=${subject}`);
    return { ok: false, error: 'no_config' };
  }
  if (!to) return { ok: false, error: 'no_recipient' };

  const token = await getAppAccessToken();
  if (!token) return { ok: false, error: 'no_token' };

  const body = {
    message: {
      subject: String(subject || '(no subject)').slice(0, 255),
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text || '',
      },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    // saveToSentItems=false → schránka notifikace@vitom.cz se nezaplní
    // tisíci odeslaných mailů. Můžeš změnit na true, pokud chceš audit log v M365.
    saveToSentItems: 'false',
  };

  try {
    const r = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(c.mailbox)}/sendMail`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.warn(`[mail] Graph sendMail ${r.status}: ${errBody.slice(0, 300)}`);
      if (r.status === 401) tokenCache = { token: null, exp: 0 };
      return { ok: false, error: `graph_${r.status}` };
    }
    // sendMail vrací 202 Accepted bez body — explicitně logujeme úspěch
    console.log(`[mail] sent OK → ${to} (subject: ${String(subject).slice(0, 80)})`);
    return { ok: true };
  } catch (err) {
    console.warn('[mail] send failed', err.message);
    return { ok: false, error: 'fetch_failed' };
  }
}

// Načti preference uživatele. Pokud řádek neexistuje, vrátíme všechny TRUE.
// Defenzivně: kdyby některé sloupce ještě neexistovaly (migrace neběžela),
// vracíme jen defaults — nesnažíme se skládat parciální řádek.
const DEFAULT_PREFS = {
  email_task_assigned:         true,
  email_task_returned:         true,
  email_task_approved:         true,
  email_new_question:          true,
  email_daily_summary:         true,
  daily_summary_days:          [1,2,3,4,5],
  daily_summary_time:          '08:05',
  email_idea_new:              true,
  email_idea_approved:         true,
  email_idea_assigned_garant:  true,
};

export async function getNotificationPrefs(userId) {
  try {
    const r = await query(
      `SELECT email_task_assigned, email_task_returned, email_task_approved, email_new_question,
              email_daily_summary, daily_summary_days, daily_summary_time,
              email_idea_new, email_idea_approved, email_idea_assigned_garant
       FROM user_notification_prefs WHERE user_id = $1`,
      [userId]
    );
    if (r.rows[0]) return { ...DEFAULT_PREFS, ...r.rows[0] };
  } catch (err) {
    if (err.code !== '42703') throw err;
    // Migrace nedoběhla — zkus starší tvar (bez idea polí).
    try {
      const r = await query(
        `SELECT email_task_assigned, email_task_returned, email_task_approved, email_new_question,
                email_daily_summary, daily_summary_days, daily_summary_time
         FROM user_notification_prefs WHERE user_id = $1`,
        [userId]
      );
      if (r.rows[0]) return { ...DEFAULT_PREFS, ...r.rows[0] };
    } catch (err2) {
      if (err2.code !== '42703') throw err2;
      const r = await query(
        `SELECT email_task_assigned, email_task_returned, email_task_approved, email_new_question
         FROM user_notification_prefs WHERE user_id = $1`,
        [userId]
      );
      if (r.rows[0]) return { ...DEFAULT_PREFS, ...r.rows[0] };
    }
  }
  return DEFAULT_PREFS;
}

// HTML šablona pro jednorázové task-related emaily. Link otevře appku
// s otevřeným úkolem (TaskDetailModal přes ?taskId=N).
export function buildTaskEmailHtml({ title, body, taskId, ctaLabel = 'Otevřít úkol' }) {
  const { base } = cfg();
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
      Tyto notifikace si můžeš vypnout v profilu → Notifikace e‑mailem.
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML šablona pro emaily z Nápadníku. Odkaz jde do interní stránky /napadnik
// (proposer je externí, ale link mu dá kontext — pokud není přihlášen, vidí login).
export function buildIdeaEmailHtml({ title, body, ctaLabel = 'Otevřít Nápadník' }) {
  const { base } = cfg();
  const url = `${base}/napadnik`;
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #eee9e4; padding: 24px; color: #1f3a40;">
  <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <div style="font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #e72b78; font-weight: bold;">VITOM Nápadník</div>
    <h2 style="margin: 12px 0 8px; color: #0c363e; font-size: 20px;">${escapeHtml(title)}</h2>
    <div style="font-size: 14px; line-height: 1.5; color: #1f3a40; margin-bottom: 20px;">${body}</div>
    <a href="${url}" style="display: inline-block; background: #0c363e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">${escapeHtml(ctaLabel)} →</a>
    <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2dcd3; font-size: 11px; color: #8a9b9f;">
      Odkaz: <a href="${url}" style="color: #0c363e;">${url}</a><br />
      Tyto notifikace si můžeš vypnout v profilu → Notifikace e‑mailem.
    </div>
  </div>
</body></html>`;
}
