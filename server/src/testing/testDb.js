// Dočasný PostgreSQL pro testy nad reálnou DB (migrace, detektory, routy).
//
// Preferuje TEST_DATABASE_URL (např. Neon test branch v CI); jinak nahodí
// embedded-postgres — žádná externí závislost, binárka se stáhne při npm
// install a testy si samy vytvoří čistou DB. Vrací { url, stop }.
//
// Pozn.: db.js si pool tvoří při importu z process.env.DATABASE_URL, takže
// volající musí nastavit process.env.DATABASE_URL = url PŘED importem db.js.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export async function startTestDb() {
  // CI / lokální override: použij existující DB, nic nespouštěj.
  if (process.env.TEST_DATABASE_URL) {
    return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // databaseDir musí být na nativním FS (ne na síťovém mountu) kvůli lock
  // souborům — os.tmpdir() je bezpečná volba lokálně i v CI.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitom-pg-'));
  const port = 50000 + Math.floor(Math.random() * 10000);
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'test', password: 'test', port, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('vitom_test');

  return {
    url: `postgres://test:test@127.0.0.1:${port}/vitom_test`,
    stop: async () => {
      try { await pg.stop(); } catch { /* už zastavený */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
