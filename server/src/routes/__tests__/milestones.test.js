// Projektové milníky (sekce 4 zadání) + jejich data pro Timeline (sekce 5).
// Pokrývá testovací scénáře 8–12 z bodu 24.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-ms2') RETURNING id`)).rows[0].id;
  const other = (await db.query(`INSERT INTO teams (name,slug) VALUES ('Cizí','t-cizi2') RETURNING id`)).rows[0].id;
  const mk = async (email, name, role) =>
    (await db.query(`INSERT INTO users (email,name,role) VALUES ($1,$2,$3) RETURNING id`, [email, name, role])).rows[0].id;

  const pm      = await mk('pm-ms@t.cz', 'PM projektu', 'senior_dev');
  const member  = await mk('mem-ms@t.cz', 'Člen', 'senior_dev');
  const outsider = await mk('out-ms@t.cz', 'Cizí', 'senior_dev');
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member'),($1,$3,'member')`, [team, pm, member]);
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member')`, [other, outsider]);

  // PM je manager projektu → smí spravovat milníky, i když není team manager.
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,due_date,team_id,manager_id)
     VALUES ('P',CURRENT_DATE,'2026-10-31'::date,$1,$2) RETURNING id`, [team, pm]
  )).rows[0].id;
  const task = (await db.query(
    `INSERT INTO tasks (project_id,title,status) VALUES ($1,'Nasadit produkci','todo') RETURNING id`, [project]
  )).rows[0].id;

  const foreignProject = (await db.query(
    `INSERT INTO projects (name,start_date,team_id) VALUES ('Cizí P',CURRENT_DATE,$1) RETURNING id`, [other]
  )).rows[0].id;
  const foreignTask = (await db.query(
    `INSERT INTO tasks (project_id,title) VALUES ($1,'Cizí úkol') RETURNING id`, [foreignProject]
  )).rows[0].id;

  return { team, other, pm, member, outsider, project, task, foreignProject, foreignTask };
}

const USER = {
  pm:     () => ({ id: ctx.pm, email: 'pm-ms@t.cz', role: 'senior_dev', name: 'PM projektu' }),
  member: () => ({ id: ctx.member, email: 'mem-ms@t.cz', role: 'senior_dev', name: 'Člen' }),
  out:    () => ({ id: ctx.outsider, email: 'out-ms@t.cz', role: 'senior_dev', name: 'Cizí' }),
};

const api = async (user, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/milestones${path}`, {
    method,
    headers: { cookie: `tf_token=${signToken(user)}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const addMilestone = (user, data) => api(user, 'POST', `/project/${ctx.project}`, data);

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
  const { default: milestonesRoutes } = await import('../milestones.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/milestones', milestonesRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('projekt lze rozdělit na víc milníků, každý s vlastním termínem', async () => {
  const a = await addMilestone(USER.pm(), { name: 'Výběr dodavatele', deadline: '2026-09-15' });
  const b = await addMilestone(USER.pm(), { name: 'Implementace', deadline: '2026-09-30' });
  const c = await addMilestone(USER.pm(), { name: 'Testování', deadline: '2026-10-10' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.milestone.deadline, '2026-09-15');
  assert.equal(b.body.milestone.deadline, '2026-09-30');
  assert.equal(c.body.milestone.deadline, '2026-10-10');

  const list = await api(USER.pm(), 'GET', `/project/${ctx.project}`);
  assert.equal(list.body.milestones.length, 3);
  assert.deepEqual(list.body.milestones.map(m => m.name),
    ['Výběr dodavatele', 'Implementace', 'Testování'], 'drží pořadí vložení');
});

test('počet milníků není omezený', async () => {
  const p = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('Hodně',CURRENT_DATE,$1,$2) RETURNING id`,
    [ctx.team, ctx.pm]
  )).rows[0].id;
  for (let i = 0; i < 12; i++) {
    const r = await api(USER.pm(), 'POST', `/project/${p}`, { name: `M${i}` });
    assert.equal(r.status, 201);
  }
  const list = await api(USER.pm(), 'GET', `/project/${p}`);
  assert.equal(list.body.milestones.length, 12);
});

test('termín projektu zůstává samostatný, milníky ho nepřepisují', async () => {
  const p = (await db.query('SELECT due_date::text AS d FROM projects WHERE id = $1', [ctx.project])).rows[0];
  assert.equal(p.d, '2026-10-31');
});

test('milník lze navázat na úkol projektu', async () => {
  const r = await addMilestone(USER.pm(), { name: 'Nasadit', deadline: '2026-10-20', task_id: ctx.task });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.milestone.task_id, ctx.task);
  assert.equal(r.body.milestone.task_title, 'Nasadit produkci');
  assert.equal(r.body.milestone.task_status, 'todo');
});

test('milník nelze navázat na úkol z jiného projektu', async () => {
  const r = await addMilestone(USER.pm(), { name: 'Špatná vazba', task_id: ctx.foreignTask });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.task_id);
});

test('milník lze upravit i odpojit od úkolu', async () => {
  const c = await addMilestone(USER.pm(), { name: 'Původní', deadline: '2026-09-01', task_id: ctx.task });
  const u = await api(USER.pm(), 'PATCH', `/${c.body.milestone.id}`,
    { name: 'Upravený', deadline: '2026-09-05', task_id: null });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.milestone.name, 'Upravený');
  assert.equal(u.body.milestone.deadline, '2026-09-05');
  assert.equal(u.body.milestone.task_id, null);
});

test('milník lze smazat', async () => {
  const c = await addMilestone(USER.pm(), { name: 'Ke smazání' });
  const d = await api(USER.pm(), 'DELETE', `/${c.body.milestone.id}`);
  assert.equal(d.status, 200);
  const gone = await api(USER.pm(), 'PATCH', `/${c.body.milestone.id}`, { name: 'X' });
  assert.equal(gone.status, 404);
});

test('milníky lze přeuspořádat', async () => {
  const p = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('Řazení',CURRENT_DATE,$1,$2) RETURNING id`,
    [ctx.team, ctx.pm]
  )).rows[0].id;
  const a = (await api(USER.pm(), 'POST', `/project/${p}`, { name: 'A' })).body.milestone.id;
  const b = (await api(USER.pm(), 'POST', `/project/${p}`, { name: 'B' })).body.milestone.id;
  const c = (await api(USER.pm(), 'POST', `/project/${p}`, { name: 'C' })).body.milestone.id;

  const r = await api(USER.pm(), 'PUT', `/project/${p}/reorder`, { order: [c, a, b] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.milestones.map(m => m.name), ['C', 'A', 'B']);
});

test('přeuspořádání nesáhne na milníky jiného projektu', async () => {
  const mine = (await api(USER.pm(), 'POST', `/project/${ctx.project}`, { name: 'Můj' })).body.milestone.id;
  const p2 = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('Druhý',CURRENT_DATE,$1,$2) RETURNING id`,
    [ctx.team, ctx.pm]
  )).rows[0].id;
  const before = (await db.query('SELECT position FROM project_milestones WHERE id = $1', [mine])).rows[0].position;
  await api(USER.pm(), 'PUT', `/project/${p2}/reorder`, { order: [mine] });
  const after = (await db.query('SELECT position FROM project_milestones WHERE id = $1', [mine])).rows[0].position;
  assert.equal(after, before, 'cizí milník zůstal nedotčený');
});

// ---------- oprávnění ----------

test('člen týmu milníky vidí, ale needituje', async () => {
  const list = await api(USER.member(), 'GET', `/project/${ctx.project}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.can_edit, false);

  const r = await api(USER.member(), 'POST', `/project/${ctx.project}`, { name: 'Nesmím' });
  assert.equal(r.status, 403);
});

test('mimo tým projektu se k milníkům nedostane', async () => {
  const r = await api(USER.out(), 'GET', `/project/${ctx.project}`);
  assert.equal(r.status, 403);
});

test('bez názvu → 400', async () => {
  const r = await addMilestone(USER.pm(), { name: '  ' });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.name);
});

test('nečíselné id nespadne na 500', async () => {
  const r = await api(USER.pm(), 'GET', '/project/abc');
  assert.equal(r.status, 400);
});

// Regrese: „2026-02-31" projde regexem, ale PostgreSQL na něm spadne.
// Musí vrátit 400, ne shodit request.
test('neexistující datum → 400, ne pád', async () => {
  const r = await addMilestone(USER.pm(), { name: 'Špatné datum', deadline: '2026-02-31' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(r.body.fields.deadline);
});

test('nečíselné task_id → 400, ne pád', async () => {
  const r = await addMilestone(USER.pm(), { name: 'Špatný úkol', task_id: 1.5 });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.task_id);
});

test('milník bez termínu je v pořádku', async () => {
  const r = await addMilestone(USER.pm(), { name: 'Bez data', deadline: '' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.milestone.deadline, null);
});

test('příliš dlouhý název → 400, neuřízne se potichu', async () => {
  const r = await addMilestone(USER.pm(), { name: 'x'.repeat(301) });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.name);
});

// Zápisové cesty musí být chráněné stejně jako POST.
test('cizí uživatel nesmí upravit ani smazat milník', async () => {
  const m = (await addMilestone(USER.pm(), { name: 'Chráněný' })).body.milestone.id;
  assert.equal((await api(USER.out(), 'PATCH', `/${m}`, { name: 'Hack' })).status, 403);
  assert.equal((await api(USER.out(), 'DELETE', `/${m}`)).status, 403);
  const still = (await db.query('SELECT name FROM project_milestones WHERE id = $1', [m])).rows[0];
  assert.equal(still.name, 'Chráněný');
});

test('člen týmu nesmí přeuspořádat ani mazat', async () => {
  const m = (await addMilestone(USER.pm(), { name: 'K řazení' })).body.milestone.id;
  assert.equal((await api(USER.member(), 'PUT', `/project/${ctx.project}/reorder`, { order: [m] })).status, 403);
  assert.equal((await api(USER.member(), 'DELETE', `/${m}`)).status, 403);
});

// ---------- data pro Timeline (sekce 5) ----------

test('seznam projektů nese milníky pro Timeline', async () => {
  const { default: projectsRoutes } = await import('../projects.js');
  const app2 = express();
  app2.use(express.json());
  app2.use(cookieParser());
  // Minimální team kontext — projects.js filtruje podle req.team_id.
  app2.use('/api/projects', projectsRoutes);
  const srv = await new Promise(r => { const s = app2.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/projects`, {
      headers: { cookie: `tf_token=${signToken(USER.pm())}` },
    });
    const body = await res.json();
    const proj = body.projects.find(p => p.id === ctx.project);
    assert.ok(Array.isArray(proj.milestones), 'projekt nese pole milestones');
    assert.ok(proj.milestones.length > 0);
    const withTask = proj.milestones.find(m => m.task_id);
    assert.ok(withTask, 'Timeline pozná milník navázaný na úkol');
    assert.ok('task_status' in withTask, 'a zná i jeho stav');
  } finally {
    await new Promise(r => srv.close(r));
  }
});
