// Stav „Čekám na" přes reálný PUT /api/tasks/:id (sekce 16 zadání).
// Regrese: waiting_until se při běžné editaci úkolu ztrácelo, protože
// DATE z pg přijde jako JS Date a String(Date).slice(0,10) dá "Sun Nov 01".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-wait') RETURNING id`)).rows[0].id;
  const mgr = (await db.query(`INSERT INTO users (email,name,role) VALUES ('m-w@t.cz','Mgr','manager') RETURNING id`)).rows[0].id;
  const dev = (await db.query(`INSERT INTO users (email,name,role) VALUES ('d-w@t.cz','Dev','senior_dev') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager'),($1,$3,'member')`, [team, mgr, dev]);
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`, [team, mgr]
  )).rows[0].id;
  return { team, mgr, dev, project };
}

const mgrUser = () => ({ id: ctx.mgr, email: 'm-w@t.cz', role: 'manager', name: 'Mgr' });

const put = async (user, id, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${id}`, {
    method: 'PUT',
    headers: { cookie: `tf_token=${signToken(user)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const newTask = async (title = 'Úkol') =>
  (await db.query(`INSERT INTO tasks (project_id,title,assignee_id) VALUES ($1,$2,$3) RETURNING id`,
    [ctx.project, title, ctx.dev])).rows[0].id;

const raw = async (id) => (await db.query(
  `SELECT status, waiting_for, waiting_note, waiting_until::text AS until FROM tasks WHERE id=$1`, [id]
)).rows[0];

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
  const { default: tasksRoutes } = await import('../tasks.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/tasks', tasksRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('úkol lze přepnout na Čekám na s důvodem, poznámkou i datem', async () => {
  const id = await newTask();
  const r = await put(mgrUser(), id, {
    status: 'waiting', waiting_for: 'Dodavatel',
    waiting_note: 'Čekáme na nabídku', waiting_until: '2026-11-01',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await raw(id);
  assert.equal(row.status, 'waiting');
  assert.equal(row.waiting_for, 'Dodavatel');
  assert.equal(row.until, '2026-11-01');
});

// Toto je ta regrese: běžná editace bez waiting polí je nesmí smazat.
test('přejmenování úkolu nesmaže důvod ani datum čekání', async () => {
  const id = await newTask('Původní');
  await put(mgrUser(), id, {
    status: 'waiting', waiting_for: 'Klient', waiting_until: '2026-11-01',
  });
  const r = await put(mgrUser(), id, { title: 'Přejmenovaný' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const row = await raw(id);
  assert.equal(row.waiting_for, 'Klient', 'důvod zůstal');
  assert.equal(row.until, '2026-11-01', 'datum se neztratilo ani neposunulo');
});

test('opakovaná editace datum neposouvá', async () => {
  const id = await newTask();
  await put(mgrUser(), id, { status: 'waiting', waiting_for: 'X', waiting_until: '2026-11-01' });
  for (let i = 0; i < 3; i++) await put(mgrUser(), id, { title: `Kolo ${i}` });
  assert.equal((await raw(id)).until, '2026-11-01');
});

test('Čekám na bez důvodu backend odmítne', async () => {
  const id = await newTask();
  const r = await put(mgrUser(), id, { status: 'waiting' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(r.body.fields.waiting_for);
  assert.notEqual((await raw(id)).status, 'waiting');
});

test('neplatné datum follow-upu se uloží jako NULL, nespadne to', async () => {
  const id = await newTask();
  const r = await put(mgrUser(), id, { status: 'waiting', waiting_for: 'X', waiting_until: 'nesmysl' });
  assert.equal(r.status, 200);
  assert.equal((await raw(id)).until, null);
});
