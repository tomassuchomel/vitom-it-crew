// API endpointy pro AI agenta:
//   GET  /api/ai-agent/preflight             – globální config check + worker heartbeat
//   GET  /api/ai-agent/preflight/:taskId     – per-task preflight (config + project repo_url + task state)
//   POST /api/tasks/:taskId/enqueue          – zařadí task do fronty (idle → queued)
//   GET  /api/tasks/:taskId/ai-status        – status + activity timeline
//
// Endpoints volá frontend, aby:
//   1. Před uložením AI úkolu varoval uživatele: „chybí repo_url / token / worker neběží"
//   2. Po uložení nabídl tlačítko „Spustit Claude" které volá enqueue
//   3. V detailu úkolu ukázal činnost agenta (activity log) a stav (badge)

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';
import { agentConfig, validateAgentConfig, describeAgentConfig } from '../aiAgent/config.js';
import { preflightTask } from '../aiAgent/preflight.js';

const router = Router();

// Stáří v ms, po kterém považujeme worker za "pravděpodobně mrtvý",
// pokud má frontu queued tasků.
const WORKER_HEARTBEAT_MAX_MS = 5 * 60 * 1000; // 5 minut

/**
 * Vrátí globální config status + indikátor, zda worker pravděpodobně běží.
 *
 * UI ho volá při otevření AI panelu / pravidelně, aby zobrazila banner
 * „AI není nakonfigurované" nebo „Worker neběží" hned, bez čekání na úkol.
 */
router.get('/preflight', requireAuth, async (req, res) => {
  if (!can.seeAllHours(req.user)) return res.status(403).json({ error: 'forbidden' });

  const v = validateAgentConfig(agentConfig);
  const desc = describeAgentConfig(agentConfig);

  // Worker heartbeat – kdy byla naposledy zapsaná aktivita
  let lastActivity = null;
  let workerLikelyAlive = false;
  try {
    const r = await query(`SELECT MAX(created_at) AS last FROM ai_agent_activity`);
    lastActivity = r.rows[0]?.last || null;
    if (lastActivity) {
      workerLikelyAlive = (Date.now() - new Date(lastActivity).getTime()) < WORKER_HEARTBEAT_MAX_MS;
    }
  } catch { /* tabulka může neexistovat při prvním deploy – neházíme */ }

  // Kolik tasků čeká ve frontě
  let queuedCount = 0;
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS c FROM tasks WHERE ai_status = 'queued' AND ai_assignee = TRUE`
    );
    queuedCount = r.rows[0]?.c ?? 0;
  } catch { /* ignore */ }

  // Sestav lidsky čitelné issues pro UI banner
  const issues = [];
  if (!agentConfig.enabled) {
    issues.push({
      severity: 'error',
      code: 'agent_disabled',
      message: 'AI agent je vypnutý. V server/.env nastav AI_AGENT_ENABLED=true a restartuj worker.',
    });
  }
  for (const e of v.errors) {
    issues.push({ severity: 'error', code: 'config_invalid', message: e });
  }
  if (agentConfig.enabled && v.ok && !workerLikelyAlive && queuedCount > 0) {
    issues.push({
      severity: 'warning',
      code: 'worker_idle',
      message: `Worker neviděl aktivitu déle než 5 minut, ale ve frontě je ${queuedCount} úkol(ů). Možná neběží — spusť „npm run ai-worker" v server/.`,
    });
  }
  if (agentConfig.enabled && v.ok && !lastActivity) {
    issues.push({
      severity: 'info',
      code: 'worker_never_ran',
      message: 'Worker zatím nikdy nezapsal aktivitu. Spusť ho příkazem „npm run ai-worker" v adresáři server/.',
    });
  }

  res.json({
    enabled: agentConfig.enabled,
    config_valid: v.ok,
    config: desc,           // booleany — nikdy nevrací hodnoty klíčů
    last_activity: lastActivity,
    worker_likely_alive: workerLikelyAlive,
    queued_count: queuedCount,
    issues,
    ready: agentConfig.enabled && v.ok && issues.filter(i => i.severity === 'error').length === 0,
  });
});

/**
 * Per-task preflight – kontroluje config + projekt + stav úkolu.
 * Frontend ho volá před zobrazením „Spustit Claude" tlačítka, aby ho mohl
 * disablovat s konkrétním důvodem.
 */
router.get('/preflight/:taskId', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: 'invalid_task_id' });
  }
  const pf = await preflightTask(taskId);
  if (pf.status === 404) return res.status(404).json({ error: 'not_found' });

  res.json({
    can_enqueue: pf.ok,
    issues: pf.issues,
    task_state: pf.task.ai_status,
    iteration_count: Number(pf.task.iteration_count || 0),
    max_iterations: Number(pf.task.max_iterations || 3),
  });
});

/**
 * Zařadí task do fronty pro AI workera. Před zařazením spustí stejnou
 * preflight kontrolu jako GET /preflight/:taskId – vrátí 400 s issues
 * pokud něco brání.
 */
router.post('/tasks/:taskId/enqueue', requireAuth, async (req, res) => {
  if (!can.createTasks(req.user)) return res.status(403).json({ error: 'forbidden' });
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: 'invalid_task_id' });
  }

  const pf = await preflightTask(taskId);
  if (pf.status === 404) return res.status(404).json({ error: 'not_found' });
  if (!pf.ok) {
    return res.status(400).json({ error: 'preflight_failed', issues: pf.issues });
  }
  const task = pf.task;

  // Resetuj iteration_count při novém spuštění z terminálního stavu
  const resetIter = ['idle', 'done', 'failed', 'needs_human'].includes(task.ai_status);
  if (resetIter) {
    await query(`UPDATE tasks SET iteration_count = 0 WHERE id = $1`, [taskId]);
  }
  // Transition na queued (trigger validuje legality)
  await query(`UPDATE tasks SET ai_status = 'queued' WHERE id = $1`, [taskId]);

  // Log
  await query(
    `INSERT INTO ai_agent_activity (task_id, action, details)
     VALUES ($1, 'enqueued_by_user', $2::jsonb)`,
    [taskId, JSON.stringify({ user_id: req.user.id, previous_state: task.ai_status, reset_iter: resetIter })]
  );

  res.json({ ok: true, ai_status: 'queued', iteration_count: resetIter ? 0 : task.iteration_count });
});

/**
 * Vrátí aktuální AI stav + activity timeline pro daný task.
 * UI to volá v detail modalu, polluje po enqueue, aby user viděl postup.
 */
router.get('/tasks/:taskId/ai-status', requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: 'invalid_task_id' });
  }
  const tr = await query(
    `SELECT t.id, t.ai_status, t.ai_status_updated_at, t.iteration_count, t.max_iterations,
            t.ai_pr_url, t.ai_cost_usd, t.ai_assignee, t.execution_mode,
            p.repo_url, p.name AS project_name
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1`,
    [taskId]
  );
  const task = tr.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });

  // Posledních 50 activity entries
  const ar = await query(
    `SELECT id, action, details, cost_usd, created_at
     FROM ai_agent_activity
     WHERE task_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [taskId]
  );

  res.json({
    task: {
      id: task.id,
      ai_status: task.ai_status,
      ai_status_updated_at: task.ai_status_updated_at,
      iteration_count: Number(task.iteration_count || 0),
      max_iterations: Number(task.max_iterations || 3),
      ai_pr_url: task.ai_pr_url,
      ai_cost_usd: Number(task.ai_cost_usd || 0),
      ai_assignee: task.ai_assignee,
      execution_mode: task.execution_mode,
      project_name: task.project_name,
      repo_url: task.repo_url,
    },
    activity: ar.rows,
  });
});

export default router;
