// Zápis akcí agenta do ai_agent_activity tabulky + konzistentní console log.
//
// Pravidla:
//   – details je vždy JSON serializovatelný objekt, nesmí obsahovat secrets
//     (API klíče, GitHub token). Nikde nelogujeme proces.env napřímo.
//   – cost_usd se přičte jen pokud akce stála peníze (planning, implementing).
//   – ID návratu se používá pro testy.

import { query as defaultQuery } from '../db.js';

/**
 * Sanitizace details – odřízne klíče, které vypadají jako secret. Defensive layer
 * proti náhodnému logování tokenů ze stack traceů.
 */
const SECRET_KEY_PATTERNS = [/api[_-]?key/i, /token/i, /password/i, /secret/i, /authorization/i];
function sanitize(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERNS.some(p => p.test(k))) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[] }>} [opts.query]
 * @param {(msg: string, data?: object) => void} [opts.logger]
 */
export function createActivityLog({ query, logger } = {}) {
  const q = query || defaultQuery;
  const log = logger || ((msg, data) => {
    if (data) console.log(`[ai-worker] ${msg}`, JSON.stringify(data));
    else console.log(`[ai-worker] ${msg}`);
  });

  /**
   * @param {number} taskId
   * @param {string} action
   * @param {object} [details={}]
   * @param {number} [costUsd=0]
   */
  async function record(taskId, action, details = {}, costUsd = 0) {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new Error('activityLog.record: taskId musí být kladné celé číslo');
    }
    if (!action || typeof action !== 'string') {
      throw new Error('activityLog.record: action musí být neprázdný string');
    }
    const safe = sanitize(details);
    const r = await q(
      `INSERT INTO ai_agent_activity (task_id, action, details, cost_usd)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, created_at`,
      [taskId, action, JSON.stringify(safe), Number(costUsd) || 0]
    );

    // Konzistentní konzolový log pro live sledování
    log(`task=${taskId} ${action}`, safe);

    // Pokud akce stála peníze, přičti k tasks.ai_cost_usd
    if (Number(costUsd) > 0) {
      await q(`UPDATE tasks SET ai_cost_usd = ai_cost_usd + $1 WHERE id = $2`, [costUsd, taskId]);
    }

    return r.rows[0];
  }

  /**
   * Vrátí historii akcí pro task (nejnovější první).
   */
  async function history(taskId, { limit = 50 } = {}) {
    const r = await q(
      `SELECT id, action, details, cost_usd, created_at
       FROM ai_agent_activity
       WHERE task_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [taskId, limit]
    );
    return r.rows;
  }

  return { record, history };
}

export { sanitize };
