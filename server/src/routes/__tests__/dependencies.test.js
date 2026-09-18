// Návaznosti mezi úkoly (sekce 15) + stav „Čekám na" (sekce 16).
// Pokrývá testovací scénáře 40–47 z bodu 24.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-dep') RETURNING id`)).rows[0].id;
  const other = (await db.query(`INSERT INTO teams (name,slug) VALUES ('Cizí','t-dep-cizi') RETURNING id`)).rows[0].id;
  const mk = async (email, name, role) =>
    (await db.query(`INSERT INTO users (email,name,role) VALUES ($1,$2,$3) RETURNING id`, [email, name, role])).rows[0].id;

  const lead   = await mk('lead-dep@t.cz', 'Vedoucí', 'senior_dev');
  const member = await mk('mem-dep@t.cz', 'Člen', 'external_dev');
  const outsider = await mk('out-dep@t.cz', 'Cizí', 'senior_dev');
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member'),($1,$3,'member')`, [team, lead, member]);
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member')`, [other, outsider]);

  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`, [team, lead]
  )).rows[0].id;
  const foreignProject = (await db.query(
    `INSERT INTO projects (name,start_date,team_id) VALUES ('Cizí',CURRENT_DATE,$1) RETURNING id`, [other]
  )).rows[0].id;
  const foreignTask = (await db.query(
    `INSERT INTO tasks (project_id,title) VALUES ($1,'Cizí úkol') RETURNING id`, [foreignProject]
  )).rows[0].id;

  return { team, other, lead, member, outsider, project, foreignProject, foreignTask };
}

const USER = {
  lead: () => ({ id: ctx.lead, email: 'lead-dep@t.cz', role: 'senior_dev', name: 'Vedoucí' }),
  mem:  () => ({ id: ctx.member, email: 'mem-dep@t.cz', role: 'external_dev', name: 'Člen' }),
  out:  () => ({ id: ctx.outsider, email: 'out-dep@t.cz', role: 'senior_dev', name: 'Cizí' }),
};

const api = async (user, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/dependencies${path}`, {
    method,
    headers: { cookie: `tf_token=${signToken(user)}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let seq = 0;
const newTask = async (title) =>
  (await db.query(`INSERT INTO tasks (project_id,title) VALUES ($1,$2) RETURNING id`,
    [ctx.project, title || `Úkol ${++seq}`])).rows[0].id;

const link = (user, taskId, dependsOnId) => api(user, 'POST', `/task/${taskId}`, { depends_on_id: dependsOnId });

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
  const { default: depRoutes } = await import('../dependencies.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/dependencies', depRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

// ---------- 15) návaznosti ----------

test('úkol lze navázat na jiný a je vidět z obou stran', async () => {
  const a = await newTask('A');
  const b = await newTask('B');
  const r = await link(USER.lead(), a, b);
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // Z pohledu A: čeká na B.
  const fromA = await api(USER.lead(), 'GET', `/task/${a}`);
  assert.equal(fromA.body.waiting_on.length, 1);
  assert.equal(fromA.body.waiting_on[0].title, 'B');
  assert.equal(fromA.body.blocking.length, 0);

  // Z pohledu B: blokuje A.
  const fromB = await api(USER.lead(), 'GET', `/task/${b}`);
  assert.equal(fromB.body.blocking.length, 1);
  assert.equal(fromB.body.blocking[0].title, 'A');
  assert.equal(fromB.body.waiting_on.length, 0);
});

test('úkol nemůže čekat sám na sebe', async () => {
  const a = await newTask();
  const r = await link(USER.lead(), a, a);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'self_dependency');
});

test('stejnou návaznost nelze založit dvakrát', async () => {
  const a = await newTask(); const b = await newTask();
  assert.equal((await link(USER.lead(), a, b)).status, 201);
  const dup = await link(USER.lead(), a, b);
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error, 'duplicate');
});

// Jádro sekce 15: A→B, B→C, C→A se nesmí uzavřít.
test('cyklickou návaznost nelze vytvořit', async () => {
  const a = await newTask('cyklA'); const b = await newTask('cyklB'); const c = await newTask('cyklC');
  assert.equal((await link(USER.lead(), a, b)).status, 201, 'A čeká na B');
  assert.equal((await link(USER.lead(), b, c)).status, 201, 'B čeká na C');

  const cycle = await link(USER.lead(), c, a);
  assert.equal(cycle.status, 400, JSON.stringify(cycle.body));
  assert.equal(cycle.body.error, 'cycle');

  // A vazba se opravdu neuložila.
  const stored = await db.query('SELECT 1 FROM task_dependencies WHERE task_id=$1 AND depends_on_id=$2', [c, a]);
  assert.equal(stored.rows.length, 0);
});

// Delší řetěz — CTE musí projít tranzitivně, ne jen o krok.
test('cyklus se zachytí i přes pět článků', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await newTask(`ret${i}`));
  for (let i = 0; i < 4; i++) {
    assert.equal((await link(USER.lead(), ids[i], ids[i + 1])).status, 201, `${i}→${i + 1}`);
  }
  const cycle = await link(USER.lead(), ids[4], ids[0]);
  assert.equal(cycle.status, 400, JSON.stringify(cycle.body));
  assert.equal(cycle.body.error, 'cycle');
});

test('přímý protisměr je taky cyklus', async () => {
  const a = await newTask(); const b = await newTask();
  assert.equal((await link(USER.lead(), a, b)).status, 201);
  const back = await link(USER.lead(), b, a);
  assert.equal(back.status, 400);
  assert.equal(back.body.error, 'cycle');
});

test('návaznost lze odstranit', async () => {
  const a = await newTask(); const b = await newTask();
  const created = await link(USER.lead(), a, b);
  const del = await api(USER.lead(), 'DELETE', `/${created.body.dependency.id}`);
  assert.equal(del.status, 200);
  const after = await api(USER.lead(), 'GET', `/task/${a}`);
  assert.equal(after.body.waiting_on.length, 0);
});

// ---------- oprávnění a izolace ----------

test('na úkol z jiného týmu navázat nelze', async () => {
  const a = await newTask();
  const r = await link(USER.lead(), a, ctx.foreignTask);
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

test('cizí uživatel návaznosti nevidí ani nezakládá', async () => {
  const a = await newTask(); const b = await newTask();
  assert.equal((await api(USER.out(), 'GET', `/task/${a}`)).status, 403);
  assert.equal((await link(USER.out(), a, b)).status, 403);
});

test('externí dev návaznosti vidí, ale nezakládá', async () => {
  const a = await newTask(); const b = await newTask();
  assert.equal((await api(USER.mem(), 'GET', `/task/${a}`)).status, 200);
  assert.equal((await link(USER.mem(), a, b)).status, 403);
});

test('nečíselné id nespadne na 500', async () => {
  assert.equal((await api(USER.lead(), 'GET', '/task/abc')).status, 400);
});

// ---------- 16) stav „Čekám na" ----------

test('úkol lze dát do stavu waiting s důvodem i datem follow-upu', async () => {
  const a = await newTask('Čekající');
  await db.query(`
    UPDATE tasks SET status='waiting', waiting_for=$1, waiting_note=$2, waiting_until=$3::date WHERE id=$4
  `, ['Dodavatel', 'Čekáme na cenovou nabídku', '2026-10-01', a]);

  const row = (await db.query(
    `SELECT status, waiting_for, waiting_note, waiting_until::text AS until FROM tasks WHERE id=$1`, [a]
  )).rows[0];
  assert.equal(row.status, 'waiting');
  assert.equal(row.waiting_for, 'Dodavatel');
  assert.equal(row.waiting_note, 'Čekáme na cenovou nabídku');
  assert.equal(row.until, '2026-10-01');
});

test('waiting je platný stav (CHECK constraint ho pouští)', async () => {
  const a = await newTask();
  await db.query(`UPDATE tasks SET status='waiting' WHERE id=$1`, [a]);
  const r = await db.query(`SELECT status FROM tasks WHERE id=$1`, [a]);
  assert.equal(r.rows[0].status, 'waiting');
});

test('vymyšlený stav CHECK constraint neprojde', async () => {
  const a = await newTask();
  await assert.rejects(() => db.query(`UPDATE tasks SET status='nesmysl' WHERE id=$1`, [a]));
});

// Zadání výslovně zakazuje automatické přepnutí stavu.
test('dokončení blokujícího úkolu nepřepne návazný úkol automaticky', async () => {
  const { notifyBlockerDone } = await import('../../taskDependencyNotify.js');
  const a = await newTask('Návazný'); const b = await newTask('Blokující');
  await link(USER.lead(), a, b);
  await db.query(`UPDATE tasks SET status='waiting' WHERE id=$1`, [a]);
  await db.query(`UPDATE tasks SET status='done' WHERE id=$1`, [b]);

  // Bez mailer konfigurace jen zaloguje, ale nesmí spadnout ani měnit stav.
  await notifyBlockerDone(b);
  const row = (await db.query(`SELECT status FROM tasks WHERE id=$1`, [a])).rows[0];
  assert.equal(row.status, 'waiting', 'stav zůstal na uživateli');
});

test('upozornění na posun termínu nemění termíny návazných úkolů', async () => {
  const { notifyBlockerDueChanged } = await import('../../taskDependencyNotify.js');
  const a = await newTask(); const b = await newTask();
  await link(USER.lead(), a, b);
  await db.query(`UPDATE tasks SET due_date='2026-10-05'::date WHERE id=$1`, [a]);

  await notifyBlockerDueChanged(b, '2026-09-01', '2026-09-20');
  const row = (await db.query(`SELECT due_date::text AS d FROM tasks WHERE id=$1`, [a])).rows[0];
  assert.equal(row.d, '2026-10-05', 'termín návazného úkolu se neposunul');
});
