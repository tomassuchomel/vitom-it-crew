// Bezpečnostní kontroly pro AI agenta:
//   – validateScopePaths(paths)            čistá funkce, žádné DB
//   – checkDailyBudget(query, config, ...) async, query je DI
//   – checkTaskBudget(query, config, ...)  async, query je DI
//
// query a config jsou injektovány, aby šly funkce testovat bez reálné DB.

/** Cesty, které agent nikdy nesmí dostat ve scope_paths (substring match). */
const FORBIDDEN_SEGMENTS = [
  '.env',
  '.git',
  'node_modules',
  '.ssh',
  '.aws',
  '.npmrc',
  '.netrc',
];

/**
 * @typedef {Object} PathValidationResult
 * @property {boolean} ok
 * @property {string} [error]    machine-readable kód chyby
 * @property {string} [path]     která konkrétní cesta selhala
 * @property {string} [message]  čitelný text pro UI
 */

/**
 * Zkontroluje seznam scope_paths a vrátí první chybu nebo ok.
 * Žádná cesta nesmí:
 *   – být prázdná / non-string
 *   – obsahovat ".." (path traversal)
 *   – začínat "/" nebo "~" (absolute / home expansion)
 *   – obsahovat null byte
 *   – referencovat .env / .git / node_modules / .ssh / .aws / .npmrc / .netrc
 *   – být čistě "." nebo "/" (root celého repa)
 * Prázdný seznam je OK – znamená "agent může všude" (kontrolu necháváme na vyšší vrstvě).
 *
 * @param {unknown} paths
 * @returns {PathValidationResult}
 */
export function validateScopePaths(paths) {
  if (paths == null) return { ok: true };
  if (!Array.isArray(paths)) {
    return { ok: false, error: 'not_an_array', message: 'scope_paths musí být pole.' };
  }
  for (const raw of paths) {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'not_a_string', path: String(raw), message: 'Každá scope_path musí být string.' };
    }
    const p = raw.trim();
    if (p === '') {
      return { ok: false, error: 'empty', path: raw, message: 'Prázdná cesta není povolena.' };
    }
    if (p.includes('\0')) {
      return { ok: false, error: 'null_byte', path: raw, message: 'Cesta obsahuje null byte.' };
    }
    if (p.startsWith('/')) {
      return { ok: false, error: 'absolute_path', path: raw, message: 'Absolutní cesta („/…") není povolena – pouze relativní cesty v repu.' };
    }
    if (p.startsWith('~')) {
      return { ok: false, error: 'home_expansion', path: raw, message: 'Cesta začínající „~" není povolena.' };
    }
    // Path traversal v jakémkoliv segmentu (split podle obou separátorů – L-1)
    const segments = p.split(/[\\/]+/);
    if (segments.includes('..')) {
      return { ok: false, error: 'path_traversal', path: raw, message: 'Cesta obsahuje „..", což otevírá únik mimo repo.' };
    }
    if (p === '.' || p === './') {
      return { ok: false, error: 'whole_repo', path: raw, message: 'Cesta „." (celé repo) není povolena – vyber konkrétní složku.' };
    }
    // Zakázané segmenty – přesný match v některém segmentu, nebo název souboru .env apod.
    const lowerSegs = segments.map(s => s.toLowerCase());
    for (const forbidden of FORBIDDEN_SEGMENTS) {
      if (lowerSegs.includes(forbidden)) {
        return { ok: false, error: 'forbidden_segment', path: raw, message: `Cesta odkazuje na „${forbidden}", což agent nesmí měnit.` };
      }
    }
  }
  return { ok: true };
}

/**
 * @typedef {Object} BudgetResult
 * @property {boolean} allowed         true = ještě je co utratit
 * @property {number} usedUsd
 * @property {number} limitUsd
 * @property {number} remainingUsd
 * @property {string} [reason]         pokud allowed=false, vysvětlení
 */

// Helper – zaokrouhlí na 4 desetiny (NUMERIC(10,4) v DB)
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

/**
 * Kolik z denního limitu zbývá? Sumuje cost_usd ze všech activity log
 * záznamů, které vznikly DNES (UTC). Tím zachytíme i in-progress tasky,
 * nikoli jen dokončené (H-8 fix – dřív se používalo completed_at, takže
 * běžící task mohl utratit $X před vyhodnocením, protože completed_at byl null).
 *
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[] }>} query
 * @param {{ maxCostPerDayUsd: number }} config
 * @param {Date} [now=new Date()]
 * @returns {Promise<BudgetResult>}
 */
export async function checkDailyBudget(query, config, now = new Date()) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  // Cost se zapisuje v reálném čase do ai_agent_activity přes log.record(..., costUsd).
  // Sumujeme přes ai_agent_activity, ne tasks.ai_cost_usd, ať máme aktuální stav
  // i pro běžící (status != done) tasky.
  const r = await query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS used
     FROM ai_agent_activity
     WHERE created_at >= $1 AND created_at < $2`,
    [dayStart.toISOString(), dayEnd.toISOString()]
  );
  const used = round4(r.rows[0]?.used ?? 0);
  const limit = round4(config.maxCostPerDayUsd);
  const remaining = round4(Math.max(0, limit - used));
  const allowed = used < limit;
  return {
    allowed,
    usedUsd: used,
    limitUsd: limit,
    remainingUsd: remaining,
    reason: allowed ? undefined : `Denní limit $${limit.toFixed(2)} byl vyčerpán.`,
  };
}

/**
 * Kolik na konkrétním tasku zbývá? Načte tasks.ai_cost_usd a porovná s task limitem.
 *
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[] }>} query
 * @param {{ maxCostPerTaskUsd: number }} config
 * @param {number} taskId
 * @returns {Promise<BudgetResult>}
 */
export async function checkTaskBudget(query, config, taskId) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error('taskId musí být kladné celé číslo');
  }
  const r = await query(`SELECT ai_cost_usd FROM tasks WHERE id = $1`, [taskId]);
  if (r.rows.length === 0) {
    throw new Error(`task #${taskId} neexistuje`);
  }
  const used = round4(r.rows[0].ai_cost_usd ?? 0);
  const limit = round4(config.maxCostPerTaskUsd);
  const remaining = round4(Math.max(0, limit - used));
  const allowed = used < limit;
  return {
    allowed,
    usedUsd: used,
    limitUsd: limit,
    remainingUsd: remaining,
    reason: allowed ? undefined : `Limit na task $${limit.toFixed(2)} byl vyčerpán.`,
  };
}

/**
 * Ověří, že název branche odpovídá povolenému prefixu (typicky "claude/").
 * @param {string} branch
 * @param {string} allowedPrefix
 */
export function isAllowedBranch(branch, allowedPrefix) {
  if (typeof branch !== 'string' || branch.length === 0) return false;
  if (typeof allowedPrefix !== 'string' || allowedPrefix.length === 0) return false;
  if (branch.includes('..') || branch.includes(' ') || branch.startsWith('-')) return false;
  return branch.startsWith(allowedPrefix);
}
