// POST /api/tasks/:id/approve-and-continue — schválí úkol (done) + založí
// navazující úkol (continues_task_id) s vlastním termínem. Jen manager / admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name, slug) VALUES ('T','t-ac') RETURNING id`)).rows[0].id;
  const mgr = (await db.query(`INSERT INTO users (email,name,role) VALUES ('mgr-ac@t.cz','Mgr','manager') RETURNING id`)).rows[0].id;
  const dev = (await db.query(`INSERT INTO users (email,name,role) VALUES ('dev-ac@t.cz','Dev','senior_dev') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager'),($1,$3,'member')`, [team, mgr, dev]);
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`, [team, mgr]
  )).rows[0].id;
  const task = (await db.query(
    `INSERT INTO tasks (project_id,title,assignee_id,status,priority) VALUES ($1,'Původní',$2,'review','high') RETURNING id`, [project, dev]
  )).rows[0].id;
  return { team, mgr, dev, project, task };
}

async function postAs(user, taskId, body) {
  const token = signToken(user);
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/approve-and-continue`, {
    method: 'POST',
    headers: { cookie: `tf_token=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const mgrUser = () => ({ id: ctx.mgr, email: 'mgr-ac@t.cz', role: 'manager', name: 'Mgr' });

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
  const { default: reviewsRoutes } = await import('../reviews.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', reviewsRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('schválí originál (done) + založí navazující úkol s vazbou a vlastním termínem', async () => {
  const r = await postAs(mgrUser(), ctx.task, { title: 'Navazující úkol', due_date: '2027-01-15', description: 'Další nápad' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.followUp, 'vrací follow-up');
  assert.equal(r.body.followUp.continues_task_id, ctx.task, 'follow-up navazuje na původní');
  assert.equal(r.body.followUp.status, 'todo');
  assert.equal(r.body.followUp.assignee_id, ctx.dev, 'zdědí řešitele originálu');

  // due_date ověř z DB přes ::text (JSON serializace DATE posune o den kvůli TZ).
  const fu = (await db.query(`SELECT due_date::text AS due_date FROM tasks WHERE id=$1`, [r.body.followUp.id])).rows[0];
  assert.equal(fu.due_date, '2027-01-15', 'follow-up má zadaný termín');

  const orig = (await db.query(`SELECT status, completed_at FROM tasks WHERE id=$1`, [ctx.task])).rows[0];
  assert.equal(orig.status, 'done', 'původní úkol je hotový');
  assert.ok(orig.completed_at, 'completed_at nastaven (drží on-time)');
});

test('bez termínu → 400', async () => {
  const t2 = (await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status) VALUES ($1,'T2',$2,'review') RETURNING id`, [ctx.project, ctx.dev])).rows[0].id;
  const r = await postAs(mgrUser(), t2, { title: 'X' });
  assert.equal(r.status, 400);
});

test('ne-manager (řešitel) → 403', async () => {
  const t3 = (await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status) VALUES ($1,'T3',$2,'review') RETURNING id`, [ctx.project, ctx.dev])).rows[0].id;
  const r = await postAs({ id: ctx.dev, email: 'dev-ac@t.cz', role: 'senior_dev', name: 'Dev' }, t3, { title: 'X', due_date: '2027-01-15' });
  assert.equal(r.status, 403);
});

test('úkol není v review → 400', async () => {
  const t4 = (await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status) VALUES ($1,'T4',$2,'in_progress') RETURNING id`, [ctx.project, ctx.dev])).rows[0].id;
  const r = await postAs(mgrUser(), t4, { title: 'X', due_date: '2027-01-15' });
  assert.equal(r.status, 400);
});
