// Schválit úkol + rovnou založit navazující úkol s vlastním termínem.
// Řeší „úkol je hotový, ale mám k němu další nápad" bez kažení skóre — původní
// úkol se schválí (drží si „dokončeno včas"), nová práce jede jako nový úkol.
import { useState } from 'react';
import { reviews as reviewsApi } from '../api.js';

export default function ApproveContinueDialog({ task, onClose, onDone }) {
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState(`Pokračování: ${task.title}`);
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const canSubmit = title.trim() && dueDate && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      await reviewsApi.approveAndContinue(task.id, {
        comment: comment.trim() || null,
        title: title.trim(),
        due_date: dueDate,
        description: description.trim() || null,
      });
      onDone?.();
    } catch (e) {
      setErr(e.response?.data?.message || 'Nepodařilo se schválit a navázat.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-cream-200">
          <div className="font-semibold text-ink-800">✅🔗 Schválit a navázat</div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <div className="text-xs text-ink-500">
            Úkol <strong className="text-ink-700">„{task.title}"</strong> se schválí jako hotový (drží si
            „dokončeno včas") a založí se navazující úkol s vlastním termínem.
          </div>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink-500">Název navazujícího úkolu</span>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink-500">Termín *</span>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink-500">Popis / nápad (volitelné)</span>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5"
              placeholder="Co je potřeba v navazujícím úkolu udělat…" />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink-500">Komentář ke schválení (volitelné)</span>
            <input type="text" value={comment} onChange={e => setComment(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>

          {err && <div className="text-xs text-red-600">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-cream-200">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 text-sm rounded border border-ink-300 hover:bg-cream-50">Zrušit</button>
          <button onClick={submit} disabled={!canSubmit}
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy ? 'Ukládám…' : 'Schválit a navázat'}
          </button>
        </div>
      </div>
    </div>
  );
}
