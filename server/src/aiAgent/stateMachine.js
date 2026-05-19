// Stavový automat pro tasks.ai_status. Hodnoty musí ladit s CHECK constraintem
// v migraci 2026-05-19-ai-agent-task-fields.sql a s AI_STATUSES v taskModel.js.
//
// Pravidlo: každý přechod musí být explicitně povolen, jinak je odmítnut.
// 'idle' je sink – z čehokoli (pro hard reset). 'queued' je obvyklý start.

import { AI_STATUSES } from '../taskModel.js';

/**
 * Mapa povolených přechodů: from → Set<to>.
 * "idle" je dosažitelný z čehokoli (manuální reset).
 * "queued" lze i z hotových/failed stavů (re-run / retry).
 */
const ALLOWED = {
  idle:          new Set(['queued']),
  queued:        new Set(['planning', 'idle', 'failed']),
  planning:      new Set(['implementing', 'failed', 'needs_human', 'idle']),
  implementing:  new Set(['in_review', 'failed', 'needs_human', 'idle']),
  in_review:     new Set(['done', 'needs_changes', 'failed', 'idle']),
  needs_changes: new Set(['implementing', 'failed', 'idle']),
  done:          new Set(['queued', 'idle']),
  failed:        new Set(['queued', 'idle']),
  needs_human:   new Set(['queued', 'idle', 'failed']),
};

// Sanity check při importu – pomáhá zachytit překlepy v dev.
for (const s of AI_STATUSES) {
  if (!ALLOWED[s]) {
    throw new Error(`stateMachine: missing transitions for status "${s}"`);
  }
}

/**
 * Vrátí, zda je přechod from→to povolen.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (!ALLOWED[from]) return false;
  return ALLOWED[from].has(to);
}

/**
 * Stejné jako canTransition, ale místo bool vrací podrobnější výsledek.
 * @returns {{ ok: boolean, error?: string, from?: string, to?: string, allowed?: string[] }}
 */
export function validateTransition(from, to) {
  if (!AI_STATUSES.includes(from)) return { ok: false, error: 'invalid_from', from };
  if (!AI_STATUSES.includes(to))   return { ok: false, error: 'invalid_to', to };
  if (from === to) return { ok: false, error: 'no_op', from, to };
  if (!canTransition(from, to)) {
    return { ok: false, error: 'transition_not_allowed', from, to, allowed: Array.from(ALLOWED[from]) };
  }
  return { ok: true, from, to };
}

/**
 * Seznam stavů, do kterých lze přejít z daného stavu.
 * @param {string} from
 * @returns {string[]}
 */
export function nextStates(from) {
  return ALLOWED[from] ? Array.from(ALLOWED[from]) : [];
}

/**
 * Terminální stavy – worker je sám nezmění (jen člověk).
 * @param {string} status
 */
export function isTerminal(status) {
  return status === 'done' || status === 'failed' || status === 'needs_human' || status === 'idle';
}
