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
async function dailyEmailSummary() {
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

      // AI doporučení — jeden Claude call per user
      const ai = await summarizeUserTasks(u, tasksR.rows, apiKey);
      const html = buildDailySummaryHtml(u, ai, tasksR.rows);
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

function buildDailySummaryHtml(user, ai, tasks) {
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

async function tick() {
  const { h, m, ymd } = nowPrague();
  // 5min toleranční okno: spustíme jakmile prošla cílová hodina, ne dřív.
  try {
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
    // Email daily summary (vyžaduje mailer + Anthropic). Spouští se v 8:05,
    // ať se neproblamuje s push digestem v 8:00 (oba dělají hodně requestů).
    if (h === 8 && m >= 5 && m < 10 && lastRun.get('email-summary') !== ymd) {
      lastRun.set('email-summary', ymd);
      const r = await dailyEmailSummary();
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
