// Porady — pravidelné schůzky, každý typ (např. "středeční porada IT") má
// vlastní kostru agendy a seznam zápisů.
//
// F1a: CRUD, editor, prezence.
// F1b (další commit): AI sumář předchozích, AI návrh agendy, rozhodnutí blok.

import { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import Avatar from '../components/Avatar.jsx';
import RichTextEditor from '../components/RichTextEditor.jsx';
import SuggestedTasksModal from '../components/SuggestedTasksModal.jsx';
import TaskDetailModal from '../components/TaskDetailModal.jsx';
import { StatusBadge } from '../components/TaskStatus.jsx';
import { meetings as api, users as usersApi, teams as teamsApi, tasks as tasksApi, projects as projectsApi } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useTeams } from '../teams.jsx';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '';
const fmtDateShort = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '—';

// Vyparsuje bodové doporučení ze sekce '## 📌 Doporučení k řešení dnes' v Markdownu.
// Vrátí array krátkých názvů (max 150 znaků) — buď mezi **...** kdyz je bod
// psaný jako "1. **Název** – popis", nebo první část řádku.
function parseRecommendations(text) {
  if (!text) return [];
  const idx = text.search(/##\s*[^\n]*Doporučení/i);
  if (idx === -1) return [];
  const section = text.slice(idx);
  const lines = section.split('\n');
  const items = [];
  for (const line of lines) {
    // "1. **Název** – popis" nebo "- **Název** – ..."
    const m1 = line.match(/^\s*(?:\d+\.|-|\*)\s*\*\*([^*]+)\*\*/);
    if (m1) { items.push(m1[1].trim()); continue; }
    // "1. Text bodu" (bez tučného)
    const m2 = line.match(/^\s*(?:\d+\.|-|\*)\s+([^*].+)$/);
    if (m2) {
      const raw = m2[1].trim();
      // Odstřih po pomlčce (obvykle "Název – popis")
      const cut = raw.split(/\s+[–\-—]\s+/)[0];
      items.push(cut.slice(0, 150));
    }
  }
  return items;
}

export default function Meetings() {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTypeId, setSelectedTypeId] = useState(null);
  const [meetingsList, setMeetingsList] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  // null = zavřený, 'new' = create, { ...type } = edit
  const [typeModal, setTypeModal] = useState(null);

  const load = () => {
    setLoading(true);
    api.listTypes().then(d => setTypes(d.types || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!selectedTypeId) { setMeetingsList([]); return; }
    api.listMeetings(selectedTypeId).then(d => setMeetingsList(d.meetings || []));
  }, [selectedTypeId]);

  const selectedType = types.find(t => t.id === selectedTypeId);

  return (
    <div className="h-full flex">
      {/* Sidebar: typy porad */}
      <aside className="w-64 border-r border-cream-200 bg-white flex flex-col">
        <div className="px-4 py-3 border-b border-cream-200 flex items-center justify-between">
          <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">🗓 Typy porad</div>
          <button onClick={() => setTypeModal('new')}
            title="Vytvořit nový typ porady (např. 'středeční porada IT')"
            className="text-xs px-2 py-0.5 border border-ink-300 rounded hover:bg-cream-50">+</button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="px-4 py-2 text-xs text-ink-400">Načítám…</div>
          ) : types.length === 0 ? (
            <div className="px-4 py-2 text-xs text-ink-400 italic">
              Zatím žádný typ. Vytvoř první — např. „středeční porada IT".
            </div>
          ) : (
            <ul>
              {types.map(t => (
                <li key={t.id}>
                  <button onClick={() => { setSelectedTypeId(t.id); setSelectedMeetingId(null); }}
                    className={`w-full text-left px-4 py-2 hover:bg-cream-50 transition ${
                      selectedTypeId === t.id ? 'bg-cream-100' : ''
                    }`}>
                    <div className="text-sm font-medium text-ink-800 truncate">{t.name}</div>
                    <div className="text-[10px] text-ink-500">
                      {t.visibility === 'team' ? (t.team_name || '—') : '👥 konkrétní lidé'}
                      {' · '}{t.meetings_count} zápisů
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Middle: seznam zápisů */}
      {selectedType && (
        <aside className="w-72 border-r border-cream-200 bg-white flex flex-col">
          <div className="px-4 py-3 border-b border-cream-200 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide truncate">{selectedType.name}</div>
              <div className="text-[10px] text-ink-400">{meetingsList.length} zápisů</div>
            </div>
            <button onClick={() => setTypeModal(selectedType)}
              title="Upravit typ porady (název, kostru agendy, organizátora, viditelnost)"
              className="text-xs px-2 py-0.5 border border-ink-300 rounded hover:bg-cream-50 shrink-0">⚙</button>
            <button onClick={async () => {
                const today = new Date().toISOString().slice(0, 10);
                const d = await api.createMeeting(selectedType.id, { meeting_date: today });
                setSelectedMeetingId(d.meeting.id);
                setMeetingsList(prev => [d.meeting, ...prev]);
              }}
              title="Vytvořit nový zápis (agenda se předvyplní z kostry typu)"
              className="text-xs px-2 py-0.5 bg-brand-500 text-white rounded hover:bg-brand-600 shrink-0">+ Zápis</button>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {meetingsList.length === 0 ? (
              <div className="px-4 py-2 text-xs text-ink-400 italic">Zatím žádný zápis.</div>
            ) : (
              <ul>
                {meetingsList.map(m => (
                  <li key={m.id}>
                    <button onClick={() => setSelectedMeetingId(m.id)}
                      className={`w-full text-left px-4 py-2.5 hover:bg-cream-50 border-b border-cream-100 transition ${
                        selectedMeetingId === m.id ? 'bg-accent-50 border-l-2 border-l-accent-500' : ''
                      }`}>
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium text-ink-800 truncate flex-1">{m.title}</div>
                        {m.status && (
                          <span className="text-[9px]">
                            {m.status === 'draft' && '📝'}
                            {m.status === 'in_progress' && '🔴'}
                            {m.status === 'completed' && '✅'}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-ink-500">
                        📅 {fmtDateShort(m.meeting_date)}
                        {m.meeting_time && ` ${m.meeting_time.slice(0, 5)}`}
                        {' · '}
                        <span title="Přítomní / pozvaní">👥 {m.present_count}/{m.attendee_count}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      )}

      {/* Right: detail zápisu */}
      <main className="flex-1 overflow-y-auto bg-cream-50">
        {selectedMeetingId ? (
          <MeetingDetail
            meetingId={selectedMeetingId}
            type={selectedType}
            onChanged={() => api.listMeetings(selectedTypeId).then(d => setMeetingsList(d.meetings || []))}
            onDeleted={() => { setSelectedMeetingId(null); load(); }}
          />
        ) : (
          <div className="p-8 text-center text-ink-400">
            {selectedType ? 'Vyber zápis vlevo, nebo vytvoř nový.' : 'Vyber typ porady vlevo.'}
          </div>
        )}
      </main>

      {typeModal && (
        <TypeModal
          type={typeModal === 'new' ? null : typeModal}
          onClose={() => setTypeModal(null)}
          onSaved={() => { setTypeModal(null); load(); }}
          onDeleted={() => {
            setTypeModal(null);
            setSelectedTypeId(null);
            setSelectedMeetingId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ==================== Detail zápisu ====================

function MeetingDetail({ meetingId, type, onChanged, onDeleted }) {
  const [meeting, setMeeting] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [teamUsers, setTeamUsers] = useState([]);
  const [summary, setSummary] = useState(null);   // { text, loading } — sumář předchozích
  const [notesSummary, setNotesSummary] = useState(null); // shrnutí AKTUÁLNÍHO zápisu
  const [aiBusy, setAiBusy] = useState(false);
  const [suggestion, setSuggestion] = useState(null); // AI navržené úkoly → SuggestedTasksModal
  const [meetingTasks, setMeetingTasks] = useState([]);
  const [detailTask, setDetailTask] = useState(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    setMeeting(null);
    setDirty(false);
    setNotesSummary(null);
    api.getMeeting(meetingId).then(d => setMeeting(d.meeting));
    api.listTasks(meetingId).then(d => setMeetingTasks(d.tasks || [])).catch(() => setMeetingTasks([]));
  }, [meetingId]);

  const reloadMeetingTasks = () => api.listTasks(meetingId).then(d => setMeetingTasks(d.tasks || [])).catch(() => {});

  // Načti členy týmu (pro checkboxy prezence)
  useEffect(() => {
    if (!type) return;
    if (type.visibility === 'team' && type.team_id) {
      usersApi.listInTeam(type.team_id).then(d => setTeamUsers(d.users || []));
    } else if (type.visibility === 'custom' && Array.isArray(type.custom_users) && type.custom_users.length > 0) {
      // Načteme všechny users a filtrujeme na custom seznam
      usersApi.list().then(d => setTeamUsers((d.users || []).filter(u => type.custom_users.map(Number).includes(u.id))));
    } else {
      setTeamUsers([]);
    }
  }, [type?.id, type?.visibility, type?.team_id]);

  const save = async () => {
    if (!meeting) return;
    setSaving(true);
    try {
      await api.updateMeeting(meeting.id, {
        title: meeting.title,
        meeting_date: meeting.meeting_date,
        meeting_time: meeting.meeting_time,
        content_json: meeting.content_json,
        agenda: meeting.agenda,
        attendees: meeting.attendees,
      });
      setDirty(false);
      onChanged?.();
    } catch (e) {
      alert(e.response?.data?.message || 'Uložení selhalo');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm('Opravdu smazat tento zápis?')) return;
    await api.removeMeeting(meeting.id);
    onDeleted?.();
  };

  if (!meeting) return <div className="p-8 text-ink-400">Načítám…</div>;

  const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : [];
  const agenda    = Array.isArray(meeting.agenda) ? meeting.agenda : [];

  // Update handlers
  const patch = (delta) => { setMeeting(m => ({ ...m, ...delta })); setDirty(true); };
  const patchAgenda = (idx, delta) => {
    const next = agenda.map((a, i) => i === idx ? { ...a, ...delta } : a);
    patch({ agenda: next });
  };
  const addAgendaItem = () => patch({ agenda: [...agenda, { text: '', checked: false, source: 'user' }] });
  const removeAgendaItem = (idx) => patch({ agenda: agenda.filter((_, i) => i !== idx) });

  // Nastaví stav docházky pro člena týmu. Pokud newStatus === null, odebere záznam.
  // Pro 'excused' přijímá volitelný reasonObj = { reason, reason_note }.
  const setAttendanceStatus = (userId, newStatus, reasonObj = null) => {
    const idx = attendees.findIndex(a => a.user_id === userId);
    // Sestavíme čistý objekt: základní status + reason jen pro excused
    const buildAttendee = (base) => {
      const out = { ...base, user_id: userId, status: newStatus };
      // Uklidíme staré reason kolonky pokud přecházíme mimo excused
      if (newStatus !== 'excused') { delete out.reason; delete out.reason_note; }
      if (newStatus === 'excused' && reasonObj) {
        if (reasonObj.reason) out.reason = reasonObj.reason;
        if (reasonObj.reason_note) out.reason_note = reasonObj.reason_note;
      }
      return out;
    };
    let next;
    if (idx >= 0) {
      if (newStatus === null) {
        next = attendees.filter((_, i) => i !== idx);
      } else {
        next = attendees.map((a, i) => i === idx ? buildAttendee(a) : a);
      }
    } else if (newStatus) {
      next = [...attendees, buildAttendee({})];
    } else {
      next = attendees;
    }
    patch({ attendees: next });
  };
  // Backward-compat: staré záznamy s present: true|false převedeme na status.
  const getAttendanceStatus = (userId) => {
    const a = attendees.find(x => x.user_id === userId);
    if (!a) return null;
    if (a.status) return a.status;
    if (a.present === true) return 'present';
    if (a.present === false) return 'missed';
    return null;
  };
  const addGuest = () => {
    const name = prompt('Jméno hosta (mimo tým):');
    if (!name?.trim()) return;
    const email = prompt('E-mail hosta (potřebný pro follow-up):');
    if (!email?.trim() || !/^[^@]+@[^@]+\.[a-z]{2,}$/i.test(email)) {
      alert('E-mail je povinný — na něj přijde follow-up po poradě.');
      return;
    }
    patch({ attendees: [...attendees, { guest_name: name.trim(), guest_email: email.trim(), present: true }] });
  };
  const removeGuest = (idx) => patch({ attendees: attendees.filter((_, i) => i !== idx) });

  // AI: sumář předchozích porad. Otevře panel pod tlačítkem.
  const genSummary = async () => {
    setAiBusy(true); setSummary({ loading: true });
    try {
      const d = await api.summary(meeting.id);
      setSummary({ text: d.text, empty: d.empty });
    } catch (e) {
      setSummary({ text: `❌ Chyba: ${e.response?.data?.message || e.message}` });
    } finally { setAiBusy(false); }
  };

  // Follow-up mail účastníkům
  const sendFollowUp = async () => {
    if (!confirm('Poslat follow-up mail všem přítomným účastníkům? Každý dostane své úkoly (organizátor dostane přehled všech).')) return;
    setAiBusy(true);
    try {
      const d = await api.followUp(meeting.id);
      alert(`✅ Odesláno ${d.sent} z ${d.total} účastníků.`);
      onChanged?.();
    } catch (e) {
      alert(`Chyba: ${e.response?.data?.message || e.message}`);
    } finally { setAiBusy(false); }
  };

  // AI: shrne aktuální zápis (obsah content_json).
  const genNotesSummary = async () => {
    setAiBusy(true); setNotesSummary({ loading: true });
    try {
      const d = await api.summarizeNotes(meeting.id);
      setNotesSummary({ text: d.text });
    } catch (e) {
      setNotesSummary({ text: `❌ ${e.response?.data?.message || e.message}` });
    } finally { setAiBusy(false); }
  };

  // AI: vygeneruj úkoly ze zápisu (jako u Poznámek).
  const genTasksFromNotes = async () => {
    setAiBusy(true);
    try {
      const d = await api.suggestTasks(meeting.id);
      if (!d.tasks || d.tasks.length === 0) {
        alert('AI z tohoto zápisu nevytáhla žádné úkoly. Zkus napsat konkrétněji „kdo co má udělat".');
        return;
      }
      setSuggestion(d);
    } catch (e) {
      // Do konzole plný response, do alertu message + error kód + status.
      console.error('[suggest-tasks] failed', { status: e.response?.status, data: e.response?.data, message: e.message });
      const d = e.response?.data;
      const parts = [
        d?.message,
        d?.error && !d?.message ? `kód: ${d.error}` : null,
        d?.raw ? `AI odpověď: ${String(d.raw).slice(0, 300)}` : null,
      ].filter(Boolean);
      const detail = parts.length > 0 ? parts.join(' · ') : e.message;
      alert(`Chyba (${e.response?.status || '?'}): ${detail}\n\nVíc detailů v Developer Tools → Console.`);
    } finally { setAiBusy(false); }
  };

  // AI: navrhne body agendy — přidá je do agendy jako source='ai'.
  const genAgenda = async () => {
    setAiBusy(true);
    try {
      const d = await api.suggestAgenda(meeting.id);
      const newItems = (d.items || []).map(it => ({ text: it.text, checked: false, source: 'ai' }));
      if (newItems.length === 0) {
        alert('AI nenavrhla žádné nové body (asi není z čeho čerpat).');
      } else {
        patch({ agenda: [...agenda, ...newItems] });
      }
    } catch (e) {
      alert(`Chyba: ${e.response?.data?.message || e.message}`);
    } finally { setAiBusy(false); }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      {/* Header */}
      <div className="bg-white border border-cream-200 rounded-lg p-4">
        <StatusBar meeting={meeting} type={type} user={user} onChanged={async () => {
          const d = await api.getMeeting(meeting.id);
          setMeeting(d.meeting);
          onChanged?.();
        }} />
        <input
          type="text"
          value={meeting.title}
          onChange={e => patch({ title: e.target.value })}
          disabled={meeting.status === 'completed' && meeting.organizer_id !== user?.id && user?.role !== 'admin'}
          className="w-full text-2xl font-bold text-ink-800 border-0 focus:outline-none focus:ring-0 bg-transparent disabled:bg-cream-50"
        />
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
          <label>
            <span className="text-xs text-ink-500">Datum</span>
            <input type="date" value={meeting.meeting_date || ''}
              onChange={e => patch({ meeting_date: e.target.value })}
              className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1" />
          </label>
          <label>
            <span className="text-xs text-ink-500">Čas</span>
            <input type="time" value={meeting.meeting_time || ''}
              onChange={e => patch({ meeting_time: e.target.value })}
              className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1" />
          </label>
          <div className="flex items-end gap-2 justify-end">
            {dirty && (
              <button onClick={save} disabled={saving}
                className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
                {saving ? 'Ukládám…' : 'Uložit změny'}
              </button>
            )}
            <button onClick={remove}
              className="px-3 py-1.5 text-sm text-red-600 hover:underline">Smazat</button>
          </div>
        </div>
      </div>

      {/* AI panel — před poradou (příprava) */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">🤖 AI — příprava porady</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={genSummary} disabled={aiBusy}
            title="AI vygeneruje textové shrnutí předchozích porad tohoto typu: co se řešilo, které úkoly jsou hotové/pozdě/po termínu, a doporučí 3-5 věcí, na které se dnes zaměřit. Zobrazí se pod tlačítkem — nezmění zápis."
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
            📊 Sumář předchozích porad
          </button>
          <button onClick={genAgenda} disabled={aiBusy}
            title="AI navrhne 3-7 dalších bodů agendy nad rámec kostry — vezme v úvahu nedokončené úkoly z minulých porad a otevřené otázky. Body se PŘIDAJÍ do sekce Agenda níže (můžeš je smazat / upravit)."
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
            🧠 Navrhnout agendu
          </button>
        </div>
        {summary && (
          <div className="mt-3 bg-cream-50 border border-cream-200 rounded p-3">
            {summary.loading ? (
              <div className="text-sm text-ink-500">Generuji sumář…</div>
            ) : summary.empty ? (
              <div className="text-sm text-ink-500 italic">{summary.text}</div>
            ) : (
              <>
                <div className="text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">{summary.text}</div>
                {/* Extrakce doporučení → rychlé přidání do agendy */}
                {(() => {
                  const recs = parseRecommendations(summary.text);
                  if (recs.length === 0) return null;
                  return (
                    <div className="mt-3 pt-3 border-t border-cream-300">
                      <div className="text-xs font-semibold text-ink-600 mb-2">
                        📌 {recs.length} doporučení — přidat do agendy:
                      </div>
                      <div className="space-y-1.5">
                        {recs.map((r, i) => {
                          const alreadyIn = agenda.some(a => (a.text || '').toLowerCase() === r.toLowerCase());
                          return (
                            <div key={i} className="flex items-start gap-2 text-sm">
                              <button
                                disabled={alreadyIn}
                                onClick={() => patch({ agenda: [...agenda, { text: r, checked: false, source: 'ai' }] })}
                                title={alreadyIn ? 'Bod už je v agendě' : 'Přidat jako bod agendy'}
                                className={`shrink-0 mt-0.5 w-6 h-6 rounded ${
                                  alreadyIn ? 'bg-emerald-100 text-emerald-600 cursor-default'
                                            : 'bg-brand-500 text-white hover:bg-brand-600'
                                }`}
                              >{alreadyIn ? '✓' : '+'}</button>
                              <span className="flex-1 text-ink-700">{r}</span>
                            </div>
                          );
                        })}
                        <button
                          onClick={() => {
                            const newItems = recs
                              .filter(r => !agenda.some(a => (a.text || '').toLowerCase() === r.toLowerCase()))
                              .map(r => ({ text: r, checked: false, source: 'ai' }));
                            if (newItems.length > 0) patch({ agenda: [...agenda, ...newItems] });
                          }}
                          className="mt-2 text-xs text-brand-500 hover:underline">
                          + Přidat všechny nezařazené
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
            <button onClick={() => setSummary(null)}
              className="mt-2 text-xs text-ink-500 hover:underline">Skrýt sumář</button>
          </div>
        )}
      </section>

      {/* Agenda */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">📋 Agenda</div>
        {agenda.length === 0 ? (
          <div className="text-sm text-ink-400 italic mb-2">Zatím žádný bod. AI návrh přijde v dalším commitu.</div>
        ) : (
          <ul className="space-y-1.5 mb-2">
            {agenda.map((a, i) => (
              <li key={i} className="flex items-center gap-2 group">
                <input type="checkbox" checked={!!a.checked}
                  onChange={e => patchAgenda(i, { checked: e.target.checked })} />
                <input type="text" value={a.text || ''}
                  onChange={e => patchAgenda(i, { text: e.target.value })}
                  className={`flex-1 text-sm border-0 border-b border-cream-200 focus:border-brand-400 focus:outline-none px-1 py-0.5 ${
                    a.checked ? 'line-through text-ink-400' : ''
                  }`} />
                <span className="text-[10px] text-ink-400 shrink-0">
                  {a.source === 'template' ? 'kostra' : a.source === 'ai' ? 'AI' : ''}
                </span>
                <button onClick={() => removeAgendaItem(i)}
                  className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-red-500 text-sm">×</button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={addAgendaItem}
          className="text-xs text-brand-500 hover:underline">+ Přidat bod</button>
      </section>

      {/* Prezence */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">
          👥 Prezence
        </div>
        <div className="text-[11px] text-ink-500 mb-2">
          Klik na status: <strong className="text-emerald-700">Byl</strong> · <strong className="text-amber-700">Pozdě</strong> · <strong className="text-red-600">Nepřišel</strong> · <strong className="text-sky-700">Omluven</strong> (nepočítá se do skóre docházky). Historie se ukládá do skóre docházky každého člověka.
        </div>
        <div className="space-y-1.5">
          {/* Členové týmu — 3-state buttons */}
          {teamUsers.map(u => {
            const rec = attendees.find(x => x.user_id === u.id) || {};
            return (
              <AttendanceRow
                key={u.id}
                name={u.name}
                avatarUser={u}
                status={getAttendanceStatus(u.id)}
                reason={rec.reason}
                reasonNote={rec.reason_note}
                onSet={(s, r) => setAttendanceStatus(u.id, s, r)}
              />
            );
          })}
          {/* Hosté */}
          {attendees.filter(a => !a.user_id).map((a) => {
            const idx = attendees.findIndex(x => x === a);
            const guestStatus = a.status || (a.present ? 'present' : 'missed');
            const setGuest = (s, r) => {
              const next = attendees.map((x, i) => {
                if (i !== idx) return x;
                const out = { ...x, status: s };
                if (s !== 'excused') { delete out.reason; delete out.reason_note; }
                if (s === 'excused' && r) {
                  if (r.reason) out.reason = r.reason;
                  if (r.reason_note) out.reason_note = r.reason_note;
                }
                return out;
              });
              patch({ attendees: next });
            };
            return (
              <div key={`guest-${idx}`} className="flex items-center gap-2 text-sm">
                <AttendanceButtons status={guestStatus} onSet={setGuest} />
                <div className="w-5 h-5 rounded-full bg-cream-200 flex items-center justify-center text-[10px]">👤</div>
                <span className="text-ink-800 flex-1">{a.guest_name}</span>
                {guestStatus === 'excused' && (
                  <span className="text-[11px] text-ink-500 italic truncate">
                    {EXCUSE_LABEL[a.reason] || '(bez důvodu)'}{a.reason_note ? ` — ${a.reason_note}` : ''}
                  </span>
                )}
                <span className="text-[10px] text-ink-400 shrink-0">{a.guest_email}</span>
                <button onClick={() => removeGuest(idx)} className="text-red-500 text-xs">×</button>
              </div>
            );
          })}
        </div>
        <button onClick={addGuest}
          className="mt-3 text-xs text-brand-500 hover:underline"
          title="Přidej hosta mimo tým. Zadáš jméno a e-mail; ten se použije pro follow-up mail po poradě.">
          + Přidat hosta mimo tým
        </button>
      </section>

      {/* Zápis (rich text). content_json je JSONB, ale ukládáme HTML string. */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">✍ Zápis</div>
        <div className="min-h-[300px]">
          <RichTextEditor
            value={typeof meeting.content_json === 'string' ? meeting.content_json : ''}
            onChange={(html) => patch({ content_json: html })}
          />
        </div>
      </section>

      {/* AI panel — po poradě (uzavření + follow-up) */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">🤖 AI — po poradě</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={genNotesSummary} disabled={aiBusy}
            title="AI shrne obsah TOHOTO zápisu do 3-5 vět. Zobrazí se pod tlačítkem, nezmění zápis. Vhodné před uzavřením porady."
            className="px-3 py-1.5 text-sm bg-slate-600 text-white rounded hover:bg-slate-700 disabled:opacity-50">
            📝 Shrnout tento zápis
          </button>
          <button onClick={genTasksFromNotes} disabled={aiBusy}
            title="AI vytáhne ze zápisu konkrétní úkoly (kdo co má udělat, termín, priorita). Otevře se dialog pro potvrzení — úkoly pak založíš do projektu a propojí se s tímto zápisem."
            className="px-3 py-1.5 text-sm bg-slate-600 text-white rounded hover:bg-slate-700 disabled:opacity-50">
            🎯 Vygenerovat úkoly ze zápisu
          </button>
          <button onClick={sendFollowUp} disabled={aiBusy}
            title="Pošle e-mail všem účastníkům označeným jako 'přítomný'. Každý dostane jen SVÉ úkoly z porady (tasks propojené s tímto zápisem přes meeting_id). Organizátor dostane přehled všech úkolů."
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
            📧 Poslat follow-up mail{meeting.followed_up_at ? ' znovu' : ''}
          </button>
        </div>
        {notesSummary && (
          <div className="mt-3 bg-slate-50 border border-slate-200 rounded p-3">
            {notesSummary.loading ? (
              <div className="text-sm text-ink-500">Generuji shrnutí…</div>
            ) : (
              <div className="text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">{notesSummary.text}</div>
            )}
            <button onClick={() => setNotesSummary(null)}
              className="mt-2 text-xs text-ink-500 hover:underline">Skrýt</button>
          </div>
        )}
        {meeting.followed_up_at && (
          <div className="mt-2 text-[11px] text-emerald-700">
            ✅ Follow-up už byl odeslán: {new Date(meeting.followed_up_at).toLocaleString('cs-CZ')}
          </div>
        )}
      </section>

      {/* Úkoly z porady */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
            🎯 Úkoly z porady ({meetingTasks.length})
          </div>
          <button onClick={() => setNewTaskOpen(true)}
            title="Založit úkol ručně a propojit ho s touto poradou (meeting_id)."
            className="text-xs px-2 py-1 bg-brand-500 text-white rounded hover:bg-brand-600">
            + Přidat úkol
          </button>
        </div>
        {meetingTasks.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            Zatím žádné úkoly. Klikni „+ Přidat úkol" nahoře nebo použij AI „Vygenerovat úkoly ze zápisu".
          </div>
        ) : (
          <ul className="divide-y divide-cream-100">
            {meetingTasks.map(t => (
              <li key={t.id}
                onClick={async () => {
                  try {
                    const d = await tasksApi.get(t.id);
                    setDetailTask(d.task);
                  } catch { /* ignore */ }
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

      {/* Audit log editací */}
      <EditsPanel meetingId={meeting.id} />

      {/* Modal pro potvrzení AI navržených úkolů */}
      {suggestion && (
        <SuggestedTasksModal
          suggestion={suggestion}
          sourceNote={{ id: meeting.id, title: meeting.title, meeting_id: meeting.id }}
          sourceScope="meeting"
          onClose={() => setSuggestion(null)}
          onCreated={() => { setSuggestion(null); reloadMeetingTasks(); }}
        />
      )}
      {detailTask && (
        <TaskDetailModal task={detailTask} onClose={() => { setDetailTask(null); reloadMeetingTasks(); }} onUpdate={() => {}} />
      )}
      {newTaskOpen && (
        <MeetingNewTaskModal
          meetingId={meeting.id}
          teamId={type?.team_id}
          currentUser={user}
          onClose={() => setNewTaskOpen(false)}
          onCreated={() => { setNewTaskOpen(false); reloadMeetingTasks(); }}
        />
      )}

      {dirty && (
        <div className="sticky bottom-4 flex justify-end">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg shadow-lg hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Ukládám…' : '💾 Uložit změny'}
          </button>
        </div>
      )}
    </div>
  );
}

function EditsPanel({ meetingId }) {
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState([]);
  useEffect(() => {
    if (!open) return;
    api.edits(meetingId).then(d => setEdits(d.edits || [])).catch(() => setEdits([]));
  }, [open, meetingId]);
  return (
    <section className="bg-white border border-cream-200 rounded-lg p-4">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-left">
        <span className="text-xs font-semibold text-ink-500 uppercase tracking-wide">📜 Historie změn</span>
        <span className="text-ink-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-3">
          {edits.length === 0 ? (
            <div className="text-sm text-ink-400 italic">Zatím žádné editace nebo se ještě neuložily.</div>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {edits.map(e => (
                <li key={e.id} className="flex gap-2 border-l-2 border-cream-300 pl-2">
                  <span className="text-ink-500 shrink-0">{new Date(e.edited_at).toLocaleString('cs-CZ')}</span>
                  <span className="font-semibold text-ink-700 shrink-0">{e.editor_name || '—'}</span>
                  <span className="text-ink-500">upravil</span>
                  <span className="font-medium">{CHANGE_LABEL[e.change_type] || e.change_type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const CHANGE_LABEL = {
  title: 'název',
  date: 'datum',
  notes: 'zápis',
  agenda: 'agendu',
  attendees: 'prezenci',
  status: 'stav',
};

// Status bar zápisu: badge + tlačítka přechodu.
// draft → in_progress → completed (uzavře) ↺ draft (reopen, jen org/admin)
const STATUS_META = {
  draft:       { label: '📝 Příprava',  cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  in_progress: { label: '🔴 Probíhá',   cls: 'bg-emerald-100 text-emerald-700 border-emerald-300 animate-pulse' },
  completed:   { label: '✅ Uzavřeno',  cls: 'bg-brand-50 text-brand-700 border-brand-300' },
};

function StatusBar({ meeting, type, user, onChanged }) {
  const [busy, setBusy] = useState(false);
  const status = meeting.status || 'draft';
  const isOrgOrAdmin = meeting.organizer_id === user?.id || user?.role === 'admin';
  const badge = STATUS_META[status] || STATUS_META.draft;

  const doTransition = async (to, needsReason = false) => {
    let reason = null;
    if (needsReason) {
      reason = prompt('Napiš důvod, proč otevíráš zápis k opravě:');
      if (!reason?.trim()) return;
    }
    // Zahájení porady: pošleme aktuální datum+čas z browseru, ať zápis
    // odpovídá skutečnému začátku (v lokální zóně organizátora).
    let start = null;
    if (to === 'in_progress' && meeting.status === 'draft') {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      start = {
        start_date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        start_time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      };
    }
    setBusy(true);
    try {
      await api.transition(meeting.id, to, reason, start);
      await onChanged();
    } catch (e) {
      alert(e.response?.data?.message || 'Přechod selhal');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <span className={`text-xs font-semibold px-2.5 py-1 rounded border ${badge.cls}`}>{badge.label}</span>
      {/* Tlačítka přechodu */}
      {status === 'draft' && (
        <button onClick={() => doTransition('in_progress')} disabled={busy}
          title="Zahájit poradu — od teď mohou účastníci upravovat zápis a prezenci."
          className="text-xs px-2 py-1 bg-emerald-500 text-white rounded hover:bg-emerald-600 disabled:opacity-50">
          ▶️ Zahájit poradu
        </button>
      )}
      {status === 'in_progress' && (
        <>
          {isOrgOrAdmin && (
            <button onClick={() => doTransition('completed')} disabled={busy}
              title="Uzavřít poradu — zápis se zamkne, jen organizátor může vyvolat opravu."
              className="text-xs px-2 py-1 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-50">
              ✅ Uzavřít a zamknout
            </button>
          )}
          <button onClick={() => doTransition('draft')} disabled={busy}
            title="Přerušit — vrátit zápis do přípravy."
            className="text-xs px-2 py-1 bg-white border border-ink-300 text-ink-700 rounded hover:bg-cream-50 disabled:opacity-50">
            ⏸ Přerušit (zpět příprava)
          </button>
        </>
      )}
      {status === 'completed' && isOrgOrAdmin && (
        <button onClick={() => doTransition('draft', true)} disabled={busy}
          title="Otevřít zámek pro úpravy. Musíš napsat důvod, který se zaznamená do historie změn."
          className="text-xs px-2 py-1 bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50">
          🔓 Otevřít k opravě
        </button>
      )}
      {status === 'completed' && !isOrgOrAdmin && (
        <span className="text-xs text-ink-500 italic">Uzavřeno. Pro úpravy kontaktuj organizátora ({type?.organizer_name || '—'}).</span>
      )}
    </div>
  );
}

// Řádek prezence pro jednoho člena týmu. 4-state selektor + zobrazení důvodu u „Omluven".
function AttendanceRow({ name, avatarUser, status, reason, reasonNote, onSet }) {
  return (
    <div className="flex items-center gap-2 text-sm hover:bg-cream-50 rounded px-1 py-0.5">
      <AttendanceButtons status={status} onSet={onSet} />
      <Avatar user={{ id: avatarUser.id, name: avatarUser.name, avatar_updated_at: avatarUser.avatar_updated_at }} size={20} />
      <span className={status ? 'text-ink-800' : 'text-ink-500'}>{name}</span>
      {status === 'excused' && (
        <span className="text-[11px] text-ink-500 italic truncate">
          {EXCUSE_LABEL[reason] || '(bez důvodu)'}{reasonNote ? ` — ${reasonNote}` : ''}
        </span>
      )}
    </div>
  );
}

const EXCUSE_LABEL = { dovolena: 'dovolená', nemoc: 'nemoc', jina: 'jiné' };

// Prompty na důvod omluvy. Vrací { reason, reason_note } nebo null pokud zrušeno.
function askExcuseReason(currentReason, currentNote) {
  const menu = `Zvol důvod omluvy:\n  1 = dovolená\n  2 = nemoc\n  3 = jiné (napíšeš důvod)\n\nzadej číslo:`;
  const cur = currentReason === 'dovolena' ? '1' : currentReason === 'nemoc' ? '2' : currentReason === 'jina' ? '3' : '';
  const pick = prompt(menu, cur);
  if (pick === null) return null;
  const p = String(pick).trim();
  if (p === '1') return { reason: 'dovolena' };
  if (p === '2') return { reason: 'nemoc' };
  if (p === '3') {
    const note = prompt('Napiš krátce důvod:', currentNote || '');
    if (!note?.trim()) return null;
    return { reason: 'jina', reason_note: note.trim().slice(0, 300) };
  }
  return null;
}

// 4 tlačítka: ✅ Byl / ⏰ Pozdě / ❌ Nepřišel / 📄 Omluven. Klik na aktivní = odebrat záznam.
function AttendanceButtons({ status, onSet }) {
  const btn = (val, cls, label, title) => {
    const active = status === val;
    return (
      <button type="button"
        title={title}
        onClick={() => {
          if (active) { onSet(null); return; }
          if (val === 'excused') {
            const r = askExcuseReason();
            if (!r) return;
            onSet('excused', r);
          } else {
            onSet(val);
          }
        }}
        className={`w-7 h-6 text-xs rounded transition ${
          active ? cls : 'bg-cream-100 text-ink-400 hover:bg-cream-200'
        }`}>{label}</button>
    );
  };
  return (
    <div className="flex gap-1 shrink-0">
      {btn('present', 'bg-emerald-500 text-white', '✓', 'Byl přítomen')}
      {btn('late',    'bg-amber-500 text-white',   '⏰', 'Přišel pozdě')}
      {btn('missed',  'bg-red-500 text-white',     '✗', 'Nepřišel (měl být)')}
      {btn('excused', 'bg-sky-500 text-white',     '📄', 'Omluven — dovolená / nemoc / jiné (zeptá se na důvod)')}
    </div>
  );
}

// ==================== Modal: přidat úkol ručně k poradě ====================
// Malý dedikovaný formulář — projekt + název + assignee + priorita + termín.
// Vždy uloží meeting_id, aby úkol byl navázaný na tento zápis.

function MeetingNewTaskModal({ meetingId, teamId, currentUser, onClose, onCreated }) {
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({
    project_id: '', title: '', assignee_id: currentUser?.id || '',
    priority: 'normal', due_date: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    // Projekty napříč týmy (aby úkol z porady mohl padnout i do jiného projektu).
    (projectsApi.listAll ? projectsApi.listAll() : projectsApi.list())
      .then(d => {
        const active = (d.projects || []).filter(p => !p.status || p.status === 'active');
        setProjects(active);
        if (active.length === 1) setForm(f => ({ ...f, project_id: active[0].id }));
      })
      .catch(() => setErr('Nepodařilo se načíst projekty.'));
  }, []);

  // Když je vybraný projekt, načteme assignees jeho týmu.
  useEffect(() => {
    if (!form.project_id) { setUsers([]); return; }
    const proj = projects.find(p => String(p.id) === String(form.project_id));
    if (!proj?.team_id) { usersApi.list().then(d => setUsers(d.users || [])); return; }
    usersApi.listInTeam(proj.team_id).then(d => {
      const list = d.users || [];
      setUsers(list);
      if (!list.some(u => u.id === currentUser?.id)) {
        setForm(f => ({ ...f, assignee_id: list[0]?.id || '' }));
      }
    }).catch(() => setUsers([]));
  }, [form.project_id, projects, currentUser?.id]);

  const submit = async () => {
    setErr(null);
    if (!form.project_id) { setErr('Vyber projekt.'); return; }
    if (!form.title.trim()) { setErr('Vyplň název úkolu.'); return; }
    if (!form.assignee_id) { setErr('Vyber, komu úkol patří.'); return; }
    setBusy(true);
    try {
      await tasksApi.create({
        project_id: Number(form.project_id),
        title: form.title.trim(),
        assignee_id: Number(form.assignee_id),
        priority: form.priority,
        due_date: form.due_date || null,
        meeting_id: meetingId,
      });
      onCreated();
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Vytvoření selhalo.');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={true} onClose={onClose} title="Přidat úkol z porady"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Vytvářím…' : 'Vytvořit úkol'}
        </button>
      </>}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Projekt *</span>
          <select value={form.project_id} onChange={e => setForm({ ...form, project_id: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
            <option value="">— vyber projekt —</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}{p.team_name ? ` · ${p.team_name}` : ''}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Název úkolu *</span>
          <input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" autoFocus />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Komu</span>
            <select value={form.assignee_id} onChange={e => setForm({ ...form, assignee_id: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
              <option value="">—</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Priorita</span>
            <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
              <option value="low">Nízká</option>
              <option value="normal">Normální</option>
              <option value="high">Vysoká</option>
              <option value="urgent">Urgentní</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Termín</span>
            <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        </div>
        <div className="text-[11px] text-ink-400">Úkol se propojí s tímto zápisem (meeting_id) a objeví se v jeho seznamu úkolů.</div>
        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </div>
    </Modal>
  );
}

// ==================== Modal: vytvořit / editovat typ porady ====================
//
// Pokud je `type` prop nastavený → edit mode (přehrání dat, PATCH, tlačítko Smazat).
// Jinak → create mode.

function TypeModal({ type, onClose, onSaved, onDeleted }) {
  const isEdit = !!type;
  const { teams } = useTeams();
  const { user } = useAuth();

  const [name, setName] = useState(type?.name || '');
  const [description, setDescription] = useState(type?.description || '');
  const [visibility, setVisibility] = useState(type?.visibility || 'team');
  const [teamId, setTeamId] = useState(type?.team_id || teams?.[0]?.id || '');
  const [customUsers, setCustomUsers] = useState(Array.isArray(type?.custom_users) ? type.custom_users.map(Number) : []);
  const [allUsers, setAllUsers] = useState([]);
  const [organizerId, setOrganizerId] = useState(type?.organizer_id || '');
  const [agendaTemplate, setAgendaTemplate] = useState(
    Array.isArray(type?.agenda_template) && type.agenda_template.length > 0
      ? type.agenda_template.map(t => t.text || '')
      : ['', '', '']
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { usersApi.list().then(d => setAllUsers(d.users || [])); }, []);
  useEffect(() => { if (!organizerId && !isEdit) setOrganizerId(user?.id); }, [user?.id, isEdit]);

  const submit = async () => {
    if (!name.trim()) { setErr('Zadej název typu porady.'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        visibility,
        team_id: visibility === 'team' ? Number(teamId) || null : null,
        custom_users: visibility === 'custom' ? customUsers : [],
        organizer_id: Number(organizerId) || null,
        agenda_template: agendaTemplate.filter(t => t.trim()).map(t => ({ text: t.trim() })),
      };
      if (isEdit) await api.updateType(type.id, payload);
      else       await api.createType(payload);
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm(`Opravdu smazat typ porady „${type.name}"?\n\nSmažou se i VŠECHNY zápisy tohoto typu. Tuto akci nelze vrátit.`)) return;
    setBusy(true); setErr(null);
    try {
      await api.removeType(type.id);
      onDeleted();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setBusy(false); }
  };

  const toggleCustomUser = (id) => setCustomUsers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  return (
    <Modal open={true} onClose={onClose} title={isEdit ? `Upravit typ: ${type.name}` : 'Nový typ porady'}
      footer={<>
        {isEdit && (
          <button onClick={remove} disabled={busy}
            className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50 mr-auto">
            Smazat typ
          </button>
        )}
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? (isEdit ? 'Ukládám…' : 'Vytvářím…') : (isEdit ? 'Uložit' : 'Vytvořit')}
        </button>
      </>}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Název *</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="např. Středeční porada IT"
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-600">Popis</span>
          <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="K čemu porada slouží (volitelné)"
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>

        {/* Visibility */}
        <div>
          <span className="text-xs font-medium text-ink-600">Kdo vidí porady</span>
          <div className="mt-1 flex gap-2">
            <label className={`px-3 py-1.5 border rounded cursor-pointer ${visibility === 'team' ? 'bg-brand-500 text-white border-brand-500' : 'bg-white border-ink-300'}`}>
              <input type="radio" checked={visibility === 'team'} onChange={() => setVisibility('team')} className="sr-only" />
              🌐 Celý tým
            </label>
            <label className={`px-3 py-1.5 border rounded cursor-pointer ${visibility === 'custom' ? 'bg-brand-500 text-white border-brand-500' : 'bg-white border-ink-300'}`}>
              <input type="radio" checked={visibility === 'custom'} onChange={() => setVisibility('custom')} className="sr-only" />
              👥 Konkrétní lidé
            </label>
          </div>
        </div>

        {visibility === 'team' && (teams?.length || 0) > 0 && (
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Tým</span>
            <select value={teamId} onChange={e => setTeamId(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}

        {visibility === 'custom' && (
          <div>
            <span className="text-xs font-medium text-ink-600">Vyber lidi</span>
            <div className="mt-1 max-h-32 overflow-y-auto border border-ink-300 rounded p-2 space-y-1">
              {allUsers.map(u => (
                <label key={u.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-cream-50 rounded px-1">
                  <input type="checkbox" checked={customUsers.includes(u.id)} onChange={() => toggleCustomUser(u.id)} />
                  <span>{u.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="block">
          <span className="text-xs font-medium text-ink-600">Organizátor (šéf porady)</span>
          <select value={organizerId} onChange={e => setOrganizerId(e.target.value)}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5">
            {allUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="text-[11px] text-ink-500">Odpovídá za zadání agendy před poradou.</span>
        </label>

        {/* Kostra agendy */}
        <div>
          <span className="text-xs font-medium text-ink-600">
            Kostra agendy — základní body, které se opakují každou poradu
          </span>
          <div className="mt-1 space-y-1">
            {agendaTemplate.map((t, i) => (
              <div key={i} className="flex gap-2">
                <input type="text" value={t} onChange={e => setAgendaTemplate(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                  placeholder={`Bod ${i + 1} (např. „Přehled sprintu")`}
                  className="flex-1 border border-ink-300 rounded px-2 py-1" />
                {agendaTemplate.length > 1 && (
                  <button onClick={() => setAgendaTemplate(prev => prev.filter((_, j) => j !== i))}
                    className="px-2 text-red-500 hover:text-red-700">×</button>
                )}
              </div>
            ))}
            <button onClick={() => setAgendaTemplate(prev => [...prev, ''])}
              className="text-xs text-brand-500 hover:underline">+ Přidat bod</button>
          </div>
        </div>

        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </div>
    </Modal>
  );
}
