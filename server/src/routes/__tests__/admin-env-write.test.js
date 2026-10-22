// PUT /api/admin/server/env — atomický zápis + validace + immutable klíče.
//
// Proč: .env přebíjí systemd (env.js, dotenv override) a zapisuje do něj
// Admin panel. Poškozený soubor tedy zahodí i DATABASE_URL a server už
// nenastartuje. Zápis proto jde přes dočasný soubor + rename a hodnoty se
// před uložením kontrolují.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

// Testovací .env v dočasném adresáři — admin-server.js si cestu bere
// z ENV_FILE_PATH, takže se skutečného souboru vůbec nedotkneme.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vitom-env-'));
const ENV_FILE = path.join(TMP_DIR, '.env');

let db, stopDb, server, port, signToken, adminId;

const put = async (key, value) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/server/env`, {
    method: 'PUT',
    headers: {
      cookie: `tf_token=${signToken({ id: adminId, email: 'adm-env@t.cz', role: 'admin', name: 'Admin' })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key, value }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const readEnvFile = () => (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '');

before(async () => {
  // Musí být nastavené DŘÍV, než se admin-server.js naimportuje (cestu si
  // přečte při vyhodnocení modulu).
  process.env.ENV_FILE_PATH = ENV_FILE;
  fs.writeFileSync(ENV_FILE, 'EXISTUJICI_KLIC=hodnota\n', { mode: 0o600 });

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

  adminId = (await db.query(
    `INSERT INTO users (email,name,role) VALUES ('adm-env@t.cz','Admin','admin') RETURNING id`
  )).rows[0].id;

  const { default: adminRoutes } = await import('../admin-server.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/server', adminRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('NODE_ENV nejde změnit — vypnulo by to frontend', async () => {
  const r = await put('NODE_ENV', 'development');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'immutable');
});

test('DATABASE_URL zůstává immutable', async () => {
  const r = await put('DATABASE_URL', 'postgres://kdokoli@nekde/db');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'immutable');
});

test('neplatná adresa se odmítne a do souboru se nezapíše', async () => {
  const before = readEnvFile();
  const r = await put('CLIENT_URL', 'tohle-neni-url');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, 'invalid_value');
  assert.match(r.body.message, /adresa/i);
  assert.equal(readEnvFile(), before, 'soubor zůstal nedotčený');
});

test('platná hodnota se uloží a jde přečíst zpět', async () => {
  const r = await put('CLIENT_URL', 'https://it.realitniekosystem.cz');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(readEnvFile(), /^CLIENT_URL=https:\/\/it\.realitniekosystem\.cz$/m);
});

test('opakovaný zápis hodnotu přepíše, nezduplikuje', async () => {
  await put('CLIENT_URL', 'https://prvni.cz');
  await put('CLIENT_URL', 'https://druha.cz');
  const lines = readEnvFile().split('\n').filter(l => l.startsWith('CLIENT_URL='));
  assert.equal(lines.length, 1, 'jen jeden řádek s klíčem');
  assert.match(lines[0], /druha\.cz/);
});

test('po zápisu nezůstane dočasný soubor', async () => {
  await put('CLIENT_URL', 'https://uklid.cz');
  const dir = path.dirname(ENV_FILE);
  const leftovers = fs.readdirSync(dir).filter(f => f.startsWith('.env.tmp-'));
  assert.deepEqual(leftovers, [], 'žádné .env.tmp-* pozůstatky');
});

test('zápis nikdy nenechá soubor prázdný', async () => {
  // Atomický rename znamená, že .env je buď starý, nebo celý nový —
  // nikdy zkrácený na nulu jako u writeFileSync.
  await put('MAIL_M365_MAILBOX', 'notifikace@vitom.cz');
  const content = readEnvFile();
  assert.ok(content.length > 0, 'soubor není prázdný');
  assert.match(content, /MAIL_M365_MAILBOX=/);
});

test('zápis nezahodí ostatní klíče ze souboru', async () => {
  await put('MAIL_M365_MAILBOX', 'notifikace@vitom.cz');
  assert.match(readEnvFile(), /^EXISTUJICI_KLIC=hodnota$/m,
    'původní obsah souboru zůstal zachovaný');
});
