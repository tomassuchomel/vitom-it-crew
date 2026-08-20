// MZV (Měsíční Zpětná Vazba) — dashboard „moji lidi + kdy byla poslední MZV" +
// editor profilu + list minulých MZV + editor zápisu (F2).
//
// F1: kostra + profil.
// F2: editor zápisu (4 rich-text sekce + 5 KPI hodnocení + manager notes),
//     AI shrnutí zápisu + suggest tasks, seznam úkolů z MZV.
// F3: AI shrnutí předchozích + reminder v denním reportu.

import { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import RichTextEditor from '../components/RichTextEditor.jsx';
import SuggestedTasksModal from '../components/SuggestedTasksModal.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import { StatusBadge } from '../components/TaskStatus.jsx';
import { mzv as api, tasks as tasksApi } from '../api.js';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ') : '—';

// 16 socionics typů — jmenný typ (přezdívka, jak se běžně používá) + kód (Ausra)
// a MBTI ekvivalent v závorce. Ukládá se KÓD; jméno je jen pro zobrazení.
const SOCIONICS_OPTIONS = [
  { code: 'ILE', label: 'Don Quijote (ILE / ENTp) — Vynálezce' },
  { code: 'SEI', label: 'Dumas (SEI / ISFp) — Prostředník' },
  { code: 'ESE', label: 'Hugo (ESE / ESFj) — Nadšenec' },
  { code: 'LII', label: 'Robespierre (LII / INTj) — Analytik' },
  { code: 'SLE', label: 'Žukov (SLE / ESTp) — Maršál' },
  { code: 'IEI', label: 'Jesenin (IEI / INFp) — Lyrik' },
  { code: 'EIE', label: 'Hamlet (EIE / ENFj) — Mentor' },
  { code: 'LSI', label: 'Maxim Gorkij (LSI / ISTj) — Inspektor' },
  { code: 'SEE', label: 'Napoleon (SEE / ESFp) — Politik' },
  { code: 'ILI', label: 'Balzac (ILI / INTp) — Kritik' },
  { code: 'LIE', label: 'Jack London (LIE / ENTj) — Podnikatel' },
  { code: 'ESI', label: 'Dreiser (ESI / ISFj) — Strážce' },
  { code: 'IEE', label: 'Huxley (IEE / ENFp) — Rádce' },
  { code: 'SLI', label: 'Gaben (SLI / ISTp) — Mistr' },
  { code: 'LSE', label: 'Stirlitz (LSE / ESTj) — Administrátor' },
  { code: 'EII', label: 'Dostojevskij (EII / INFj) — Humanista' },
];
const SOCIONICS_LABEL = Object.fromEntries(SOCIONICS_OPTIONS.map(o => [o.code, o.label]));
const daysAgo = (iso) => {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
};

export default function MZV() {
  const [subs, setSubs] = useState([]);
  const [selected, setSelected] = useState(null); // { id, name, ... }
  const [loading, setLoading] = useState(true);

  const load = () => api.subordinates().then(d => setSubs(d.subordinates || [])).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="MZV — měsíční zpětná vazba" subtitle="Pravidelný rozhovor s podřízenými: profil, cíle, priority, 5 KPI sekcí." />
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* Levý sloupec: seznam lidí */}
        <aside className="w-full lg:w-80 border-r border-cream-200 overflow-y-auto bg-cream-25">
          {loading ? (
            <div className="p-6 text-ink-400 text-sm">Načítám…</div>
          ) : subs.length === 0 ? (
            <div className="p-6 text-ink-400 text-sm">
              Zatím nejsi manager žádného týmu, nebo tvoje týmy nemají členy.
            </div>
          ) : (
            <ul>
              {subs.map(s => {
                const days = daysAgo(s.last_mzv_date);
                const stale = days === null || days > 30;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelected(s)}
                      className={`w-full text-left px-4 py-3 border-b border-cream-100 hover:bg-cream-50 transition flex items-center gap-3 ${
                        selected?.id === s.id ? 'bg-cream-100' : ''
                      }`}>
                      <Avatar user={s} size={32} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-ink-800 truncate">{s.name}</div>
                        <div className="text-[11px] text-ink-500 truncate">
                          {s.last_mzv_date
                            ? `Poslední MZV: ${fmtDate(s.last_mzv_date)} (${days} dní)`
                            : 'MZV zatím neproběhlo'}
                          {' · '}
                          <span className={s.has_profile ? 'text-emerald-700' : 'text-amber-700'}>
                            {s.has_profile ? 'profil ✓' : 'bez profilu'}
                          </span>
                        </div>
                      </div>
                      {stale && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">
                          !
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Detail vybraného člověka */}
        <main className="flex-1 overflow-y-auto p-6">
          {selected ? (
            <SubordinateDetail user={selected} onProfileSaved={load} />
          ) : (
            <div className="text-ink-400 text-sm italic">
              Vyber člověka vlevo — uvidíš jeho profil a historii MZV.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// Detail jednoho podřízeného: profil + historie MZV + tlačítko Zahájit MZV.
// Když je vybraný konkrétní MZV zápis, přepneme do MeetingView místo historie.
function SubordinateDetail({ user, onProfileSaved }) {
  const [profile, setProfile] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openMeetingId, setOpenMeetingId] = useState(null);
  const [historySummary, setHistorySummary] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  const genHistorySummary = async () => {
    setAiBusy(true); setHistorySummary({ loading: true });
    try {
      const d = await api.historySummary(user.id);
      setHistorySummary({ text: d.text, empty: d.empty });
    } catch (e) {
      setHistorySummary({ text: `❌ ${e.response?.data?.message || e.message}` });
    } finally { setAiBusy(false); }
  };

  const loadDetail = () => {
    api.getProfile(user.id).then(d => setProfile(d.profile || null)).catch(() => {});
    api.listMeetings(user.id).then(d => setMeetings(d.meetings || [])).catch(() => setMeetings([]));
  };
  useEffect(() => { loadDetail(); setOpenMeetingId(null); setHistorySummary(null); }, [user.id]);

  const startMZV = async () => {
    if (!confirm(`Zahájit MZV s ${user.name}?\n\nVytvoří se nový zápis na dnešní datum a rovnou tě přepnu do editoru.`)) return;
    setCreating(true);
    try {
      const d = await api.createMeeting(user.id, new Date().toISOString().slice(0, 10));
      loadDetail();
      setOpenMeetingId(d.meeting.id);
    } catch (e) {
      alert(`Chyba: ${e.response?.data?.message || e.message}`);
    } finally { setCreating(false); }
  };

  // Když je otevřený konkrétní zápis, ukazujeme editor. Profil vlevo v aside.
  if (openMeetingId) {
    return (
      <MeetingView
        meetingId={openMeetingId}
        user={user}
        profile={profile}
        onBack={() => { setOpenMeetingId(null); loadDetail(); }}
      />
    );
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <Avatar user={user} size={48} />
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-ink-800">{user.name}</h2>
          <div className="text-sm text-ink-500">{user.email}</div>
        </div>
        <button onClick={startMZV} disabled={creating}
          className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50">
          {creating ? 'Vytvářím…' : '▶ Zahájit MZV'}
        </button>
      </div>

      {/* Profil */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">👤 Profil pracovníka</div>
          <button onClick={() => setProfileOpen(true)}
            className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">
            {profile ? 'Upravit profil' : '+ Vyplnit profil'}
          </button>
        </div>
        {profile ? <ProfileView profile={profile} userId={user.id} /> : (
          <div className="text-sm text-ink-400 italic">
            Profil zatím nemá vyplněný. Přidej datum nástupu, motivaci, kariérní směr a 5 KPI sekcí.
          </div>
        )}
      </section>

      {/* Historie MZV */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
            🗓 Historie MZV ({meetings.length})
          </div>
          <button onClick={genHistorySummary} disabled={aiBusy || meetings.length === 0}
            title="AI projde poslední MZV, úkoly z nich, profil a vytvoří shrnutí + doporučení co dnes řešit."
            className="text-xs px-2 py-1 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
            📊 AI shrnutí historie
          </button>
        </div>
        {historySummary && (
          <div className="mb-3 bg-cream-50 border border-cream-200 rounded p-3">
            {historySummary.loading ? (
              <div className="text-sm text-ink-500">Generuji shrnutí…</div>
            ) : historySummary.empty ? (
              <div className="text-sm text-ink-500 italic">{historySummary.text}</div>
            ) : (
              <div className="text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">{historySummary.text}</div>
            )}
            <button onClick={() => setHistorySummary(null)}
              className="mt-2 text-xs text-ink-500 hover:underline">Skrýt</button>
          </div>
        )}
        {meetings.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            Zatím žádné MZV. Klikni „Zahájit MZV" nahoře — vytvoří se draft.
          </div>
        ) : (
          <ul className="divide-y divide-cream-100">
            {meetings.map(m => (
              <li key={m.id}
                onClick={() => setOpenMeetingId(m.id)}
                className="py-2 flex items-center gap-3 cursor-pointer hover:bg-cream-50 rounded px-1">
                <span className={`text-[10px] px-2 py-0.5 rounded border ${
                  m.status === 'completed'
                    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                    : 'bg-slate-100 text-slate-600 border-slate-300'
                }`}>
                  {m.status === 'completed' ? '✅ dokončeno' : '📝 rozpracováno'}
                </span>
                <div className="flex-1">
                  <div className="text-sm text-ink-800">MZV {fmtDate(m.meeting_date)}</div>
                  <div className="text-[11px] text-ink-500">
                    Manager: {m.manager_name || '—'} · vytvořeno {fmtDate(m.created_at)}
                  </div>
                </div>
                <span className="text-[11px] text-brand-500">Otevřít →</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {profileOpen && (
        <ProfileModal
          user={user}
          profile={profile}
          onClose={() => setProfileOpen(false)}
          onSaved={() => { setProfileOpen(false); loadDetail(); onProfileSaved?.(); }}
        />
      )}
    </div>
  );
}

// ==================== Editor MZV zápisu (F2) ====================
// 4 rich-text sekce + 5 KPI hodnocení + manager notes + AI tlačítka + úkoly.

function MeetingView({ meetingId, user, profile, onBack }) {
  const [meeting, setMeeting] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [summary, setSummary] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [meetingTasks, setMeetingTasks] = useState([]);
  const [detailTask, setDetailTask] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    api.getMeeting(meetingId).then(d => setMeeting(d.meeting));
    api.listTasks(meetingId).then(d => setMeetingTasks(d.tasks || [])).catch(() => setMeetingTasks([]));
  }, [meetingId]);

  const patch = (delta) => { setMeeting(m => ({ ...m, ...delta })); setDirty(true); };

  const save = async () => {
    if (!meeting) return;
    setSaving(true);
    try {
      await api.updateMeeting(meeting.id, {
        meeting_date: meeting.meeting_date ? String(meeting.meeting_date).slice(0, 10) : null,
        rozhovor: meeting.rozhovor || '',
        priorities: meeting.priorities || '',
        to_improve: meeting.to_improve || '',
        to_continue: meeting.to_continue || '',
        manager_notes: meeting.manager_notes || '',
        kpi_ratings: Array.isArray(meeting.kpi_ratings) ? meeting.kpi_ratings : [],
      });
      setDirty(false);
    } catch (e) {
      alert(e.response?.data?.message || e.response?.data?.error || `Uložení selhalo (${e.response?.status ?? e.message})`);
    } finally { setSaving(false); }
  };

  const complete = async () => {
    if (dirty && !confirm('Máš neuložené změny — nejdřív ulož. Pokračovat i tak?')) return;
    if (!confirm('Uzavřít tento MZV zápis? Po uzavření ho lze upravit jen po znovu-otevření.')) return;
    setSaving(true);
    try {
      const d = await api.complete(meeting.id);
      setMeeting(d.meeting);
      setDirty(false);
    } catch (e) {
      alert(e.response?.data?.message || 'Uzavření selhalo');
    } finally { setSaving(false); }
  };

  const reopen = async () => {
    if (!confirm('Otevřít uzavřený zápis k opravě?')) return;
    setSaving(true);
    try {
      const d = await api.reopen(meeting.id);
      setMeeting(d.meeting);
    } catch (e) {
      alert(e.response?.data?.message || 'Otevření selhalo');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm('Opravdu smazat tento MZV zápis? Nelze vrátit.')) return;
    try {
      await api.removeMeeting(meeting.id);
      onBack();
    } catch (e) {
      alert(e.response?.data?.message || 'Smazání selhalo');
    }
  };

  const genSummary = async () => {
    setAiBusy(true); setSummary({ loading: true });
    try {
      const d = await api.summarize(meeting.id);
      setSummary({ text: d.text });
    } catch (e) {
      setSummary({ text: `❌ ${e.response?.data?.message || e.message}` });
    } finally { setAiBusy(false); }
  };

  const genHistorySummary = async () => {
    setAiBusy(true); setSummary({ loading: true, kind: 'history' });
    try {
      const d = await api.historySummary(user.id);
      setSummary({ text: d.text, kind: 'history', empty: d.empty });
    } catch (e) {
      setSummary({ text: `❌ ${e.response?.data?.message || e.message}`, kind: 'history' });
    } finally { setAiBusy(false); }
  };

  const genSuggestTasks = async () => {
    setAiBusy(true);
    try {
      const d = await api.suggestTasks(meeting.id);
      if (!d.tasks || d.tasks.length === 0) {
        alert('AI z Priorit + „Co zlepšit" nevytáhla žádné úkoly. Napiš konkrétněji „kdo co má udělat".');
        return;
      }
      setSuggestion(d);
    } catch (e) {
      alert(`Chyba: ${e.response?.data?.message || e.message}`);
    } finally { setAiBusy(false); }
  };

  const reloadMeetingTasks = () => api.listTasks(meeting.id).then(d => setMeetingTasks(d.tasks || [])).catch(() => {});

  if (!meeting) return <div className="p-8 text-ink-400">Načítám…</div>;

  const locked = meeting.status === 'completed';
  const kpiSections = Array.isArray(profile?.kpi_sections) ? profile.kpi_sections.slice(0, 5) : [];
  const kpiRatings = Array.isArray(meeting.kpi_ratings) ? meeting.kpi_ratings : [];
  const patchKpi = (i, delta) => {
    const next = Array.from({ length: 5 }, (_, idx) => ({
      rating: kpiRatings[idx]?.rating || null,
      comment: kpiRatings[idx]?.comment || '',
      ...(idx === i ? delta : {}),
    }));
    patch({ kpi_ratings: next });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 bg-white border border-cream-200 rounded-lg p-3">
        <button onClick={onBack}
          className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">← Zpět</button>
        <Avatar user={user} size={32} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-800 truncate">
            MZV s {user.name}
          </div>
          <div className="text-[11px] text-ink-500">Datum:
            <input type="date" value={meeting.meeting_date?.slice(0, 10) || ''} disabled={locked}
              onChange={e => patch({ meeting_date: e.target.value })}
              className="ml-1 border border-ink-300 rounded px-1 py-0.5 text-[11px] disabled:bg-cream-50" />
          </div>
        </div>
        <span className={`text-[10px] px-2 py-1 rounded border ${
          locked
            ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
            : 'bg-slate-100 text-slate-700 border-slate-300'
        }`}>{locked ? '✅ Uzavřeno' : '📝 Rozpracováno'}</span>
        {dirty && !locked && (
          <button onClick={save} disabled={saving}
            className="text-xs px-2 py-1 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Ukládám…' : 'Uložit'}
          </button>
        )}
        {!locked && (
          <button onClick={complete} disabled={saving}
            className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
            ✅ Uzavřít
          </button>
        )}
        {locked && (
          <button onClick={reopen} disabled={saving}
            className="text-xs px-2 py-1 bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50">
            🔓 Otevřít
          </button>
        )}
        <button onClick={remove} className="text-xs text-red-500 hover:underline">Smazat</button>
      </div>

      {/* Kompaktní profil karta — vždy na očích */}
      <ProfileCard profile={profile} userId={user.id} onEdit={() => setProfileOpen(true)} />

      {/* AI panel */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">🤖 AI</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={genHistorySummary} disabled={aiBusy}
            title="AI projde poslední MZV s tímto člověkem, úkoly z nich, profil — a vytvoří shrnutí + 3-5 doporučení co dnes řešit."
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
            📊 Shrnutí historie + doporučení
          </button>
          <button onClick={genSummary} disabled={aiBusy}
            title="AI shrne obsah tohoto zápisu (rozhovor + priority + zlepšit + pokračovat) do 3-5 vět."
            className="px-3 py-1.5 text-sm bg-slate-600 text-white rounded hover:bg-slate-700 disabled:opacity-50">
            📝 Shrnout tento zápis
          </button>
          <button onClick={genSuggestTasks} disabled={aiBusy}
            title={'AI vytáhne z Priorit a „Co zlepšit" konkrétní úkoly. Otevře se dialog pro potvrzení.'}
            className="px-3 py-1.5 text-sm bg-slate-600 text-white rounded hover:bg-slate-700 disabled:opacity-50">
            🎯 Vygenerovat úkoly ze zápisu
          </button>
        </div>
        {summary && (
          <div className="mt-3 bg-slate-50 border border-slate-200 rounded p-3">
            {summary.loading
              ? <div className="text-sm text-ink-500">Generuji shrnutí…</div>
              : <div className="text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">{summary.text}</div>}
            <button onClick={() => setSummary(null)} className="mt-2 text-xs text-ink-500 hover:underline">Skrýt</button>
          </div>
        )}
      </section>

      {/* 4 textové sekce zápisu */}
      <NoteSection label="💬 Rozhovor" hint="Volně o čem jste si povídali — osobní i pracovní."
        value={meeting.rozhovor || ''} onChange={v => patch({ rozhovor: v })} disabled={locked} />
      <NoteSection label="🎯 Priority na další období" hint="3–5 konkrétních bodů. AI z nich vytáhne úkoly."
        value={meeting.priorities || ''} onChange={v => patch({ priorities: v })} disabled={locked} />
      <NoteSection label="🔧 Co by měl zlepšit" hint="1–3 věci konstruktivně."
        value={meeting.to_improve || ''} onChange={v => patch({ to_improve: v })} disabled={locked} />
      <NoteSection label="⭐ V čem je dobrý a v čem pokračovat" hint="1–3 věci — pochvala."
        value={meeting.to_continue || ''} onChange={v => patch({ to_continue: v })} disabled={locked} />

      {/* 5 KPI hodnocení — manager only */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">
          📊 5 KPI sekcí — hodnocení (jen manager)
        </div>
        {kpiSections.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            V profilu nejsou definované KPI sekce. Otevři profil a přidej je (max 5).
          </div>
        ) : (
          <div className="space-y-3">
            {kpiSections.map((s, i) => (
              <KpiRow key={i}
                index={i}
                section={s}
                rating={kpiRatings[i]?.rating}
                comment={kpiRatings[i]?.comment || ''}
                disabled={locked}
                onSet={(delta) => patchKpi(i, delta)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Privátní poznámky managera */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">
          🔒 Poznámky managera (privátní — nevidí podřízený)
        </div>
        <textarea rows={4} value={meeting.manager_notes || ''} disabled={locked}
          onChange={e => patch({ manager_notes: e.target.value })}
          placeholder="Cokoli, co si potřebuješ pamatovat — dojmy, obavy, plány, které zatím nechceš sdílet."
          className="w-full border border-ink-300 rounded px-2 py-1.5 text-sm disabled:bg-cream-50" />
      </section>

      {/* Úkoly z MZV */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">
          🎯 Úkoly z MZV ({meetingTasks.length})
        </div>
        {meetingTasks.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            Zatím žádné úkoly. Použij „🎯 Vygenerovat úkoly ze zápisu" nahoře — AI vytáhne z Priorit + Co zlepšit.
          </div>
        ) : (
          <ul className="divide-y divide-cream-100">
            {meetingTasks.map(t => (
              <li key={t.id}
                onClick={async () => {
                  try { const d = await tasksApi.get(t.id); setDetailTask(d.task); } catch { /* ignore */ }
                }}
                className="py-2 flex items-center gap-3 cursor-pointer hover:bg-cream-50 rounded px-1">
                <StatusBadge status={t.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink-800 truncate">{t.title}</div>
                  <div className="text-[11px] text-ink-500 truncate">
                    {t.project_name}
                    {t.assignee_name && ` · 👤 ${t.assignee_name}`}
                    {t.due_date && ` · 📅 ${new Date(t.due_date).toLocaleDateString('cs-CZ')}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dirty && !locked && (
        <div className="sticky bottom-4 flex justify-end">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg shadow-lg hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Ukládám…' : '💾 Uložit změny'}
          </button>
        </div>
      )}

      {suggestion && (
        <SuggestedTasksModal
          suggestion={suggestion}
          sourceNote={{ id: meeting.id, title: `MZV ${fmtDate(meeting.meeting_date)}`, mzv_meeting_id: meeting.id }}
          sourceScope="mzv"
          onClose={() => setSuggestion(null)}
          onCreated={() => { setSuggestion(null); reloadMeetingTasks(); }}
        />
      )}
      {detailTask && (
        <TaskDetailModal task={detailTask} onClose={() => { setDetailTask(null); reloadMeetingTasks(); }} onUpdate={() => {}} />
      )}
      {profileOpen && (
        <ProfileModal
          user={user}
          profile={profile}
          onClose={() => setProfileOpen(false)}
          onSaved={() => { setProfileOpen(false); onBack(); }}
        />
      )}
    </div>
  );
}

// Kompaktní karta profilu — přehled klíčových údajů. Klik na „upravit" otevře modal.
function ProfileCard({ profile, userId, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  if (!profile) {
    return (
      <section className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-amber-700">⚠️ Profil zatím není vyplněný.</span>
          <button onClick={onEdit} className="text-xs text-brand-500 hover:underline">Vyplnit teď →</button>
        </div>
      </section>
    );
  }
  const children = Array.isArray(profile.children) ? profile.children : [];
  const age = yearsMonthsSince(profile.birth_date)?.years;
  const years = yearsMonthsSince(profile.hire_date)?.years;
  return (
    <section className="bg-cream-25 border border-cream-200 rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <MiniField label="Ve firmě od" value={profile.hire_date && `${fmtDate(profile.hire_date)}${years != null ? ` · ${years} let` : ''}`} />
          <MiniField label="Narozeniny"  value={profile.birth_date && `${fmtDate(profile.birth_date)}${age != null ? ` · ${age} let` : ''}`} />
          <MiniField label="Ambice"
            value={profile.ambition_type === 'growth' ? '🚀 Růst'
                  : profile.ambition_type === 'stability' ? '⭐ Stabilita' : '—'} />
          <MiniField label="Děti" value={children.length > 0 ? children.map(c => c.name).join(', ') : '—'} />
        </div>
        <div className="shrink-0 flex flex-col gap-1">
          <button onClick={onEdit}
            className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">
            Upravit profil
          </button>
          <button onClick={() => setExpanded(v => !v)}
            className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">
            {expanded ? '▾ Skrýt detail' : '▸ Celý profil'}
          </button>
        </div>
      </div>
      {!expanded && profile.career_direction && (
        <div className="mt-2 text-[12px] text-ink-700">
          <strong>Směřování:</strong> {profile.career_direction}
        </div>
      )}
      {!expanded && profile.feedback_history && (
        <div className="mt-1 text-[12px] text-ink-600 italic">
          {profile.feedback_history}
        </div>
      )}
      {expanded && (
        <div className="mt-3 border-t border-cream-200 pt-3">
          <ProfileView profile={profile} userId={userId} />
        </div>
      )}
    </section>
  );
}
function MiniField({ label, value }) {
  return (
    <div>
      <div className="uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-ink-800">{value || '—'}</div>
    </div>
  );
}

// Jedna textová sekce zápisu s rich text editorem.
function NoteSection({ label, hint, value, onChange, disabled }) {
  return (
    <section className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">{label}</div>
      {hint && <div className="text-[11px] text-ink-400 mb-2">{hint}</div>}
      <div className={disabled ? 'opacity-70 pointer-events-none' : ''}>
        <RichTextEditor value={value} onChange={onChange} />
      </div>
    </section>
  );
}

// Řádek pro jednu KPI sekci: název + 1-5 hodnocení + komentář.
function KpiRow({ index, section, rating, comment, disabled, onSet }) {
  const buttons = [1, 2, 3, 4, 5];
  return (
    <div className="border border-cream-200 rounded p-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-800 truncate">
            {index + 1}. {section.name || <em className="text-ink-400 font-normal">(bez názvu)</em>}
          </div>
          {section.description && (
            <div className="text-[11px] text-ink-500 truncate">{section.description}</div>
          )}
        </div>
        <div className="flex gap-0.5 shrink-0">
          {buttons.map(n => {
            const active = rating === n;
            return (
              <button key={n} type="button" disabled={disabled}
                onClick={() => onSet({ rating: active ? null : n })}
                title={`${n}/5`}
                className={`w-7 h-7 text-xs rounded transition ${
                  active
                    ? (n <= 2 ? 'bg-red-500 text-white' : n === 3 ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white')
                    : 'bg-cream-100 text-ink-400 hover:bg-cream-200 disabled:opacity-50'
                }`}>{n}</button>
            );
          })}
        </div>
      </div>
      <input type="text" value={comment} disabled={disabled}
        onChange={e => onSet({ comment: e.target.value })}
        placeholder="Krátký komentář (co konkrétně vidím)"
        className="w-full border border-cream-300 rounded px-2 py-1 text-xs disabled:bg-cream-50" />
    </div>
  );
}

// Read-only pohled na profil — kompaktní kartička s kolonkami.
// ── Odvozené připomínky z profilu (výročí, narozeniny, děti) ───────────────
// Počítá se z už uložených dat (nástup, narození, děti) — žádný nový sběr.
// Okno: události v příštích 60 dnech; u dětí dárková připomínka do 30 dní.
function daysUntilNext(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
  return { days: Math.round((next - today) / 86400000), turningYears: next.getFullYear() - d.getFullYear() };
}

// Celé roky + měsíce mezi datem a dneškem (pro věk / „ve firmě 6 let 3 měsíce").
function yearsMonthsSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}

function tenureLabel(dateStr) {
  const t = yearsMonthsSince(dateStr);
  if (!t) return null;
  const yl = t.years > 0 ? `${t.years} ${t.years === 1 ? 'rok' : t.years < 5 ? 'roky' : 'let'}` : '';
  const ml = t.months > 0 ? `${t.months} ${t.months === 1 ? 'měsíc' : t.months < 5 ? 'měsíce' : 'měsíců'}` : '';
  return [yl, ml].filter(Boolean).join(' ') || 'méně než měsíc';
}

function daysLabel(n) {
  if (n === 0) return 'dnes';
  if (n === 1) return 'zítra';
  return `za ${n} ${n < 5 ? 'dny' : 'dní'}`;
}

function buildReminders(profile, windowDays = 60) {
  const out = [];
  const anniv = daysUntilNext(profile.hire_date);
  if (anniv && anniv.days <= windowDays) {
    out.push({ icon: '🎉', title: `${anniv.turningYears}. výročí ve firmě`, days: anniv.days });
  }
  const bday = daysUntilNext(profile.birth_date);
  if (bday && bday.days <= windowDays) {
    out.push({ icon: '🎂', title: `Narozeniny (bude ${bday.turningYears})`, days: bday.days });
  }
  for (const c of (Array.isArray(profile.children) ? profile.children : [])) {
    // Dětské narozeniny ukazujeme vždy (kvůli plánování dárku), ne jen v okně.
    const cb = daysUntilNext(c.birth_date);
    if (cb) {
      out.push({
        icon: '🎁',
        title: `${c.name || 'Dítě'} — ${cb.turningYears}. narozeniny`,
        hint: cb.days <= 30 ? 'kup dárek' : null,
        days: cb.days,
      });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

function ProfileReminders({ profile }) {
  const items = buildReminders(profile);
  if (items.length === 0) {
    return (
      <div className="text-xs text-ink-400 italic mb-3">
        Žádné blížící se výročí ani narozeniny (příštích 60 dní).
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
      {items.map((r, i) => (
        <div key={i}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${
            r.days <= 7 ? 'bg-accent-50 border-accent-200' : 'bg-cream-50 border-ink-300'
          }`}>
          <span className="text-lg leading-none">{r.icon}</span>
          <div className="min-w-0">
            <div className="font-medium text-ink-800 truncate text-sm">{r.title}</div>
            <div className="text-xs text-ink-500">{daysLabel(r.days)}{r.hint ? ` · ${r.hint}` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Skóre plnění úkolů podřízeného (v termínu) + měsíční trend jako sparkline.
// Data z /api/mzv/score/:userId (stejná definice jako Scoreboard).
function ProfileScore({ userId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let ok = true;
    api.score(userId, 6).then(d => { if (ok) setData(d); }).catch(() => { if (ok) setErr(true); });
    return () => { ok = false; };
  }, [userId]);

  if (err) return null;
  if (!data) return <div className="text-xs text-ink-400 mb-4">Načítám skóre…</div>;
  if (data.success_rate == null) {
    return <div className="text-xs text-ink-400 italic mb-4">Zatím není dost dokončených úkolů s termínem pro skóre.</div>;
  }

  const months = Array.isArray(data.months) ? data.months : [];
  const rated = months.filter(m => m.rate != null);
  const last = rated[rated.length - 1]?.rate;
  const prev = rated[rated.length - 2]?.rate;
  const delta = (last != null && prev != null) ? last - prev : null;
  const cats = [
    { key: 'on_time', label: 'včas', count: data.done_on_time },
    { key: 'late', label: 'pozdě', count: data.done_late },
    { key: 'overdue', label: 'po termínu', count: data.overdue },
    { key: 'active', label: 'rozpracované', count: data.active },
  ];
  const openList = open ? (data.tasks?.[open] || []) : [];
  const taskDate = (t) => (open === 'on_time' || open === 'late')
    ? (t.completed_at && fmtDate(t.completed_at))
    : (t.due_date && fmtDate(t.due_date));

  return (
    <div className="rounded-lg border border-ink-300 bg-cream-50 px-3 py-2 mb-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] uppercase tracking-wide text-ink-500">📈 Skóre plnění (v termínu)</div>
        {delta != null && (
          <span className={`text-xs font-medium ${delta > 0 ? 'text-green-600' : delta < 0 ? 'text-accent-600' : 'text-ink-500'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '■'} {Math.abs(delta)} b. vs minulý měsíc
          </span>
        )}
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <div className="text-2xl font-bold text-ink-800 leading-none">{data.success_rate}%</div>
        <div className="flex flex-wrap gap-1.5 pb-0.5">
          {cats.map(c => (
            <button key={c.key} type="button" disabled={c.count === 0}
              onClick={() => setOpen(open === c.key ? null : c.key)}
              className={`text-xs px-2 py-0.5 rounded-full border transition ${
                c.count === 0 ? 'text-ink-400 border-ink-300 cursor-default'
                : open === c.key ? 'bg-brand-500 text-white border-brand-500'
                : 'text-ink-600 border-ink-300 hover:bg-cream-100'
              }`}>
              {c.count} {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-0.5 ml-auto h-8" title="Posledních 6 měsíců (% v termínu)">
          {months.map((m, i) => (
            <div key={i} title={`${m.ym}: ${m.rate == null ? '—' : m.rate + '%'}`}
              className="w-2 rounded-t bg-brand-300"
              style={{ height: `${m.rate == null ? 2 : Math.max(4, (m.rate / 100) * 32)}px` }} />
          ))}
        </div>
      </div>
      {open && (
        <div className="mt-2 border-t border-ink-300 pt-2">
          {openList.length === 0 ? (
            <div className="text-xs text-ink-400 italic">Žádné úkoly v této kategorii.</div>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {openList.map(t => (
                <li key={t.id} className="text-xs text-ink-700 flex justify-between gap-2">
                  <span className="truncate">{t.title}<span className="text-ink-400"> · {t.project_name}</span></span>
                  <span className="text-ink-400 shrink-0">{taskDate(t)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Popisek dítěte: jméno + věk + za kolik dní narozeniny (stejný detail jako u pracovníka).
function childLabel(c) {
  const name = c.name || 'Dítě';
  if (!c.birth_date) return name;
  const age = yearsMonthsSince(c.birth_date)?.years;
  const next = daysUntilNext(c.birth_date);
  const bits = [fmtDate(c.birth_date)];
  if (age != null) bits.push(`${age} ${age === 1 ? 'rok' : age < 5 ? 'roky' : 'let'}`);
  if (next) bits.push(`nar. ${daysLabel(next.days)}`);
  return `${name} (${bits.join(' · ')})`;
}

function ProfileView({ profile, userId }) {
  // Skryj prázdné KPI sloty (uložené bez názvu i popisu).
  const kpi = (Array.isArray(profile.kpi_sections) ? profile.kpi_sections : []).filter(s => s?.name || s?.description);
  const children = Array.isArray(profile.children) ? profile.children : [];
  const age = yearsMonthsSince(profile.birth_date)?.years;
  const tenure = tenureLabel(profile.hire_date);
  return (
    <>
    <ProfileReminders profile={profile} />
    <ProfileScore userId={userId} />
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <Field label="Narození" value={profile.birth_date && `${fmtDate(profile.birth_date)}${age != null ? ` · ${age} let` : ''}`} />
      <Field label="Ve firmě od" value={profile.hire_date && `${fmtDate(profile.hire_date)}${tenure ? ` · ${tenure}` : ''}`} />
      <Field label="Ambice"
        value={profile.ambition_type === 'growth' ? 'Růst (superstar)'
              : profile.ambition_type === 'stability' ? 'Stabilita (rockstar)' : null} />
      <Field label="Preferovaný feedback" value={profile.feedback_style} />
      <div className="md:col-span-2">
        <Field label="Děti" value={children.length > 0
          ? children.map(childLabel).join(', ')
          : null} />
      </div>
      <div className="md:col-span-2">
        <SocionicsSection socionicsType={profile.socionics_type} userId={userId} />
      </div>
      <Field long label="Proč pracuje / co peníze řeší" value={profile.work_motivation} />
      <Field long label="Životní cíle"                    value={profile.life_goals} />
      <Field long label="Kariérní směřování"              value={profile.career_direction} />
      <Field long label="Silné stránky"                   value={profile.strengths} />
      <Field long label="Vývojové oblasti"                value={profile.development_areas} />
      <Field long label="Zdroje energie / vyčerpání"      value={profile.energy_sources} />
      <Field long label="Aktuální osobní kontext"         value={profile.personal_context} />
      <Field long label="Historie zpětné vazby"           value={profile.feedback_history} />
      <div className="md:col-span-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">📊 KPI sekce ({kpi.length}/5)</div>
        {kpi.length === 0 ? (
          <div className="text-xs text-ink-400 italic">Zatím nedefinováno.</div>
        ) : (
          <ol className="text-sm space-y-1 list-decimal list-inside">
            {kpi.map((s, i) => (
              <li key={i}>
                <strong>{s.name || <em className="text-ink-400">(bez názvu)</em>}</strong>
                {s.description && <span className="text-ink-500"> — {s.description}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
    </>
  );
}

// Socionický typ + tlačítko na AI insights (silné/slabé, komunikace, motivace).
// AI se negeneruje automaticky — jen na klik, ať neplýtváme tokeny při každém
// otevření profilu. Insights se ale nekešují, dat je málo.
function SocionicsSection({ socionicsType, userId }) {
  const [insights, setInsights] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true); setInsights({ loading: true });
    try {
      const d = await api.socionicsInsights(userId);
      setInsights({ text: d.text });
    } catch (e) {
      setInsights({ text: `❌ ${e.response?.data?.message || e.message}` });
    } finally { setBusy(false); }
  };

  if (!socionicsType) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-500">🧠 Socionický typ</div>
        <div className="text-sm text-ink-400 italic">—</div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-ink-500">🧠 Socionický typ</div>
        <button onClick={load} disabled={busy}
          title="AI popíše silné/slabé stránky, komunikaci a motivaci pro tento typ."
          className="text-xs px-2 py-0.5 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
          {busy ? 'Načítám…' : (insights ? 'Načíst znovu' : '🧠 AI insights')}
        </button>
      </div>
      <div className="text-sm text-ink-800 font-medium">{SOCIONICS_LABEL[socionicsType] || socionicsType}</div>
      {insights && (
        <div className="mt-2 bg-cream-50 border border-cream-200 rounded p-3">
          {insights.loading
            ? <div className="text-xs text-ink-500">AI generuje popis typu {socionicsType}…</div>
            : <div className="text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">{insights.text}</div>}
          <button onClick={() => setInsights(null)}
            className="mt-2 text-xs text-ink-500 hover:underline">Skrýt</button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, long }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      {value ? (
        <div className={`text-sm text-ink-800 ${long ? 'whitespace-pre-wrap' : ''}`}>{value}</div>
      ) : (
        <div className="text-sm text-ink-400 italic">—</div>
      )}
    </div>
  );
}

// Modal na editaci profilu. Ukládá kompletní tělo přes PUT.
function ProfileModal({ user, profile, onClose, onSaved }) {
  const [form, setForm] = useState({
    birth_date: profile?.birth_date?.slice(0, 10) || '',
    hire_date: profile?.hire_date?.slice(0, 10) || '',
    children: Array.isArray(profile?.children) ? profile.children : [],
    work_motivation: profile?.work_motivation || '',
    life_goals: profile?.life_goals || '',
    career_direction: profile?.career_direction || '',
    ambition_type: profile?.ambition_type || '',
    socionics_type: profile?.socionics_type || '',
    strengths: profile?.strengths || '',
    development_areas: profile?.development_areas || '',
    feedback_style: profile?.feedback_style || '',
    energy_sources: profile?.energy_sources || '',
    personal_context: profile?.personal_context || '',
    feedback_history: profile?.feedback_history || '',
    kpi_sections: Array.isArray(profile?.kpi_sections) && profile.kpi_sections.length > 0
      ? profile.kpi_sections
      : [{ name: '', description: '' }, { name: '', description: '' }, { name: '', description: '' }, { name: '', description: '' }, { name: '', description: '' }],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.putProfile(user.id, form);
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setBusy(false); }
  };

  const addChild = () => set({ children: [...form.children, { name: '', birth_date: '' }] });
  const patchChild = (i, delta) => set({ children: form.children.map((c, idx) => idx === i ? { ...c, ...delta } : c) });
  const removeChild = (i) => set({ children: form.children.filter((_, idx) => idx !== i) });

  const patchKpi = (i, delta) => set({
    kpi_sections: form.kpi_sections.map((s, idx) => idx === i ? { ...s, ...delta } : s),
  });

  return (
    <Modal open={true} onClose={onClose} title={`Profil: ${user.name}`}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Ukládám…' : 'Uložit'}
        </button>
      </>}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Datum narození</span>
            <input type="date" value={form.birth_date} onChange={e => set({ birth_date: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Datum nástupu do firmy</span>
            <input type="date" value={form.hire_date} onChange={e => set({ hire_date: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-600">Děti</span>
            <button onClick={addChild} className="text-xs text-brand-500 hover:underline">+ Přidat dítě</button>
          </div>
          {form.children.length === 0 ? (
            <div className="text-xs text-ink-400 italic mt-1">Bez záznamu.</div>
          ) : (
            <div className="mt-1 space-y-1">
              {form.children.map((c, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="text" value={c.name || ''} placeholder="Jméno"
                    onChange={e => patchChild(i, { name: e.target.value })}
                    className="flex-1 border border-ink-300 rounded px-2 py-1" />
                  <input type="date" value={c.birth_date || ''}
                    onChange={e => patchChild(i, { birth_date: e.target.value })}
                    className="border border-ink-300 rounded px-2 py-1" />
                  <button onClick={() => removeChild(i)} className="text-red-500 text-xs">×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <TextArea label="Proč pracuje / co mu peníze v životě řeší" value={form.work_motivation} onChange={v => set({ work_motivation: v })} />
        <TextArea label="Životní cíle"                              value={form.life_goals}       onChange={v => set({ life_goals: v })} />
        <TextArea label="Kariérní směřování — kam chce postoupit, co vyzkoušet" value={form.career_direction} onChange={v => set({ career_direction: v })} />

        <label className="block">
          <span className="text-xs font-medium text-ink-600">
            🧠 Socionický typ (16 typů dle Augustinavičiūtė) — po uložení najdeš v profilu
            tlačítko „AI insights" na silné/slabé stránky, komunikaci a motivaci
          </span>
          <select value={form.socionics_type} onChange={e => set({ socionics_type: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
            <option value="">— nezvoleno —</option>
            {SOCIONICS_OPTIONS.map(o => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-ink-600">
            Aktuální ambice (Radical Candor)
          </span>
          <select value={form.ambition_type} onChange={e => set({ ambition_type: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
            <option value="">— nezvoleno —</option>
            <option value="growth">🚀 Růst (superstar) — chce výzvy, novou funkci</option>
            <option value="stability">⭐ Stabilita (rockstar) — chce prohlubovat, ne měnit</option>
          </select>
        </label>

        <TextArea label="Silné stránky (co ho baví + v čem excelluje)"     value={form.strengths}         onChange={v => set({ strengths: v })} />
        <TextArea label="Vývojové oblasti (na čem dlouhodobě pracuje)"     value={form.development_areas} onChange={v => set({ development_areas: v })} />
        <TextArea label="Preferovaný styl zpětné vazby (přímý/jemný, hned/s odstupem)" value={form.feedback_style} onChange={v => set({ feedback_style: v })} />
        <TextArea label="Zdroje energie a únavy"                           value={form.energy_sources}    onChange={v => set({ energy_sources: v })} />
        <TextArea label="Aktuální osobní kontext (novorozenec, nemoc v rodině, stavba…)" value={form.personal_context} onChange={v => set({ personal_context: v })} />
        <TextArea label="Historie zásadní zpětné vazby (3–5 vět, čeho jsme se opakovaně dotýkali)" value={form.feedback_history} onChange={v => set({ feedback_history: v })} />

        {/* KPI sekce — vždy 5 slotů. */}
        <div>
          <div className="text-xs font-medium text-ink-600 mb-1">
            📊 5 KPI sekcí — na co se budeme každý měsíc dívat
          </div>
          <div className="text-[11px] text-ink-500 mb-2">
            Slovní hodnocení dnes; napojení na statistiky přijde v další fázi.
          </div>
          <div className="space-y-2">
            {form.kpi_sections.slice(0, 5).map((s, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(150px,1fr)_2fr] gap-2 items-start">
                <input type="text" value={s.name || ''} placeholder={`Sekce ${i + 1} (např. „Kvalita kódu")`}
                  onChange={e => patchKpi(i, { name: e.target.value })}
                  className="border border-ink-300 rounded px-2 py-1" />
                <input type="text" value={s.description || ''} placeholder="Krátký popis / co konkrétně se sleduje"
                  onChange={e => patchKpi(i, { description: e.target.value })}
                  className="border border-ink-300 rounded px-2 py-1" />
              </div>
            ))}
          </div>
        </div>

        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </div>
    </Modal>
  );
}

function TextArea({ label, value, onChange, rows = 2 }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink-600">{label}</span>
      <textarea rows={rows} value={value} onChange={e => onChange(e.target.value)}
        className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
    </label>
  );
}
