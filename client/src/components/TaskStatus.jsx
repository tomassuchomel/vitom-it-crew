// Sdílené komponenty pro stav úkolu a akční tlačítka.
// Vizuálně oddělené: STATUS = velký barevný badge (informuje), AKCE = malé outlined tlačítko (mění stav).
import { useState } from 'react';

export const STATUS_META = {
  todo:        { label: 'Čeká',         icon: '🕐', bg: 'bg-amber-100',    text: 'text-amber-800',     border: 'border-amber-300',  dot: 'bg-amber-500' },
  in_progress: { label: 'Pracuje se',   icon: '⚙️', bg: 'bg-blue-100',     text: 'text-blue-800',      border: 'border-blue-300',   dot: 'bg-blue-500 animate-pulse' },
  review:      { label: 'Čeká na review', icon: '👀', bg: 'bg-accent-100', text: 'text-accent-800',    border: 'border-accent-300', dot: 'bg-accent-500' },
  needs_fix:   { label: 'K opravě',     icon: '🔄', bg: 'bg-orange-100',  text: 'text-orange-800',    border: 'border-orange-300', dot: 'bg-orange-500 animate-pulse' },
  done:        { label: 'Hotovo',       icon: '✅', bg: 'bg-emerald-100', text: 'text-emerald-800',   border: 'border-emerald-400',dot: 'bg-emerald-500' },
};

// Velký status badge – primárně INFORMUJE o stavu (ne tlačítko)
export function StatusBadge({ status, size = 'normal' }) {
  const m = STATUS_META[status];
  if (!m) return null;
  const sizes = {
    small:  'text-[10px] px-1.5 py-0.5 gap-1',
    normal: 'text-xs px-2 py-1 gap-1.5',
    large:  'text-sm px-3 py-1.5 gap-2',
  };
  return (
    <span className={`inline-flex items-center font-semibold rounded-full border ${m.bg} ${m.text} ${m.border} ${sizes[size]}`}>
      <span>{m.icon}</span>
      <span>{m.label}</span>
    </span>
  );
}

// Akční tlačítka pro PŘECHOD mezi stavy.
//
// Workflow:
//   todo        → in_progress         (kdokoli s právem)
//   in_progress → review              ("Předat k review" – nahrazuje přímé „Dokončit")
//   needs_fix   → in_progress         ("Začít opravu" – po vrácení od managera)
//   review      → done/needs_fix      (jen manager projektu nebo admin, akce z reviewQueue)
//
// Props:
//   - task: aktuální task
//   - onChange(task, status): pro standardní statusové přechody (in_progress, review, needs_fix)
//   - onReview(task, verdict): otevřít approve/reject flow (jen pro manager/admin v review stavu)
//   - canReview: zda current user má právo review-ovat tenhle task
//   - canChange: zda current user může vůbec měnit status (assignee nebo createTasks)
export function StatusActions({ task, onChange, onReview, compact = false, canChange = true, canReview = false }) {
  if (!canChange && !canReview) return null;
  const sz = compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs';
  const baseBtn = 'inline-flex items-center gap-1 rounded-md border bg-white font-medium transition hover:shadow-sm';
  const fromStatus = task.status;

  const palette = {
    ink:      'border-ink-300 text-ink-700 hover:border-ink-500 hover:bg-cream-50',
    blue:     'border-blue-300 text-blue-700 hover:bg-blue-50',
    accent:   'border-accent-300 text-accent-700 hover:bg-accent-50',
    emerald:  'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
    orange:   'border-orange-300 text-orange-700 hover:bg-orange-50',
    red:      'border-red-300 text-red-700 hover:bg-red-50',
  };

  // Tlačítko pro PŘECHOD statusu (in_progress, review, needs_fix, …)
  const Btn = ({ targetStatus, label, color = 'ink' }) => (
    <button
      onClick={() => onChange(task, targetStatus)}
      className={`${baseBtn} ${sz} ${palette[color]}`}
      title={`Změnit stav: ${STATUS_META[targetStatus]?.label || targetStatus}`}
    >→ {label}</button>
  );

  // Tlačítko pro REVIEW akci (approve/reject) – volá onReview místo onChange
  const ReviewBtn = ({ verdict, label, color }) => (
    <button
      onClick={() => onReview && onReview(task, verdict)}
      className={`${baseBtn} ${sz} ${palette[color]}`}
      title={verdict === 'approved' ? 'Schválit a označit jako hotové' : 'Vrátit programátorovi k opravě'}
    >{label}</button>
  );

  if (fromStatus === 'todo' && canChange) {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="in_progress" label="Začít pracovat" color="blue" />
      </div>
    );
  }
  if (fromStatus === 'in_progress' && canChange) {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="review" label="Předat k review" color="emerald" />
        <Btn targetStatus="todo" label="Pozastavit" color="ink" />
      </div>
    );
  }
  if (fromStatus === 'review') {
    if (canReview) {
      return (
        <div className="flex items-center gap-1">
          <ReviewBtn verdict="approved" label="✅ Schválit & dokončit" color="emerald" />
          <ReviewBtn verdict="rejected" label="🔄 Vrátit k opravě" color="orange" />
        </div>
      );
    }
    // Programátor čeká na review – ukáže info text místo tlačítek
    return (
      <div className="text-[11px] text-ink-400 italic px-1">
        Čeká na schválení vedoucího projektu…
      </div>
    );
  }
  if (fromStatus === 'needs_fix' && canChange) {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="in_progress" label="Začít opravu" color="blue" />
      </div>
    );
  }
  if (fromStatus === 'done' && canChange) {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="todo" label="Otevřít znovu" color="ink" />
      </div>
    );
  }
  return null;
}

// AI Estimate Badge – ukazuje status AI odhadu (pending/done/error).
// Při kliku na 'error' state ukáže plný text chyby (na mobilu tooltip nefunguje).
export function AIEstimateBadge({ task }) {
  const [showErr, setShowErr] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (task.ai_estimate_status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded border border-brand-200">
        <span className="animate-spin">⟳</span> AI odhaduje…
      </span>
    );
  }
  if (task.ai_estimate_status === 'error') {
    const retry = async (e) => {
      e.stopPropagation();
      setRetrying(true);
      try {
        // Manuální spuštění odhadu na backendu – stejné API jako automatický kickoff.
        const { api } = await import('../api.js');
        await api.post(`/tasks/${task.id}/estimate`);
        // Po retry zavřeme overlay, parent stránka si odhad načte při dalším refreshi.
        setShowErr(false);
      } catch (err) {
        // Necháme overlay otevřený – zobrazí původní chybu, retry se pokusí ještě jednou
      } finally {
        setRetrying(false);
      }
    };
    return (
      <>
        <button
          onClick={(e) => { e.stopPropagation(); setShowErr(true); }}
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-red-50 text-red-600 rounded border border-red-200 hover:bg-red-100"
          title={task.ai_estimate_note || 'Klikni pro detail'}
        >
          ⚠ AI odhad selhal
        </button>
        {showErr && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowErr(false)}>
            <div className="bg-white rounded-lg max-w-lg w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-ink-800">⚠ AI odhad selhal</h3>
                <button onClick={() => setShowErr(false)} className="text-ink-400 hover:text-ink-700 text-xl leading-none">×</button>
              </div>
              <div className="text-xs text-ink-500 mb-1">Důvod chyby:</div>
              <pre className="text-xs bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap break-words text-red-800 max-h-64 overflow-y-auto">
                {task.ai_estimate_note || '(žádný detail – podívej se do Render Logs na řádek „[ai estimate]")'}
              </pre>
              <div className="flex items-center gap-2 mt-4">
                <button
                  onClick={retry}
                  disabled={retrying}
                  className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50"
                >{retrying ? 'Spouštím…' : '🔄 Zkusit znovu'}</button>
                <button onClick={() => setShowErr(false)} className="px-3 py-1.5 text-sm text-ink-500 hover:text-ink-700">Zavřít</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }
  if (task.ai_estimated_h != null) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded border border-brand-200"
        title={task.ai_estimate_note || ''}>
        🤖 AI: {Number(task.ai_estimated_h).toFixed(1)} h
      </span>
    );
  }
  return null;
}
