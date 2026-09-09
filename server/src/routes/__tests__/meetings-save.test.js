// PATCH /api/meetings/:id — uložení zápisu.
// Regrese: (a) prezence musí přežít uložení, (b) datum se nesmí posouvat
// o den (DATE ↔ ISO/timezone past).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-ms') RETURNING id`)).rows[0].id;
  const admin = (await db.query(`INSERT INTO users (email,name,role) VALUES ('a-ms@t.cz','Admin','admin') RETURNING id`)).rows[0].id;
  const u1 = (await db.query(`INSERT INTO users (email,name,role) VALUES ('u1-ms@t.cz','Libor','senior_dev') RETURNING id`)).rows[0].id;
  const u2 = (await db.query(`INSERT INTO users (email,name,role) VALUES ('u2-ms@t.cz','Martin','senior_dev') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager'),($1,$3,'member'),($1,$4,'member')`, [team, admin, u1, u2]);
  const type = (await db.query(`INSERT INTO meeting_types (team_id,name,visibility,organizer_id) VALUES ($1,'Středy','team',$2) RETURNING id`, [team, admin])).rows[0].id;
  return { team, admin, u1, u2, type };
}

const newMeeting = async (date = '2026-09-02') =>
  (await db.query(`INSERT INTO meetings (type_id,title,meeting_date) VALUES ($1,'P',$2::date) RETURNING id`, [ctx.type, date])).rows[0].id;

async function patchAs(meetingId, body) {
  const token = signToken({ id: ctx.admin, email: 'a-ms@t.cz', role: 'admin', name: 'Admin' });
  const res = await fetch(`http://127.0.0.1:${port}/api/meetings/meetings/${meetingId}`, {
    method: 'PATCH',
    headers: { cookie: `tf_token=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const dbDate = async (id) => (await db.query(`SELECT meeting_date::text AS d FROM meetings WHERE id=$1`, [id])).rows[0].d;

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

test('prezence (včetně omluvy s důvodem) přežije uložení', async () => {
  const id = await newMeeting();
  const attendees = [
    { user_id: ctx.u1, status: 'present' },
    { user_id: ctx.u2, status: 'excused', reason: 'nemoc' },
  ];
  const r = await patchAs(id, { attendees });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const saved = (await db.query(`SELECT attendees FROM meetings WHERE id=$1`, [id])).rows[0].attendees;
  const byUser = Object.fromEntries(saved.map(a => [a.user_id, a]));
  assert.equal(byUser[ctx.u1].status, 'present');
  assert.equal(byUser[ctx.u2].status, 'excused');
  assert.equal(byUser[ctx.u2].reason, 'nemoc', 'důvod omluvy zůstal');
});

test('opakované uložení data neposouvá datum porady', async () => {
  const id = await newMeeting('2026-09-02');
  for (let i = 0; i < 3; i++) {
    const r = await patchAs(id, { meeting_date: '2026-09-02', title: 'P' });
    assert.equal(r.status, 200);
  }
  assert.equal(await dbDate(id), '2026-09-02', 'datum se ani po 3 uloženích neposunulo');
});

test('datum v ISO tvaru se ořízne na den, ne na timestamp', async () => {
  const id = await newMeeting('2026-09-02');
  await patchAs(id, { meeting_date: '2026-09-10T00:00:00.000Z' });
  assert.equal(await dbDate(id), '2026-09-10');
});

test('nesmyslné datum se uloží jako NULL, ne jako chyba', async () => {
  const id = await newMeeting('2026-09-02');
  const r = await patchAs(id, { meeting_date: 'nesmysl' });
  assert.equal(r.status, 200);
  assert.equal(await dbDate(id), null);
});
