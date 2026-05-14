// Sdílené komponenty pro stav úkolu a akční tlačítka.
// Vizuálně oddělené: STATUS = velký barevný badge (informuje), AKCE = malé outlined tlačítko (mění stav).

export const STATUS_META = {
  todo:        { label: 'Čeká',     icon: '🕐', bg: 'bg-amber-100',    text: 'text-amber-800',     border: 'border-amber-300', dot: 'bg-amber-500' },
  in_progress: { label: 'Pracuje se', icon: '⚙️', bg: 'bg-blue-100',     text: 'text-blue-800',      border: 'border-blue-300',  dot: 'bg-blue-500 animate-pulse' },
  review:      { label: 'Review',   icon: '👀', bg: 'bg-accent-100',   text: 'text-accent-800',    border: 'border-accent-300',dot: 'bg-accent-500' },
  done:        { label: 'Hotovo',   icon: '✅', bg: 'bg-emerald-100',  text: 'text-emerald-800',   border: 'border-emerald-400',dot: 'bg-emerald-500' },
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

// Akční tlačítka pro PŘECHOD mezi stavy. Vizuálně outline, jasně jako "akce".
// Stav je v badge oddělen; tato tlačítka jen mění stav.
export function StatusActions({ task, onChange, compact = false, canChange = true }) {
  if (!canChange) return null;
  const sz = compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs';
  const baseBtn = 'inline-flex items-center gap-1 rounded-md border bg-white font-medium transition hover:shadow-sm';

  // Tlačítka pro každý stav: kam se může pokračovat
  const fromStatus = task.status;

  // Pomocná tlačítka – outline, decentní
  const Btn = ({ targetStatus, label, color = 'ink' }) => {
    const palette = {
      ink:      'border-ink-300 text-ink-700 hover:border-ink-500 hover:bg-cream-50',
      blue:     'border-blue-300 text-blue-700 hover:bg-blue-50',
      accent:   'border-accent-300 text-accent-700 hover:bg-accent-50',
      emerald:  'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
      red:      'border-red-300 text-red-700 hover:bg-red-50',
    };
    return (
      <button
        onClick={() => onChange(task, targetStatus)}
        className={`${baseBtn} ${sz} ${palette[color]}`}
        title={`Změnit stav: ${STATUS_META[targetStatus].label}`}
      >→ {label}</button>
    );
  };

  if (fromStatus === 'todo') {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="in_progress" label="Začít pracovat" color="blue" />
        <Btn targetStatus="done" label="Dokončit" color="emerald" />
      </div>
    );
  }
  if (fromStatus === 'in_progress') {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="review" label="Do review" color="accent" />
        <Btn targetStatus="done" label="Dokončit" color="emerald" />
        <Btn targetStatus="todo" label="Pozastavit" color="ink" />
      </div>
    );
  }
  if (fromStatus === 'review') {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="done" label="Schválit & dokončit" color="emerald" />
        <Btn targetStatus="in_progress" label="Vrátit do práce" color="blue" />
      </div>
    );
  }
  if (fromStatus === 'done') {
    return (
      <div className="flex items-center gap-1">
        <Btn targetStatus="todo" label="Otevřít znovu" color="ink" />
      </div>
    );
  }
  return null;
}

// AI Estimate Badge – ukazuje status AI odhadu (pending/done/error)
export function AIEstimateBadge({ task }) {
  if (task.ai_estimate_status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded border border-brand-200">
        <span className="animate-spin">⟳</span> AI odhaduje…
      </span>
    );
  }
  if (task.ai_estimate_status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-red-50 text-red-600 rounded border border-red-200"
        title={task.ai_estimate_note}>
        ⚠ AI odhad selhal
      </span>
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
