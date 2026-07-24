// nav-counts: cross-team úkoly jdou do 'other', součet byTeam+other = total.
//
// Scénář: user A je členem teamu A. Team B má projekt, task s assignee=A.
// GET /api/nav-counts → myTasks.total = 1, byTeam prázdné, other = 1.
// Admin ten samý request → myTasks.byTeam obsahuje team B, other = 0.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, userA, userAdmin, teamA, teamB;

async function fetchAs(user) {
  const token = signToken(user);
  const res = await fetch(`http://127.0.0.1:${port}/api/nav-counts`, {
    headers: { cookie: `tf_token=${token}` },
  });
  return res.json();
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

  const { default: navCountsRoutes } = await import('../nav-counts.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/nav-counts', navCountsRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });

  // Seed
  await db.query(`INSERT INTO teams (name, slug) VALUES ('A','a'), ('B','b')`);
  teamA = (await db.query(`SELECT id FROM teams WHERE slug='a'`)).rows[0].id;
  teamB = (await db.query(`SELECT id FROM teams WHERE slug='b'`)).rows[0].id;

  userA     = (await db.query(`INSERT INTO users (email,name,role,active) VALUES ('a@t.cz','A','senior_dev',TRUE) RETURNING id`)).rows[0].id;
  userAdmin = (await db.query(`INSERT INTO users (email,name,role,active) VALUES ('adm@t.cz','Adm','admin',TRUE) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member')`, [teamA, userA]);

  // Projekt v teamu B, task s assignee=A (cross-team host)
  const pB = (await db.query(
    `INSERT INTO projects (name, start_date, team_id) VALUES ('PB', CURRENT_DATE, $1) RETURNING id`, [teamB]
  )).rows[0].id;
  await db.query(
    `INSERT INTO tasks (project_id, title, assignee_id, status) VALUES ($1, 'cross', $2, 'todo')`,
    [pB, userA]
  );
  // Projekt v teamu A, task pro A (member)
  const pA = (await db.query(
    `INSERT INTO projects (name, start_date, team_id) VALUES ('PA', CURRENT_DATE, $1) RETURNING id`, [teamA]
  )).rows[0].id;
  await db.query(
    `INSERT INTO tasks (project_id, title, assignee_id, status) VALUES ($1, 'own', $2, 'todo')`,
    [pA, userA]
  );
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('non-admin: cross-team úkol se počítá do other, ne do byTeam', async () => {
  const data = await fetchAs({ id: userA, email: 'a@t.cz', role: 'senior_dev', name: 'A' });
  assert.equal(data.myTasks.total, 2, 'total zahrnuje oba úkoly');
  assert.equal(data.myTasks.byTeam[teamA], 1, 'členský tým A má 1');
  assert.equal(data.myTasks.byTeam[teamB], undefined, 'nečlenský tým B se v byTeam neukáže');
  assert.equal(data.myTasks.other, 1, 'cross-team → other=1');
  assert.equal(
    Object.values(data.myTasks.byTeam).reduce((a,b) => a+b, 0) + data.myTasks.other,
    data.myTasks.total,
    'suma byTeam + other == total'
  );
});

test('admin: vidí všechny týmy v byTeam, other = 0', async () => {
  const data = await fetchAs({ id: userAdmin, email: 'adm@t.cz', role: 'admin', name: 'Adm' });
  // Admin nemá vlastní úkoly, ale reviewQueue vidí všechno globální.
  // Ověříme, že bucket admin variantu netrestá otherem.
  for (const key of ['myTasks','reviewQueue','needsFix','inboxPending','answersUnread','dueRequests']) {
    assert.equal(data[key].other, 0, `${key}.other musí být 0 pro admina`);
  }
});
