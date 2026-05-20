// AI agent panel pro TaskDetailModal:
//   - aktuální ai_status (badge)
//   - tlačítko „Spustit Claude" (volá POST /api/tasks/:id/enqueue)
//   - preflight banner s issues (chybí repo_url / agent disabled / config / worker)
//   - activity timeline – posledních 50 entries z ai_agent_activity
//   - cost so far + iteration count + PR link když existuje
//
// Komponenta se monstí jen pro task.ai_assignee=true. Polluje status každé 4s,
// dokud je task v aktivním stavu (queued/running/in_review/awaiting_…).
import { useEffect, useRef, useState } from 'react';
import { aiAgent as aiAgentApi } from '../api.js';

const AI_STATUS_META = {
  idle:               { label: '⏸️ Idle',                 cls: 'bg-slate-100 text-slate-700' },
  queued:             { label: '⏳ Ve frontě',             cls: 'bg-amber-100 text-amber-800' },
  running:            { label: '🤖 Pracuje',              cls: 'bg-blue-100 text-blue-800' },
  awaiting_clarification: { label: '❓ Čeká na odpověď',   cls: 'bg-purple-100 text-purple-800' },
  in_review:          { label: '🔍 Reviewer kontroluje',  cls: 'bg-indigo-100 text-indigo-800' },
  needs_changes:      { label: '🔄 Reviewer vrátil',      cls: 'bg-orange-100 text-orange-800' },
  needs_human:        { label: '🆘 Potřebuje člověka',    cls: 'bg-red-100 text-red-800' },
  done:               { label: '✅ Hotovo',                cls: 'bg-emerald-100 text-emerald-800' },
  failed:             { label: '❌ Selhalo',              cls: 'bg-red-100 text-red-800' },
};

// V těchto stavech má smysl pollovat, agent právě pracuje nebo čeká.
const POLLING_STATES = ['queued', 'running', 'in_review', 'awaiting_clarification'];

// V těchto stavech je možné agenta (znovu) spustit přes "Spustit Claude".
const RELAUNCHABLE_STATES = ['idle', 'done', 'failed', 'needs_human', 'needs_changes'];

export default function AiAgentPanel({ task }) {
  // Lokální data
  const [data, setData] = useState(null);          // { task, activity }
  const [preflight, setPreflight] = useState(null); // { can_enqueue, issues, ... }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);          // success hláška po enqueue
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const loadAll = async () => {
    try {
      const [s, pf] = await Promise.all([
        aiAgentApi.status(task.id),
        aiAgentApi.taskPreflight(task.id).catch(() => null),
      ]);
      setData(s);
      setPreflight(pf);
    } catch (e) {
      setErr(e.response?.data?.error || 'Nepodařilo se načíst AI status');
    } finally {
      setLoading(false);
    }
  };

  // Polling – jen pokud je task ve "aktivním" stavu
  useEffect(() => {
    loadAll();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    if (!data?.task) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (POLLING_STATES.includes(data.task.ai_status)) {
      timerRef.current = setTimeout(loadAll, 4000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.task?.ai_status]);

  const enqueue = async () => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      await aiAgentApi.enqueue(task.id);
      setInfo('Zařazeno do fronty. Worker si úkol vyzvedne.');
      await loadAll();
    } catch (e) {
      const issues = e.response?.data?.issues;
      if (issues && issues.length) {
        // Hlavní zprávu vezmeme z prvního issue – detailní výpis zobrazí PreflightList níže
        setErr(issues[0].message);
        // Aktualizujeme preflight, ať uživatel vidí všechny issues
        setPreflight({ can_enqueue: false, issues });
      } else {
        setErr(e.response?.data?.error || 'Spuštění selhalo');
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="text-xs text-ink-400">Načítám AI status…</div>;
  if (!data?.task) return <div className="text-xs text-red-600">{err || 'AI status nedostupný'}</div>;

  const t = data.task;
  const meta = AI_STATUS_META[t.ai_status] || { label: t.ai_status, cls: 'bg-slate-100 text-slate-700' };
  const canRelaunch = RELAUNCHABLE_STATES.includes(t.ai_status);
  const issues = preflight?.issues || [];
  const hasErrors = issues.some(i => i.severity === 'error');

  return (
    <div className="space-y-3">
      {/* Status + akce */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`text-xs font-semibold px-2 py-1 rounded ${meta.cls}`}>{meta.label}</span>
        <span className="text-xs text-ink-500">
          Iterace {t.iteration_count}/{t.max_iterations}
        </span>
        {t.ai_cost_usd > 0 && (
          <span className="text-xs text-ink-500">
            Cena: ${t.ai_cost_usd.toFixed(2)}
          </span>
        )}
        {t.ai_pr_url && (
          <a
            href={t.ai_pr_url}
            target="_blank" rel="noreferrer"
            className="text-xs text-brand-500 hover:underline font-medium"
          >🔗 PR</a>
        )}
        <div className="ml-auto">
          {canRelaunch ? (
            <button
              onClick={enqueue}
              disabled={busy || hasErrors}
              className="px-3 py-1.5 text-xs font-medium bg-accent-500 text-white rounded hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
              title={hasErrors ? 'Nejdřív vyřeš chyby níže' : 'Spustit Claude na tomto úkolu'}
            >
              {busy ? 'Zařazuji…' : (t.ai_status === 'idle' ? '▶ Spustit Claude' : '🔁 Znovu spustit')}
            </button>
          ) : (
            <span className="text-xs text-ink-400 italic">Agent právě pracuje, počkej…</span>
          )}
        </div>
      </div>

      {/* Issues / errors */}
      {info && <div className="rounded border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-800">✅ {info}</div>}
      {err && !preflight?.issues?.length && (
        <div className="rounded border border-red-300 bg-red-50 p-2.5 text-xs text-red-800">⛔ {err}</div>
      )}
      {issues.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-ink-500 font-medium">Co brání spuštění:</div>
          {issues.map((i, idx) => (
            <IssueRow key={idx} issue={i} />
          ))}
        </div>
      )}

      {/* Activity timeline */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-500 font-medium mb-1.5">Aktivita agenta</div>
        {data.activity.length === 0 ? (
          <div className="text-xs text-ink-400 italic">Zatím žádná aktivita.</div>
        ) : (
          <ul className="space-y-1.5 max-h-72 overflow-y-auto text-xs">
            {data.activity.map(a => <ActivityRow key={a.id} entry={a} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function IssueRow({ issue }) {
  const sevStyle = issue.severity === 'error'
    ? 'border-red-300 bg-red-50 text-red-800'
    : issue.severity === 'warning'
      ? 'border-amber-300 bg-amber-50 text-amber-800'
      : 'border-slate-200 bg-slate-50 text-slate-700';
  const icon = issue.severity === 'error' ? '⛔' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
  return (
    <div className={`rounded border ${sevStyle} p-2.5 text-xs`}>
      <span className="font-medium mr-1">{icon}</span>{issue.message}
    </div>
  );
}

// Lidsky čitelný popisek pro každý typ activity action.
// Klíče zrcadlí log.record(...) volání ve worker.js / routes/aiAgent.js.
// Pro nepokryté action zobrazíme raw název.
const ACTION_LABELS = {
  // Lifecycle (zařazení do fronty)
  enqueued_by_user:         '👤 Zařazeno uživatelem',
  enqueued_auto:            '⚡ Automaticky zařazeno (execution_mode=auto)',
  state_changed:            '🔀 Změna stavu',
  invalid_transition:       '⛔ Neplatný přechod stavů',
  // Worktree
  worktree_ready:           '🌿 Worktree připravený',
  worktree_failed:          '⛔ Worktree selhal',
  worktree_cleaned:         '🧹 Worktree uklizen',
  worktree_cleanup_failed:  '⚠️ Worktree cleanup selhal',
  // Context / agent
  context_assembled:        '📚 Sestaven kontext pro agenta',
  context_assembly_failed:  '⚠️ Sestavení kontextu selhalo',
  previous_review_loaded:   '🔁 Načten předchozí review',
  agent_summary:            '📝 Souhrn práce agenta',
  agent_error:              '⛔ Chyba agenta',
  // Git / PR
  no_commits:               '🤷 Agent neudělal commity',
  branch_pushed:            '⬆️ Branch pushnut na GitHub',
  push_failed:              '⛔ Push selhal',
  commits_check_failed:     '⚠️ Kontrola commitů selhala',
  pr_created:               '🔗 Otevřen pull request',
  pr_already_exists:        '🔁 PR už existuje, použiju ho',
  pr_creation_failed:       '⛔ Vytvoření PR selhalo',
  pr_marked_ready:          '✅ PR označen jako ready for review',
  pr_mark_ready_failed:     '⚠️ Mark ready selhal',
  reiterate_comment_added:  '💬 Komentář na PR (nová iterace)',
  reiterate_comment_failed: '⚠️ Komentář na PR selhal',
  // Review
  review_started:           '🔍 Spuštěn reviewer (Opus)',
  reviewer_error:           '⛔ Chyba revieweru',
  reviewer_budget_too_low:  '💸 Příliš málo rozpočtu pro reviewera',
  review_comment_failed:    '⚠️ Vložení review komentáře selhalo',
  diff_collection_failed:   '⚠️ Sběr diffu selhal',
  unknown_verdict:          '❓ Neznámý reviewer verdict',
  // Iterace + ukončení
  iteration_incremented:    '🔁 Další iterace',
  iterations_exhausted:     '🚫 Vyčerpány iterace',
  // Bezpečnost / rozpočet
  budget_exhausted:         '💸 Vyčerpán rozpočet',
  invalid_scope_paths:      '⛔ Neplatné scope_paths',
  // Worker
  worker_error:             '⛔ Chyba workeru',
  stuck_task_detected:      '⚠️ Task uvízl – recovery',
};

function ActivityRow({ entry }) {
  const ts = new Date(entry.created_at + (entry.created_at.endsWith('Z') ? '' : 'Z'));
  const label = ACTION_LABELS[entry.action] || entry.action;
  const detail = entry.details && Object.keys(entry.details).length > 0
    ? renderDetails(entry.action, entry.details)
    : null;

  return (
    <li className="border-l-2 border-cream-300 pl-2 py-0.5">
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-ink-700">{label}</span>
        {entry.cost_usd > 0 && (
          <span className="text-[10px] text-ink-400">${Number(entry.cost_usd).toFixed(3)}</span>
        )}
        <span className="ml-auto text-[10px] text-ink-400">
          {ts.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      {detail && <div className="text-[11px] text-ink-500 mt-0.5 truncate">{detail}</div>}
    </li>
  );
}

// Heuristika – pro pár známých actions vyrobíme čitelnější popis detailu.
function renderDetails(action, d) {
  if (action === 'state_changed') return `${d.from} → ${d.to}`;
  if (action === 'pr_created' || action === 'pr_already_exists' || action === 'pr_marked_ready') return d.pr_url || '';
  if (action === 'branch_pushed') return d.branch || '';
  if (action === 'agent_summary') return String(d.summary || '').slice(0, 200);
  if (action === 'iteration_incremented') return `${d.from} → ${d.to}`;
  if (action === 'iterations_exhausted') return `max=${d.max}, used=${d.used}`;
  if (action === 'budget_exhausted') return `${d.kind}: spent=${d.spentUsd ?? d.spent}, limit=${d.limitUsd ?? d.limit}`;
  if (action === 'worktree_ready') return d.branch ? `branch=${d.branch}` : '';
  if (['agent_error', 'reviewer_error', 'worker_error', 'push_failed', 'pr_creation_failed', 'worktree_failed']
      .includes(action)) return String(d.error || '').slice(0, 200);
  // Fallback – zkrácený JSON
  try { return JSON.stringify(d).slice(0, 160); } catch { return ''; }
}
