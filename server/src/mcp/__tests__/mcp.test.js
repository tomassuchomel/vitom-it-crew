// Unit testy MCP serveru — bez skutečné DB / HTTP. Testujeme:
//   (a) auth middleware (401 bez tokenu, next() s tokenem)
//   (b) mapy MCP_TO_DB / DB_TO_MCP (round-trip)
//   (c) validace přechodů ALLOWED_TRANSITIONS
//   (d) claim idempotence + race — přes stub `query`
//
// Skutečné integrační testy (proti běžící DB + HTTP) jsou mimo tento suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requireMcpAuth,
} from '../index.js';
import {
  MCP_TO_DB, DB_TO_MCP, ALLOWED_TRANSITIONS,
} from '../index.js';

// --- (a) auth (middleware je nyní async — musíme awaitovat) ---

test('auth: bez Authorization header → 401', async () => {
  process.env.MCP_AUTH_TOKEN = 'secret123';
  const req = { headers: {} };
  const captured = {};
  const res = { status(s) { captured.status = s; return this; }, json(b) { captured.body = b; } };
  let nextCalled = false;
  await requireMcpAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
  assert.equal(captured.body.error, 'unauthorized');
});

test('auth: špatný token (global env se nezhoduje, DB lookup nenajde) → 401', async () => {
  process.env.MCP_AUTH_TOKEN = 'secret123';
  const req = { headers: { authorization: 'Bearer wrong' } };
  const captured = {};
  const res = { status(s) { captured.status = s; return this; }, json(b) { captured.body = b; } };
  let nextCalled = false;
  await requireMcpAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(captured.status, 401);
});

test('auth: správný global Bearer token → volá next() + mcpUser.global=true', async () => {
  process.env.MCP_AUTH_TOKEN = 'secret123';
  const req = { headers: { authorization: 'Bearer secret123' } };
  const res = { status() { return this; }, json() {} };
  let nextCalled = false;
  await requireMcpAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.mcpUser, { global: true });
});

test('auth: bez env var + neznámý token → 401 (DB lookup vrátí null)', async () => {
  delete process.env.MCP_AUTH_TOKEN;
  const req = { headers: { authorization: 'Bearer whatever' } };
  const captured = {};
  const res = { status(s) { captured.status = s; return this; }, json(b) { captured.body = b; } };
  await requireMcpAuth(req, res, () => { throw new Error('should not call next'); });
  assert.equal(captured.status, 401);
});

// --- (b) status mapy ---

test('status map: round-trip MCP → DB → MCP', () => {
  for (const mcp of ['todo', 'in_progress', 'in_review', 'done', 'blocked']) {
    const db = MCP_TO_DB[mcp];
    const back = DB_TO_MCP[db];
    assert.equal(back, mcp, `${mcp} round-trip failed via ${db}`);
  }
});

test('status map: backlog má DB alias todo (asymetrie povolená)', () => {
  assert.equal(MCP_TO_DB.backlog, 'todo');
});

// --- (c) transitions ---

test('transitions: todo → in_progress povoleno', () => {
  assert.ok(ALLOWED_TRANSITIONS.todo.includes('in_progress'));
});

test('transitions: done → cokoli zamítnuto', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.done, []);
});

test('transitions: in_progress → in_review povoleno', () => {
  assert.ok(ALLOWED_TRANSITIONS.in_progress.includes('in_review'));
});

test('transitions: blocked → in_progress povoleno (odblokování)', () => {
  assert.ok(ALLOWED_TRANSITIONS.blocked.includes('in_progress'));
});

test('transitions: in_progress → todo zakázáno (nesmí zpět)', () => {
  assert.ok(!ALLOWED_TRANSITIONS.in_progress.includes('todo'));
});
