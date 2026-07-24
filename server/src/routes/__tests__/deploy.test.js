// GitHub webhook: HMAC verifikace + filtrace event/ref. Deploy trigger sám
// netestujeme (spawn detach by pustil reálný script), scénáře volíme tak,
// aby žádná varianta neskončila v runDeploy().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { getRecentErrors, clearErrors } from '../../errorBuffer.js';

let server, port;

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function post(body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/deploy/github-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

before(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
  const { default: deployRoutes } = await import('../deploy.js');
  const app = express();
  app.use('/api/deploy', deployRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
});

test('bez GITHUB_WEBHOOK_SECRET vrací 503', async () => {
  const saved = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  const r = await post('{}', { 'X-Hub-Signature-256': sign('x', '{}') });
  process.env.GITHUB_WEBHOOK_SECRET = saved;
  assert.equal(r.status, 503);
});

test('špatný HMAC podpis → 401 a NEplní error buffer (šum od botů)', async () => {
  clearErrors();
  const r = await post('{"ref":"refs/heads/main"}', {
    'X-Hub-Signature-256': 'sha256=deadbeef',
    'X-GitHub-Event': 'push',
  });
  assert.equal(r.status, 401);
  assert.equal(getRecentErrors(10).length, 0, 'bad signature nesmí zaplavit ring buffer');
});

test('ping event → pong', async () => {
  const body = '{"zen":"hello"}';
  const r = await post(body, {
    'X-Hub-Signature-256': sign('test-secret', body),
    'X-GitHub-Event': 'ping',
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.pong, true);
});

test('push na jinou branch se ignoruje (neběží deploy)', async () => {
  const body = JSON.stringify({ ref: 'refs/heads/feature-x', after: 'abc' });
  const r = await post(body, {
    'X-Hub-Signature-256': sign('test-secret', body),
    'X-GitHub-Event': 'push',
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.ignored, /feature-x/);
});

test('non-push event se ignoruje', async () => {
  const body = '{}';
  const r = await post(body, {
    'X-Hub-Signature-256': sign('test-secret', body),
    'X-GitHub-Event': 'issues',
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.ignored, /issues/);
});
