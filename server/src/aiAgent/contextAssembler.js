// Sestaví "TaskBundle" – kompletní balíček vstupů pro AI agenta:
//   – task data (vč. AC, out_of_scope, scope_paths)
//   – parent task (pokud existuje)
//   – "komentáře" (v této appce reprezentované záznamy v questions tabulce)
//   – project metadata
//   – obsah CLAUDE.md z repa (pokud existuje)
//
// Návrh: query a fs jsou injektovatelné, aby šlo modul unit-testovat bez DB
// a souborového systému.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, query as defaultQuery } from '../db.js';

/**
 * @typedef {Object} TaskBundle
 * @property {object} task
 * @property {object|null} parent
 * @property {object|null} project
 * @property {Array<object>} comments
 * @property {{ content: string|null, source: 'file'|'missing' }} claudeMd
 * @property {string} assembledAt
 */

/**
 * @param {object} [opts]
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[] }>} [opts.query]
 * @param {(p: string) => Promise<string>} [opts.readFile]   pro DI testů
 * @param {string} [opts.repoRoot]                            kde hledat CLAUDE.md
 */
export function createContextAssembler({ query, readFile, repoRoot } = {}) {
  const q = query || defaultQuery;
  const rf = readFile || ((p) => fs.readFile(p, 'utf8'));
  const root = repoRoot || process.cwd();

  /**
   * Sestaví bundle pro daný task. Pokud task neexistuje, vyhodí error.
   * @param {number} taskId
   * @returns {Promise<TaskBundle>}
   */
  async function assemble(taskId) {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new Error('taskId musí být kladné celé číslo');
    }

    // Hlavní task
    const tR = await q(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    const task = tR.rows[0];
    if (!task) throw new Error(`task #${taskId} neexistuje`);

    // Parent task (lehčí výřez)
    let parent = null;
    if (task.parent_id) {
      const pR = await q(
        `SELECT id, title, description, status, priority, due_date
         FROM tasks WHERE id = $1`,
        [task.parent_id]
      );
      parent = pR.rows[0] || null;
    }

    // Project metadata
    let project = null;
    if (task.project_id) {
      const projR = await q(
        `SELECT id, name, description, status, due_date
         FROM projects WHERE id = $1`,
        [task.project_id]
      );
      project = projR.rows[0] || null;
    }

    // Komentáře = otázky na tomhle úkolu (chronologicky)
    const cR = await q(
      `SELECT q.id, q.question, q.answer, q.status, q.created_at, q.answered_at,
              fu.name AS from_user_name, tu.name AS to_user_name
       FROM questions q
       JOIN users fu ON fu.id = q.from_user_id
       JOIN users tu ON tu.id = q.to_user_id
       WHERE q.task_id = $1
       ORDER BY q.created_at ASC`,
      [taskId]
    );

    // CLAUDE.md – nepovinné. Kdyby chybělo (jako dnes v repu), vrátíme placeholder.
    let claudeMd = { content: null, source: 'missing' };
    try {
      const content = await rf(path.join(root, 'CLAUDE.md'));
      claudeMd = { content, source: 'file' };
    } catch {
      // missing – záměrně ticho, source: 'missing' už říká vše
    }

    return Object.freeze({
      task: shapeTaskForBundle(task),
      parent,
      project,
      comments: cR.rows,
      claudeMd,
      assembledAt: new Date().toISOString(),
    });
  }

  return { assemble };
}

// Vybere jen fieldy relevantní pro agenta – schovává např. completed_at,
// které nejsou pro plánování práce zajímavé.
function shapeTaskForBundle(t) {
  return {
    id: t.id,
    project_id: t.project_id,
    parent_id: t.parent_id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    due_date: t.due_date,
    estimated_h: t.estimated_h,
    ai_assignee: t.ai_assignee,
    execution_mode: t.execution_mode,
    ai_status: t.ai_status,
    acceptance_criteria: t.acceptance_criteria,
    out_of_scope: t.out_of_scope,
    scope_paths: t.scope_paths,
    iteration_count: t.iteration_count,
    max_iterations: t.max_iterations,
    ai_cost_usd: t.ai_cost_usd,
  };
}

// Convenience – pro běh ze CLI/workeru s default query a fs.
export const defaultAssembler = createContextAssembler();
export { pool };
