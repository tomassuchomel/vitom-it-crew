// Nápadník — workflow a lifecycle po úpravách z podzimu 2026:
//   - ze schválené analýzy jde nápad rovnou uzavřít (ne vždy je potřeba projekt)
//   - omylem uzavřený nápad jde vrátit k rozpracování
//   - sloučení přenáší i vazbu na úkoly a projekt
//   - historie editace ukazuje starou i novou hodnotu
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const mgmtTeam = (await db.query(`
    INSERT INTO teams (name, slug) VALUES ('Management','management')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `)).rows[0].id;
  const itTeam = (await db.query(`INSERT INTO teams (name,slug) VALUES ('IT','it-wf') RETURNING id`)).rows[0].id;
  const mk = async (e, n, r) =>
    (await db.query(`INSERT INTO users (email,name,role) VALUES ($1,$2,$3) RETURNING id`, [e, n, r])).rows[0].id;

  const mgmt = await mk('mgmt-wf@t.cz', 'Manager', 'manager');
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager')`, [mgmtTeam, mgmt]);
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member')`, [itTeam, mgmt]);

  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`,
    [itTeam, mgmt]
  )).rows[0].id;
  return { mgmtTeam, itTeam, mgmt, project };
}

const USER = () => ({ id: ctx.mgmt, email: 'mgmt-wf@t.cz', role: 'manager', name: 'Manager' });

const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/ideas${path}`, {
    method,
    headers: { cookie: `tf_token=${signToken(USER())}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const newIdea = async (state = 'zadano') => (await db.query(`
  INSERT INTO ideas (proposer_name, proposer_email, title, department, category,
    problem_description, solution_proposal, state, garant_id)
  VALUES ('N','n@t.cz','Nápad','Marketing','AI využití','problém','řešení',$1,$2) RETURNING id
`, [state, ctx.mgmt])).rows[0].id;

const stateOf = async (id) => (await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state;

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  process.env.JWT_SECRET = 'test-secret';
  process.env.DISABLE_AUTOSEED = '1';
  db = await import('../../db.js');
  await db.migrate();
  await db.runFileMigrations();
  ({ signToken } = await import('../../auth.js'));
  const { default: ideasRoutes } = await import('../ideas.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/ideas', ideasRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

// ---------- uzavření bez projektu ----------

test('schválenou analýzu lze uzavřít jako hotovou i bez projektu', async () => {
  const id = await newIdea('schvalena_analyza');
  const tr = await api('GET', `/${id}/transitions`);
  assert.ok(tr.body.transitions.some(t => t.to === 'hotovo'), 'akce se nabízí');

  const r = await api('POST', `/${id}/state`, { to_state: 'hotovo', comment: 'Udělalo se rovnou.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await stateOf(id), 'hotovo');
});

test('uzavření bez komentáře neprojde', async () => {
  const id = await newIdea('schvalena_analyza');
  const r = await api('POST', `/${id}/state`, { to_state: 'hotovo' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'comment_required');
});

// ---------- vrácení hotového ----------

test('hotový nápad lze vrátit k rozpracování s důvodem', async () => {
  const id = await newIdea('hotovo');
  const r = await api('POST', `/${id}/state`, { to_state: 'rozpracovano', comment: 'Omyl, ještě není hotovo.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await stateOf(id), 'rozpracovano');

  const ev = await db.query(
    `SELECT comment FROM idea_events WHERE idea_id=$1 AND to_state='rozpracovano'`, [id]
  );
  assert.match(ev.rows[0].comment, /Omyl/, 'důvod je v historii');
});

test('vrácení bez důvodu neprojde', async () => {
  const id = await newIdea('hotovo');
  const r = await api('POST', `/${id}/state`, { to_state: 'rozpracovano' });
  assert.equal(r.status, 400);
});

// ---------- sloučení ----------

test('sloučení přenese i vazbu na úkoly, cíl se pak umí dokončit', async () => {
  const { syncIdeaCompletion } = await import('../../ideaLifecycle.js');
  const src = await newIdea();
  const dst = await newIdea();

  const task = (await api('POST', `/${src}/create-task`, { project_id: ctx.project })).body.task.id;
  assert.equal(await stateOf(src), 'rozpracovano');

  const m = await api('POST', `/${src}/merge`, { target_id: dst });
  assert.equal(m.status, 200, JSON.stringify(m.body));

  const moved = await db.query('SELECT idea_id FROM idea_tasks WHERE task_id=$1', [task]);
  assert.equal(moved.rows.length, 1);
  assert.equal(Number(moved.rows[0].idea_id), Number(dst), 'vazba přešla na cíl');

  // Cíl musí jít dokončit — dřív mu total vyšlo 0 a zůstal viset navždy.
  await db.query(`UPDATE ideas SET state='rozpracovano' WHERE id=$1`, [dst]);
  await db.query(`UPDATE tasks SET status='done' WHERE id=$1`, [task]);
  await syncIdeaCompletion(dst);
  assert.equal(await stateOf(dst), 'hotovo');
});

test('sloučený nápad se sám neuzavírá', async () => {
  const { syncIdeaCompletion } = await import('../../ideaLifecycle.js');
  const src = await newIdea();
  const dst = await newIdea();
  await api('POST', `/${src}/create-task`, { project_id: ctx.project });
  await api('POST', `/${src}/merge`, { target_id: dst });

  await db.query(`UPDATE ideas SET state='rozpracovano' WHERE id=$1`, [src]);
  await syncIdeaCompletion(src);
  assert.notEqual(await stateOf(src), 'hotovo', 'sloučený nápad řeší jeho cíl');
});

test('zrušený projekt nenechá nápad viset navždy', async () => {
  const { syncIdeaCompletion } = await import('../../ideaLifecycle.js');
  const p = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,status) VALUES ('Zrušený',CURRENT_DATE,$1,'cancelled') RETURNING id`,
    [ctx.itTeam]
  )).rows[0].id;
  const id = await newIdea('rozpracovano');
  await db.query(`UPDATE ideas SET linked_project_id=$1 WHERE id=$2`, [p, id]);

  await syncIdeaCompletion(id);
  assert.equal(await stateOf(id), 'hotovo');
});

// ---------- audit editace ----------

test('historie editace ukazuje starou i novou hodnotu', async () => {
  const id = await newIdea();
  await api('PATCH', `/${id}`, { pm_note: 'První verze' });
  await api('PATCH', `/${id}`, { pm_note: 'Druhá verze' });

  const ev = await db.query(
    `SELECT comment FROM idea_events WHERE idea_id=$1 AND action='edit' ORDER BY id`, [id]
  );
  assert.equal(ev.rows.length, 2);
  assert.match(ev.rows[0].comment, /Poznámka PM: \(prázdné\) → První verze/);
  assert.match(ev.rows[1].comment, /Poznámka PM: První verze → Druhá verze/);
});

test('editace beze změny hodnoty nic neloguje', async () => {
  const id = await newIdea();
  await api('PATCH', `/${id}`, { pm_note: 'Stejné' });
  await api('PATCH', `/${id}`, { pm_note: 'Stejné' });

  const ev = await db.query(
    `SELECT 1 FROM idea_events WHERE idea_id=$1 AND action='edit'`, [id]
  );
  assert.equal(ev.rows.length, 1, 'jen skutečná změna');
});
