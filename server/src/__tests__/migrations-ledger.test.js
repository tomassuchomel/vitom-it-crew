// Evidence aplikovaných migrací (schema_migrations).
//
// Dřív se všechny soubory pouštěly při každém startu znovu nad živými daty.
// Jedna chyba na produkčních datech = server se přestal umět nastartovat.
// Tyhle testy hlídají, že se každá migrace aplikuje právě jednou a že
// opakovaný start nad NEPRÁZDNOU databází projde.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb } from '../testing/testDb.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

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

test('po prvním běhu je evidovaný každý soubor migrace', async () => {
  const r = await db.query('SELECT filename FROM schema_migrations ORDER BY filename');
  const recorded = r.rows.map(x => x.filename);
  assert.deepEqual(recorded, MIGRATION_FILES,
    'evidence odpovídá souborům na disku');
});

test('druhý běh už žádný soubor nespustí', async () => {
  const before = await db.query('SELECT filename, applied_at FROM schema_migrations ORDER BY filename');

  await db.runFileMigrations();

  const after = await db.query('SELECT filename, applied_at FROM schema_migrations ORDER BY filename');
  assert.equal(after.rows.length, before.rows.length, 'nepřibyl žádný záznam');
  // applied_at se nesmí změnit — kdyby se migrace pustila znovu, přepsalo
  // by se nebo přibyl duplicitní řádek.
  assert.deepEqual(
    after.rows.map(r => r.applied_at.toISOString()),
    before.rows.map(r => r.applied_at.toISOString()),
    'časy aplikace zůstaly beze změny'
  );
});

test('restart nad neprázdnou databází projde (data ve všech stavech úkolu)', async () => {
  const team = (await db.query(`INSERT INTO teams (name,slug) VALUES ('T','t-ledger') RETURNING id`)).rows[0].id;
  const user = (await db.query(`INSERT INTO users (email,name,role) VALUES ('l@t.cz','L','manager') RETURNING id`)).rows[0].id;
  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`,
    [team, user]
  )).rows[0].id;
  for (const status of ['todo', 'in_progress', 'review', 'done', 'needs_fix', 'waiting']) {
    await db.query(`INSERT INTO tasks (project_id,title,status) VALUES ($1,$2,$3)`,
      [project, `Úkol ${status}`, status]);
  }

  // Přesně to, co dělá index.js při startu.
  await db.migrate();
  await db.runFileMigrations();

  const n = (await db.query('SELECT COUNT(*)::int AS n FROM tasks')).rows[0].n;
  assert.equal(n, 6, 'žádný úkol se restartem neztratil');
});

test('nový soubor migrace se aplikuje a zaeviduje', async () => {
  const name = '9999-12-31-test-ledger.sql';
  const file = path.join(MIGRATIONS_DIR, name);
  fs.writeFileSync(file, 'CREATE TABLE IF NOT EXISTS _ledger_probe (id INT);\n');
  try {
    await db.runFileMigrations();

    const rec = await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [name]);
    assert.equal(rec.rows.length, 1, 'nový soubor je v evidenci');
    const tbl = await db.query(`SELECT to_regclass('_ledger_probe') AS t`);
    assert.ok(tbl.rows[0].t, 'nový soubor se opravdu aplikoval');
  } finally {
    fs.unlinkSync(file);
    await db.query('DROP TABLE IF EXISTS _ledger_probe');
    await db.query('DELETE FROM schema_migrations WHERE filename = $1', [name]);
  }
});

test('selhání migrace se nezaeviduje a změny se vrátí zpět', async () => {
  const name = '9999-12-30-test-fail.sql';
  const file = path.join(MIGRATIONS_DIR, name);
  // První příkaz projde, druhý spadne — transakce musí vrátit i ten první.
  fs.writeFileSync(file, 'CREATE TABLE _fail_probe (id INT);\nSELECT neexistujici_funkce();\n');
  try {
    await assert.rejects(() => db.runFileMigrations(), 'chybná migrace vyhodí chybu');

    const rec = await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [name]);
    assert.equal(rec.rows.length, 0, 'neúspěšná migrace se neeviduje');
    const tbl = await db.query(`SELECT to_regclass('_fail_probe') AS t`);
    assert.equal(tbl.rows[0].t, null, 'částečné změny se vrátily zpět');
  } finally {
    fs.unlinkSync(file);
  }
});
