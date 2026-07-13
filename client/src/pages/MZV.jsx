// MZV (Měsíční Zpětná Vazba) — dashboard „moji lidi + kdy byla poslední MZV" +
// editor profilu + list minulých MZV + tlačítko Zahájit MZV (zatím jen vytvoří draft).
//
// F1: kostra. F2 přidá editor zápisu (rozhovor, priority, zlepšit, pokračovat + 5 KPI sekcí).
// F3: AI shrnutí předchozích, návrh úkolů, shrnutí zápisu.

import { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import { mzv as api } from '../api.js';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ') : '—';
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
function SubordinateDetail({ user, onProfileSaved }) {
  const [profile, setProfile] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadDetail = () => {
    api.getProfile(user.id).then(d => setProfile(d.profile || null)).catch(() => {});
    api.listMeetings(user.id).then(d => setMeetings(d.meetings || [])).catch(() => setMeetings([]));
  };
  useEffect(() => { loadDetail(); }, [user.id]);

  const startMZV = async () => {
    if (!confirm(`Zahájit MZV s ${user.name}?\n\nVytvoří se draft na dnešní datum. Zápis editace přijde v další verzi.`)) return;
    setCreating(true);
    try {
      await api.createMeeting(user.id, new Date().toISOString().slice(0, 10));
      loadDetail();
    } catch (e) {
      alert(`Chyba: ${e.response?.data?.message || e.message}`);
    } finally { setCreating(false); }
  };

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
        {profile ? <ProfileView profile={profile} /> : (
          <div className="text-sm text-ink-400 italic">
            Profil zatím nemá vyplněný. Přidej datum nástupu, motivaci, kariérní směr a 5 KPI sekcí.
          </div>
        )}
      </section>

      {/* Historie MZV */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-3">
          🗓 Historie MZV ({meetings.length})
        </div>
        {meetings.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            Zatím žádné MZV. Klikni „Zahájit MZV" nahoře — vytvoří se draft.
          </div>
        ) : (
          <ul className="divide-y divide-cream-100">
            {meetings.map(m => (
              <li key={m.id} className="py-2 flex items-center gap-3">
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
                <span className="text-[11px] text-ink-400">Editor přijde ve F2</span>
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

// Read-only pohled na profil — kompaktní kartička s kolonkami.
function ProfileView({ profile }) {
  const kpi = Array.isArray(profile.kpi_sections) ? profile.kpi_sections : [];
  const children = Array.isArray(profile.children) ? profile.children : [];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <Field label="Narození" value={profile.birth_date && fmtDate(profile.birth_date)} />
      <Field label="Ve firmě od" value={profile.hire_date && fmtDate(profile.hire_date)} />
      <Field label="Ambice"
        value={profile.ambition_type === 'growth' ? 'Růst (superstar)'
              : profile.ambition_type === 'stability' ? 'Stabilita (rockstar)' : null} />
      <Field label="Preferovaný feedback" value={profile.feedback_style} />
      <div className="md:col-span-2">
        <Field label="Děti" value={children.length > 0
          ? children.map(c => `${c.name}${c.birth_date ? ` (${fmtDate(c.birth_date)})` : ''}`).join(', ')
          : null} />
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
