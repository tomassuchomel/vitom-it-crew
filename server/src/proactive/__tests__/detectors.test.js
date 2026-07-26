// Testy proaktivních detektorů nad reálnou DB (embedded-postgres přes testDb).
//
// Seed jde do vlastního týmu (unikátní slug), aby ho neovlivnila data, která
// zakládají produkční migrace (Management tým apod.). Fixtury pokrývají po
// jednom "trefeném" i "netrefeném" případu pro každý detektor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, teamId;
const ids = {}; // pojmenované id úkolů/uživatelů pro asserce

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  db = await import('../../db.js');
  await db.migrate();
  await db.runFileMigrations();
  await seed();
});

after(async () => {
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

async function seed() {
  const q = db.query;
  const team = await q(`INSERT INTO teams (name, slug) VALUES ('Detektor test','det-test') RETURNING id`);
  teamId = team.rows[0].id;

  const u1 = await q(
    `INSERT INTO users (email, name, role) VALUES ('det-alice@test.local','Alice','senior_dev') RETURNING id`
  );
  const u2 = await q(
    `INSERT INTO users (email, name, role) VALUES ('det-bob@test.local','Bob','senior_dev') RETURNING id`
  );
  ids.alice = u1.rows[0].id;
  ids.bob = u2.rows[0].id;

  const proj = await q(
    `INSERT INTO projects (name, start_date, team_id, manager_id)
     VALUES ('Projekt X', CURRENT_DATE, $1, $2) RETURNING id`,
    [teamId, ids.alice]
  );
  const pid = proj.rows[0].id;

  const insTask = async (title, cols) => {
    const r = await q(
      `INSERT INTO tasks (project_id, title, status, assignee_id, due_date, estimated_h, actual_h, completed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, NOW())) RETURNING id`,
      [pid, title, cols.status, cols.assignee ?? null, cols.due ?? null,
       cols.est ?? null, cols.actual ?? null, cols.completed ?? null, cols.created ?? null]
    );
    return r.rows[0].id;
  };

  // Skluz: po termínu, čerstvě založený (aby nespadl i do "bez pohybu")
  ids.overdue = await insTask('Overdue', { status: 'in_progress', assignee: ids.bob });
  await q(`UPDATE tasks SET due_date = CURRENT_DATE - 5 WHERE id = $1`, [ids.overdue]);

  // Blížící se deadline (za 2 dny)
  ids.upcoming = await insTask('Upcoming', { status: 'todo', assignee: ids.bob });
  await q(`UPDATE tasks SET due_date = CURRENT_DATE + 2 WHERE id = $1`, [ids.upcoming]);

  // Bez pohybu: aktivní, založen před 30 dny, žádné hodiny/review
  ids.stalled = await insTask('Stalled', { status: 'in_progress', assignee: ids.bob });
  await q(`UPDATE tasks SET created_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [ids.stalled]);

  // Přetažený odhad: hotový, actual 10 vs estimate 4 (2.5×)
  ids.overrun = await insTask('Overrun', { status: 'done', assignee: ids.alice, est: 4, actual: 10 });
  await q(`UPDATE tasks SET completed_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [ids.overrun]);

  // Hotový přesně na odhad (nemá se hlásit)
  ids.normal = await insTask('NormalDone', { status: 'done', assignee: ids.alice, est: 5, actual: 5 });
  await q(`UPDATE tasks SET completed_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [ids.normal]);

  // Alice má dnešní zápis hodin → není "nezapsané hodiny". Bob nemá nic.
  await q(
    `INSERT INTO time_entries (user_id, project_id, task_id, date, hours)
     VALUES ($1, $2, $3, CURRENT_DATE, 8)`,
    [ids.alice, pid, ids.overrun]
  );
}

const taskIds = (signals) => signals.map((s) => s.task_id);
const userIds = (signals) => signals.map((s) => s.user_id);

test('overdueTasks: najde úkol po termínu', async () => {
  const { overdueTasks } = await import('../detectors.js');
  const s = await overdueTasks(teamId);
  assert.ok(taskIds(s).includes(ids.overdue), 'overdue úkol chybí');
  assert.ok(!taskIds(s).includes(ids.upcoming), 'upcoming se nemá počítat jako overdue');
});

test('upcomingDeadlines: najde blížící se termín', async () => {
  const { upcomingDeadlines } = await import('../detectors.js');
  const s = await upcomingDeadlines(teamId, 3);
  assert.ok(taskIds(s).includes(ids.upcoming), 'upcoming úkol chybí');
  assert.ok(!taskIds(s).includes(ids.overdue), 'overdue (v minulosti) se nemá počítat');
});

test('stalledTasks: najde úkol bez pohybu, ne čerstvé', async () => {
  const { stalledTasks } = await import('../detectors.js');
  const s = await stalledTasks(teamId, 7);
  assert.ok(taskIds(s).includes(ids.stalled), 'stalled úkol chybí');
  assert.ok(!taskIds(s).includes(ids.overdue), 'čerstvý overdue se nemá počítat jako stalled');
  assert.ok(!taskIds(s).includes(ids.upcoming), 'čerstvý upcoming se nemá počítat jako stalled');
});

test('unloggedHours: najde řešitele bez zápisu, ne toho se zápisem', async () => {
  const { unloggedHours } = await import('../detectors.js');
  const s = await unloggedHours(teamId, 7);
  assert.ok(userIds(s).includes(ids.bob), 'Bob (bez hodin) chybí');
  assert.ok(!userIds(s).includes(ids.alice), 'Alice má hodiny, neměla by se hlásit');
});

test('estimateOverruns: najde přetažený odhad, ne přesný', async () => {
  const { estimateOverruns } = await import('../detectors.js');
  const s = await estimateOverruns(teamId, 1.5, 30);
  assert.ok(taskIds(s).includes(ids.overrun), 'overrun úkol chybí');
  assert.ok(!taskIds(s).includes(ids.normal), 'přesný odhad se nemá hlásit');
});

test('detectAll: vrátí sloučené signály včetně všech typů', async () => {
  const { detectAll } = await import('../detectors.js');
  const s = await detectAll(teamId);
  const types = new Set(s.map((x) => x.type));
  for (const t of ['overdue', 'upcoming_deadline', 'stalled', 'unlogged_hours', 'estimate_overrun']) {
    assert.ok(types.has(t), `chybí typ signálu: ${t}`);
  }
});
