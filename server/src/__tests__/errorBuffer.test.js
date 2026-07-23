// Redakce citlivých dat + oříznutí query stringu z path v error bufferu.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordError, getRecentErrors, clearErrors, redact } from '../errorBuffer.js';

beforeEach(() => clearErrors());

test('recordError: DB connection string se zamaskuje v message i stacku', () => {
  recordError({
    source: 'api',
    message: 'connect ECONNREFUSED postgres://vitom:s3cret@10.0.0.1:5432/vitom_prod',
    stack: 'Error: at pool.connect\n  postgresql://alice:pw@host/db',
    path: '/api/foo',
  });
  const [e] = getRecentErrors(1);
  assert.ok(!/s3cret|vitom_prod/.test(e.message), `message stále obsahuje secret: ${e.message}`);
  assert.match(e.message, /postgres:\/\/\*\*\*/);
  assert.ok(!/alice|pw/.test(e.stack), 'stack stále obsahuje secret');
});

test('recordError: Bearer + Authorization header → ***', () => {
  recordError({
    source: 'api',
    message: 'Bearer sk-ant-abc123DEFghi456jklMNOPQrst rejected',
    stack: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
  });
  const [e] = getRecentErrors(1);
  assert.ok(!/sk-ant-abc123/.test(e.message), 'sk-ant klíč se prosakuje do message');
  assert.match(e.message, /Bearer \*\*\*/);
  assert.ok(!/eyJhbGciOiJIUzI1NiJ9/.test(e.stack), 'JWT se prosakuje do stacku');
});

test('recordError: query string se z path ořízne (nese tokeny/emaily)', () => {
  recordError({
    source: 'api',
    message: 'bad',
    path: '/api/auth/callback?code=abc123&email=test@example.com',
  });
  const [e] = getRecentErrors(1);
  assert.equal(e.path, '/api/auth/callback');
});

test('recordError: prázdné/undefined vstupy nespadnou', () => {
  recordError({ source: 'test' });
  recordError({ source: 'test', message: '', stack: null, path: null });
  recordError({ source: 'test', message: undefined, stack: undefined, path: undefined });
  const list = getRecentErrors(10);
  assert.equal(list.length, 3);
  for (const e of list) {
    assert.equal(typeof e.message, 'string');
    assert.equal(e.path, null);
  }
});

test('recordError: tvar záznamu + délkové limity beze změny', () => {
  const longMsg = 'x'.repeat(1000);
  const longStack = 'y'.repeat(5000);
  recordError({ source: 's', message: longMsg, stack: longStack, path: '/p', status: 500, userId: 42 });
  const [e] = getRecentErrors(1);
  assert.deepEqual(Object.keys(e).sort(), ['message','path','source','stack','status','ts','userId']);
  assert.ok(e.message.length <= 500, `message limit překročen: ${e.message.length}`);
  assert.ok(e.stack.length <= 2000, `stack limit překročen: ${e.stack.length}`);
  assert.equal(e.status, 500);
  assert.equal(e.userId, 42);
});

test('redact: nezmasakruje krátká slova', () => {
  const s = redact('User logged out at 12:00, request id abc12');
  assert.match(s, /User logged out/);
  assert.match(s, /abc12/);
});
