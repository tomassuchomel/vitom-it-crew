// GET /api/meetings/:id/previous-tasks — úkoly z PŘEDCHOZÍCH porad stejného typu
// + jejich aktuální stav ("Last úkoly"). Přístup gated přes canAccessType.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name, slug) VALUES ('T','t-pt') RETURNING id`)).rows[0].id;
  const mgr = (await db.query(`INSERT INTO users (email,name,role) VALUES ('mgr-pt@t.cz','Mgr','manager') RETURNING id`)).rows[0].id;
  const dev = (await db.query(`INSERT INTO users (email,name,role) VALUES ('dev-pt@t.cz','Dev','senior_dev') RETURNING id`)).rows[0].id;
  const outsider = (await db.query(`INSERT INTO users (email,name,role) VALUES ('out-pt@t.cz','Out','external_dev') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager'),($1,$3,'member')`, [team, mgr, dev]);
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`, [team, mgr]
  )).rows[0].id;
  const type = (await db.query(
    `INSERT INTO meeting_types (team_id,name,visibility,organizer_id) VALUES ($1,'Porada IT','team',$2) RETURNING id`, [team, mgr]
  )).rows[0].id;
  // Tři porady stejného typu — stará, prostřední, aktuální.
  const mOld = (await db.query(`INSERT INTO meetings (type_id,title,meeting_date) VALUES ($1,'Porada 1','2026-01-01') RETURNING id`, [type])).rows[0].id;
  const mMid = (await db.query(`INSERT INTO meetings (type_id,title,meeting_date) VALUES ($1,'Porada 2','2026-02-01') RETURNING id`, [type])).rows[0].id;
  const mNow = (await db.query(`INSERT INTO meetings (type_id,title,meeting_date) VALUES ($1,'Porada 3','2026-03-01') RETURNING id`, [type])).rows[0].id;
  // Úkoly z minulých porad.
  await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status,meeting_id) VALUES ($1,'Ze staré',$2,'done',$3)`, [project, dev, mOld]);
  await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status,meeting_id) VALUES ($1,'Z prostřední',$2,'in_progress',$3)`, [project, dev, mMid]);
  // Úkol na AKTUÁLNÍ poradě — nesmí být v "previous".
  await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status,meeting_id) VALUES ($1,'Z aktuální',$2,'todo',$3)`, [project, dev, mNow]);
  // Úkol jiného typu porady — nesmí prosáknout.
  const otherType = (await db.query(`INSERT INTO meeting_types (team_id,name,visibility,organizer_id) VALUES ($1,'Jiná','team',$2) RETURNING id`, [team, mgr])).rows[0].id;
  const mOther = (await db.query(`INSERT INTO meetings (type_id,title,meeting_date) VALUES ($1,'Jiná porada','2026-01-15') RETURNING id`, [otherType])).rows[0].id;
  await db.query(`INSERT INTO tasks (project_id,title,assignee_id,status,meeting_id) VALUES ($1,'Cizí',$2,'todo',$3)`, [project, dev, mOther]);
  return { team, mgr, dev, outsider, type, mOld, mMid, mNow };
}

async function getAs(user, meetingId) {
  const token = signToken(user);
  const res = await fetch(`http://127.0.0.1:${port}/api/meetings/meetings/${meetingId}/previous-tasks`, {
    headers: { cookie: `tf_token=${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const mgrUser = () => ({ id: ctx.mgr, email: 'mgr-pt@t.cz', role: 'manager', name: 'Mgr' });

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
  const { default: meetingsRoutes } = await import('../meetings.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/meetings', meetingsRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('vrátí úkoly z předchozích porad stejného typu (ne z aktuální, ne z jiného typu)', async () => {
  const r = await getAs(mgrUser(), ctx.mNow);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const titles = r.body.tasks.map(t => t.title);
  assert.ok(titles.includes('Ze staré'), 'obsahuje úkol ze staré porady');
  assert.ok(titles.includes('Z prostřední'), 'obsahuje úkol z prostřední porady');
  assert.ok(!titles.includes('Z aktuální'), 'NEobsahuje úkol z aktuální porady');
  assert.ok(!titles.includes('Cizí'), 'NEobsahuje úkol z jiného typu porady');
});

test('nese aktuální stav + z jaké porady úkol je', async () => {
  const r = await getAs(mgrUser(), ctx.mNow);
  const done = r.body.tasks.find(t => t.title === 'Ze staré');
  assert.equal(done.status, 'done');
  assert.ok(done.from_meeting_id, 'nese from_meeting_id');
  assert.equal(done.assignee_name, 'Dev');
});

test('řadí od nejnovější porady (prostřední před starou)', async () => {
  const r = await getAs(mgrUser(), ctx.mNow);
  const idxMid = r.body.tasks.findIndex(t => t.title === 'Z prostřední');
  const idxOld = r.body.tasks.findIndex(t => t.title === 'Ze staré');
  assert.ok(idxMid < idxOld, 'novější porada je výš');
});

test('z první porady (mOld) nejsou žádné previous', async () => {
  const r = await getAs(mgrUser(), ctx.mOld);
  assert.equal(r.status, 200);
  assert.equal(r.body.tasks.length, 0);
});

test('outsider bez přístupu → 403', async () => {
  const r = await getAs({ id: ctx.outsider, email: 'out-pt@t.cz', role: 'external_dev', name: 'Out' }, ctx.mNow);
  assert.equal(r.status, 403);
});

test('neexistující porada → 404', async () => {
  const r = await getAs(mgrUser(), 999999);
  assert.equal(r.status, 404);
});
