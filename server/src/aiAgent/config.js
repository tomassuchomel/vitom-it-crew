// AI agent config – načte ENV, validuje a vrátí imutabilní config objekt.
//
// Návrh:
//   – Když AI_AGENT_ENABLED != 'true', vrátíme config s enabled:false a žádné
//     další pole nejsou povinná. Aplikace tak může startovat i bez nastavení.
//   – Když je zapnuté, validujeme všechny povinné položky a vyhodíme čitelnou
//     chybu (ne přes throw uvnitř loaderu, ale přes validateAgentConfig()).
//   – Žádné console.log obsahu klíčů. Helper hasGithubToken() vrací jen boolean.
//
// JSDoc typy nahrazují TS – projekt nemá TypeScript.

/**
 * @typedef {Object} AiAgentConfig
 * @property {boolean} enabled                       Hlavní vypínač.
 * @property {string|null} anthropicApiKey           Klíč pro Claude (může být null pokud vypnuto).
 * @property {number} maxCostPerTaskUsd              Strop $ na 1 task.
 * @property {number} maxCostPerDayUsd               Denní strop $ napříč všemi tasky.
 * @property {string|null} workDir                   Absolutní cesta k pracovní složce pro worktrees.
 * @property {string} allowedBranchesPrefix          Povolený prefix git branchů (default "claude/").
 * @property {string|null} githubToken               GitHub PAT pro tvorbu PR.
 */

// Defaulty pro číselné limity – použijí se i když AI_AGENT_ENABLED=false,
// ať volající kód nemusí řešit null.
const DEFAULT_MAX_COST_PER_TASK_USD = 2.0;
const DEFAULT_MAX_COST_PER_DAY_USD = 20.0;
const DEFAULT_BRANCH_PREFIX = 'claude/';

function parseFloatOrDefault(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isTruthy(v) {
  return typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Načte konfiguraci z process.env. Bezpečné volat opakovaně.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {AiAgentConfig}
 */
export function loadAgentConfig(env = process.env) {
  const enabled = isTruthy(env.AI_AGENT_ENABLED);
  return Object.freeze({
    enabled,
    anthropicApiKey: env.ANTHROPIC_API_KEY ? String(env.ANTHROPIC_API_KEY) : null,
    maxCostPerTaskUsd: parseFloatOrDefault(env.AI_AGENT_MAX_COST_PER_TASK_USD, DEFAULT_MAX_COST_PER_TASK_USD),
    maxCostPerDayUsd:  parseFloatOrDefault(env.AI_AGENT_MAX_COST_PER_DAY_USD,  DEFAULT_MAX_COST_PER_DAY_USD),
    workDir: env.AI_AGENT_WORKDIR ? String(env.AI_AGENT_WORKDIR) : null,
    allowedBranchesPrefix: env.AI_AGENT_ALLOWED_BRANCHES_PREFIX
      ? String(env.AI_AGENT_ALLOWED_BRANCHES_PREFIX)
      : DEFAULT_BRANCH_PREFIX,
    githubToken: env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN) : null,
  });
}

/**
 * Validuje, že je config kompletní pro běh agenta.
 * Volat až ve chvíli, kdy chceme agenta spustit – při startu serveru jen logujeme stav.
 * @param {AiAgentConfig} config
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAgentConfig(config) {
  if (!config.enabled) return { ok: true, errors: [] };
  const errors = [];
  if (!config.anthropicApiKey) errors.push('ANTHROPIC_API_KEY chybí (potřeba pro Claude API)');
  if (!config.workDir) errors.push('AI_AGENT_WORKDIR chybí (pracovní složka pro worktree)');
  if (!config.githubToken) errors.push('GITHUB_TOKEN chybí (potřeba pro tvorbu PR)');
  if (!config.allowedBranchesPrefix || !config.allowedBranchesPrefix.endsWith('/')) {
    errors.push('AI_AGENT_ALLOWED_BRANCHES_PREFIX musí končit lomítkem (např. "claude/")');
  }
  if (config.maxCostPerTaskUsd <= 0) errors.push('AI_AGENT_MAX_COST_PER_TASK_USD musí být > 0');
  if (config.maxCostPerDayUsd <= 0)  errors.push('AI_AGENT_MAX_COST_PER_DAY_USD musí být > 0');
  if (config.maxCostPerTaskUsd > config.maxCostPerDayUsd) {
    errors.push('AI_AGENT_MAX_COST_PER_TASK_USD nesmí být vyšší než denní limit');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Bezpečný popis pro logy – nikdy nevrací hodnoty klíčů, jen booleany.
 * @param {AiAgentConfig} config
 */
export function describeAgentConfig(config) {
  return {
    enabled: config.enabled,
    has_anthropic_key: !!config.anthropicApiKey,
    has_github_token: !!config.githubToken,
    work_dir_set: !!config.workDir,
    max_cost_per_task_usd: config.maxCostPerTaskUsd,
    max_cost_per_day_usd: config.maxCostPerDayUsd,
    branch_prefix: config.allowedBranchesPrefix,
  };
}

// Eager singleton pro běžné použití. Pro testy použij loadAgentConfig(fakeEnv).
export const agentConfig = loadAgentConfig();
