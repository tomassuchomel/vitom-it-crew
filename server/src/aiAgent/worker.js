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
import { runReviewerAgent, formatReviewComment } from './reviewerAgent.js';
import {
  createPullRequest, parseGitHubRemote,
  addPrComment, markPrReady, parsePullRequestUrl,
  findOpenPullRequest,
} from './githubApi.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

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

    // 4) Worktree – idempotent (re-run cyklus zachová existující)
    let worktree;
    try {
      worktree = await ensureWorktree(task);
      await log.record(task.id, 'worktree_ready', {
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        reused: !!worktree.reused,
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

    // 6) Re-run cyklus: pokud iteration_count > 0, načti poslední review feedback
    let previousReview = null;
    const currentIteration = Number(task.iteration_count || 0);
    if (currentIteration > 0) {
      previousReview = await loadLatestReview(task.id);
      await log.record(task.id, 'previous_review_loaded', {
        iteration: currentIteration,
        has_feedback: !!previousReview,
      });
    }

    // 7) Spusť ImplementationAgent
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
        previousReview,
      });
    } catch (err) {
      await log.record(task.id, 'agent_error', { error: err.message });
      await transitionStatus({ q: query, log }, task.id, 'implementing', 'failed', { reason: 'agent_error' });
      return;
    }

    // Ulož detailní stopu kroků agenta (tool_use, api_response, …) do DB,
    // ať uživatel v UI vidí, co Claude konkrétně dělal. Bez tohoto je logika
    // agenta neviditelná – jen finalní "úspěch / selhání".
    for (const ev of (agentResult.log || [])) {
      if (ev.event === 'tool_use') {
        await log.record(task.id, 'tool_use', {
          iteration: ev.iteration,
          tool: ev.name,
          input: ev.input_summary,
        });
      } else if (ev.event === 'api_response') {
        await log.record(task.id, 'api_response', {
          iteration: ev.iteration,
          stop_reason: ev.stop_reason,
          input_tokens: ev.usage?.input_tokens,
          output_tokens: ev.usage?.output_tokens,
        }, ev.cost);
      } else if (ev.event === 'end_turn_without_done' || ev.event === 'unexpected_stop' || ev.event === 'api_error') {
        await log.record(task.id, 'agent_'+ev.event, ev);
      }
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

    // 10) Vytvoř (nebo aktualizuj) PR. Pro re-run cyklus už PR existuje –
    //     stačí push commitů z předchozího kroku, GitHub PR se sám updatuje.
    const existingPrUrl = await getTaskPrUrl(task.id);
    let prInfo = null;
    if (!existingPrUrl) {
      try {
        const remote = await detectRemote(worktree.worktreePath);
        const { owner, repo } = parseGitHubRemote(remote);

        // H-5: idempotent PR creation. Pokud worker spadl mezi push a UPDATE
        // tasks.ai_pr_url, PR už může existovat na GitHubu. Najdi ho přes API
        // místo abychom POST a dostali 422.
        let pr = await findOpenPullRequest({
          token: config.githubToken, owner, repo,
          head: pushed.branch, base: git.baseBranch,
        });
        if (pr) {
          await log.record(task.id, 'pr_already_exists', { pr_url: pr.html_url, number: pr.number });
        } else {
          pr = await createPullRequest({
            token: config.githubToken,
            owner, repo,
            head: pushed.branch,
            base: git.baseBranch,
            title: `[claude] ${task.title}`,
            body: buildPrBody(task, agentResult.summary),
            draft: true,
          });
          await log.record(task.id, 'pr_created', { pr_url: pr.html_url, number: pr.number });
        }
        await query(`UPDATE tasks SET ai_pr_url = $1 WHERE id = $2`, [pr.html_url, task.id]);
        prInfo = { ...pr, owner, repo };
      } catch (err) {
        await log.record(task.id, 'pr_creation_failed', { error: err.message });
        await transitionStatus({ q: query, log }, task.id, 'implementing', 'needs_human', { reason: 'pr_creation_failed' });
        return;
      }
    } else {
      // Re-run – PR už existuje, jen napiš komentář že je tu nová iterace.
      try {
        const { owner, repo, number } = parsePullRequestUrl(existingPrUrl);
        prInfo = { html_url: existingPrUrl, number, owner, repo };
        await addPrComment({
          token: config.githubToken, owner, repo, issueNumber: number,
          body: `🔁 Iterace ${currentIteration + 1}: nový push s opravami podle předchozího review. Spouštím re-review…`,
        });
        await log.record(task.id, 'reiterate_comment_added', { pr_url: existingPrUrl });
      } catch (err) {
        await log.record(task.id, 'reiterate_comment_failed', { error: err.message });
        // Pokračujeme i tak – komentář selhal, ale review může běžet.
      }
    }

    // 11) implementing → in_review
    await transitionStatus({ q: query, log }, task.id, 'implementing', 'in_review', {
      iterations: agentResult.iterations,
      cost_usd: Number(agentResult.costUsd.toFixed(4)),
    });

    // 12) Spusť reviewera a podle verdictu rozhodni další stav
    await runReviewCycle({ task, worktree, prInfo, currentIteration });
  }

  /**
   * Reviewer cyklus: shromáždí kontext, spustí reviewerAgent, podle verdictu
   * rozhodne next state (done / needs_changes → queued / needs_human).
   */
  async function runReviewCycle({ task, worktree, prInfo, currentIteration }) {
    // H-9: reviewer budget gate – jeden review může utratit až ~$0.70 (Opus 4.7,
    // 100K vstup + 8K výstup). Pokud daily zbývá < $1, neriskuj.
    const dailyAfter = await checkDailyBudget(query, config);
    if (dailyAfter.remainingUsd < 1.0) {
      await log.record(task.id, 'reviewer_budget_too_low', { remainingUsd: dailyAfter.remainingUsd });
      await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_human', {
        reason: 'budget_too_low_for_review',
      });
      return;
    }

    // Sběr inputů pro reviewera
    let diff = '';
    try {
      diff = await git.getDiff(task.id);
    } catch (err) {
      await log.record(task.id, 'diff_collection_failed', { error: err.message });
    }
    const planContent = await readPlanIfExists(worktree.worktreePath);
    const testOutput = await runProjectTests(worktree.worktreePath);
    const lintOutput = null; // zatím neimplementováno – placeholder pro budoucí lint pipeline

    await log.record(task.id, 'review_started', {
      diff_chars: diff.length,
      has_plan: !!planContent,
      test_output_chars: testOutput?.length || 0,
    });

    let agentSummary = null;
    try {
      const s = await query(
        `SELECT details FROM ai_agent_activity WHERE task_id = $1 AND action = 'agent_summary'
         ORDER BY created_at DESC LIMIT 1`,
        [task.id]
      );
      agentSummary = s.rows[0]?.details?.summary || null;
    } catch { /* nepodstatné pro běh reviewera */ }

    let reviewResult;
    try {
      reviewResult = await runReviewerAgent({
        task,
        diff,
        testOutput,
        lintOutput,
        planContent,
        implementerSummary: agentSummary,
        previousReviewCount: currentIteration,
        apiKey: config.anthropicApiKey,
      });
    } catch (err) {
      await log.record(task.id, 'reviewer_error', { error: err.message });
      await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_human', { reason: 'reviewer_crashed' });
      return;
    }

    await log.record(
      task.id,
      'review_complete',
      {
        verdict: reviewResult.review?.verdict || null,
        error: reviewResult.error,
        // Plný review JSON ukládáme do details, ať ho další iterace najde
        review: reviewResult.review,
      },
      reviewResult.costUsd
    );

    if (!reviewResult.review || reviewResult.error) {
      // Parse/api error – nelze rozhodnout, eskalace
      await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_human', {
        reason: reviewResult.error || 'reviewer_no_verdict',
      });
      return;
    }

    // Komentář na PR (i pro approve – uvidí ho lidé)
    const commentBody = formatReviewComment(reviewResult.review, { iteration: currentIteration + 1 });
    if (prInfo && prInfo.number && prInfo.owner && prInfo.repo) {
      try {
        await addPrComment({
          token: config.githubToken,
          owner: prInfo.owner, repo: prInfo.repo,
          issueNumber: prInfo.number, body: commentBody,
        });
      } catch (err) {
        await log.record(task.id, 'review_comment_failed', { error: err.message });
      }
    }

    // Routing podle verdictu
    switch (reviewResult.review.verdict) {
      case 'approve': {
        // Draft → ready
        if (prInfo) {
          try {
            await markPrReady({
              token: config.githubToken,
              owner: prInfo.owner, repo: prInfo.repo, number: prInfo.number,
            });
            await log.record(task.id, 'pr_marked_ready', { pr_url: prInfo.html_url });
          } catch (err) {
            await log.record(task.id, 'pr_mark_ready_failed', { error: err.message });
          }
        }
        await transitionStatus({ q: query, log }, task.id, 'in_review', 'done', {
          iteration: currentIteration + 1,
        });
        // M-2: cleanup worktree po úspěšném done – PR drží branch na originu,
        // lokální worktree je už nepotřebná. Failed/needs_human worktree
        // necháme pro forenziku.
        try {
          await git.cleanupWorktree(task.id);
          await log.record(task.id, 'worktree_cleaned', {});
        } catch (err) {
          await log.record(task.id, 'worktree_cleanup_failed', { error: err.message });
        }
        return;
      }
      case 'request_changes': {
        const newIter = currentIteration + 1;
        await query(`UPDATE tasks SET iteration_count = $1 WHERE id = $2`, [newIter, task.id]);
        await log.record(task.id, 'iteration_incremented', { from: currentIteration, to: newIter });
        const maxIter = Number(task.max_iterations || 3);
        if (newIter >= maxIter) {
          // Vyčerpané iterace → eskalace na člověka
          await log.record(task.id, 'iterations_exhausted', { max: maxIter, used: newIter });
          await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_human', {
            reason: 'iterations_exhausted',
          });
        } else {
          // Re-queue: in_review → needs_changes → queued (povolené přechody)
          await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_changes');
          await transitionStatus({ q: query, log }, task.id, 'needs_changes', 'queued', {
            iteration: newIter,
          });
        }
        return;
      }
      case 'reject': {
        await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_human', {
          reason: 'reviewer_rejected',
        });
        return;
      }
      default: {
        await log.record(task.id, 'unknown_verdict', { verdict: reviewResult.review.verdict });
        await transitionStatus({ q: query, log }, task.id, 'in_review', 'needs_human', {
          reason: 'unknown_verdict',
        });
      }
    }
  }

  // Helper: vrátí (vytvoří, nebo reusne) worktree pro task.
  // Pokud worktree path už existuje, vrátíme ho beze změny – re-run cyklus.
  async function ensureWorktree(task) {
    const wt = git.getWorktreePath(task.id);
    try {
      await fs.access(wt);
      // Path existuje → reuse
      return { worktreePath: wt, branch: git.getBranchName(task.id), reused: true };
    } catch {
      // Path neexistuje → vytvoř nový worktree
      return await git.createWorktree(task.id);
    }
  }

  // Helper: zjisti origin remote URL z worktree
  async function detectRemote(worktreePath) {
    try {
      const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath });
      return stdout.trim();
    } catch (err) {
      throw new Error(`nelze zjistit origin remote: ${err.message}`);
    }
  }

  // Helper: vrátí ai_pr_url tasku (může být null pro první iteraci)
  async function getTaskPrUrl(taskId) {
    const r = await query(`SELECT ai_pr_url FROM tasks WHERE id = $1`, [taskId]);
    return r.rows[0]?.ai_pr_url || null;
  }

  // Helper: načte PLAN.md z worktree, pokud existuje
  async function readPlanIfExists(worktreePath) {
    try {
      return await fs.readFile(path.join(worktreePath, 'PLAN.md'), 'utf8');
    } catch {
      return null;
    }
  }

  // Helper: spustí projekt testy v worktree, vrátí kombinovaný stdout+stderr.
  // Selže-li, vrátí output včetně error message – reviewer to musí vidět.
  async function runProjectTests(worktreePath) {
    try {
      const { stdout, stderr } = await execFileP('npm', ['test', '--prefix', 'server'], {
        cwd: worktreePath, maxBuffer: 20 * 1024 * 1024, timeout: 120_000,
      });
      return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
    } catch (err) {
      // npm test failed (exit != 0) – výstup je v err.stdout / err.stderr
      return `EXIT ${err.code ?? '?'}\nSTDOUT:\n${err.stdout || ''}\n\nSTDERR:\n${err.stderr || err.message}`;
    }
  }

  // Helper: načte poslední review feedback pro task jako čitelný markdown
  async function loadLatestReview(taskId) {
    const r = await query(
      `SELECT details FROM ai_agent_activity
       WHERE task_id = $1 AND action = 'review_complete' AND details ? 'review'
       ORDER BY created_at DESC LIMIT 1`,
      [taskId]
    );
    const review = r.rows[0]?.details?.review;
    if (!review) return null;
    return formatReviewComment(review);
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

  /**
   * H-4: recovery scanner – při startu workeru (a periodicky) přesune tasky
   * uvíznuté > 15 min v non-terminal stavech do needs_human, ať mohou být
   * dál řešeny člověkem. Bez tohohle by crash workeru znamenal navždy stuck task.
   */
  async function recoverStuckTasks() {
    const stuckMin = 15;
    const r = await query(
      `SELECT id, ai_status, ai_status_updated_at FROM tasks
       WHERE ai_assignee = TRUE
         AND ai_status IN ('planning', 'implementing', 'in_review')
         AND ai_status_updated_at < NOW() - INTERVAL '${stuckMin} minutes'`
    );
    for (const t of r.rows) {
      try {
        await log.record(t.id, 'stuck_task_detected', {
          previous_status: t.ai_status,
          stuck_since: t.ai_status_updated_at,
        });
        await transitionStatus({ q: query, log }, t.id, t.ai_status, 'needs_human', {
          reason: 'stuck_after_crash',
        });
      } catch (err) {
        console.error('[ai-worker] recovery error for task', t.id, err.message);
      }
    }
    if (r.rows.length > 0) {
      console.log(`[ai-worker] recovery: ${r.rows.length} stuck tasks moved to needs_human`);
    }
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

    // H-4: recovery scanner – uvolnit stuck tasky z předchozího crashe
    try { await recoverStuckTasks(); }
    catch (err) { console.error('[ai-worker] recovery scan failed:', err.message); }

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
