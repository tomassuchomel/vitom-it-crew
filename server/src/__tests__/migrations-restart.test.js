// Migrace běží při KAŽDÉM startu serveru — ne jen nad čistou databází, ale
// nad živými daty. Tenhle test to simuluje: naplní tabulky reálnými stavy
// a pustí migrace znovu, jako by server restartoval.
//
// Vzniklo po výpadku produkce (říjen 2026): stará migrace nastavovala CHECK
// constraint na stavy úkolu BEZ 'waiting'. Jakmile někdo nový stav poprvé
// použil, každý další start skončil chybou „check constraint is violated by
// some row" a server se do nekonečna restartoval. Stávající test idempotence
// to nechytil, protože běžel nad prázdnou databází.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../testing/testDb.js';

let db, stopDb;

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  process.env.DISABLE_AUTOSEED = '1';
  db = await import('../db.js');
  await db.migrate();
  await db.runFileMigrations();
});

after(async () => {
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

// Všechny stavy, které smí úkol mít. Při přidání dalšího ho dopiš sem —
// test pak ohlídá, že se o něj nerozbije restart.
const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'needs_fix', 'waiting'];

test('restart serveru projde, i když data obsahují všechny stavy úkolu', async () => {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-restart') RETURNING id`)).rows[0].id;
  const user = (await db.query(`INSERT INTO users (email,name,role) VALUES ('r@t.cz','R','manager') RETURNING id`)).rows[0].id;
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`,
    [team, user]
  )).rows[0].id;

  for (const status of TASK_STATUSES) {
    await db.query(
      `INSERT INTO tasks (project_id,title,status,waiting_for) VALUES ($1,$2,$3,$4)`,
      [project, `Úkol ve stavu ${status}`, status, status === 'waiting' ? 'Dodavatel' : null]
    );
  }

  // Simulace restartu — přesně to, co dělá index.js při startu.
  await db.migrate();
  await db.runFileMigrations();

  const r = await db.query(`SELECT status, COUNT(*)::int AS n FROM tasks GROUP BY status ORDER BY status`);
  assert.equal(r.rows.length, TASK_STATUSES.length, 'žádný úkol se restartem neztratil');
});

test('CHECK constraint po restartu pouští všechny platné stavy', async () => {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T2','t-restart2') RETURNING id`)).rows[0].id;
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id) VALUES ('P2',CURRENT_DATE,$1) RETURNING id`, [team]
  )).rows[0].id;

  for (const status of TASK_STATUSES) {
    await db.query(`INSERT INTO tasks (project_id,title,status) VALUES ($1,'X',$2)`, [project, status]);
  }
  // A naopak: vymyšlený stav musí constraint pořád odmítnout.
  await assert.rejects(
    () => db.query(`INSERT INTO tasks (project_id,title,status) VALUES ($1,'X','nesmysl')`, [project]),
    'neplatný stav constraint odmítne'
  );
});
