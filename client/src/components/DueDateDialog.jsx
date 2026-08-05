// Posun termínu úkolu z jednoho místa. Když má uživatel právo (zadavatel /
// manager / admin), termín se změní rovnou; jinak se z toho stane žádost o
// změnu termínu, kterou schválí zadavatel. Otevírá se klikem na 📅 u úkolu.
import { useState } from 'react';
import { tasks as tasksApi, dueChangeRequests as dueApi } from '../api.js';

export default function DueDateDialog({ task, onClose, onDone }) {
  const [due, setDue] = useState(task.due_date ? String(task.due_date).slice(0, 10) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null); // null | 'changed' | 'requested'

  const submit = async () => {
    if (!due || busy) return;
    setBusy(true); setErr(null);
    try {
      await tasksApi.update(task.id, { due_date: due });
      setResult('changed');
    } catch (e) {
      if (e.response?.data?.error === 'requires_due_change_request') {
        try {
          await dueApi.create(task.id, due, note.trim() || null);
          setResult('requested');
        } catch (e2) {
          setErr(e2.response?.data?.message || 'Odeslání žádosti selhalo.');
        }
      } else {
        setErr(e.response?.data?.message || 'Změna termínu selhala.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-cream-200">
          <div className="font-semibold text-ink-800">📅 Posun termínu</div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        {result ? (
          <div className="px-5 py-5 text-sm">
            {result === 'changed' ? (
              <div className="text-emerald-700">✅ Termín úkolu byl změněn.</div>
            ) : (
              <div className="text-brand-600">
                📨 Nemáš právo měnit termín přímo — odeslali jsme <strong>žádost o posun</strong>
                zadavateli úkolu. Až ji schválí, termín se změní a přijde ti upozornění.
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button onClick={onDone}
                className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600">Hotovo</button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-5 py-4 space-y-3 text-sm">
              <div className="text-xs text-ink-500">
                Úkol <strong className="text-ink-700">„{task.title}"</strong>
                {task.due_date && <> · současný termín {String(task.due_date).slice(0, 10)}</>}
              </div>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-ink-500">Nový termín</span>
                <input type="date" value={due} onChange={e => setDue(e.target.value)}
                  className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-ink-500">Důvod (když půjde o žádost)</span>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                  className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5"
                  placeholder="Proč potřebuješ posunout termín…" />
              </label>
              {err && <div className="text-xs text-red-600">{err}</div>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-cream-200">
              <button onClick={onClose} disabled={busy}
                className="px-3 py-1.5 text-sm rounded border border-ink-300 hover:bg-cream-50">Zrušit</button>
              <button onClick={submit} disabled={!due || busy}
                className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
                {busy ? 'Ukládám…' : 'Posunout termín'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
