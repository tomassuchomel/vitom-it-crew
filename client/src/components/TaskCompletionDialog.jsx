// Dialog při dokončení úkolu – zeptá se na skutečný čas.
// Vstupní `task` musí obsahovat estimated_h, ai_estimated_h, logged_hours, actual_h.
// Po potvrzení zavolá onConfirm(actualHours).
import { useEffect, useMemo, useState } from 'react';

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(1).replace(/\.0$/, '');
}

export default function TaskCompletionDialog({ task, onConfirm, onCancel }) {
  // Preferovaná předvyplněná hodnota:
  //   1) předchozí actual_h (úkol je už jednou dokončen, znovu zavírá)
  //   2) součet time_entries (logged_hours) – nejlepší proxy pro realitu
  //   3) manuální odhad
  //   4) AI odhad
  //   5) prázdné
  const defaultValue = useMemo(() => {
    if (task?.actual_h != null) return String(task.actual_h);
    if (task?.logged_hours && Number(task.logged_hours) > 0) return String(Number(task.logged_hours).toFixed(1));
    if (task?.estimated_h != null) return String(task.estimated_h);
    if (task?.ai_estimated_h != null) return String(task.ai_estimated_h);
    return '';
  }, [task]);

  const [hours, setHours] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { setHours(defaultValue); setErr(null); }, [defaultValue]);

  if (!task) return null;

  const submit = async (e) => {
    e?.preventDefault?.();
    const num = Number(hours);
    if (hours === '' || Number.isNaN(num) || num < 0) {
      setErr('Zadej nezáporné číslo hodin (např. 3.5). Nech 0 pokud nevíš.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await onConfirm(num);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Uložení selhalo');
    } finally {
      setBusy(false);
    }
  };

  // Porovnání odhad vs skutečnost (jen ilustrativně, při napsání čísla)
  const num = Number(hours);
  const validNum = !Number.isNaN(num) && num > 0;
  const manualEst = task.estimated_h != null ? Number(task.estimated_h) : null;
  const aiEst     = task.ai_estimated_h != null ? Number(task.ai_estimated_h) : null;
  const manualDiff = (validNum && manualEst != null) ? (num - manualEst) : null;
  const aiDiff     = (validNum && aiEst != null)     ? (num - aiEst)     : null;
  const fmtDiff = (d) => {
    if (d == null) return null;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)} h`;
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-cream-200">
          <h2 className="font-semibold text-ink-800 text-lg">✅ Dokončit úkol</h2>
          <p className="text-xs text-ink-500 mt-1 truncate">{task.title}</p>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4">
          {/* Přehled odhadů – pro orientaci */}
          <div className="bg-cream-100 rounded-lg p-3 text-sm">
            <div className="text-xs text-ink-500 uppercase tracking-wide mb-2">Pro porovnání</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-[10px] text-ink-500 uppercase">Manual</div>
                <div className="font-semibold text-ink-700">{fmtNum(task.estimated_h)} h</div>
              </div>
              <div>
                <div className="text-[10px] text-ink-500 uppercase">AI odhad</div>
                <div className="font-semibold text-ink-700">{fmtNum(task.ai_estimated_h)} h</div>
              </div>
              <div>
                <div className="text-[10px] text-ink-500 uppercase">Zapsáno v Hodinách</div>
                <div className="font-semibold text-ink-700">{fmtNum(task.logged_hours)} h</div>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Kolik hodin trval úkol ve skutečnosti?
            </label>
            <input
              type="number"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-base font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="např. 3.5"
            />
            <div className="mt-2 flex items-center gap-3 text-xs text-ink-500">
              {manualDiff != null && (
                <span>vs manuál: <span className={manualDiff > 0 ? 'text-red-600 font-semibold' : manualDiff < 0 ? 'text-emerald-600 font-semibold' : 'text-ink-700 font-semibold'}>{fmtDiff(manualDiff)}</span></span>
              )}
              {aiDiff != null && (
                <span>vs AI: <span className={aiDiff > 0 ? 'text-red-600 font-semibold' : aiDiff < 0 ? 'text-emerald-600 font-semibold' : 'text-ink-700 font-semibold'}>{fmtDiff(aiDiff)}</span></span>
              )}
            </div>
            <p className="text-[11px] text-ink-400 mt-2">
              Tuhle hodnotu používáme pro vyhodnocení přesnosti odhadu. Můžeš ji později upravit v detailu úkolu.
            </p>
          </div>

          {err && <div className="text-sm text-red-600">{err}</div>}

          <div className="flex justify-end gap-2 pt-2 border-t border-cream-200">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm rounded border border-ink-300 hover:bg-cream-50"
            >Zrušit</button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-1.5 text-sm rounded bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50"
            >{busy ? 'Ukládám…' : 'Dokončit úkol'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
