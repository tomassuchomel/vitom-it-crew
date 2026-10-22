// Stav „Čekám na" se nepočítá jako zpoždění.
//
// Rozhodnutí: úkol ve stavu 'waiting' stojí vědomě a s uvedeným důvodem
// (čeká na klienta, na schválení, na jiný úkol). Počítat ho jako overdue by
// trestalo člověka za něco, co neovlivní — a hlavně by ho to motivovalo ten
// stav nepoužívat, čímž by celá funkce ztratila smysl. Mezi aktivními úkoly
// zůstává, jen nesráží skóre.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../testing/testDb.js';

let db, stopDb, userScore, ctx;

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  process.env.DISABLE_AUTOSEED = '1';
  db = await import('../db.js');
  await db.migrate();
  await db.runFileMigrations();
  ({ userScore } = await import('../mzvScore.js'));

  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-score') RETURNING id`)).rows[0].id;
  const user = (await db.query(`INSERT INTO users (email,name,role) VALUES ('s@t.cz','S','senior_dev') RETURNING id`)).rows[0].id;
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id) VALUES ('P',CURRENT_DATE,$1) RETURNING id`, [team]
  )).rows[0].id;
  ctx = { team, user, project };
});

after(async () => {
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

const addTask = (title, status, dueOffsetDays) => db.query(
  `INSERT INTO tasks (project_id,title,assignee_id,status,due_date)
   VALUES ($1,$2,$3,$4, CURRENT_DATE + $5::int)`,
  [ctx.project, title, ctx.user, status, dueOffsetDays]
);

test('úkol po termínu ve stavu Čekám na se nepočítá jako zpožděný', async () => {
  await addTask('Čeká na klienta', 'waiting', -10);
  const s = await userScore(ctx.user);
  assert.equal(s.overdue, 0, 'čekání netrestá');
});

test('rozpracovaný úkol po termínu se jako zpožděný počítá dál', async () => {
  await addTask('Fakt zpožděný', 'in_progress', -10);
  const s = await userScore(ctx.user);
  assert.equal(s.overdue, 1, 'skutečné zpoždění se počítá');
});

test('čekající úkol zůstává mezi aktivními, nezmizí z přehledu', async () => {
  const s = await userScore(ctx.user);
  const titles = s.tasks.active.map(t => t.title);
  assert.ok(titles.includes('Čeká na klienta'), 'je vidět jako aktivní');
  assert.ok(!s.tasks.overdue.some(t => t.title === 'Čeká na klienta'), 'ale ne jako zpožděný');
});

test('úspěšnost nesráží čekání na někoho jiného', async () => {
  // Jen samotné čekání → žádné dokončené ani zpožděné úkoly do poměru.
  const team2 = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T2','t-score2') RETURNING id`)).rows[0].id;
  const u2 = (await db.query(`INSERT INTO users (email,name,role) VALUES ('s2@t.cz','S2','senior_dev') RETURNING id`)).rows[0].id;
  const p2 = (await db.query(
    `INSERT INTO projects (name,start_date,team_id) VALUES ('P2',CURRENT_DATE,$1) RETURNING id`, [team2]
  )).rows[0].id;
  await db.query(
    `INSERT INTO tasks (project_id,title,assignee_id,status,due_date)
     VALUES ($1,'Jen čekám',$2,'waiting', CURRENT_DATE - 30)`, [p2, u2]
  );

  const s = await userScore(u2);
  assert.equal(s.overdue, 0);
  assert.equal(s.success_rate, null, 'bez dokončených úkolů se úspěšnost nepočítá');
});
