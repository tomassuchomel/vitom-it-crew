// MZV — uložení zápisu (PATCH /api/mzv/meetings/:id).
// Regrese: ředitel dostával 403, protože canManage pouštěl jen 'manager'.
// Dál hlídáme, že se datum uložením nevynuluje a že uzavřený zápis je zamčený.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

async function seed() {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-mzv') RETURNING id`)).rows[0].id;
  const mk = async (email, name, role) =>
    (await db.query(`INSERT INTO users (email,name,role) VALUES ($1,$2,$3) RETURNING id`, [email, name, role])).rows[0].id;

  const admin   = await mk('admin-mzv@t.cz',   'Admin',    'admin');
  const manager = await mk('mgr-mzv@t.cz',     'Manager',  'manager');
  const reditel = await mk('reditel-mzv@t.cz', 'Ředitel',  'manager');
  const member  = await mk('member-mzv@t.cz',  'Member',   'senior_dev');
  const sub     = await mk('sub-mzv@t.cz',     'Patrícia', 'senior_dev');

  await db.query(
    `INSERT INTO team_members (team_id,user_id,team_role)
     VALUES ($1,$2,'manager'),($1,$3,'manager'),($1,$4,'reditel'),($1,$5,'member'),($1,$6,'member')`,
    [team, admin, manager, reditel, member, sub]
  );
  return { team, admin, manager, reditel, member, sub };
}

const USERS = {
  admin:   () => ({ id: ctx.admin,   email: 'admin-mzv@t.cz',   role: 'admin',      name: 'Admin' }),
  manager: () => ({ id: ctx.manager, email: 'mgr-mzv@t.cz',     role: 'manager',    name: 'Manager' }),
  reditel: () => ({ id: ctx.reditel, email: 'reditel-mzv@t.cz', role: 'manager',    name: 'Ředitel' }),
  member:  () => ({ id: ctx.member,  email: 'member-mzv@t.cz',  role: 'senior_dev', name: 'Member' }),
};

const req = async (user, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/mzv${path}`, {
    method,
    headers: { cookie: `tf_token=${signToken(user)}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Zápis zakládáme přímo v DB, ať test ukládání nezávisí na POST endpointu.
const newMeeting = async (managerId, date = '2026-09-02') =>
  (await db.query(
    `INSERT INTO mzv_meetings (subordinate_id, manager_id, meeting_date, status, created_by)
     VALUES ($1,$2,$3::date,'draft',$2) RETURNING id`,
    [ctx.sub, managerId, date]
  )).rows[0].id;

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
  const { default: mzvRoutes } = await import('../mzv.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/mzv', mzvRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('admin uloží zápis', async () => {
  const id = await newMeeting(ctx.manager);
  const r = await req(USERS.admin(), 'PATCH', `/meetings/${id}`, { rozhovor: 'Shrnutí od admina' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.meeting.rozhovor, 'Shrnutí od admina');
});

test('manager uloží zápis svého člověka', async () => {
  const id = await newMeeting(ctx.manager);
  const r = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, { rozhovor: 'Shrnutí od manažera' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.meeting.rozhovor, 'Shrnutí od manažera');
});

// Toto je ta původně nahlášená chyba: „nefunguje uložit Patricia Geratova MZV".
test('ředitel uloží zápis (dřív padalo na 403)', async () => {
  const id = await newMeeting(ctx.reditel);
  const r = await req(USERS.reditel(), 'PATCH', `/meetings/${id}`, { rozhovor: 'Shrnutí od ředitele' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.meeting.rozhovor, 'Shrnutí od ředitele');
});

test('řadový člen týmu zápis uložit nesmí', async () => {
  const id = await newMeeting(ctx.manager);
  const r = await req(USERS.member(), 'PATCH', `/meetings/${id}`, { rozhovor: 'Pokus' });
  assert.equal(r.status, 403);
});

test('uloží všechna textová pole i KPI hodnocení', async () => {
  const id = await newMeeting(ctx.manager);
  const r = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, {
    rozhovor: 'Rozhovor', priorities: 'Priority', to_improve: 'Zlepšit',
    to_continue: 'Pokračovat', manager_notes: 'Interní',
    kpi_ratings: [{ rating: 5, comment: 'výborně' }, { rating: 3, comment: 'ok' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.meeting;
  assert.equal(m.priorities, 'Priority');
  assert.equal(m.to_improve, 'Zlepšit');
  assert.equal(m.to_continue, 'Pokračovat');
  assert.equal(m.manager_notes, 'Interní');
  assert.equal(m.kpi_ratings.length, 2);
  assert.equal(m.kpi_ratings[0].rating, 5);
});

test('neplatné KPI hodnocení se uloží jako null, nespadne to', async () => {
  const id = await newMeeting(ctx.manager);
  const r = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, {
    kpi_ratings: [{ rating: 9, comment: 'mimo rozsah' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.meeting.kpi_ratings[0].rating, null);
});

// FE posílá datum tak, jak ho dostal z API (ISO s časem) — nesmí se vynulovat
// ani posunout o den.
test('datum v ISO tvaru se uloží jako správný den', async () => {
  const id = await newMeeting(ctx.manager, '2026-09-02');
  const r = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, { meeting_date: '2026-09-10T00:00:00.000Z' });
  assert.equal(r.status, 200);
  const d = (await db.query(`SELECT meeting_date::text AS d FROM mzv_meetings WHERE id=$1`, [id])).rows[0].d;
  assert.equal(d, '2026-09-10');
});

test('opakované uložení datum neposouvá', async () => {
  const id = await newMeeting(ctx.manager, '2026-09-02');
  for (let i = 0; i < 3; i++) {
    await req(USERS.manager(), 'PATCH', `/meetings/${id}`, { meeting_date: '2026-09-02', rozhovor: `kolo ${i}` });
  }
  const d = (await db.query(`SELECT meeting_date::text AS d FROM mzv_meetings WHERE id=$1`, [id])).rows[0].d;
  assert.equal(d, '2026-09-02');
});

test('uzavřený zápis nejde uložit, po reopen ano', async () => {
  const id = await newMeeting(ctx.manager);
  assert.equal((await req(USERS.manager(), 'POST', `/meetings/${id}/complete`)).status, 200);

  const locked = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, { rozhovor: 'Po uzavření' });
  assert.equal(locked.status, 400);
  assert.equal(locked.body.error, 'meeting_completed');

  assert.equal((await req(USERS.manager(), 'POST', `/meetings/${id}/reopen`)).status, 200);
  const after = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, { rozhovor: 'Po reopenu' });
  assert.equal(after.status, 200);
  assert.equal(after.body.meeting.rozhovor, 'Po reopenu');
});

test('prázdné tělo → 400 no_fields (nepřepíše zápis prázdnem)', async () => {
  const id = await newMeeting(ctx.manager);
  const r = await req(USERS.manager(), 'PATCH', `/meetings/${id}`, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'no_fields');
});

test('neexistující zápis → 404', async () => {
  const r = await req(USERS.admin(), 'PATCH', `/meetings/999999`, { rozhovor: 'X' });
  assert.equal(r.status, 404);
});
