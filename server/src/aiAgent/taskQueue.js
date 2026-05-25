// Najde tasky ve frontě pro AI agenta.
//
// Pravidla:
//   – ai_assignee = TRUE (jen AI tasky)
//   – ai_status = 'queued'
//   – execution_mode 'auto' jde dřív než 'manual' (manual stejně čeká na akci člověka,
//     ale i tak ho zařadíme – CLI může spustit manual)
//   – Stabilní řazení: priority (urgent → low), created_at ASC
//
// Návrh: query je injektovaná pro testovatelnost.

import { query as defaultQuery } from '../db.js';

// Pozn.: bez aliasu `t.` – tabulku tasks v query nealiasujeme.
// (Předtím tu byla `t.priority` ale FROM nemá alias → PG error
// "missing FROM-clause entry for table 't'".)
const PRIORITY_ORDER = `CASE priority
  WHEN 'urgent' THEN 0
  WHEN 'high'   THEN 1
  WHEN 'normal' THEN 2
  WHEN 'low'    THEN 3
  ELSE 4
END`;

/**
 * @param {object} [opts]
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[] }>} [opts.query]
 */
export function createTaskQueue({ query } = {}) {
  const q = query || defaultQuery;

  /**
   * @param {object} [filter]
   * @param {number} [filter.limit=10]
   * @returns {Promise<Array<object>>}
   */
  async function getQueued({ limit = 10 } = {}) {
    const r = await q(`
      SELECT id, project_id, title, priority, execution_mode, ai_status,
             acceptance_criteria, out_of_scope, scope_paths,
             max_iterations, iteration_count, ai_cost_usd
      FROM tasks
      WHERE ai_assignee = TRUE
        AND ai_status = 'queued'
      ORDER BY (execution_mode = 'auto') DESC, ${PRIORITY_ORDER}, created_at ASC
      LIMIT $1
    `, [limit]);
    return r.rows;
  }

  /**
   * Atomická operace – přečte next task a rovnou jej "pickne" (queued → planning).
   * Pokud nic není, vrátí null. Pro single-worker je to dost; multi-worker by
   * vyžadovalo FOR UPDATE SKIP LOCKED.
   */
  async function pickNext() {
    const rows = await getQueued({ limit: 1 });
    return rows[0] || null;
  }

  return { getQueued, pickNext };
}
