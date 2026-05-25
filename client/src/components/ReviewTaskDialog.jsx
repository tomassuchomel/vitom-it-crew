// Dialog pro review akci managera/admina.
//
// Dva módy podle prop `verdict`:
//   - 'approved'  → schválit a dokončit, jen confirm + volitelný komentář
//   - 'rejected'  → vrátit k opravě: povinný komentář + možnost nahrát foto (přílohy)
//
// Foto/přílohy se uploadují přes existující Attachments endpoint navázaný na taskId.
// Komentář a verdict se uloží do task_reviews přes POST /api/tasks/:id/review.

import { useState } from 'react';
import { reviews as reviewsApi, attachments as attachmentsApi } from '../api.js';

export default function ReviewTaskDialog({ task, verdict, onClose, onDone }) {
  const isReject = verdict === 'rejected';
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState([]);    // File[] vybrané k uploadu
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null);
    if (isReject && !comment.trim()) {
      setErr('Při vrácení k opravě je komentář povinný – napiš, co je třeba opravit.');
      return;
    }
    setBusy(true);
    try {
      // 1) Pokud reject + uživatel nahrál soubory – upload se musí stát PŘED review
      //    (po review se task přepne na needs_fix; přílohy se vážou k taskId, takže
      //    by to fungovalo i po, ale je čistší mít soubory hotové než se rozhodne).
      if (isReject && files.length > 0) {
        await attachmentsApi.upload(task.id, files);
      }
      // 2) Zaznamenat verdict
      await reviewsApi.decide(task.id, verdict, comment || null);
      onDone?.();
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Akce selhala');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-cream-200 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink-800">
              {isReject ? '🔄 Vrátit k opravě' : '✅ Schválit a dokončit'}
            </h2>
            <div className="text-xs text-ink-500 mt-0.5 truncate max-w-md">{task.title}</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-3">
          {isReject ? (
            <>
              <label className="block">
                <span className="text-xs font-medium text-ink-600">Komentář (povinný) *</span>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={4}
                  autoFocus
                  placeholder="Napiš programátorovi konkrétně, co je třeba opravit. Buď konkrétní."
                  className="mt-1 w-full border border-ink-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </label>
              <div>
                <span className="text-xs font-medium text-ink-600">Přílohy (volitelné)</span>
                <div className="mt-1 border-2 border-dashed border-ink-200 rounded-lg p-3">
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    onChange={e => setFiles(Array.from(e.target.files || []))}
                    className="block w-full text-xs text-ink-600
                      file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0
                      file:text-xs file:font-medium file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100"
                  />
                  {files.length > 0 && (
                    <ul className="mt-2 text-[11px] text-ink-500 space-y-0.5">
                      {files.map((f, i) => (
                        <li key={i}>📎 {f.name} <span className="text-ink-400">({(f.size / 1024).toFixed(0)} kB)</span></li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 text-[10px] text-ink-400">Foto/screenshot toho, co je špatně. JPG, PNG, MP4 (max 25 MB).</div>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-700">
                Schválením označíš úkol jako <strong>hotový</strong>. Programátor uvidí status „Hotovo".
              </p>
              <label className="block">
                <span className="text-xs font-medium text-ink-600">Komentář (volitelný)</span>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={3}
                  placeholder="Případná pochvala nebo poznámka k práci…"
                  className="mt-1 w-full border border-ink-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </label>
            </>
          )}

          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        </div>

        <div className="px-5 py-3 border-t border-cream-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-sm rounded border border-ink-300 hover:bg-cream-50">
            Zrušit
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className={`px-4 py-1.5 text-sm rounded font-medium text-white disabled:opacity-50 ${
              isReject ? 'bg-orange-500 hover:bg-orange-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {busy
              ? (isReject ? 'Vracím…' : 'Schvaluju…')
              : (isReject ? 'Vrátit k opravě' : 'Schválit a dokončit')}
          </button>
        </div>
      </div>
    </div>
  );
}
