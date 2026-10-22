// Chyba v async handleru musí skončit jako JSON odpověď, ne jako visící
// request. Express 4 odmítnutý promise sám nezachytí — řeší to import
// 'express-async-errors' v index.js, který patchuje router globálně.
//
// Testujeme skutečný errorHandler z ../errorHandler.js, ne jeho kopii.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import 'express-async-errors';
import { errorHandler } from '../errorHandler.js';

let server, port;

// Timeout kolem fetche: kdyby se oprava rozbila, request by visel a test by
// jinak doběhl až na timeout celého běhu. Takhle selže rychle a srozumitelně.
async function call(path, ms = 4000) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(ms) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  const app = express();

  // Async handler bez try/catch, který spadne — přesně vzor 133 handlerů v repu.
  app.get('/boom', async () => {
    await new Promise(r => setImmediate(r));
    throw new Error('prasklo to uvnitř async handleru');
  });

  // Simulace chyb z PostgreSQL.
  app.get('/fk', async () => {
    const e = new Error('update or delete on table "projects" violates foreign key constraint');
    e.code = '23503';
    throw e;
  });
  app.get('/dup', async () => {
    const e = new Error('duplicate key value violates unique constraint');
    e.code = '23505';
    throw e;
  });

  // Chyba poté, co odpověď začala odcházet — handler ji nesmí přepisovat.
  app.get('/after-send', async (req, res) => {
    res.status(200).write('kus dat');
    throw new Error('pozdní chyba');
  });

  app.get('/ok', async (req, res) => res.json({ ok: true }));

  app.use(errorHandler);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
});

test('chyba v async handleru vrátí 500 JSON, request nevisí', async () => {
  const r = await call('/boom');
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'server_error');
  assert.match(r.body.message, /prasklo to/);
});

test('porušení cizího klíče (23503) → 409 se srozumitelnou hláškou', async () => {
  const r = await call('/fk');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'in_use');
  assert.match(r.body.message, /navazuj/i, 'hláška je česky a pro člověka');
});

test('duplicitní záznam (23505) → 409', async () => {
  const r = await call('/dup');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'duplicate');
});

test('chyba po odeslání hlaviček odpověď nepřepisuje', async () => {
  // Klient už dostal 200 i s kusem těla — handler ho nesmí přepsat na 500
  // (to by skončilo „Cannot set headers after they are sent" a shodilo by
  // to proces). Server jen spojení ukončí.
  const r = await call('/after-send', 3000);
  assert.equal(r.status, 200, 'původní stav odpovědi zůstal');
});

test('bezchybný handler funguje dál', async () => {
  const r = await call('/ok');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});
