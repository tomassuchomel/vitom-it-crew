// node:test – validateScopePaths + checkDailyBudget + checkTaskBudget + isAllowedBranch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScopePaths,
  checkDailyBudget,
  checkTaskBudget,
  isAllowedBranch,
} from '../safety.js';

// ─── validateScopePaths ───────────────────────────────────────────────────

test('validateScopePaths: prázdný seznam = OK', () => {
  assert.deepEqual(validateScopePaths([]), { ok: true });
});

test('validateScopePaths: null/undefined = OK', () => {
  assert.deepEqual(validateScopePaths(null), { ok: true });
  assert.deepEqual(validateScopePaths(undefined), { ok: true });
});

test('validateScopePaths: validní relativní cesty', () => {
  const r = validateScopePaths(['src/components/', 'server/src/routes/tasks.js', 'client/src']);
  assert.equal(r.ok, true);
});

test('validateScopePaths: ".." path traversal odmítnut', () => {
  const r = validateScopePaths(['src/../../../etc/passwd']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'path_traversal');
});

test('validateScopePaths: ".." samostatně odmítnut', () => {
  assert.equal(validateScopePaths(['..']).error, 'path_traversal');
  assert.equal(validateScopePaths(['../foo']).error, 'path_traversal');
});

test('validateScopePaths: absolutní cesta odmítnuta', () => {
  const r = validateScopePaths(['/etc/passwd']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'absolute_path');
});

test('validateScopePaths: ~ home expansion odmítnut', () => {
  assert.equal(validateScopePaths(['~/secrets']).error, 'home_expansion');
});

test('validateScopePaths: .env odmítnut', () => {
  assert.equal(validateScopePaths(['.env']).error, 'forbidden_segment');
  assert.equal(validateScopePaths(['server/.env']).error, 'forbidden_segment');
});

test('validateScopePaths: .git odmítnut', () => {
  assert.equal(validateScopePaths(['.git']).error, 'forbidden_segment');
  assert.equal(validateScopePaths(['.git/config']).error, 'forbidden_segment');
});

test('validateScopePaths: node_modules odmítnut', () => {
  assert.equal(validateScopePaths(['node_modules']).error, 'forbidden_segment');
  assert.equal(validateScopePaths(['server/node_modules/pg']).error, 'forbidden_segment');
});

test('validateScopePaths: další citlivé soubory odmítnuty', () => {
  for (const bad of ['.ssh', '.aws', '.npmrc', '.netrc']) {
    assert.equal(validateScopePaths([bad]).error, 'forbidden_segment', `${bad} měl být odmítnut`);
  }
});

test('validateScopePaths: prázdný / non-string řádek odmítnut', () => {
  assert.equal(validateScopePaths(['']).error, 'empty');
  assert.equal(validateScopePaths(['   ']).error, 'empty');
  assert.equal(validateScopePaths([42]).error, 'not_a_string');
  assert.equal(validateScopePaths([null]).error, 'not_a_string');
});

test('validateScopePaths: null byte odmítnut', () => {
  assert.equal(validateScopePaths(['foo\0bar']).error, 'null_byte');
});

test('validateScopePaths: "." (celé repo) odmítnut', () => {
  assert.equal(validateScopePaths(['.']).error, 'whole_repo');
  assert.equal(validateScopePaths(['./']).error, 'whole_repo');
});

test('validateScopePaths: vstup není pole', () => {
  const r = validateScopePaths('src/');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_an_array');
});

test('validateScopePaths: case-insensitive forbidden segments', () => {
  assert.equal(validateScopePaths(['Node_Modules/pkg']).error, 'forbidden_segment');
  assert.equal(validateScopePaths(['.GIT/HEAD']).error, 'forbidden_segment');
});

// ─── checkDailyBudget ─────────────────────────────────────────────────────

function fakeQuery(rows) {
  return async () => ({ rows });
}

test('checkDailyBudget: nic se nestrávilo → allowed=true, remaining=limit', async () => {
  const q = fakeQuery([{ used: 0 }]);
  const r = await checkDailyBudget(q, { maxCostPerDayUsd: 20 });
  assert.equal(r.allowed, true);
  assert.equal(r.usedUsd, 0);
  assert.equal(r.limitUsd, 20);
  assert.equal(r.remainingUsd, 20);
});

test('checkDailyBudget: částečně použito', async () => {
  const q = fakeQuery([{ used: 7.5 }]);
  const r = await checkDailyBudget(q, { maxCostPerDayUsd: 20 });
  assert.equal(r.allowed, true);
  assert.equal(r.usedUsd, 7.5);
  assert.equal(r.remainingUsd, 12.5);
});

test('checkDailyBudget: vyčerpáno → allowed=false', async () => {
  const q = fakeQuery([{ used: 20.0 }]);
  const r = await checkDailyBudget(q, { maxCostPerDayUsd: 20 });
  assert.equal(r.allowed, false);
  assert.equal(r.remainingUsd, 0);
  assert.ok(r.reason?.includes('Denní limit'));
});

test('checkDailyBudget: překročeno → remaining = 0 (ne záporné)', async () => {
  const q = fakeQuery([{ used: 25 }]);
  const r = await checkDailyBudget(q, { maxCostPerDayUsd: 20 });
  assert.equal(r.allowed, false);
  assert.equal(r.remainingUsd, 0);
});

// ─── checkTaskBudget ──────────────────────────────────────────────────────

test('checkTaskBudget: task neexistuje → throw', async () => {
  const q = async () => ({ rows: [] });
  await assert.rejects(
    () => checkTaskBudget(q, { maxCostPerTaskUsd: 2 }, 999),
    /neexistuje/
  );
});

test('checkTaskBudget: validní taskId, žádný útrata', async () => {
  const q = async () => ({ rows: [{ ai_cost_usd: 0 }] });
  const r = await checkTaskBudget(q, { maxCostPerTaskUsd: 2 }, 1);
  assert.equal(r.allowed, true);
  assert.equal(r.remainingUsd, 2);
});

test('checkTaskBudget: task vyčerpal limit', async () => {
  const q = async () => ({ rows: [{ ai_cost_usd: 2.0 }] });
  const r = await checkTaskBudget(q, { maxCostPerTaskUsd: 2 }, 5);
  assert.equal(r.allowed, false);
  assert.ok(r.reason?.includes('Limit na task'));
});

test('checkTaskBudget: neplatný taskId', async () => {
  const q = async () => ({ rows: [] });
  await assert.rejects(() => checkTaskBudget(q, { maxCostPerTaskUsd: 2 }, 0), /kladné celé/);
  await assert.rejects(() => checkTaskBudget(q, { maxCostPerTaskUsd: 2 }, -3), /kladné celé/);
  await assert.rejects(() => checkTaskBudget(q, { maxCostPerTaskUsd: 2 }, 1.5), /kladné celé/);
});

// ─── isAllowedBranch ──────────────────────────────────────────────────────

test('isAllowedBranch: branch začíná povoleným prefixem', () => {
  assert.equal(isAllowedBranch('claude/fix-footer', 'claude/'), true);
});

test('isAllowedBranch: branch mimo prefix odmítnut', () => {
  assert.equal(isAllowedBranch('main', 'claude/'), false);
  assert.equal(isAllowedBranch('feature/x', 'claude/'), false);
});

test('isAllowedBranch: nebezpečné znaky odmítnuty', () => {
  assert.equal(isAllowedBranch('claude/fix..weird', 'claude/'), false);
  assert.equal(isAllowedBranch('claude/with space', 'claude/'), false);
  assert.equal(isAllowedBranch('-claude/dash', 'claude/'), false);
});

test('isAllowedBranch: prázdné inputy', () => {
  assert.equal(isAllowedBranch('', 'claude/'), false);
  assert.equal(isAllowedBranch('claude/x', ''), false);
});
