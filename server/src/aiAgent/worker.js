// Hlavní worker loop AI agenta. Zatím skeleton – neprovádí skutečné volání Claude.
//
// Tok per task:
//   1) pickne queued task z TaskQueue
//   2) zkontroluje denní + task budget (safety.js)
//   3) zvaliduje scope_paths (safety.js)
//   4) přepne stav: queued → planning (StateMachine)
//   5) vytvoří worktree (GitManager)
//   6) zapíše placeholder do activityLog ("agent by tu pracoval")
//   7) přepne stav: planning → implementing → in_review
//   8) NEČISTÍ worktree – ten zůstává pro lidskou review (cleanupWorktree
//      je expliticky volán až při done/failed v budoucnu)
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

    // 5) Sestav bundle (placeholder – skutečné volání agenta tu zatím není)
    try {
      const bundle = await assembler.assemble(task.id);
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

    // 6) PLACEHOLDER – tady by Claude pracoval. Zatím jen zapíšeme co by udělal.
    await log.record(task.id, 'placeholder_work', {
      note: 'agent by tu pracoval – kostra workeru, skutečné Claude volání zatím není',
      worktreePath: worktree.worktreePath,
    });

    // 7) planning → implementing → in_review
    await transitionStatus({ q: query, log }, task.id, 'planning', 'implementing');
    await transitionStatus({ q: query, log }, task.id, 'implementing', 'in_review', {
      note: 'skeleton run – diff zatím prázdný',
    });
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
