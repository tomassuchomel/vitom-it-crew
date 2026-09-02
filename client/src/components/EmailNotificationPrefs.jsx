// Per-user email notification preferences (Profile → Notifikace emailem).
// Toggles per event type + rozvrh denního shrnutí (dny + čas).
// Ulož se na PUT /api/notifications/me.

import { useEffect, useState } from 'react';
import { notifications as notifApi } from '../api.js';

const EVENTS = [
  { key: 'email_daily_summary', label: 'Denní souhrn (AI reminder)', emoji: '☀️', hint: 'Rozvrh nastavíš níž — dny a čas.' },
  { key: 'email_task_assigned', label: 'Nový úkol pro mě',     emoji: '✅', hint: 'Někdo mi přiřadí nový úkol.' },
  { key: 'email_task_returned', label: 'Úkol vrácen k opravě', emoji: '🔄', hint: 'Manažer mi vrátí úkol k přepracování.' },
  { key: 'email_task_approved', label: 'Úkol schválen',        emoji: '🎉', hint: 'Manažer schválí úkol, který jsem dokončil.' },
  { key: 'email_new_question',  label: 'Nový dotaz',           emoji: '💬', hint: 'Někdo se mě zeptá v dotazech.' },
  { key: 'email_idea_new',              label: 'Nápadník: nový nápad',       emoji: '💡', hint: 'Někdo podal nový nápad (jen pro Management).' },
  { key: 'email_idea_assigned_garant',  label: 'Nápadník: jsem garant',      emoji: '👤', hint: 'Byl(a) jsem přiřazen(a) jako garant nápadu.' },
  { key: 'email_idea_approved',         label: 'Nápadník: rozhodnutí',       emoji: '📣', hint: 'Nápad byl schválen/zamítnut (týká se Management).' },
];

// 0 = neděle ... 6 = sobota (JS Date.getDay convention).
const DAYS = [
  { value: 1, label: 'Po' },
  { value: 2, label: 'Út' },
  { value: 3, label: 'St' },
  { value: 4, label: 'Čt' },
  { value: 5, label: 'Pá' },
  { value: 6, label: 'So' },
  { value: 0, label: 'Ne' },
];

export default function EmailNotificationPrefs() {
  const [prefs, setPrefs] = useState(null);
  const [mailerOk, setMailerOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [err, setErr] = useState(null);
  const [testMsg, setTestMsg] = useState(null); // { ok, text } — výsledek testovacího odeslání

  useEffect(() => {
    notifApi.get()
      .then(d => { setPrefs(d.prefs); setMailerOk(d.mailer_configured); })
      .catch(() => setErr('Načtení nastavení selhalo.'));
  }, []);

  const toggle = (key) => setPrefs(p => ({ ...p, [key]: !p[key] }));

  const toggleDay = (day) => {
    setPrefs(p => {
      const cur = Array.isArray(p.daily_summary_days) ? p.daily_summary_days : [];
      const next = cur.includes(day) ? cur.filter(d => d !== day) : [...cur, day].sort();
      return { ...p, daily_summary_days: next };
    });
  };

  const setTime = (time) => setPrefs(p => ({ ...p, daily_summary_time: time }));

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

  // Diagnostika: pošle denní report hned a ukáže přesný výsledek/důvod.
  const sendTest = async () => {
    setBusy(true); setTestMsg(null);
    try {
      const d = await notifApi.testDailySummary();
      setTestMsg({ ok: !!d.ok, text: d.message || (d.ok ? 'Odesláno.' : 'Nepovedlo se.') });
    } catch (e) {
      setTestMsg({ ok: false, text: e.response?.data?.message || 'Test se nepodařilo spustit.' });
    } finally { setBusy(false); }
  };

  if (!prefs) return <div className="text-xs text-ink-400">Načítám…</div>;

  const selectedDays = Array.isArray(prefs.daily_summary_days) ? prefs.daily_summary_days : [1,2,3,4,5];
  const timeVal = /^\d{1,2}:\d{2}$/.test(prefs.daily_summary_time || '') ? prefs.daily_summary_time : '08:05';

  return (
    <div className="space-y-3">
      {!mailerOk && (
        <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 text-amber-800">
          ⚠️ Email provider zatím není nakonfigurován. Nastavení tě budeme respektovat, jakmile bude připraveno.
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

      {/* Rozvrh denního shrnutí — jen když je zapnuté */}
      {prefs.email_daily_summary && (
        <div className="border border-cream-300 bg-white rounded-lg p-3 space-y-3">
          <div className="text-xs font-semibold text-ink-700 uppercase tracking-wide">📅 Rozvrh denního souhrnu</div>
          <div>
            <div className="text-[11px] text-ink-500 mb-1.5">Ve které dny chceš dostávat souhrn:</div>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(d => (
                <button key={d.value} type="button" onClick={() => toggleDay(d.value)}
                  className={`px-3 py-1.5 text-xs rounded-full border transition ${
                    selectedDays.includes(d.value)
                      ? 'bg-brand-500 text-white border-brand-500'
                      : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
                  }`}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-[11px] text-ink-500">V kolik hodin (Praha):</label>
            <input type="time" value={timeVal}
              onChange={(e) => setTime(e.target.value)}
              className="border border-ink-300 rounded px-2 py-1 text-sm" />
            <span className="text-[10px] text-ink-400">± 5 min tolerance (cron tick)</span>
          </div>
          {selectedDays.length === 0 && (
            <div className="text-[11px] text-amber-700">
              ⚠️ Žádné vybrané dny — souhrn ti nikdy nepřijde. Vyber alespoň jeden den, nebo vypni přepínač výše.
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
          {busy ? 'Ukládám…' : 'Uložit'}
        </button>
        {savedAt && <span className="text-xs text-emerald-700">✓ Uloženo {savedAt.toLocaleTimeString('cs-CZ')}</span>}
        {err && <span className="text-xs text-red-600">{err}</span>}
        <button onClick={sendTest} disabled={busy}
          title="Pošle denní report hned (bez čekání na ranní čas) a ukáže, jestli to funguje"
          className="ml-auto px-3 py-1.5 text-sm rounded border border-brand-300 text-brand-600 hover:bg-brand-50 disabled:opacity-50">
          ✉️ Poslat testovací report teď
        </button>
      </div>
      {testMsg && (
        <div className={`text-xs rounded p-2 border ${testMsg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          {testMsg.ok ? '✅ ' : '⚠️ '}{testMsg.text}
        </div>
      )}
      <div className="text-[10px] text-ink-400">
        Emaily přicházejí z noreply adresy — neodpovídej na ně. Akci provedeš kliknutím na odkaz v mailu.
      </div>
    </div>
  );
}
