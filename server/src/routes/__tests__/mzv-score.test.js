// Test výpočtu MZV skóre (userScore) nad reálnou DB (embedded-postgres).
// Ověřuje snapshot (success_rate, on_time/late/overdue) i měsíční trend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../../testing/testDb.js';

let db, userScore, stopDb, userId;

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  db = await import('../../db.js');
  await db.migrate();
  await db.runFileMigrations();
  ({ userScore } = await import('../../mzvScore.js'));
  await seed();
});

after(async () => {
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

async function seed() {
  const q = db.query;
  const team = await q(`INSERT INTO teams (name, slug) VALUES ('Skóre test','score-test') RETURNING id`);
  const u = await q(`INSERT INTO users (email, name, role) VALUES ('score-user@test.local','Skóre User','senior_dev') RETURNING id`);
  userId = u.rows[0].id;
  const proj = await q(
    `INSERT INTO projects (name, start_date, team_id) VALUES ('P', CURRENT_DATE, $1) RETURNING id`,
    [team.rows[0].id]
  );
  const pid = proj.rows[0].id;

  const ins = (title, status, due, completed) => q(
    `INSERT INTO tasks (project_id, title, status, assignee_id, due_date, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [pid, title, status, userId, due, completed]
  );

  // Aktuální měsíc: 1× včas, 1× pozdě.
  await ins('T1 včas', 'done', null, null);
  await q(`UPDATE tasks SET due_date = CURRENT_DATE, completed_at = NOW() WHERE title='T1 včas'`);
  await ins('T2 pozdě', 'done', null, null);
  await q(`UPDATE tasks SET due_date = CURRENT_DATE - 10, completed_at = NOW() WHERE title='T2 pozdě'`);

  // Nedokončený po termínu → overdue.
  await ins('T3 overdue', 'in_progress', null, null);
  await q(`UPDATE tasks SET due_date = CURRENT_DATE - 5 WHERE title='T3 overdue'`);

  // Minulý měsíc: 1× včas.
  await ins('T4 minulý', 'done', null, null);
  await q(`
    UPDATE tasks SET
      completed_at = date_trunc('month', CURRENT_DATE) - INTERVAL '15 days',
      due_date = (date_trunc('month', CURRENT_DATE) - INTERVAL '15 days')::date
    WHERE title='T4 minulý'
  `);

  // Rozpracovaný s budoucím termínem → active.
  await ins('T5 aktivní', 'in_progress', null, null);
  await q(`UPDATE tasks SET due_date = CURRENT_DATE + 5 WHERE title='T5 aktivní'`);
}

test('snapshot: success_rate + počty sedí', async () => {
  const d = await userScore(userId, 6);
  assert.equal(d.done_on_time, 2, 'on_time (T1 + T4)');
  assert.equal(d.done_late, 1, 'late (T2)');
  assert.equal(d.overdue, 1, 'overdue (T3)');
  assert.equal(d.success_rate, 50, '2 / (2+1+1) = 50 %');
});

test('trend: řada 6 měsíců, aktuální 50 %, jeden měsíc 100 %', async () => {
  const d = await userScore(userId, 6);
  assert.equal(d.months.length, 6, '6 měsíců v řadě');
  const current = d.months[d.months.length - 1];
  assert.equal(current.rate, 50, 'aktuální měsíc: 1 včas / 2 = 50 %');
  assert.ok(d.months.some(m => m.rate === 100), 'minulý měsíc má 100 %');
});

test('drill-down: seznamy úkolů per kategorie', async () => {
  const d = await userScore(userId, 6);
  assert.equal(d.active, 1, 'active count (T5)');
  assert.equal(d.tasks.on_time.length, 2, 'on_time list');
  assert.equal(d.tasks.late.length, 1, 'late list');
  assert.equal(d.tasks.overdue.length, 1, 'overdue list');
  assert.equal(d.tasks.active.length, 1, 'active list');
  assert.ok(d.tasks.overdue.some(t => t.title === 'T3 overdue'), 'overdue obsahuje T3');
  assert.ok(d.tasks.active.some(t => t.title === 'T5 aktivní'), 'active obsahuje T5');
});

test('cizí uživatel bez úkolů → success_rate null', async () => {
  const other = await db.query(`INSERT INTO users (email, name, role) VALUES ('empty@test.local','Empty','senior_dev') RETURNING id`);
  const d = await userScore(other.rows[0].id, 6);
  assert.equal(d.success_rate, null);
  assert.equal(d.months.length, 6);
});
