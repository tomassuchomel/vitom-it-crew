// Zápis akcí agenta do ai_agent_activity tabulky + konzistentní console log.
//
// Pravidla:
//   – details je vždy JSON serializovatelný objekt, nesmí obsahovat secrets
//     (API klíče, GitHub token). Nikde nelogujeme proces.env napřímo.
//   – cost_usd se přičte jen pokud akce stála peníze (planning, implementing).
//   – ID návratu se používá pro testy.

import { query as defaultQuery } from '../db.js';

/**
 * Sanitizace details – DVA layery:
 *   1) Klíče matchující SECRET_KEY_PATTERNS → maskovat celé hodnoty.
 *   2) Stringové hodnoty (rekurzivně) → regexem najít token-shaped patterny
 *      (sk-ant-..., ghp_..., AKIA..., generický high-entropy) a redactnout je.
 *
 * Audit H-7: dříve byl pouze key-based, takže `details.command = "echo
 * GITHUB_TOKEN=ghp_xxx"` nebyl maskovaný – klíč "command" neprošel regexem.
 */
const SECRET_KEY_PATTERNS = [/api[_-]?key/i, /token/i, /password/i, /secret/i, /authorization/i];

// Token formáty, které chceme v hodnotách najít a maskovat.
// Pořadí: nejspecifičtější → nejobecnější (specifické se uplatní dřív).
const SECRET_VALUE_PATTERNS = [
  // Anthropic – sk-ant- + base64-ish, alespoň 40 znaků za prefixem
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{40,}/g },
  // GitHub Personal Access Token (classic)
  { name: 'github_pat',    re: /ghp_[A-Za-z0-9]{36,}/g },
  // GitHub fine-grained PAT
  { name: 'github_pat_fg', re: /github_pat_[A-Za-z0-9_]{40,}/g },
  // GitHub server-to-server / OAuth / install tokens
  { name: 'github_oauth',  re: /\b(?:ghs_|gho_|ghu_|ghr_)[A-Za-z0-9]{36,}/g },
  // AWS access key ID
  { name: 'aws_access',    re: /\bAKIA[0-9A-Z]{16}\b/g },
  // OpenAI – sk- + ~48 znaků
  { name: 'openai_key',    re: /\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/g },
  // Slack tokens
  { name: 'slack_token',   re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Generický high-entropy string ≥ 32 chars (last resort)
  // Hledá kontinuální [A-Za-z0-9+/=_-] délky ≥ 40 v rámci "secret-shaped"
  // kontextu (token / key / secret slovo poblíž). Pure entropy match by způsoboval
  // false positives, držíme se zatím konzervativně jen u explicitních prefixů.
];

function redactSecretsInString(s) {
  if (typeof s !== 'string' || s.length < 8) return s;
  let out = s;
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactSecretsInString(value);
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
