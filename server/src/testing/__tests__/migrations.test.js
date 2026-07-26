// Regresní test: appka MUSÍ nabootovat z úplně prázdné databáze.
//
// V minulosti to padalo (server vůbec nenastartoval na čisté DB), protože:
//   1) inline failsafe v db.js sahal na tabulky (notes, user_notification_prefs),
//      které vznikají až souborovou migrací běžící PO inline schématu,
//   2) některé souborové migrace se abecedně řadily PŘED svého "tvůrce"
//      (team-features-* před teams, note-shares před notes, …).
// Fix: guardy v db.js + prefix 0- u tvořících migrací. Tenhle test to hlídá.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../testDb.js';

let db, stopDb;

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  // Nasměruj db.js na testovací PG PŘED importem (pool se tvoří při importu).
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  db = await import('../../db.js');
});

after(async () => {
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

test('cold-boot: migrace projdou na prázdné DB', async () => {
  await db.migrate();
  await db.runFileMigrations();

  const r = await db.query(
    `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`
  );
  assert.ok(r.rows[0].n >= 20, `čekáno ≥20 tabulek, je ${r.rows[0].n}`);

  // Klíčové tabulky napříč doménami skutečně vznikly.
  for (const name of ['users', 'teams', 'team_members', 'notes', 'user_notification_prefs', 'ideas', 'tasks']) {
    const e = await db.query(`SELECT to_regclass($1) AS t`, [name]);
    assert.ok(e.rows[0].t, `tabulka ${name} chybí po migracích`);
  }
});

test('idempotence: druhý běh migrací nic nerozbije', async () => {
  const b = await db.query(
    `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`
  );
  await db.migrate();
  await db.runFileMigrations();
  const a = await db.query(
    `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`
  );
  assert.equal(a.rows[0].n, b.rows[0].n, 'počet tabulek se mezi běhy změnil');
});
