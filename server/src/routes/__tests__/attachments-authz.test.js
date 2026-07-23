// Autorizace GET /api/attachments/:id/file — cross-team izolace + download hlavičky.
//
// Scénář (uzavřen mimo tým prostředí):
//   Tým A (projekt s taskem, assignee = userA) — userA je člen A, userB v týmu B,
//   userMgr je manažer projektu (v týmu A), userAdmin má globální admin roli.
//   userCross je člen B, ale je assignee taského úkolu → cross-team host přístup.
//
// Očekáváme: 200 pro userA / userMgr / userAdmin / userCross, 404 pro userB.
// U 200 kontrolujeme Content-Disposition attachment + X-Content-Type-Options: nosniff.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, users;

async function seed() {
  await db.query(`INSERT INTO teams (name, slug) VALUES ('Team A', 'team-a'), ('Team B', 'team-b')`);
  const teamA = (await db.query(`SELECT id FROM teams WHERE slug='team-a'`)).rows[0].id;
  const teamB = (await db.query(`SELECT id FROM teams WHERE slug='team-b'`)).rows[0].id;

  const mkUser = async (email, name, role) => {
    const r = await db.query(
      `INSERT INTO users (email, name, role, hourly_rate, active) VALUES ($1,$2,$3,0,TRUE) RETURNING id`,
      [email, name, role]
    );
    return r.rows[0].id;
  };
  const userA     = await mkUser('a@t.cz',     'A',     'senior_dev');
  const userB     = await mkUser('b@t.cz',     'B',     'senior_dev');
  const userMgr   = await mkUser('m@t.cz',     'Mgr',   'manager');
  const userAdmin = await mkUser('adm@t.cz',   'Admin', 'admin');
  const userCross = await mkUser('cross@t.cz', 'Cross', 'senior_dev');

  await db.query(
    `INSERT INTO team_members (team_id, user_id, team_role) VALUES
       ($1,$2,'member'), ($1,$3,'admin'),
       ($4,$5,'member'), ($4,$6,'member')`,
    [teamA, userA, userMgr, teamB, userB, userCross]
  );
  // Admin nemusí být v teamu — role admin ho pouští všude.

  const project = (await db.query(
    `INSERT INTO projects (name, start_date, team_id, manager_id) VALUES ('P', CURRENT_DATE, $1, $2) RETURNING id`,
    [teamA, userMgr]
  )).rows[0].id;

  const task = (await db.query(
    `INSERT INTO tasks (project_id, title, assignee_id) VALUES ($1, 'T', $2) RETURNING id`,
    [project, userA]
  )).rows[0].id;

  const buf = Buffer.from('binary-payload', 'utf8');
  const att = (await db.query(
    `INSERT INTO attachments (task_id, uploader_id, filename, original_name, mime_type, size, kind, data)
     VALUES ($1,$2,'stored.bin','Návrh řešení.txt','text/plain',$3,'other',$4) RETURNING id`,
    [task, userA, buf.length, buf]
  )).rows[0].id;

  // Reassign na cross-team assignee: task teď „vidí" host userCross, aniž by byl v týmu.
  const taskCross = (await db.query(
    `INSERT INTO tasks (project_id, title, assignee_id) VALUES ($1, 'T-cross', $2) RETURNING id`,
    [project, userCross]
  )).rows[0].id;
  const attCross = (await db.query(
    `INSERT INTO attachments (task_id, uploader_id, filename, original_name, mime_type, size, kind, data)
     VALUES ($1,$2,'x.bin','x.bin','application/octet-stream',$3,'other',$4) RETURNING id`,
    [taskCross, userMgr, buf.length, buf]
  )).rows[0].id;

  return { userA, userB, userMgr, userAdmin, userCross, att, attCross };
}

async function fetchAs(user, attId) {
  const token = signToken(user);
  const res = await fetch(`http://127.0.0.1:${port}/api/attachments/${attId}/file`, {
    headers: { cookie: `tf_token=${token}` },
  });
  return res;
}

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

  const auth = await import('../../auth.js');
  signToken = auth.signToken;

  const { default: attachmentsRoutes } = await import('../attachments.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/attachments', attachmentsRoutes);

  await new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });

  users = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('cizí tým dostane 404 (žádné prozrazení existence)', async () => {
  const r = await fetchAs({ id: users.userB, email: 'b@t.cz', role: 'senior_dev', name: 'B' }, users.att);
  assert.equal(r.status, 404, 'user z jiného týmu nesmí vidět přílohu');
});

test('assignee dostane 200 + attachment hlavičky', async () => {
  const r = await fetchAs({ id: users.userA, email: 'a@t.cz', role: 'senior_dev', name: 'A' }, users.att);
  assert.equal(r.status, 200);
  const cd = r.headers.get('content-disposition') || '';
  assert.ok(cd.includes('attachment'), `Content-Disposition musí obsahovat 'attachment' (dostal: ${cd})`);
  assert.ok(cd.includes(`filename*=UTF-8''`), `Content-Disposition musí mít UTF-8 filename* (dostal: ${cd})`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('manager projektu dostane 200 (bez členství v týmu spec)', async () => {
  const r = await fetchAs({ id: users.userMgr, email: 'm@t.cz', role: 'manager', name: 'Mgr' }, users.att);
  assert.equal(r.status, 200);
});

test('admin vidí přílohu i mimo tým', async () => {
  const r = await fetchAs({ id: users.userAdmin, email: 'adm@t.cz', role: 'admin', name: 'Admin' }, users.att);
  assert.equal(r.status, 200);
});

test('cross-team assignee (host) vidí svou přílohu', async () => {
  const r = await fetchAs({ id: users.userCross, email: 'cross@t.cz', role: 'senior_dev', name: 'Cross' }, users.attCross);
  assert.equal(r.status, 200);
});

test('neexistující id → 404', async () => {
  const r = await fetchAs({ id: users.userA, email: 'a@t.cz', role: 'senior_dev', name: 'A' }, 999999);
  assert.equal(r.status, 404);
});
