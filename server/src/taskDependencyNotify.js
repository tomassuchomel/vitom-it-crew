// Upozornění kolem návazností úkolů (sekce 15 a 16 zadání).
//
// Dvě situace:
//   1) blokující úkol je hotový → dej vědět řešiteli návazného úkolu a
//      vedoucímu jeho projektu, že se může rozjet,
//   2) blokujícímu úkolu se posunul termín → upozorni vedoucího projektu,
//      že to může ovlivnit navazující práci.
//
// Stav návazného úkolu NIKDY neměníme automaticky — zadání to výslovně
// zakazuje, rozhodnout musí člověk.
//
// Vše fire-and-forget: chyba v mailu nesmí shodit dokončení úkolu.

import { query } from './db.js';
import { sendMail, buildTaskEmailHtml, getNotificationPrefs } from './mailer.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Pošle mail s respektem k preferencím uživatele. Klíč prefs sdílíme
// s „úkol ti byl přiřazen" — je to stejná kategorie „něco se děje s mým úkolem".
async function mailUser(userId, email, subject, title, body, taskId) {
  if (!userId || !email) return;
  try {
    const prefs = await getNotificationPrefs(userId);
    if (!prefs.email_task_assigned) return;
    await sendMail({ to: email, subject, html: buildTaskEmailHtml({ title, body, taskId }) });
  } catch (err) {
    console.warn('[mail/dependency]', err.message);
  }
}

// Blokující úkol dokončen → komu to dát vědět.
export async function notifyBlockerDone(blockerTaskId) {
  const r = await query(`
    SELECT t.id, t.title, t.assignee_id, t.status,
           au.email AS assignee_email,
           p.name AS project_name, p.manager_id,
           mu.email AS manager_email,
           b.title AS blocker_title
    FROM task_dependencies d
    JOIN tasks t      ON t.id = d.task_id
    JOIN tasks b      ON b.id = d.depends_on_id
    JOIN projects p   ON p.id = t.project_id
    LEFT JOIN users au ON au.id = t.assignee_id
    LEFT JOIN users mu ON mu.id = p.manager_id
    WHERE d.depends_on_id = $1 AND t.status <> 'done'
  `, [blockerTaskId]);

  for (const row of r.rows) {
    const body = `<p>Úkol <strong>${esc(row.blocker_title)}</strong>, na který se čekalo, je hotový.</p>
      <p>Můžeš se pustit do <strong>${esc(row.title)}</strong> (${esc(row.project_name)}).</p>
      <p style="color:#5b7177;font-size:13px;">Stav úkolu jsme nezměnili — přepni ho sám, až se do něj pustíš.</p>`;
    await mailUser(row.assignee_id, row.assignee_email,
      `Odblokováno: ${row.title}`, '🔓 Můžeš pokračovat', body, row.id);

    // Vedoucímu projektu jen když to není tentýž člověk.
    if (row.manager_id && row.manager_id !== row.assignee_id) {
      await mailUser(row.manager_id, row.manager_email,
        `Odblokováno: ${row.title}`, '🔓 Návazný úkol se může rozjet', body, row.id);
    }
  }
}

// Blokujícímu úkolu se posunul termín → upozorni vedoucí navazujících úkolů.
// Termíny navazujících úkolů NEposouváme.
export async function notifyBlockerDueChanged(blockerTaskId, oldDue, newDue) {
  const r = await query(`
    SELECT t.id, t.title, t.due_date::text AS due_date,
           p.name AS project_name, p.manager_id,
           mu.email AS manager_email,
           b.title AS blocker_title
    FROM task_dependencies d
    JOIN tasks t      ON t.id = d.task_id
    JOIN tasks b      ON b.id = d.depends_on_id
    JOIN projects p   ON p.id = t.project_id
    LEFT JOIN users mu ON mu.id = p.manager_id
    WHERE d.depends_on_id = $1 AND t.status <> 'done' AND p.manager_id IS NOT NULL
  `, [blockerTaskId]);

  const fmt = (d) => (d ? String(d).slice(0, 10) : 'bez termínu');
  for (const row of r.rows) {
    const body = `<p>Blokujícímu úkolu <strong>${esc(row.blocker_title)}</strong> se posunul termín:
      ${esc(fmt(oldDue))} → <strong>${esc(fmt(newDue))}</strong>.</p>
      <p>Může to ovlivnit navazující úkol <strong>${esc(row.title)}</strong> (${esc(row.project_name)})
      s termínem ${esc(fmt(row.due_date))}.</p>
      <p style="color:#5b7177;font-size:13px;">Termín navazujícího úkolu jsme nezměnili — posuď sám, jestli je potřeba.</p>`;
    await mailUser(row.manager_id, row.manager_email,
      `Posun termínu může ovlivnit: ${row.title}`, '⚠️ Posunutý blokující úkol', body, row.id);
  }
}
