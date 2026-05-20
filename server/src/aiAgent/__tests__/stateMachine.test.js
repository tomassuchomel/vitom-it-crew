import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, validateTransition, nextStates, isTerminal } from '../stateMachine.js';

// ─── canTransition – jen happy path / not-allowed ────────────────────────

test('canTransition: idle → queued povoleno', () => {
  assert.equal(canTransition('idle', 'queued'), true);
});

test('canTransition: queued → planning povoleno', () => {
  assert.equal(canTransition('queued', 'planning'), true);
});

test('canTransition: planning → implementing povoleno', () => {
  assert.equal(canTransition('planning', 'implementing'), true);
});

test('canTransition: implementing → in_review povoleno', () => {
  assert.equal(canTransition('implementing', 'in_review'), true);
});

test('canTransition: in_review → done povoleno', () => {
  assert.equal(canTransition('in_review', 'done'), true);
});

test('canTransition: in_review → needs_changes povoleno', () => {
  assert.equal(canTransition('in_review', 'needs_changes'), true);
});

test('canTransition: needs_changes → implementing povoleno (retry kola)', () => {
  assert.equal(canTransition('needs_changes', 'implementing'), true);
});

test('canTransition: done → queued povoleno (re-run)', () => {
  assert.equal(canTransition('done', 'queued'), true);
});

test('canTransition: failed → queued povoleno (retry)', () => {
  assert.equal(canTransition('failed', 'queued'), true);
});

test('canTransition: cokoli → idle povoleno (hard reset)', () => {
  for (const s of ['queued', 'planning', 'implementing', 'in_review', 'needs_changes', 'done', 'failed', 'needs_human']) {
    assert.equal(canTransition(s, 'idle'), true, `${s} → idle`);
  }
});

// ─── canTransition – co povoleno NENÍ ────────────────────────────────────

test('canTransition: in_review → needs_human povoleno (reviewer reject)', () => {
  assert.equal(canTransition('in_review', 'needs_human'), true);
});

test('canTransition: needs_changes → queued povoleno (re-run cyklus)', () => {
  assert.equal(canTransition('needs_changes', 'queued'), true);
});

test('canTransition: idle → done přímo zakázáno', () => {
  assert.equal(canTransition('idle', 'done'), false);
});

test('canTransition: queued → done přímo zakázáno', () => {
  assert.equal(canTransition('queued', 'done'), false);
});

test('canTransition: planning → done přímo zakázáno', () => {
  assert.equal(canTransition('planning', 'done'), false);
});

test('canTransition: done → planning zakázáno (musí přes queued)', () => {
  assert.equal(canTransition('done', 'planning'), false);
});

test('canTransition: neznámý from = false', () => {
  assert.equal(canTransition('unknown', 'queued'), false);
});

// ─── validateTransition – machine readable chyby ─────────────────────────

test('validateTransition: invalid_from', () => {
  const r = validateTransition('foo', 'queued');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_from');
});

test('validateTransition: invalid_to', () => {
  const r = validateTransition('queued', 'bar');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_to');
});

test('validateTransition: no_op (from = to)', () => {
  const r = validateTransition('queued', 'queued');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_op');
});

test('validateTransition: transition_not_allowed vrátí seznam povolených', () => {
  const r = validateTransition('idle', 'done');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'transition_not_allowed');
  assert.ok(Array.isArray(r.allowed));
  assert.ok(r.allowed.includes('queued'));
});

test('validateTransition: úspěch obsahuje from + to', () => {
  const r = validateTransition('queued', 'planning');
  assert.deepEqual(r, { ok: true, from: 'queued', to: 'planning' });
});

// ─── nextStates / isTerminal ─────────────────────────────────────────────

test('nextStates: vrátí konzistentní seznam', () => {
  const out = nextStates('queued').sort();
  assert.deepEqual(out, ['failed', 'idle', 'planning'].sort());
});

test('nextStates: neznámý → []', () => {
  assert.deepEqual(nextStates('xxx'), []);
});

test('isTerminal: done/failed/needs_human/idle = true', () => {
  for (const s of ['done', 'failed', 'needs_human', 'idle']) {
    assert.equal(isTerminal(s), true, s);
  }
});

test('isTerminal: queued/planning/implementing/in_review/needs_changes = false', () => {
  for (const s of ['queued', 'planning', 'implementing', 'in_review', 'needs_changes']) {
    assert.equal(isTerminal(s), false, s);
  }
});
