// Cron-style notifikace. Žádný node-cron — používáme setInterval+čas,
// abychom nezavlékli další dependency. Vyhodnocujeme každých 5 minut, jestli
// uplynul cílový čas; bezpečné proti driftu serveru o pár minut.
//
// Joby:
//   18:00 Europe/Prague  → DEADLINE check (push: úkoly s due_date = zítra)
//   08:00 Europe/Prague  → DAILY DIGEST (push: kolik dnes deadlinů, vrácení, otázek)
//   08:05 Europe/Prague  → DAILY EMAIL SUMMARY (AI reminder asistent: per-user)

import { query } from './db.js';
import { sendToUser, isPushConfigured } from './push.js';
import { sendMail, isMailerConfigured, getNotificationPrefs } from './mailer.js';
import { generateAgendaSuggestion } from './meetingsAi.js';

const TZ = 'Europe/Prague';

// Vrátí aktuální čas v Praze jako { h, m, ymd } – ymd je YYYY-MM-DD pro
// dedup klíč (každý job běží jednou denně).
function nowPrague() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return { h: Number(parts.hour), m: Number(parts.minute), ymd: `${parts.year}-${parts.month}-${parts.day}` };
}

// Den v týdnu podle Prague TZ. 0=neděle, 1=pondělí, ..., 6=sobota.
function dayOfWeekPrague() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date());
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[parts] ?? new Date().getDay();
}

// Track posledního běhu per-job, aby restart serveru během 5min okna ho neopakoval.
const lastRun = new Map(); // jobKey -> ymd

async function deadlineReminders() {
  // Úkoly s due_date = "zítra" (vůči Europe/Prague) a status open/in_progress/review/needs_fix
  const r = await query(`
    SELECT t.id, t.title, t.assignee_id, p.name AS project_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id IS NOT NULL
      AND t.status IN ('open', 'in_progress', 'review', 'needs_fix')
      AND t.due_date = (CURRENT_DATE AT TIME ZONE 'Europe/Prague')::date + INTERVAL '1 day'
  `);
  if (r.rows.length === 0) return { sent: 0, skipped: 0 };

  // Seskupit per uživatele (radši jedna notifikace s počtem než 5 zvlášť).
  const byUser = new Map();
  for (const row of r.rows) {
    const arr = byUser.get(row.assignee_id) || [];
    arr.push(row);
    byUser.set(row.assignee_id, arr);
  }

  let sent = 0;
  for (const [userId, tasks] of byUser.entries()) {
    const titles = tasks.slice(0, 3).map(t => `„${t.title}"`).join(', ');
    const more = tasks.length > 3 ? ` (+${tasks.length - 3} dalších)` : '';
    const body = tasks.length === 1
      ? `Zítra: ${titles} (${tasks[0].project_name})`
      : `Zítra ti vyprší ${tasks.length} úkolů: ${titles}${more}`;
    await sendToUser(userId, {
      title: '⏰ Deadline zítra',
      body,
      url: '/my-tasks',
      tag: 'deadline-tomorrow',
    });
    sent++;
  }
  return { sent, skipped: 0 };
}

async function dailyDigest() {
  // Pro každého uživatele s aspoň jednou active push subscription spočti
  // počet úkolů s due_date dnes + vrácení + otevřené dotazy.
  const r = await query(`
    SELECT u.id, u.name,
      (SELECT COUNT(*)::int FROM tasks t
        WHERE t.assignee_id = u.id
          AND t.status IN ('open', 'in_progress', 'review', 'needs_fix')
          AND t.due_date = (CURRENT_DATE AT TIME ZONE 'Europe/Prague')::date) AS due_today,
      (SELECT COUNT(*)::int FROM tasks t
        WHERE t.assignee_id = u.id AND t.status = 'needs_fix') AS needs_fix,
      (SELECT COUNT(*)::int FROM questions q
        WHERE q.to_user_id = u.id AND q.answered_at IS NULL) AS pending_questions
    FROM users u
    WHERE EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)
      AND u.active = TRUE
  `);

  let sent = 0;
  for (const u of r.rows) {
    const parts = [];
    if (u.due_today > 0) parts.push(`${u.due_today} deadline${u.due_today > 1 ? 'y' : ''} dnes`);
    if (u.needs_fix > 0) parts.push(`${u.needs_fix} vrácené k opravě`);
    if (u.pending_questions > 0) parts.push(`${u.pending_questions} otevřené dotazy`);
    if (parts.length === 0) continue; // nic akčního → nerušíme

    await sendToUser(u.id, {
      title: '☀️ Dobré ráno',
      body: parts.join(' · '),
      url: '/',
      tag: 'daily-digest',
    });
    sent++;
  }
  return { sent, skipped: 0 };
}

// AI reminder asistent — pro každého aktivního usera s open úkoly a
// email_daily_summary=TRUE pošle email se shrnutím a hlavním doporučením.
// Cíl: aby všechny úkoly byly včas. Hlavní doporučení nahoře, pak seznam.
//
// Per-user schedule: každý user má rozvrh (daily_summary_days + daily_summary_time).
// Cron se volá každé 4 minuty; tato funkce si sama filtruje, komu POSLAT NYNÍ.
// Parametr `nowPra` = { h, m, ymd, dayOfWeek } (0=neděle ... 6=sobota) v Praze.
async function dailyEmailSummary({ h, m, ymd, dayOfWeek } = {}) {
  if (!isMailerConfigured()) return { sent: 0, skipped: 'no_mailer' };
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { sent: 0, skipped: 'no_anthropic_key' };

  // Načti aktivní usery s alespoň jedním open úkolem.
  const usersR = await query(`
    SELECT DISTINCT u.id, u.email, u.name
    FROM users u
    JOIN tasks t ON t.assignee_id = u.id
    WHERE u.active = TRUE
      AND u.email IS NOT NULL
      AND t.status IN ('todo', 'in_progress', 'needs_fix', 'review')
  `);

  let sent = 0;
  for (const u of usersR.rows) {
    try {
      const prefs = await getNotificationPrefs(u.id);
      if (prefs.email_daily_summary === false) continue;

      // Per-user schedule check: dnes v jeho dnech + současný čas v ±5 min okně
      // jeho preferovaného času. Kdyby prefs neměl schedule (starý DB), použij default.
      const days = Array.isArray(prefs.daily_summary_days) && prefs.daily_summary_days.length > 0
        ? prefs.daily_summary_days.map(Number)
        : [1,2,3,4,5];
      const timeStr = /^\d{1,2}:\d{2}$/.test(prefs.daily_summary_time || '') ? prefs.daily_summary_time : '08:05';
      if (!days.includes(dayOfWeek)) continue;
      const [Ht, Mt] = timeStr.split(':').map(Number);
      // Delta v minutách od uživatelova času (< 0 = ještě neuplynul, > 5 = už moc pozdě)
      const nowTotalMin = h * 60 + m;
      const userTotalMin = Ht * 60 + Mt;
      const delta = nowTotalMin - userTotalMin;
      if (delta < 0 || delta >= 5) continue;
      // Dedup per user per den — ať restart serveru neposílá dvakrát
      const dedupKey = `email-summary-${u.id}`;
      if (lastRun.get(dedupKey) === ymd) continue;
      lastRun.set(dedupKey, ymd);

      // Open úkoly seřazené dle priority + due_date (NULL last).
      const tasksR = await query(`
        SELECT t.id, t.title, t.status, t.priority, t.due_date, t.estimated_h,
               p.name AS project_name
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.assignee_id = $1
          AND t.status IN ('todo', 'in_progress', 'needs_fix', 'review')
        ORDER BY
          CASE t.priority
            WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
            WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
          END,
          t.due_date NULLS LAST,
          t.id
      `, [u.id]);

      if (tasksR.rows.length === 0) continue;

      // Připomínka: nadcházející porada (do 48h), kde jsem organizer a
      // agenda ještě není finalizovaná. Vloží se do denního mailu jako varování.
      let meetingReminder = null;
      try {
        const mR = await query(`
          SELECT m.id, m.title, m.meeting_date, m.meeting_time, t.name AS type_name
          FROM meetings m JOIN meeting_types t ON t.id = m.type_id
          WHERE t.organizer_id = $1
            AND m.agenda_finalized_at IS NULL
            AND m.meeting_date IS NOT NULL
            AND m.meeting_date >= CURRENT_DATE
            AND m.meeting_date <= (CURRENT_DATE + INTERVAL '2 days')::date
          ORDER BY m.meeting_date ASC LIMIT 3
        `, [u.id]);
        if (mR.rows.length > 0) meetingReminder = mR.rows;
      } catch (err) {
        if (err.code !== '42P01') console.warn('[dailyEmailSummary] meetings check', err.message);
      }

      // MZV reminder: pokud je uživatel manager v nějakém týmu a má tam podřízené,
      // kterým MZV visí déle než 30 dní (nebo vůbec neproběhlo), vypíšeme je.
      let mzvReminder = null;
      try {
        const zR = await query(`
          WITH my_teams AS (
            SELECT team_id FROM team_members WHERE user_id = $1 AND team_role = 'manager'
          ),
          my_subs AS (
            SELECT DISTINCT sub.user_id
            FROM team_members sub
            JOIN my_teams t ON t.team_id = sub.team_id
            WHERE sub.user_id != $1
          )
          SELECT u.id, u.name,
                 (SELECT MAX(meeting_date) FROM mzv_meetings m WHERE m.subordinate_id = u.id AND m.manager_id = $1) AS last_mzv_date
          FROM my_subs s JOIN users u ON u.id = s.user_id
          WHERE (
            (SELECT MAX(meeting_date) FROM mzv_meetings m WHERE m.subordinate_id = u.id AND m.manager_id = $1) IS NULL
            OR (SELECT MAX(meeting_date) FROM mzv_meetings m WHERE m.subordinate_id = u.id AND m.manager_id = $1) < (CURRENT_DATE - INTERVAL '30 days')::date
          )
          ORDER BY last_mzv_date ASC NULLS FIRST, u.name ASC
          LIMIT 10
        `, [u.id]);
        if (zR.rows.length > 0) mzvReminder = zR.rows;
      } catch (err) {
        if (err.code !== '42P01') console.warn('[dailyEmailSummary] mzv check', err.message);
      }

      // AI doporučení — jeden Claude call per user
      const ai = await summarizeUserTasks(u, tasksR.rows, apiKey);
      const html = buildDailySummaryHtml(u, ai, tasksR.rows, meetingReminder, mzvReminder);
      const r = await sendMail({
        to: u.email,
        subject: `VITOM: Tvůj plán na dnes (${tasksR.rows.length} úkolů)`,
        html,
      });
      if (r.ok) sent++;
    } catch (err) {
      console.warn(`[dailyEmailSummary] user=${u.id} failed`, err.message?.slice(0, 200));
    }
  }
  return { sent, skipped: 0 };
}

async function summarizeUserTasks(user, tasks, apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  // Pošleme jen co potřeba: title, priority, deadline, hours, project.
  const compact = tasks.map(t => ({
    title: t.title,
    project: t.project_name,
    priority: t.priority,
    status: t.status,
    due_date: t.due_date,
    estimated_h: t.estimated_h,
  }));
  const system = `Jsi reminder asistent VITOM IT Crew. Tvůj cíl: pomoc uživateli ${user.name} dokončit všechny úkoly včas.
Dostaneš seznam jeho otevřených úkolů. Vrať POUZE validní JSON (nic okolo):
{
  "headline":       "jedna jasná věta, hlavní doporučení na dnes (max 100 znaků)",
  "recommendation": "2-3 věty: co konkrétně dnes řešit, v jakém pořadí a proč. Buď direktivní a stručný."
}

PRAVIDLA:
- Mluv česky, oslovuj tykáním.
- Soustřeď se na priority urgent/high + úkoly s deadlinem ≤ 7 dní + needs_fix (vrácené).
- Když je urgent/high s blízkým deadlinem, zmiň ho v headline jménem.
- Žádný corporate buzz, žádné "v souladu s..." atd.`;
  const userMsg = `Dnes je ${today}. Otevřené úkoly:\n${JSON.stringify(compact, null, 2)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: 400, system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) return { headline: `Máš ${tasks.length} otevřených úkolů`, recommendation: 'Začni s úkoly s nejbližším deadlinem.' };
  const d = await res.json();
  const raw = (d.content?.[0]?.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      headline: String(parsed.headline || '').slice(0, 200),
      recommendation: String(parsed.recommendation || '').slice(0, 800),
    };
  } catch {
    return { headline: `Máš ${tasks.length} otevřených úkolů`, recommendation: 'Začni s úkoly s nejbližším deadlinem.' };
  }
}

function buildDailySummaryHtml(user, ai, tasks, meetingReminder, mzvReminder) {
  const base = (process.env.APP_BASE_URL?.trim() || 'https://it.realitniekosystem.cz').replace(/\/$/, '');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const PRIO_LABEL = { urgent: '🔥 Urgent', high: '⬆ Vysoká', normal: 'Normální', low: '⬇ Nízká' };
  const PRIO_COLOR = { urgent: '#dc2626', high: '#d97706', normal: '#5b7177', low: '#8a9b9f' };
  const fmtDate = (d) => {
    if (!d) return '<span style="color:#8a9b9f;">bez termínu</span>';
    const dt = new Date(d);
    const today = new Date(); today.setHours(0,0,0,0);
    const tt = new Date(dt); tt.setHours(0,0,0,0);
    const diff = Math.round((tt - today) / 86400000);
    const label = dt.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
    if (diff < 0) return `<strong style="color:#dc2626;">${label} (po termínu)</strong>`;
    if (diff === 0) return `<strong style="color:#dc2626;">${label} (dnes)</strong>`;
    if (diff === 1) return `<strong style="color:#d97706;">${label} (zítra)</strong>`;
    if (diff <= 7) return `<span style="color:#d97706;">${label} (za ${diff} dní)</span>`;
    return `<span style="color:#5b7177;">${label}</span>`;
  };

  const rows = tasks.map(t => `
    <tr>
      <td style="padding:8px 6px;border-bottom:1px solid #e2dcd3;">
        <a href="${base}/my-tasks?taskId=${t.id}" style="color:#0c363e;text-decoration:none;font-weight:500;">${esc(t.title)}</a>
        <div style="font-size:11px;color:#8a9b9f;">${esc(t.project_name)}</div>
      </td>
      <td style="padding:8px 6px;border-bottom:1px solid #e2dcd3;color:${PRIO_COLOR[t.priority] || '#5b7177'};font-size:12px;white-space:nowrap;">
        ${PRIO_LABEL[t.priority] || t.priority}
      </td>
      <td style="padding:8px 6px;border-bottom:1px solid #e2dcd3;font-size:12px;">
        ${fmtDate(t.due_date)}
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #eee9e4; padding: 24px; color: #1f3a40;">
  <div style="max-width: 640px; margin: 0 auto; background: white; border-radius: 12px; padding: 24px;">
    <div style="font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #e72b78; font-weight: bold;">VITOM IT Crew · Reminder asistent</div>
    <h2 style="margin: 12px 0 8px; color: #0c363e; font-size: 22px;">☀️ Tvůj plán na dnes</h2>
    <p style="font-size:13px;color:#5b7177;margin:0 0 16px;">Ahoj <strong>${esc(user.name)}</strong>, tady je tvoje denní shrnutí.</p>

    <!-- Hlavní AI doporučení -->
    <div style="background:#fde6ef;border-left:4px solid #e72b78;padding:14px 16px;border-radius:6px;margin-bottom:20px;">
      <div style="font-weight:600;color:#0c363e;font-size:15px;margin-bottom:4px;">${esc(ai.headline)}</div>
      <div style="color:#365156;font-size:13px;line-height:1.5;">${esc(ai.recommendation)}</div>
    </div>

    ${meetingReminder && meetingReminder.length > 0 ? `
    <!-- Připomínka: nadcházející porada bez agendy -->
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:6px;margin-bottom:20px;">
      <div style="font-weight:600;color:#78350f;font-size:14px;margin-bottom:4px;">⚠️ Nadcházející porada — chybí agenda</div>
      <div style="color:#78350f;font-size:13px;line-height:1.5;">
        ${meetingReminder.map(m => {
          const d = new Date(m.meeting_date);
          const today = new Date(); today.setHours(0,0,0,0);
          const diff = Math.round((d - today) / 86400000);
          const dayLabel = diff === 0 ? '<strong>dnes</strong>' : diff === 1 ? '<strong>zítra</strong>' : `za ${diff} dní`;
          return `<div style="margin:6px 0;">
            📅 ${esc(m.type_name)} — ${dayLabel}${m.meeting_time ? ` v ${m.meeting_time.slice(0, 5)}` : ''}.
            Zadej agendu <a href="${base}/porady" style="color:#e72b78;font-weight:600;">v aplikaci</a>,
            jinak ji AI vygeneruje sama a rozešle účastníkům.
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    ${mzvReminder && mzvReminder.length > 0 ? `
    <!-- MZV reminder: podřízení, kteří nemají MZV déle než 30 dní -->
    <div style="background:#dbeafe;border-left:4px solid #3b82f6;padding:14px 16px;border-radius:6px;margin-bottom:20px;">
      <div style="font-weight:600;color:#1e3a8a;font-size:14px;margin-bottom:4px;">🎯 MZV vyprchává — ${mzvReminder.length} ${mzvReminder.length === 1 ? 'člověk' : mzvReminder.length < 5 ? 'lidé' : 'lidí'}</div>
      <div style="color:#1e3a8a;font-size:13px;line-height:1.5;">
        ${mzvReminder.map(s => {
          const label = s.last_mzv_date
            ? `poslední ${new Date(s.last_mzv_date).toLocaleDateString('cs-CZ')}`
            : '<strong>ještě nikdy</strong>';
          return `<div style="margin:6px 0;">
            👤 <strong>${esc(s.name)}</strong> — ${label}.
            <a href="${base}/mzv" style="color:#e72b78;font-weight:600;">Naplánovat MZV →</a>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Seznam úkolů seřazený dle priority + termínu -->
    <div style="font-size:13px;color:#0c363e;font-weight:600;margin-bottom:6px;">📋 Tvé otevřené úkoly (${tasks.length})</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#1f3a40;">
      <thead>
        <tr style="background:#f9f6f1;text-align:left;">
          <th style="padding:8px 6px;font-size:11px;color:#5b7177;text-transform:uppercase;letter-spacing:0.05em;">Úkol</th>
          <th style="padding:8px 6px;font-size:11px;color:#5b7177;text-transform:uppercase;letter-spacing:0.05em;">Priorita</th>
          <th style="padding:8px 6px;font-size:11px;color:#5b7177;text-transform:uppercase;letter-spacing:0.05em;">Termín</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="margin-top: 20px;">
      <a href="${base}/my-tasks" style="display: inline-block; background: #0c363e; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Otevřít Moje úkoly →</a>
    </div>

    <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2dcd3; font-size: 11px; color: #8a9b9f;">
      Klik na úkol otevře jeho detail v appce. Denní souhrn můžeš vypnout v profilu → Notifikace e-mailem.
    </div>
  </div>
</body></html>`;
}

// Meeting agenda deadline: pro nadcházející porady (meeting_date ≤ zítra),
// kde organizer nefinalizoval agendu, AI vygeneruje kompletní návrh a rozešle
// všem účastníkům e-mailem. Běží jednou za hodinu (9-18h), dedup per meeting_id.
async function meetingAgendaCron({ ymd }) {
  if (!isMailerConfigured()) return { sent: 0, skipped: 'no_mailer' };
  if (!process.env.ANTHROPIC_API_KEY) return { sent: 0, skipped: 'no_ai' };

  // Meetings s datem = zítra, agenda_finalized_at IS NULL.
  // Dedup per meeting: jeden mail za život meetingu.
  const r = await query(`
    SELECT m.*, t.name AS type_name, t.agenda_template, t.organizer_id, t.team_id
    FROM meetings m JOIN meeting_types t ON t.id = m.type_id
    WHERE m.agenda_finalized_at IS NULL
      AND m.meeting_date IS NOT NULL
      AND m.meeting_date <= (CURRENT_DATE + INTERVAL '1 day')::date
      AND m.meeting_date >= CURRENT_DATE
  `);
  let sent = 0;
  for (const m of r.rows) {
    const dedupKey = `meeting-agenda-${m.id}`;
    if (lastRun.get(dedupKey)) continue;

    // Generuj AI agendu (helper už spojí kostru + AI návrh)
    const type = { id: m.type_id, name: m.type_name, agenda_template: m.agenda_template };
    const out = await generateAgendaSuggestion(m, type);
    if (out.error) { console.warn('[meeting-agenda] AI', m.id, out.error); continue; }

    // Merge template + AI items
    const template = Array.isArray(m.agenda_template) ? m.agenda_template.map(t => ({ text: t.text, checked: false, source: 'template' })) : [];
    const aiItems = (out.items || []).map(i => ({ text: i.text, checked: false, source: 'ai' }));
    const fullAgenda = [...template, ...aiItems];

    // Ulož agendu + agenda_source, ale NEfinalizuj (organizer může ještě edit)
    await query(`
      UPDATE meetings SET agenda = $1::jsonb, agenda_finalized_at = NOW(), agenda_source = 'ai_auto'
      WHERE id = $2
    `, [JSON.stringify(fullAgenda), m.id]);

    // Rozešli attendees + organizer
    const attendees = Array.isArray(m.attendees) ? m.attendees : [];
    const emails = new Set();
    for (const a of attendees) {
      if (a.user_id) {
        const u = (await query(`SELECT email FROM users WHERE id = $1`, [a.user_id])).rows[0];
        if (u?.email) emails.add(u.email);
      } else if (a.guest_email) emails.add(a.guest_email);
    }
    if (m.organizer_id) {
      const u = (await query(`SELECT email FROM users WHERE id = $1`, [m.organizer_id])).rows[0];
      if (u?.email) emails.add(u.email);
    }

    const url = `${process.env.CLIENT_URL || ''}/porady`;
    const agendaHtml = fullAgenda.map(a =>
      `<li>${a.source === 'ai' ? '🤖 ' : ''}${escapeMailStr(a.text)}</li>`).join('') || '<li><em>Prázdno</em></li>';
    const dateStr = new Date(m.meeting_date).toLocaleDateString('cs-CZ');
    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;color:#1f3a40">
      <div style="max-width:560px;margin:auto;background:white;border-radius:8px;padding:20px">
        <div style="color:#e72b78;font-weight:bold;font-size:11px;letter-spacing:0.15em">VITOM PORADY</div>
        <h2 style="margin:8px 0">Agenda porady ${escapeMailStr(m.type_name)}</h2>
        <div style="color:#5b7177;font-size:13px">${dateStr}${m.meeting_time ? ` v ${m.meeting_time.slice(0, 5)}` : ''}</div>
        <p style="font-size:13px;color:#e72b78">⚠️ Organizátor agendu nefinalizoval, AI ji vygenerovala automaticky.</p>
        <h3 style="margin-top:16px">${escapeMailStr(m.title)}</h3>
        <ul style="font-size:14px;line-height:1.6">${agendaHtml}</ul>
        <div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2dcd3;font-size:12px;color:#5b7177">
          <a href="${url}" style="color:#e72b78">Upravit v aplikaci →</a>
        </div>
      </div></body></html>`;
    for (const email of emails) {
      try { await sendMail({ to: email, subject: `Agenda porady ${dateStr}`, html }); sent++; }
      catch (err) { console.warn('[meeting-agenda] mail', email, err.message); }
    }
    lastRun.set(dedupKey, ymd);
  }
  return { sent };
}

function escapeMailStr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tick() {
  const { h, m, ymd } = nowPrague();
  // 5min toleranční okno: spustíme jakmile prošla cílová hodina, ne dřív.
  try {
    // Porady: kontrola agendy 24h dopředu, každou celou hodinu 09-18.
    if (m < 5 && h >= 9 && h <= 18) {
      const rKey = `meeting-agenda-hour-${h}`;
      if (lastRun.get(rKey) !== ymd) {
        lastRun.set(rKey, ymd);
        const r = await meetingAgendaCron({ ymd });
        if (r.sent > 0) console.log(`[pushCron] meeting agenda mails sent=${r.sent}`);
      }
    }
    // Push deadlines + digest (vyžaduje push konfiguraci)
    if (isPushConfigured()) {
      if (h === 18 && m < 5 && lastRun.get('deadline') !== ymd) {
        lastRun.set('deadline', ymd);
        const r = await deadlineReminders();
        console.log(`[pushCron] deadline reminders sent=${r.sent}`);
      }
      if (h === 8 && m < 5 && lastRun.get('digest') !== ymd) {
        lastRun.set('digest', ymd);
        const r = await dailyDigest();
        console.log(`[pushCron] daily digest sent=${r.sent}`);
      }
    }
    // Email daily summary — per-user schedule check probíhá uvnitř funkce.
    // Voláme každý tick a funkce si sama filtruje, komu POSLAT NYNÍ podle
    // jeho zvolených dnů + časů.
    const r = await dailyEmailSummary({ h, m, ymd, dayOfWeek: dayOfWeekPrague() });
    if (r.sent > 0 || (r.skipped && r.skipped !== 'no_mailer' && r.skipped !== 'no_anthropic_key')) {
      console.log(`[pushCron] daily email summary sent=${r.sent}${r.skipped ? ` skipped=${r.skipped}` : ''}`);
    }
  } catch (err) {
    console.warn('[pushCron] tick error', err.message);
  }
}

export function startPushCron() {
  // Tick každé 4 minuty — bezpečně pokryje 5min okno bez race.
  setInterval(tick, 4 * 60 * 1000);
  // První tick za 30s po startu (případně doženeme zmeškané dnes).
  setTimeout(tick, 30 * 1000);
  console.log('[pushCron] started (deadline 18:00, push digest 08:00, email summary 08:05 Europe/Prague)');
}
