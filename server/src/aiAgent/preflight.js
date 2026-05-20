// Sdílená preflight logika – zda se konkrétní task dá zařadit AI agentovi.
//
// Volá se z:
//   - GET  /api/ai-agent/preflight/:taskId   (UI to volá před zobrazením tlačítka)
//   - POST /api/tasks/:taskId/enqueue        (server validuje znovu před vložením do fronty)
//   - POST /api/tasks  + PUT /api/tasks/:id  (auto-enqueue při execution_mode='auto')
//
// Vrací { issues, can_enqueue, errors }:
//   - issues: pole { severity: 'error'|'warning'|'info', code, message }
//   - errors: jen ty s severity='error'
//   - can_enqueue: errors.length === 0

import { query } from '../db.js';
import { agentConfig, validateAgentConfig } from './config.js';

// Stavy, ze kterých se task dá (znovu) zařadit do fronty.
// 'queued' nebo 'running' znamená, že už ho agent zpracovává.
export const RE_ENQUEUEABLE_STATES = ['idle', 'done', 'failed', 'needs_human', 'needs_changes'];

/**
 * Preflight pro konkrétní task. Načítá projekt z DB (kvůli repo_url).
 * @param {number} taskId
 * @returns {Promise<{ ok: boolean, issues: object[], task: object|null, status: number }>}
 *   status = HTTP status code (404 pokud task neexistuje)
 */
export async function preflightTask(taskId) {
  const tr = await query(
    `SELECT t.*, p.repo_url, p.name AS project_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1`,
    [taskId]
  );
  const task = tr.rows[0];
  if (!task) return { ok: false, issues: [], task: null, status: 404 };

  const issues = [];

  if (!task.ai_assignee) {
    issues.push({
      severity: 'error',
      code: 'not_ai_task',
      message: 'Úkol není přiřazen Claude. V editaci úkolu zapni „🤖 Přiřadit Claudovi".',
    });
  }
  if (!task.repo_url) {
    issues.push({
      severity: 'error',
      code: 'no_repo_url',
      message: `Projekt „${task.project_name}" nemá nastavený GitHub repo. Otevři projekt → Editovat → vyplň GitHub repo URL.`,
    });
  }
  if (!agentConfig.enabled) {
    issues.push({
      severity: 'error',
      code: 'agent_disabled',
      message: 'AI agent je vypnutý (AI_AGENT_ENABLED=false v server/.env). Po zapnutí restartuj server.',
    });
  }
  const v = validateAgentConfig(agentConfig);
  for (const e of v.errors) {
    issues.push({ severity: 'error', code: 'config_invalid', message: e });
  }

  if (!RE_ENQUEUEABLE_STATES.includes(task.ai_status)) {
    issues.push({
      severity: 'error',
      code: 'invalid_state',
      message: `Úkol je teď ve stavu „${task.ai_status}" – už ho agent zpracovává, počkej. Po dokončení (done/failed/needs_human) ho budeš moct spustit znovu.`,
    });
  }

  const errors = issues.filter(i => i.severity === 'error');
  return { ok: errors.length === 0, issues, task, status: 200 };
}
