// "Model" tasku – v JS projektu bez TS nahrazuje typescript typy/interface.
// Slouží jako:
//   1) zdroj pravdy pro enumy (musí ladit s CHECK constraints v migracích)
//   2) validační helpery pro routes
//   3) defaultní hodnoty pro nově vytvořený task
//
// Pole z původního schématu (status, priority) ponecháme tady jen pro AI-agent
// rozšíření, ať nezasahujeme do stávající logiky. Validace existujících polí
// zůstává tam, kde je dnes (in-line v routes/tasks.js).

// AI agent životní cyklus (sloupec ai_status). NEPLÉST s ai_estimate_status,
// což je samostatný stav pro jednorázový AI odhad času.
export const AI_STATUSES = [
  'idle',          // nepoužitý – výchozí stav
  'queued',        // čeká ve frontě na agenta
  'planning',      // agent čte kontext, plánuje kroky
  'implementing',  // agent píše kód
  'in_review',     // PR otevřen, čeká na review
  'needs_changes', // reviewer požaduje úpravy
  'done',          // hotovo a smerged
  'failed',        // chyba, agent to vzdal
  'needs_human',   // překročen max_iterations nebo agent potřebuje rozhodnutí
];

// Mód spuštění AI agenta (sloupec execution_mode)
export const EXECUTION_MODES = ['auto', 'manual'];

// Výchozí hodnoty pro nově vytvořený AI task. Použij při INSERT, pokud frontend
// nepošle hodnotu. Reflektuje DEFAULTy v migraci, ale můžeme je tu měnit pro UX
// bez zásahu do DB.
export const AI_TASK_DEFAULTS = {
  ai_assignee: false,
  execution_mode: 'manual',
  acceptance_criteria: [],
  out_of_scope: [],
  scope_paths: [],
  iteration_count: 0,
  max_iterations: 3,
  ai_status: 'idle',
  ai_branch: null,
  ai_pr_url: null,
  ai_cost_usd: 0,
};

// Validace – vrátí null pokud OK, jinak chybový string.
export function validateAiStatus(v) {
  if (v == null) return null;
  return AI_STATUSES.includes(v) ? null : `invalid ai_status: ${v}`;
}
export function validateExecutionMode(v) {
  if (v == null) return null;
  return EXECUTION_MODES.includes(v) ? null : `invalid execution_mode: ${v}`;
}

// Normalizace JSON pole – přijme array nebo string (parse). Vrací array nebo
// vyhodí. Použij před INSERT/UPDATE pro acceptance_criteria, out_of_scope, scope_paths.
export function normalizeJsonArray(v, fieldName) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed;
    } catch (err) {
      throw new Error(`invalid JSON array for ${fieldName}: ${err.message}`);
    }
  }
  throw new Error(`${fieldName} must be an array or JSON string`);
}
