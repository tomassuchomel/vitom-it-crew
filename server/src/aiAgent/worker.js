// Hlavní worker loop AI agenta.
//
// Tok per task:
//   1) pickne queued task z TaskQueue
//   2) zkontroluje denní + task budget (safety.js)
//   3) zvaliduje scope_paths (safety.js)
//   4) přepne stav: queued → planning (StateMachine)
//   5) vytvoří worktree (GitManager)
//   6) sestaví TaskBundle (ContextAssembler)
//   7) spustí ImplementationAgent (Claude API loop s tools)
//   8) Pokud agent skončil úspěšně:
//        – pushne branch (NIKDY do main)
//        – vytvoří draft PR přes GitHub API
//        – uloží ai_pr_url, ai_cost_usd, structured output do activityLogu
//        – přepne stav: planning → implementing → in_review
//      Pokud neúspěch:
//        – přepne stav na failed / needs_human (podle kódu chyby)
//   9) NEČISTÍ worktree – ten zůstává pro lidskou review
//
// Graceful shutdown:
//   – SIGINT/SIGTERM zastaví polling
//   – pokud zrovna nějaký task běží, dokončí ho, pak skončí
//   – uvolní DB pool
//
// Loop intervalu: konfigurovatelný (default 5s). Mezi taskama v rámci jednoho
// pollu spí jen krátce.

import { query, pool } from '../db.js';
import { agentConfig, validateAgentConfig, describeAgentConfig } from './config.js';
import { checkDailyBudget, checkTaskBudget, validateScopePaths } from './safety.js';
import { canTransition, validateTransition } from './stateMachine.js';
import { createTaskQueue } from './taskQueue.js';
import { createContextAssembler } from './contextAssembler.js';
import { createGitManager } from './gitManager.js';
import { createActivityLog } from './activityLog.js';
import { runImplementationAgent } from './implementationAgent.js';
import { createPullRequest, parseGitHubRemote } from './githubApi.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Změna stavu úkolu se zápisem do activityLogu (zachování invariantů).
 */
async function transitionStatus({ q, log }, taskId, from, to, details = {}) {
  const v = validateTransition(from, to);
  if (!v.ok) {
    await log.record(taskId, 'invalid_transition', { from, to, error: v.error, allowed: v.allowed });
    throw new Error(`invalid transition ${from} → ${to} (allowed: ${v.allowed?.join(', ')})`);
  }
  await q(`UPDATE tasks SET ai_status = $1 WHERE id = $2`, [to, taskId]);
  await log.record(taskId, 'state_changed', { from, to, ...details });
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config]
 * @param {object} [opts.queue]
 * @param {object} [opts.assembler]
 * @param {object} [opts.git]
 * @param {object} [opts.log]
 * @param {number} [opts.pollIntervalMs=5000]
 */
export function createWorker(opts = {}) {
  const config = opts.config || agentConfig;
  const queue = opts.queue || createTaskQueue();
  const assembler = opts.assembler || createContextAssembler({ repoRoot: opts.repoRoot });
  const git = opts.git || createGitManager({
    repoRoot: opts.repoRoot || process.cwd(),
    workDir: config.workDir || '/tmp/vitom-ai-agent',
    branchPrefix: config.allowedBranchesPrefix,
  });
  const log = opts.log || createActivityLog();
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;

  let running = false;
  let stopRequested = false;
  /** @type {Promise<void>|null} */
  let currentTaskPromise = null;

  /**
   * Zpracování jednoho tasku – jakákoliv chyba je zachycená a převedena na 'failed'.
   */
  async function processTask(task) {
    // 1) Budgety
    const daily = await checkDailyBudget(query, config);
    if (!daily.allowed) {
      await log.record(task.id, 'budget_exhausted', { kind: 'daily', ...daily });
      await transitionStatus({ q: query, log }, task.id, 'queued', 'needs_human', { reason: 'daily_budget' });
      return;
    }
    const taskBudget = await checkTaskBudget(query, config, task.id);
    if (!taskBudget.allowed) {
      await log.record(task.id, 'budget_exhausted', { kind: 'task', ...taskBudget });
      await transitionStatus({ q: query, log }, task.id, 'queued', 'needs_human', { reason: 'task_budget' });
      return;
    }

    // 2) Validace scope_paths (defensive – už by mělo být zvalidované při uložení)
    const scopeCheck = validateScopePaths(task.scope_paths);
    if (!scopeCheck.ok) {
      await log.record(task.id, 'invalid_scope_paths', scopeCheck);
      await transitionStatus({ q: query, log }, task.id, 'queued', 'failed', { reason: 'scope_paths' });
      return;
    }

    // 3) queued → planning
    await transitionStatus({ q: query, log }, task.id, 'queued', 'planning');

    // 4) Worktree
    let worktree;
    try {
      worktree = await git.createWorktree(task.id);
      await log.record(task.id, 'worktree_created', {
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
      });
    } catch (err) {
      await log.record(task.id, 'worktree_failed', { error: err.message, code: err.code });
      await transitionStatus({ q: query, log }, task.id, 'planning', 'failed', { reason: 'worktree' });
      return;
    }

    // 5) Sestav bundle
    let bundle;
    try {
      bundle = await assembler.assemble(task.id);
      await log.record(task.id, 'context_assembled', {
        comments_count: bundle.comments.length,
        has_parent: !!bundle.parent,
        has_claude_md: bundle.claudeMd.source === 'file',
      });
    } catch (err) {
      await log.record(task.id, 'context_assembly_failed', { error: err.message });
      await transitionStatus({ q: query, log }, task.id, 'planning', 'failed', { reason: 'context' });
      return;
    }

    // 6) Spusť ImplementationAgent – Claude přes Anthropic API s tools
    await transitionStatus({ q: query, log }, task.id, 'planning', 'implementing');
    const remainingBudget = Math.min(daily.remainingUsd, taskBudget.remainingUsd);
    let agentResult;
    try {
      agentResult = await runImplementationAgent({
        task,
        bundle,
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        apiKey: config.anthropicApiKey,
        maxIterations: task.max_iterations || 8,
        maxCostUsd: remainingBudget,
      });
    } catch (err) {
      await log.record(task.id, 'agent_error', { error: err.message });
      await transitionStatus({ q: query, log }, task.id, 'implementing', 'failed', { reason: 'agent_error' });
      return;
    }

    await log.record(
      task.id,
      'agent_run_complete',
      {
        success: agentResult.success,
        iterations: agentResult.iterations,
        error: agentResult.error,
      },
      agentResult.costUsd
    );

    if (!agentResult.success) {
      const nextState = agentResult.error === 'budget_exhausted' || agentResult.error === 'max_iterations_reached'
        ? 'needs_human'
        : 'failed';
      await log.record(task.id, 'agent_summary', { summary: agentResult.summary || null });
      await transitionStatus({ q: query, log }, task.id, 'implementing', nextState, {
        reason: agentResult.error,
      });
      return;
    }

    // 7) Agent skončil úspěšně. Ulož strukturovaný výstup do logu.
    await log.record(task.id, 'agent_summary', { summary: agentResult.summary });

    // 8) Sanity check – jsou tu commity?
    let commitsAhead = 0;
    try {
      commitsAhead = await git.commitsAheadOfBase(task.id);
    } catch (err) {
      await log.record(task.id, 'commits_check_failed', { error: err.message });
    }
    if (commitsAhead === 0) {
      await log.record(task.id, 'no_commits', { note: 'agent neprovedl žádné commity – nepushuju, čeká člověk' });
      await transitionStatus({ q: query, log }, task.id, 'implementing', 'needs_human', { reason: 'no_commits' });
      return;
    }

    // 9) Push branch (NIKDY do main – GitManager hlídá)
    let pushed;
    try {
      pushed = await git.pushBranch(task.id);
      await log.record(task.id, 'branch_pushed', { branch: pushed.branch });
    } catch (err) {
      await log.record(task.id, 'push_failed', { error: err.message });
      await transitionStatus({ q: query, log }, task.id, 'implementing', 'needs_human', { reason: 'push_failed' });
      return;
    }

    // 10) Vytvoř draft PR
    try {
      const remote = await detectRemote(worktree.worktreePath);
      const { owner, repo } = parseGitHubRemote(remote);
      const pr = await createPullRequest({
        token: config.githubToken,
        owner, repo,
        head: pushed.branch,
        base: git.baseBranch,
        title: `[claude] ${task.title}`,
        body: buildPrBody(task, agentResult.summary),
        draft: true,
      });
      await query(`UPDATE tasks SET ai_pr_url = $1 WHERE id = $2`, [pr.html_url, task.id]);
      await log.record(task.id, 'pr_created', { pr_url: pr.html_url, number: pr.number });
    } catch (err) {
      await log.record(task.id, 'pr_creation_failed', { error: err.message });
      // PR selhal, ale push prošel – uživatel může otevřít PR ručně. needs_human.
      await transitionStatus({ q: query, log }, task.id, 'implementing', 'needs_human', { reason: 'pr_creation_failed' });
      return;
    }

    // 11) implementing → in_review
    await transitionStatus({ q: query, log }, task.id, 'implementing', 'in_review', {
      iterations: agentResult.iterations,
      cost_usd: Number(agentResult.costUsd.toFixed(4)),
    });
  }

  // Helper: zjisti origin remote URL z worktree (pro odvození owner/repo)
  async function detectRemote(worktreePath) {
    try {
      const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath });
      return stdout.trim();
    } catch (err) {
      throw new Error(`nelze zjistit origin remote: ${err.message}`);
    }
  }

  // Helper: sestaví PR body z task description + agent summary
  function buildPrBody(task, summary) {
    const lines = [
      `**Task #${task.id}:** ${task.title}`,
      '',
      task.description ? `## Zadání\n\n${task.description}\n` : '',
      summary ? `## Agent output\n\n${summary}` : '',
      '',
      '---',
      '_Vytvořeno autonomním Claude agentem. Před mergem zkontroluj diff a spuštěné testy._',
    ];
    return lines.filter(Boolean).join('\n');
  }

  async function tick() {
    const task = await queue.pickNext();
    if (!task) return;
    currentTaskPromise = (async () => {
      try {
        await processTask(task);
      } catch (err) {
        // Defensive – cokoli neodchyceného nemá zhroutit celý worker
        try {
          await log.record(task.id, 'worker_error', { error: err?.message || String(err) });
        } catch { /* nelze logovat – tichý fallback */ }
      } finally {
        currentTaskPromise = null;
      }
    })();
    await currentTaskPromise;
  }

  async function start() {
    if (running) return;
    const v = validateAgentConfig(config);
    if (!config.enabled) {
      throw new Error('AI_AGENT_ENABLED=false – worker se nespustí.');
    }
    if (!v.ok) {
      throw new Error('Nevalidní config: ' + v.errors.join('; '));
    }
    running = true;
    stopRequested = false;
    console.log('[ai-worker] startuje', JSON.stringify(describeAgentConfig(config)));

    while (!stopRequested) {
      try {
        await tick();
      } catch (err) {
        console.error('[ai-worker] tick error:', err?.message);
      }
      // Krátký sleep, ale dělitelný na menší kousky, aby SIGINT byl responzivní
      const slices = Math.max(1, Math.ceil(pollIntervalMs / 250));
      for (let i = 0; i < slices && !stopRequested; i++) await sleep(250);
    }

    // Pokud zrovna běží task, počkáme na něj
    if (currentTaskPromise) {
      console.log('[ai-worker] čekám na dokončení aktuálního tasku…');
      try { await currentTaskPromise; } catch { /* už zalogováno */ }
    }
    console.log('[ai-worker] končím čistě');
    running = false;
  }

  function stop() {
    stopRequested = true;
  }

  return { start, stop, _internals: { processTask, tick } };
}

/**
 * Nainstaluje SIGINT/SIGTERM handler, který worker zastaví, dokončí current
 * task a uzavře DB pool.
 */
export function installSignalHandlers(worker) {
  let already = false;
  const handler = (sig) => {
    if (already) {
      console.log(`[ai-worker] druhý ${sig}, vynucený exit`);
      process.exit(1);
    }
    already = true;
    console.log(`[ai-worker] dostal ${sig}, čekám na dokončení tasku…`);
    worker.stop();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

/**
 * Pohodlný entry-point. Po `start()` skončí čistě, uvolní pool a exit(0).
 */
export async function runWorker(opts) {
  const worker = createWorker(opts);
  installSignalHandlers(worker);
  try {
    await worker.start();
  } finally {
    try { await pool.end(); } catch { /* už zavřeno */ }
  }
}
