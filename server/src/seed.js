// Naplnění DB ukázkovými daty pro 4-členný tým.
// Spustit: npm run seed (POZOR – smaže existující data!)
import 'dotenv/config';
import { pool, query, migrate } from './db.js';

async function main() {
  await migrate();

  console.log('[seed] mažu existující data…');
  await query(`
    TRUNCATE attachments, questions, time_entries, tasks, projects, users
    RESTART IDENTITY CASCADE
  `);

  // ---------- Uživatelé ----------
  const users = [
    { email: 'tomas.suchomel@vitom.cz',  name: 'Tomáš Suchomel',     role: 'admin',         rate: 1500 },
    { email: 'manager@vitom.cz',         name: 'Project Manager',    role: 'manager',       rate: 1200 },
    { email: 'senior.dev@vitom.cz',      name: 'Senior Programátor', role: 'senior_dev',    rate: 1300 },
    { email: 'external.dev@vitom.cz',    name: 'Externí Programátor',role: 'external_dev',  rate: 700  },
  ];
  const userIds = {};
  for (const u of users) {
    const r = await query(
      `INSERT INTO users (email, name, role, hourly_rate) VALUES ($1, $2, $3, $4) RETURNING id`,
      [u.email, u.name, u.role, u.rate]
    );
    userIds[u.role] = r.rows[0].id;
  }
  console.log(`[seed] vloženo ${users.length} uživatelů`);

  // ---------- Projekty ----------
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  const projects = [
    { name: 'E-shop pro klienta A',     description: 'Redesign a nová logika košíku, integrace s ERP.',
      client: 'Klient A s.r.o.',  start: addDays(today, -20), due: addDays(today,  25), budget: 250000 },
    { name: 'Interní CRM',              description: 'Modul reportů a notifikací nad existujícím CRM.',
      client: 'Vitom (interní)',  start: addDays(today, -10), due: addDays(today,  40), budget: 180000 },
    { name: 'Mobilní aplikace klient B',description: 'iOS + Android aplikace pro objednávkový systém.',
      client: 'Klient B a.s.',    start: addDays(today,   5), due: addDays(today,  90), budget: 420000 },
  ];
  const projectIds = [];
  for (const p of projects) {
    const r = await query(`
      INSERT INTO projects (name, description, client, start_date, due_date, manager_id, budget)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [p.name, p.description, p.client, iso(p.start), iso(p.due), userIds.manager, p.budget]);
    projectIds.push(r.rows[0].id);
  }
  console.log(`[seed] vloženo ${projects.length} projektů`);

  // ---------- Úkoly ----------
  const insTask = async (p) => {
    const r = await query(`
      INSERT INTO tasks (project_id, parent_id, title, description, assignee_id, status, priority, estimated_h, due_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [p.project_id, p.parent_id || null, p.title, p.description || null, p.assignee_id || null,
        p.status || 'todo', p.priority || 'normal', p.estimated_h || null, p.due_date || null]);
    return r.rows[0].id;
  };

  // E-shop
  const t1 = await insTask({ project_id: projectIds[0], title: 'Návrh nového košíku', description: 'Wireframy a flow pro nový checkout', assignee_id: userIds.senior_dev, status: 'in_progress', priority: 'high', estimated_h: 16, due_date: iso(addDays(today, 3)) });
  await insTask({ project_id: projectIds[0], parent_id: t1, title: 'Wireframy', description: 'Figma návrhy', assignee_id: userIds.senior_dev, status: 'done', estimated_h: 6, due_date: iso(addDays(today, -5)) });
  await insTask({ project_id: projectIds[0], parent_id: t1, title: 'Review s klientem', description: 'Odprezentovat klientovi', assignee_id: userIds.manager, estimated_h: 2, due_date: iso(addDays(today, 2)) });
  await insTask({ project_id: projectIds[0], title: 'Implementace košíku', description: 'React komponenty + napojení API', assignee_id: userIds.external_dev, priority: 'high', estimated_h: 40, due_date: iso(addDays(today, 18)) });
  await insTask({ project_id: projectIds[0], title: 'Integrace s ERP', description: 'Webhook + sync', assignee_id: userIds.senior_dev, priority: 'urgent', estimated_h: 24, due_date: iso(addDays(today, 22)) });

  // CRM
  const t2 = await insTask({ project_id: projectIds[1], title: 'Modul reportů', description: 'Dashboardy nad existujícími daty', assignee_id: userIds.senior_dev, status: 'in_progress', priority: 'high', estimated_h: 30, due_date: iso(addDays(today, 20)) });
  await insTask({ project_id: projectIds[1], parent_id: t2, title: 'Datový model reportů', assignee_id: userIds.senior_dev, status: 'done', estimated_h: 6, due_date: iso(addDays(today, -2)) });
  await insTask({ project_id: projectIds[1], parent_id: t2, title: 'UI grafy', description: 'Recharts', assignee_id: userIds.external_dev, status: 'in_progress', estimated_h: 16, due_date: iso(addDays(today, 12)) });
  await insTask({ project_id: projectIds[1], title: 'Notifikace přes email', assignee_id: userIds.external_dev, estimated_h: 12, due_date: iso(addDays(today, 30)) });

  // Mobil
  await insTask({ project_id: projectIds[2], title: 'Discovery + analýza', assignee_id: userIds.manager, priority: 'high', estimated_h: 20, due_date: iso(addDays(today, 15)) });
  await insTask({ project_id: projectIds[2], title: 'Prototyp v React Native', assignee_id: userIds.senior_dev, estimated_h: 60, due_date: iso(addDays(today, 60)) });
  console.log('[seed] vloženy úkoly');

  // ---------- Time entries ----------
  const entries = [
    { user: 'external_dev', proj: 0, day: -7, hours: 6,  desc: 'Wireframy košíku – první draft' },
    { user: 'external_dev', proj: 0, day: -6, hours: 7,  desc: 'Úprava wireframů po feedbacku' },
    { user: 'external_dev', proj: 1, day: -5, hours: 4,  desc: 'Práce na grafech v reportech' },
    { user: 'external_dev', proj: 1, day: -4, hours: 8,  desc: 'Recharts integrace + filtry' },
    { user: 'external_dev', proj: 0, day: -3, hours: 5,  desc: 'Začátek implementace košíku' },
    { user: 'external_dev', proj: 0, day: -2, hours: 7,  desc: 'Implementace košíku – komponenty' },
    { user: 'external_dev', proj: 1, day: -1, hours: 6,  desc: 'Notifikace – příprava' },
    { user: 'senior_dev',   proj: 0, day: -3, hours: 4,  desc: 'Code review + ERP analýza' },
    { user: 'senior_dev',   proj: 1, day: -2, hours: 5,  desc: 'Datový model reportů' },
    { user: 'manager',      proj: 0, day: -4, hours: 2,  desc: 'Schůzka s klientem' },
  ];
  for (const e of entries) {
    await query(`
      INSERT INTO time_entries (user_id, project_id, date, hours, description)
      VALUES ($1, $2, $3, $4, $5)
    `, [userIds[e.user], projectIds[e.proj], iso(addDays(today, e.day)), e.hours, e.desc]);
  }
  console.log(`[seed] vloženo ${entries.length} time entries`);

  console.log('\n✅ Seed hotový.');
}

main().then(() => pool.end()).catch(err => {
  console.error('[seed] CHYBA:', err);
  pool.end();
  process.exit(1);
});
