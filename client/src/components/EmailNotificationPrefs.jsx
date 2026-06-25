// Per-user email notification preferences (Profile → Notifikace emailem).
// Toggles per event type, ulož se na PUT /api/notifications/me.
// Defaults TRUE; bez RESEND_API_KEY v env se emaily neodesílají,
// ale UI funguje (server vrátí mailer_configured=false → varování).

import { useEffect, useState } from 'react';
import { notifications as notifApi } from '../api.js';

const EVENTS = [
  { key: 'email_daily_summary', label: 'Denní souhrn (AI reminder)', emoji: '☀️', hint: 'Každé ráno v 8:05: hlavní doporučení + seznam úkolů dle priority.' },
  { key: 'email_task_assigned', label: 'Nový úkol pro mě',     emoji: '✅', hint: 'Někdo mi přiřadí nový úkol.' },
  { key: 'email_task_returned', label: 'Úkol vrácen k opravě', emoji: '🔄', hint: 'Manažer mi vrátí úkol k přepracování.' },
  { key: 'email_task_approved', label: 'Úkol schválen',        emoji: '🎉', hint: 'Manažer schválí úkol, který jsem dokončil.' },
  { key: 'email_new_question',  label: 'Nový dotaz',           emoji: '💬', hint: 'Někdo se mě zeptá v dotazech.' },
];

export default function EmailNotificationPrefs() {
  const [prefs, setPrefs] = useState(null);
  const [mailerOk, setMailerOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    notifApi.get()
      .then(d => { setPrefs(d.prefs); setMailerOk(d.mailer_configured); })
      .catch(() => setErr('Načtení nastavení selhalo.'));
  }, []);

  const toggle = (key) => {
    setPrefs(p => ({ ...p, [key]: !p[key] }));
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await notifApi.update(prefs);
      setPrefs(d.prefs);
      setSavedAt(new Date());
    } catch {
      setErr('Uložení selhalo.');
    } finally { setBusy(false); }
  };

  if (!prefs) return <div className="text-xs text-ink-400">Načítám…</div>;

  return (
    <div className="space-y-3">
      {!mailerOk && (
        <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 text-amber-800">
          ⚠️ Email provider zatím není nakonfigurován (chybí <code>RESEND_API_KEY</code> v env).
          Nastavení tě budeme respektovat, jakmile admin klíč doplní.
        </div>
      )}
      <div className="space-y-1.5">
        {EVENTS.map(ev => (
          <label key={ev.key}
            className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition ${
              prefs[ev.key] ? 'border-cream-300 bg-cream-50' : 'border-cream-200 bg-white hover:border-cream-300'
            }`}>
            <input type="checkbox" checked={!!prefs[ev.key]} onChange={() => toggle(ev.key)}
              className="mt-0.5 w-4 h-4" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink-800">
                {ev.emoji} {ev.label}
              </div>
              <div className="text-[11px] text-ink-500">{ev.hint}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
          {busy ? 'Ukládám…' : 'Uložit'}
        </button>
        {savedAt && <span className="text-xs text-emerald-700">✓ Uloženo {savedAt.toLocaleTimeString('cs-CZ')}</span>}
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
      <div className="text-[10px] text-ink-400">
        Emaily přicházejí z noreply adresy — neodpovídej na ně. Akci provedeš kliknutím na odkaz v mailu.
      </div>
    </div>
  );
}
