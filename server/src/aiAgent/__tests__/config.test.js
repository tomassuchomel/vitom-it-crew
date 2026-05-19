// node:test – běh: `npm test --prefix server` z root nebo `npm test` v server/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentConfig, validateAgentConfig, describeAgentConfig } from '../config.js';

test('config: vypnutý agent → enabled=false, validace projde i bez klíčů', () => {
  const cfg = loadAgentConfig({});
  assert.equal(cfg.enabled, false);
  const v = validateAgentConfig(cfg);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('config: AI_AGENT_ENABLED="false" stále vypnuto', () => {
  const cfg = loadAgentConfig({ AI_AGENT_ENABLED: 'false' });
  assert.equal(cfg.enabled, false);
});

test('config: AI_AGENT_ENABLED="true" zapnuto, ale chybějící klíče → validace selže', () => {
  const cfg = loadAgentConfig({ AI_AGENT_ENABLED: 'true' });
  assert.equal(cfg.enabled, true);
  const v = validateAgentConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('ANTHROPIC_API_KEY')));
  assert.ok(v.errors.some(e => e.includes('GITHUB_TOKEN')));
  assert.ok(v.errors.some(e => e.includes('AI_AGENT_WORKDIR')));
});

test('config: kompletní zapnutí prochází validací', () => {
  const cfg = loadAgentConfig({
    AI_AGENT_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    AI_AGENT_WORKDIR: '/tmp/agent',
    AI_AGENT_ALLOWED_BRANCHES_PREFIX: 'claude/',
    GITHUB_TOKEN: 'ghp_xxx',
    AI_AGENT_MAX_COST_PER_TASK_USD: '1.50',
    AI_AGENT_MAX_COST_PER_DAY_USD: '15',
  });
  const v = validateAgentConfig(cfg);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(cfg.maxCostPerTaskUsd, 1.5);
  assert.equal(cfg.maxCostPerDayUsd, 15);
});

test('config: defaultní limity pokud nezadané', () => {
  const cfg = loadAgentConfig({ AI_AGENT_ENABLED: 'false' });
  assert.equal(cfg.maxCostPerTaskUsd, 2.0);
  assert.equal(cfg.maxCostPerDayUsd, 20.0);
  assert.equal(cfg.allowedBranchesPrefix, 'claude/');
});

test('config: task limit > daily limit → validace selže', () => {
  const cfg = loadAgentConfig({
    AI_AGENT_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'k',
    AI_AGENT_WORKDIR: '/tmp',
    GITHUB_TOKEN: 't',
    AI_AGENT_MAX_COST_PER_TASK_USD: '50',
    AI_AGENT_MAX_COST_PER_DAY_USD: '20',
  });
  const v = validateAgentConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('vyšší než denní')));
});

test('config: branch prefix bez koncového lomítka → chyba', () => {
  const cfg = loadAgentConfig({
    AI_AGENT_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'k',
    AI_AGENT_WORKDIR: '/tmp',
    GITHUB_TOKEN: 't',
    AI_AGENT_ALLOWED_BRANCHES_PREFIX: 'claude',
  });
  const v = validateAgentConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('lomítkem')));
});

test('describeAgentConfig: nikdy nevrací hodnoty klíčů', () => {
  const cfg = loadAgentConfig({
    AI_AGENT_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'sk-ant-SUPER-SECRET',
    GITHUB_TOKEN: 'ghp_SUPER-SECRET',
    AI_AGENT_WORKDIR: '/tmp/agent',
  });
  const desc = describeAgentConfig(cfg);
  const json = JSON.stringify(desc);
  assert.equal(json.includes('SUPER-SECRET'), false, 'popis nesmí obsahovat tajné hodnoty');
  assert.equal(desc.has_anthropic_key, true);
  assert.equal(desc.has_github_token, true);
  assert.equal(desc.work_dir_set, true);
});
