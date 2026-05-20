// Integration test ReviewerAgentu s mockovaným Anthropic SDK.
// Test pokrývá:
//   – 3 verdikty (approve / request_changes / reject)
//   – Parsing strukturovaného JSON výstupu
//   – Cost computation (Opus 4.7 pricing)
//   – Selhání parsingu při malformed JSON
//   – Diff truncation pro obří diffy
//   – formatReviewComment markdown sestavení

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReviewerAgent,
  formatReviewComment,
  REVIEW_SCHEMA,
  _internals,
} from '../reviewerAgent.js';

const { computeCostUsd, buildUserMessage, MAX_DIFF_CHARS, MAX_TEST_OUTPUT_CHARS } = _internals;

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeMockClient(scriptedResponse) {
  const calls = [];
  return {
    client: {
      messages: {
        create: async (params) => {
          calls.push({ params: JSON.parse(JSON.stringify(params)) });
          if (scriptedResponse instanceof Error) throw scriptedResponse;
          return scriptedResponse;
        },
      },
    },
    getCalls: () => calls,
  };
}

function mockApiResponse(reviewJson, usage = {}) {
  return {
    id: `msg_mock_${Math.random()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text: JSON.stringify(reviewJson) }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: usage.input_tokens ?? 5000,
      output_tokens: usage.output_tokens ?? 800,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

const sampleTask = {
  id: 42,
  title: 'Add dark mode toggle',
  description: 'Add a button in header that toggles between light and dark themes.',
  acceptance_criteria: ['Toggle button visible in header', 'Theme persists across reload'],
  out_of_scope: ['Custom themes beyond light/dark'],
  scope_paths: ['client/src/components/'],
};

const sampleInputs = {
  task: sampleTask,
  diff: 'diff --git a/client/src/components/Header.jsx ...',
  testOutput: 'PASS  client/src/components/Header.test.jsx',
  planContent: '## Cíl\nDark mode toggle\n## Kroky\n1. Komponenta DarkModeToggle\n2. Context provider',
  implementerSummary: '## Co jsem udělal\nPřidán toggle...',
  apiKey: 'mock-key',
};

// ─── Cost ────────────────────────────────────────────────────────────────

test('computeCostUsd: Opus 4.7 pricing (5/25)', () => {
  // 1M input + 1M output → 5 + 25 = 30 USD
  assert.equal(computeCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), 30);
});

test('computeCostUsd: cache read 0.1× Opus input', () => {
  // 1M cache_read = 0.5 USD (5 * 0.1)
  assert.equal(Number(computeCostUsd({ cache_read_input_tokens: 1_000_000 }).toFixed(4)), 0.5);
});

// ─── Approve verdict ──────────────────────────────────────────────────────

test('approve verdict: vrátí review, žádný error', async () => {
  const review = {
    verdict: 'approve',
    ac_check: [
      { criterion: 'Toggle button visible in header', met: true, evidence: 'Header.jsx řádek 12' },
      { criterion: 'Theme persists across reload', met: true, evidence: 'localStorage v ThemeContext' },
    ],
    issues: [],
    out_of_scope_violations: [],
    summary: 'AC splněna, testy zelené, čistý kód.',
  };
  const mock = makeMockClient(mockApiResponse(review));

  const result = await runReviewerAgent({ ...sampleInputs, client: mock.client });
  assert.equal(result.error, null);
  assert.equal(result.review.verdict, 'approve');
  assert.equal(result.review.ac_check.length, 2);
  assert.ok(result.costUsd > 0);
});

// ─── Request changes ─────────────────────────────────────────────────────

test('request_changes verdict: vrátí review se seznamem issues', async () => {
  const review = {
    verdict: 'request_changes',
    ac_check: [
      { criterion: 'Toggle button visible in header', met: true, evidence: 'OK' },
      { criterion: 'Theme persists across reload', met: false, evidence: 'localStorage chybí, jen state' },
    ],
    issues: [
      { severity: 'blocker', file: 'client/src/components/Header.jsx', line: 25, comment: 'localStorage save chybí' },
      { severity: 'minor', file: 'client/src/components/Header.jsx', line: 8, comment: 'typo v komentáři' },
    ],
    out_of_scope_violations: [],
    summary: 'AC #2 není splněno, blocker v persistence.',
  };
  const mock = makeMockClient(mockApiResponse(review));

  const result = await runReviewerAgent({ ...sampleInputs, client: mock.client });
  assert.equal(result.review.verdict, 'request_changes');
  assert.equal(result.review.issues.length, 2);
  assert.equal(result.review.issues[0].severity, 'blocker');
});

// ─── Reject ──────────────────────────────────────────────────────────────

test('reject verdict: scope violation, eskalace', async () => {
  const review = {
    verdict: 'reject',
    ac_check: [],
    issues: [
      { severity: 'blocker', file: 'server/src/db.js', line: 50, comment: 'fundamentální zásah do DB schema' },
    ],
    out_of_scope_violations: ['server/src/db.js – mimo scope (client/src/components/) a mimo zadání'],
    summary: 'Autor sáhl do serveru přestože měl pracovat jen na klientovi. Vyžaduje člověka.',
  };
  const mock = makeMockClient(mockApiResponse(review));

  const result = await runReviewerAgent({ ...sampleInputs, client: mock.client });
  assert.equal(result.review.verdict, 'reject');
  assert.equal(result.review.out_of_scope_violations.length, 1);
});

// ─── Error paths ─────────────────────────────────────────────────────────

test('parse_error: malformed JSON v text bloku', async () => {
  const badResponse = {
    content: [{ type: 'text', text: 'this is not json' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  const mock = makeMockClient(badResponse);
  const result = await runReviewerAgent({ ...sampleInputs, client: mock.client });
  assert.equal(result.review, null);
  assert.match(result.error, /parse_error/);
});

test('parse_error: chybějící verdict', async () => {
  const incomplete = { ac_check: [], issues: [], out_of_scope_violations: [], summary: 'oops' };
  const mock = makeMockClient(mockApiResponse(incomplete));
  const result = await runReviewerAgent({ ...sampleInputs, client: mock.client });
  assert.equal(result.review, null);
  assert.match(result.error, /invalid verdict/);
});

test('api_error: SDK throw je odchycen a vrácen', async () => {
  const mock = makeMockClient(new Error('rate limit'));
  const result = await runReviewerAgent({ ...sampleInputs, client: mock.client });
  assert.equal(result.review, null);
  assert.match(result.error, /api_error.*rate limit/);
});

// ─── Prompt + schema ─────────────────────────────────────────────────────

test('build user message: obsahuje všechny vstupy', () => {
  const msg = buildUserMessage({
    task: sampleTask,
    diff: 'sample diff',
    testOutput: 'PASS',
    planContent: 'sample plan',
    implementerSummary: 'sample summary',
    previousReviewCount: 0,
  });
  assert.match(msg, /Add dark mode toggle/);
  assert.match(msg, /Toggle button visible in header/);
  assert.match(msg, /Custom themes beyond light\/dark/);
  assert.match(msg, /client\/src\/components\//);
  assert.match(msg, /sample diff/);
  assert.match(msg, /sample plan/);
  assert.match(msg, /sample summary/);
  assert.match(msg, /PASS/);
});

test('build user message: previousReviewCount > 0 vloží varování o opakování', () => {
  const msg = buildUserMessage({
    task: sampleTask, diff: '', testOutput: '', planContent: '', implementerSummary: '',
    previousReviewCount: 2,
  });
  assert.match(msg, /3\. iterace/);
  assert.match(msg, /reject/);
});

test('build user message: ořeže obří diff a poznamenává to', () => {
  const hugeDiff = 'A'.repeat(MAX_DIFF_CHARS + 10_000);
  const msg = buildUserMessage({
    task: sampleTask, diff: hugeDiff, testOutput: '', planContent: '', implementerSummary: '',
    previousReviewCount: 0,
  });
  assert.match(msg, /DIFF ZKRÁCEN/);
});

test('REVIEW_SCHEMA: validní strukturní popis', () => {
  // Sanity check – schema má všechny povinné properties
  assert.deepEqual(REVIEW_SCHEMA.required.sort(), [
    'ac_check', 'issues', 'out_of_scope_violations', 'summary', 'verdict',
  ]);
  assert.deepEqual(REVIEW_SCHEMA.properties.verdict.enum, ['approve', 'request_changes', 'reject']);
  assert.deepEqual(REVIEW_SCHEMA.properties.issues.items.properties.severity.enum,
                   ['blocker', 'major', 'minor']);
});

// ─── formatReviewComment ─────────────────────────────────────────────────

test('formatReviewComment: approve dá ✅ header', () => {
  const md = formatReviewComment({
    verdict: 'approve',
    ac_check: [{ criterion: 'X', met: true, evidence: 'Y' }],
    issues: [],
    out_of_scope_violations: [],
    summary: 'OK.',
  });
  assert.match(md, /✅ Schváleno/);
  assert.match(md, /\*\*X\*\*/);
  assert.match(md, /OK\./);
});

test('formatReviewComment: request_changes seskupí issues po severity', () => {
  const md = formatReviewComment({
    verdict: 'request_changes',
    ac_check: [],
    issues: [
      { severity: 'blocker', file: 'a.js', line: 10, comment: 'B' },
      { severity: 'major', file: 'b.js', line: null, comment: 'M' },
      { severity: 'minor', file: 'c.js', line: 1, comment: 'm' },
    ],
    out_of_scope_violations: ['x.js'],
    summary: 'changes needed',
  }, { iteration: 2 });
  assert.match(md, /🔄 Vyžadovány změny.*iterace 2/);
  assert.match(md, /Blockers/);
  assert.match(md, /Major issues/);
  assert.match(md, /Minor issues/);
  assert.match(md, /\*\*a\.js:10\*\*/);  // file:line
  assert.match(md, /\*\*b\.js\*\*/);     // line null = jen file
  assert.match(md, /Porušení scope/);
});

test('formatReviewComment: reject dá ❌ header', () => {
  const md = formatReviewComment({
    verdict: 'reject',
    ac_check: [],
    issues: [],
    out_of_scope_violations: [],
    summary: 'nope',
  });
  assert.match(md, /❌ Zamítnuto/);
});

test('formatReviewComment: null vstup graceful', () => {
  assert.equal(formatReviewComment(null), '_(empty review)_');
});
