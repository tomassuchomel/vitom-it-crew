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
import { meetings as api, users as usersApi, teams as teamsApi } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useTeams } from '../teams.jsx';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '';
const fmtDateShort = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '—';

export default function Meetings() {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTypeId, setSelectedTypeId] = useState(null);
  const [meetingsList, setMeetingsList] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [creatingType, setCreatingType] = useState(false);

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
          <button onClick={() => setCreatingType(true)}
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
          <div className="px-4 py-3 border-b border-cream-200 flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide truncate">{selectedType.name}</div>
              <div className="text-[10px] text-ink-400">{meetingsList.length} zápisů</div>
            </div>
            <button onClick={async () => {
                const today = new Date().toISOString().slice(0, 10);
                const d = await api.createMeeting(selectedType.id, { meeting_date: today });
                setSelectedMeetingId(d.meeting.id);
                setMeetingsList(prev => [d.meeting, ...prev]);
              }}
              title="Vytvořit nový zápis (agenda se předvyplní z kostry typu)"
              className="text-xs px-2 py-0.5 bg-brand-500 text-white rounded hover:bg-brand-600">+ Nový zápis</button>
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
                      <div className="text-sm font-medium text-ink-800 truncate">{m.title}</div>
                      <div className="text-[10px] text-ink-500">
                        📅 {fmtDateShort(m.meeting_date)}
                        {m.meeting_time && ` ${m.meeting_time.slice(0, 5)}`}
                        {' · '}
                        <span title="Přítomní / pozvaní">👥 {m.present_count}/{m.attendee_count}</span>
                        {m.is_locked && ' · 🔒'}
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

      {creatingType && (
        <CreateTypeModal onClose={() => setCreatingType(false)} onCreated={() => { setCreatingType(false); load(); }} />
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
  const { user } = useAuth();

  useEffect(() => {
    setMeeting(null);
    setDirty(false);
    api.getMeeting(meetingId).then(d => setMeeting(d.meeting));
  }, [meetingId]);

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

  const toggleUserPresent = (userId) => {
    const idx = attendees.findIndex(a => a.user_id === userId);
    let next;
    if (idx >= 0) {
      next = attendees.map((a, i) => i === idx ? { ...a, present: !a.present } : a);
    } else {
      next = [...attendees, { user_id: userId, present: true }];
    }
    patch({ attendees: next });
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

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      {/* Header */}
      <div className="bg-white border border-cream-200 rounded-lg p-4">
        <input
          type="text"
          value={meeting.title}
          onChange={e => patch({ title: e.target.value })}
          className="w-full text-2xl font-bold text-ink-800 border-0 focus:outline-none focus:ring-0 bg-transparent"
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
          👥 Prezence ({attendees.filter(a => a.present).length}/{attendees.length + teamUsers.filter(u => !attendees.some(a => a.user_id === u.id)).length})
        </div>
        <div className="space-y-1.5">
          {/* Členové týmu (checkboxy) */}
          {teamUsers.map(u => {
            const att = attendees.find(a => a.user_id === u.id);
            const present = !!att?.present;
            return (
              <label key={u.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-cream-50 rounded px-1 py-0.5">
                <input type="checkbox" checked={present} onChange={() => toggleUserPresent(u.id)} />
                <Avatar user={{ id: u.id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={20} />
                <span className={present ? 'text-ink-800' : 'text-ink-500'}>{u.name}</span>
              </label>
            );
          })}
          {/* Hosté */}
          {attendees.filter(a => !a.user_id).map((a, absIdx) => {
            const idx = attendees.findIndex(x => x === a);
            return (
              <div key={`guest-${idx}`} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!a.present}
                  onChange={() => patchAgenda /* not agenda */} />
                <span className="text-ink-800">{a.guest_name}</span>
                <span className="text-xs text-ink-400">{a.guest_email}</span>
                <button onClick={() => removeGuest(idx)} className="text-red-500 text-xs">×</button>
              </div>
            );
          })}
        </div>
        <button onClick={addGuest}
          className="mt-2 text-xs text-brand-500 hover:underline"
          title="Přidej hosta mimo tým. Zadáš jméno a e-mail; ten se použije pro follow-up mail po poradě.">
          + Přidat hosta mimo tým
        </button>
      </section>

      {/* Zápis (rich text) */}
      <section className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">✍ Zápis</div>
        <div className="min-h-[300px]">
          <RichTextEditor
            value={meeting.content_json}
            onChange={(json) => patch({ content_json: json })}
          />
        </div>
      </section>

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

// ==================== Modal: vytvořit typ porady ====================

function CreateTypeModal({ onClose, onCreated }) {
  const { teams } = useTeams();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('team');
  const [teamId, setTeamId] = useState(teams?.[0]?.id || '');
  const [customUsers, setCustomUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [organizerId, setOrganizerId] = useState('');
  const [agendaTemplate, setAgendaTemplate] = useState(['', '', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { user } = useAuth();

  useEffect(() => { usersApi.list().then(d => setAllUsers(d.users || [])); }, []);
  useEffect(() => { if (!organizerId) setOrganizerId(user?.id); }, [user?.id]);

  const submit = async () => {
    if (!name.trim()) { setErr('Zadej název typu porady.'); return; }
    setBusy(true); setErr(null);
    try {
      await api.createType({
        name: name.trim(),
        description: description.trim() || null,
        visibility,
        team_id: visibility === 'team' ? Number(teamId) || null : null,
        custom_users: visibility === 'custom' ? customUsers : [],
        organizer_id: Number(organizerId) || null,
        agenda_template: agendaTemplate.filter(t => t.trim()).map(t => ({ text: t.trim() })),
      });
      onCreated();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setBusy(false); }
  };

  const toggleCustomUser = (id) => setCustomUsers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  return (
    <Modal open={true} onClose={onClose} title="Nový typ porady"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {busy ? 'Vytvářím…' : 'Vytvořit'}
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
