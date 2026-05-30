// Cron-style push notifikace. Žádný node-cron — používáme setInterval+čas,
// abychom nezavlékli další dependency. Vyhodnocujeme každých 5 minut, jestli
// uplynul cílový čas; bezpečné proti driftu serveru o pár minut.
//
// Joby:
//   18:00 Europe/Prague  → DEADLINE check (úkoly s due_date = zítra, status != done/cancelled)
//   08:00 Europe/Prague  → DAILY DIGEST (per uživatel: kolik dnes deadlinů, vrácení, otázek)

import { query } from './db.js';
import { sendToUser, isPushConfigured } from './push.js';

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

async function tick() {
  if (!isPushConfigured()) return;
  const { h, m, ymd } = nowPrague();
  // 5min toleranční okno: spustíme jakmile prošla cílová hodina, ne dřív.
  try {
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
  } catch (err) {
    console.warn('[pushCron] tick error', err.message);
  }
}

export function startPushCron() {
  // Tick každé 4 minuty — bezpečně pokryje 5min okno bez race.
  setInterval(tick, 4 * 60 * 1000);
  // První tick za 30s po startu (případně doženeme zmeškané dnes).
  setTimeout(tick, 30 * 1000);
  console.log('[pushCron] started (deadline 18:00, digest 08:00 Europe/Prague)');
}
