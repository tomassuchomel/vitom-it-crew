// Dialog pro přepnutí úkolu do stavu „Čekám na" (sekce 16 zadání).
// Ptá se, na koho/na co se čeká — bez toho je stav k ničemu, protože
// za týden nikdo neví, proč úkol stojí.

import { useState } from 'react';

// DATE z API přijde jako ISO s časem v UTC ("2026-10-31T23:00:00Z" = 1. 11.
// v Praze). Prostý slice(0,10) by ubral den, proto skládáme lokální složky.
function toLocalYMD(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


// Časté důvody čekání. Vybrat jde i vlastní text.
const PRESETS = ['Kolega', 'Management', 'Schválení', 'Klient', 'Dodavatel', 'Jiný úkol', 'Externí informace'];

export default function WaitingDialog({ task, onClose, onConfirm }) {
  const [waitingFor, setWaitingFor] = useState(task?.waiting_for || '');
  const [note, setNote] = useState(task?.waiting_note || '');
  const [until, setUntil] = useState(toLocalYMD(task?.waiting_until));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    if (!waitingFor.trim()) { setErr('Napiš, na koho nebo na co se čeká.'); return; }
    setBusy(true); setErr(null);
    try {
      await onConfirm({
        waiting_for: waitingFor.trim(),
        waiting_note: note.trim() || null,
        waiting_until: until || null,
      });
    } catch (e) {
      setErr(e.response?.data?.message || 'Uložení selhalo.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="text-lg font-semibold text-ink-800">⏳ Čekám na…</div>
        <div className="text-xs text-ink-500">
          Úkol se přepne do stavu „Čekám na". Zůstane mezi aktivními, jen bude jasné, proč stojí.
        </div>

        <div>
          <div className="text-xs text-ink-500 mb-1">Na koho / na co *</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {PRESETS.map(p => (
              <button key={p} type="button" onClick={() => setWaitingFor(p)}
                className={`px-2.5 py-1 text-xs rounded-full border transition ${
                  waitingFor === p
                    ? 'bg-brand-500 text-white border-brand-500'
                    : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
                }`}>{p}</button>
            ))}
          </div>
          <input value={waitingFor} onChange={e => setWaitingFor(e.target.value)}
            placeholder="např. Radovan — schválení rozpočtu"
            className="w-full border border-ink-300 rounded px-2 py-1.5 text-sm" />
        </div>

        <label className="block">
          <span className="text-xs text-ink-500">Poznámka</span>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
            placeholder="Co přesně potřebuješ, ať to nemusíš dohledávat…"
            className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1.5 text-sm" />
        </label>

        <label className="block">
          <span className="text-xs text-ink-500">Datum follow-upu (volitelné)</span>
          <input type="date" value={until} onChange={e => setUntil(e.target.value)}
            className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1.5 text-sm" />
        </label>

        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border border-ink-300 rounded hover:bg-cream-50">Zrušit</button>
          <button onClick={submit} disabled={busy}
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
            {busy ? 'Ukládám…' : 'Přepnout na čekání'}
          </button>
        </div>
      </div>
    </div>
  );
}
