// Nápadník - interní Wishlist (Fáze 1).
// Fáze 2 přidá workflow tranzice, F3 analýzu, F4 dashboard, F5 export.

import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { ideas as ideasApi, users as usersApi } from '../api.js';
import { useTeams } from '../teams.jsx';

const STATE_META = {
  zadano:                    { label: 'zadáno',                    cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  ke_schvaleni:              { label: 'ke schválení',              cls: 'bg-blue-100 text-blue-700 border-blue-300' },
  schvaleno_ceka_na_analyzu: { label: 'čeká na analýzu',           cls: 'bg-indigo-100 text-indigo-700 border-indigo-300' },
  ke_schvaleni_analyzy:      { label: 'ke schválení analýzy',       cls: 'bg-orange-100 text-orange-700 border-orange-300' },
  schvalena_analyza:         { label: 'schválena analýza',          cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  rozpracovano:              { label: 'rozpracováno',               cls: 'bg-purple-100 text-purple-700 border-purple-300' },
  hotovo:                    { label: 'hotovo',                     cls: 'bg-emerald-200 text-emerald-800 border-emerald-400' },
  zamitnuto:                 { label: 'zamítnuto',                  cls: 'bg-red-100 text-red-700 border-red-300' },
  odlozeno:                  { label: 'odloženo',                   cls: 'bg-amber-100 text-amber-800 border-amber-300' },
};

const PM_REC_META = {
  A: { label: 'A – řešit ihned',                  cls: 'text-red-600 font-semibold' },
  B: { label: 'B – plánovat',                     cls: 'text-emerald-600 font-semibold' },
  C: { label: 'C – sledovat / odložit',           cls: 'text-slate-500' },
  D: { label: 'D – čeká na vstupy',               cls: 'text-orange-600' },
};

const STATE_FILTERS = [
  { value: 'all',     label: 'Vše' },
  { value: 'open',    label: 'Otevřené' },   // = vše kromě hotovo / zamitnuto / odlozeno
  { value: 'zadano', label: '📥 Zadané' },
  { value: 'ke_schvaleni', label: '👔 Ke schválení' },
  { value: 'schvaleno_ceka_na_analyzu', label: '🔍 V analýze' },
  { value: 'rozpracovano', label: '🚀 Rozpracované' },
  { value: 'hotovo', label: '✅ Hotové' },
  { value: 'zamitnuto', label: '❌ Zamítnuté' },
];

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '';

export default function Napadnik() {
  const [ideas, setIdeas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null); // { idea, analysis, events }
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');

  // silent=true refresh: neschovává tabulku (aby rozbalený detail
  // nezmizel a nezpůsobil re-mount, který resetuje jeho interní state).
  const load = (silent = false) => {
    if (!silent) setLoading(true);
    ideasApi.list()
      .then(d => setIdeas(d.ideas || []))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id); setDetail(null); setDetailLoading(true);
    try {
      const d = await ideasApi.get(id);
      setDetail(d);
    } finally { setDetailLoading(false); }
  };

  const filtered = useMemo(() => {
    let out = ideas;
    if (filter === 'open') {
      out = out.filter(i => !['hotovo', 'zamitnuto', 'odlozeno'].includes(i.state));
    } else if (filter !== 'all') {
      out = out.filter(i => i.state === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(i =>
        i.title?.toLowerCase().includes(q) ||
        i.proposer_name?.toLowerCase().includes(q) ||
        i.department?.toLowerCase().includes(q) ||
        i.category?.toLowerCase().includes(q)
      );
    }
    return out;
  }, [ideas, filter, search]);

  return (
    <div>
      <PageHeader
        title="Nápadník"
        subtitle={`${filtered.length} z ${ideas.length} nápadů — sběr, schvalování a řízení`}
        actions={
          <a href="/napadnik-form" target="_blank" rel="noreferrer"
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-lg hover:bg-brand-600">
            🔗 Veřejný formulář
          </a>
        }
      />
      <div className="p-6 space-y-4">
        {/* Filtry */}
        <div className="flex flex-wrap gap-2 items-center">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Hledat (název, navrhovatel, oddělení…)"
            className="border border-ink-300 rounded px-3 py-1.5 text-sm min-w-[220px] flex-1 max-w-md" />
          <div className="flex flex-wrap gap-1.5">
            {STATE_FILTERS.map(f => (
              <button key={f.value} onClick={() => setFilter(f.value)}
                className={`px-3 py-1 text-xs rounded-full border transition ${
                  filter === f.value
                    ? 'bg-brand-500 text-white border-brand-500'
                    : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
                }`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-ink-500 text-sm">Načítám…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-cream-200 rounded-xl p-8 text-center text-ink-400 text-sm">
            Zatím žádné nápady v této kategorii.<br />
            <a href="/napadnik-form" target="_blank" rel="noreferrer" className="text-brand-500 hover:underline mt-2 inline-block">
              🔗 Otevřít veřejný formulář
            </a>
          </div>
        ) : (
          <div className="bg-white border border-cream-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-cream-100 text-left text-xs uppercase tracking-wider text-ink-600">
                <tr>
                  <th className="px-3 py-2 w-16">#</th>
                  <th className="px-3 py-2">Datum</th>
                  <th className="px-3 py-2">Název nápadu</th>
                  <th className="px-3 py-2">Oddělení</th>
                  <th className="px-3 py-2">Kategorie</th>
                  <th className="px-3 py-2">Garant</th>
                  <th className="px-3 py-2">Doporučení</th>
                  <th className="px-3 py-2">Stav</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(i => (
                  <React.Fragment key={i.id}>
                    <tr onClick={() => toggleExpand(i.id)}
                      className={`border-t border-cream-100 cursor-pointer transition ${
                        expandedId === i.id ? 'bg-cream-50' : 'hover:bg-cream-50'
                      }`}>
                      <td className="px-3 py-2 text-ink-400 text-xs">#{i.id}</td>
                      <td className="px-3 py-2 text-xs text-ink-500">{fmtDate(i.created_at)}</td>
                      <td className="px-3 py-2 font-medium text-ink-800">{i.title}</td>
                      <td className="px-3 py-2 text-xs text-ink-600">{i.department}</td>
                      <td className="px-3 py-2 text-xs text-ink-600">{i.category}</td>
                      <td className="px-3 py-2 text-xs">{i.garant_name || <span className="text-ink-400 italic">nepřiřazen</span>}</td>
                      <td className={`px-3 py-2 text-xs ${PM_REC_META[i.pm_recommendation]?.cls || 'text-ink-400'}`}>
                        {PM_REC_META[i.pm_recommendation]?.label || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded border ${STATE_META[i.state]?.cls || ''}`}>
                          {STATE_META[i.state]?.label || i.state}
                        </span>
                      </td>
                    </tr>
                    {expandedId === i.id && (
                      <tr>
                        <td colSpan={8} className="bg-cream-50 border-t border-cream-200 px-4 py-4">
                          {detailLoading ? (
                            <div className="text-ink-500 text-sm">Načítám detail…</div>
                          ) : detail ? (
                            <IdeaDetail data={detail} onChanged={() => load(true)} />
                          ) : (
                            <div className="text-ink-400 text-sm">Detail se nenačetl.</div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Detail nápadu s workflow tlačítky, editací PM polí a historií.
// Fáze 2: přechody stavu + komentáře + „Vytvořit projekt".
function IdeaDetail({ data, onChanged }) {
  const [state, setState] = useState(data);
  const [transitions, setTransitions] = useState(null);
  const [users, setUsers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const { idea, events } = state;

  // Načti transitions + users (cross-team pro garanta)
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      ideasApi.transitions(idea.id).catch(() => ({ transitions: [], isManagement: false, isGarant: false })),
      usersApi.listAcrossMyTeams().catch(() => usersApi.list().catch(() => ({ users: [] }))),
    ]).then(([tr, u]) => {
      if (cancelled) return;
      setTransitions(tr);
      setUsers(u.users || u || []);
    });
    return () => { cancelled = true; };
  }, [idea.id]);

  // Reload detail po změně (state / edit / create-project)
  const reload = async () => {
    const d = await ideasApi.get(idea.id);
    setState(d);
    const tr = await ideasApi.transitions(idea.id).catch(() => ({ transitions: [] }));
    setTransitions(tr);
    onChanged?.(); // refresh seznamu (nezavírá rozbalený detail)
  };

  // Rychlá editace: garant / priorita / doporučení PM / poznámka PM
  const patchField = async (field, value) => {
    setSaving(true); setErr(null);
    try {
      await ideasApi.patch(idea.id, { [field]: value });
      await reload();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setSaving(false); }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
      {/* Levý sloupec — kontakt + obsah */}
      <div className="bg-white border border-cream-200 rounded-lg p-3">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">Kontakt & obsah</div>
        <div className="space-y-1 text-ink-700">
          <div><strong>Navrhovatel:</strong> {idea.proposer_name}</div>
          <div><strong>E‑mail:</strong> {idea.proposer_email}</div>
          <div className="pt-2"><strong>Problém:</strong><br />{idea.problem_description}</div>
          <div className="pt-2"><strong>Návrh řešení:</strong><br />{idea.solution_proposal}</div>
          {idea.impact_scope && <div className="pt-2"><strong>Dopad:</strong> {idea.impact_scope}</div>}
          {idea.estimated_time_savings && <div><strong>Úspora:</strong> {idea.estimated_time_savings}</div>}
          {idea.external_link && <div className="pt-2">
            <a href={idea.external_link} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">🔗 {idea.external_link}</a>
          </div>}
          {idea.linked_project_id && <div className="pt-2 text-emerald-700">
            🚀 <strong>Projekt:</strong> {idea.linked_project_name}
            {idea.linked_project_team_name && <span className="text-ink-500"> ({idea.linked_project_team_name})</span>}
          </div>}
        </div>
      </div>

      {/* Střední sloupec — editace + workflow */}
      <div className="bg-white border border-cream-200 rounded-lg p-3 space-y-3">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">Řízení nápadu</div>

        {/* Editace: garant / priorita / doporučení PM */}
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="text-ink-500">Garant (PM)</span>
            <select
              value={idea.garant_id || ''}
              onChange={e => patchField('garant_id', e.target.value ? Number(e.target.value) : null)}
              disabled={saving}
              className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-sm"
            >
              <option value="">— nepřiřazen —</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-ink-500">Priorita</span>
            <select
              value={idea.priority || 'normal'}
              onChange={e => patchField('priority', e.target.value)}
              disabled={saving}
              className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-sm"
            >
              <option value="low">Nízká</option>
              <option value="normal">Normální</option>
              <option value="high">Vysoká</option>
              <option value="urgent">Urgentní</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-ink-500">Doporučení PM</span>
            <select
              value={idea.pm_recommendation || ''}
              onChange={e => patchField('pm_recommendation', e.target.value || null)}
              disabled={saving}
              className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-sm"
            >
              <option value="">— žádné —</option>
              <option value="A">A – řešit ihned</option>
              <option value="B">B – plánovat</option>
              <option value="C">C – sledovat / odložit</option>
              <option value="D">D – čeká na vstupy</option>
            </select>
          </label>
          <PmNoteField initial={idea.pm_note || ''} onSave={v => patchField('pm_note', v)} disabled={saving} />
        </div>

        {/* Workflow — akční tlačítka */}
        <div className="border-t border-cream-200 pt-3">
          <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">Akce</div>
          {!transitions ? (
            <div className="text-ink-400 text-xs">Načítám akce…</div>
          ) : transitions.transitions.length === 0 ? (
            <div className="text-ink-400 text-xs italic">Žádné další akce (stav {idea.state}).</div>
          ) : (
            <div className="space-y-1.5">
              {transitions.transitions.map(t => (
                <TransitionButton
                  key={t.to + t.action}
                  transition={t}
                  ideaId={idea.id}
                  onDone={reload}
                />
              ))}
            </div>
          )}
          {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
        </div>
      </div>

      {/* Pravý sloupec — historie */}
      <div className="bg-white border border-cream-200 rounded-lg p-3">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">Historie ({events.length})</div>
        <ul className="space-y-1.5 text-xs">
          {events.map(ev => (
            <li key={ev.id} className="border-l-2 border-cream-300 pl-2">
              <div className="text-ink-700">
                {ev.action === 'state_change'
                  ? <>Přechod: <em>{ev.from_state}</em> → <strong>{ev.to_state}</strong></>
                  : ev.action === 'create_project'
                    ? <>🚀 Vytvořen projekt</>
                    : ev.action === 'edit'
                      ? <>Úprava polí</>
                      : ev.action}
              </div>
              <div className="text-ink-400 text-[10px]">
                {fmtDate(ev.created_at)}{ev.user_name ? ` · ${ev.user_name}` : ''}
              </div>
              {ev.comment && ev.action !== 'edit' && (
                <div className="text-ink-600 mt-0.5 whitespace-pre-wrap">{ev.comment}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Poznámka PM: textarea s Uložit tlačítkem (patch až po klik, ne po každém keystroke).
function PmNoteField({ initial, onSave, disabled }) {
  const [val, setVal] = useState(initial);
  const dirty = val !== initial;
  return (
    <label className="block text-xs">
      <span className="text-ink-500">Poznámka PM</span>
      <textarea
        value={val}
        onChange={e => setVal(e.target.value)}
        disabled={disabled}
        rows={2}
        className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-sm resize-y"
      />
      {dirty && (
        <button
          type="button"
          onClick={() => onSave(val.trim() || null)}
          disabled={disabled}
          className="mt-1 px-2 py-0.5 bg-brand-500 text-white text-xs rounded hover:bg-brand-600 disabled:opacity-50"
        >Uložit poznámku</button>
      )}
    </label>
  );
}

// Jedno workflow tlačítko. Klik → inline panel:
//   - „create_project": input pro název + team dropdown
//   - requireComment: textarea (Management akce)
//   - jinak přímo Potvrdit
function TransitionButton({ transition, ideaId, onDone }) {
  const { teams } = useTeams();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [projName, setProjName] = useState('');
  const [projTeamId, setProjTeamId] = useState(teams?.[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const canClick = transition.allowed;
  const isCreateProject = transition.special === 'create_project';
  const needsInput = transition.requireComment || isCreateProject;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (isCreateProject) {
        if (!projName.trim()) { setErr('Zadej název projektu.'); return; }
        if (!projTeamId) { setErr('Vyber tým.'); return; }
        await ideasApi.createProject(ideaId, Number(projTeamId), projName.trim());
      } else {
        await ideasApi.transition(ideaId, transition.to, comment.trim() || null);
      }
      setOpen(false); setComment(''); setProjName('');
      await onDone();
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  const btnColor = transition.to === 'zamitnuto'
    ? 'bg-red-500 hover:bg-red-600 text-white'
    : transition.to === 'schvalena_analyza' || transition.to === 'schvaleno_ceka_na_analyzu' || isCreateProject
      ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
      : 'bg-brand-500 hover:bg-brand-600 text-white';

  if (!canClick) return null;

  return (
    <div>
      {!open ? (
        <button
          type="button"
          onClick={() => needsInput ? setOpen(true) : submit()}
          disabled={busy}
          className={`w-full text-left px-3 py-1.5 rounded text-xs ${btnColor} disabled:opacity-50`}
        >
          {busy ? 'Provádím…' : `→ ${transition.action}`}
        </button>
      ) : (
        <div className="border border-cream-300 rounded p-2 bg-cream-50 space-y-2">
          <div className="text-xs font-semibold text-ink-700">{transition.action}</div>
          {isCreateProject ? (
            <>
              <input
                value={projName}
                onChange={e => setProjName(e.target.value)}
                placeholder="Název projektu"
                className="w-full border border-ink-300 rounded px-2 py-1 text-xs"
                autoFocus
              />
              <select
                value={projTeamId}
                onChange={e => setProjTeamId(e.target.value)}
                className="w-full border border-ink-300 rounded px-2 py-1 text-xs"
              >
                <option value="">— vyber tým —</option>
                {teams?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </>
          ) : (
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={2}
              placeholder={transition.requireComment ? 'Komentář (povinný)' : 'Komentář (volitelný)'}
              className="w-full border border-ink-300 rounded px-2 py-1 text-xs resize-y"
              autoFocus
            />
          )}
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className={`flex-1 px-3 py-1.5 rounded text-xs ${btnColor} disabled:opacity-50`}
            >{busy ? 'Provádím…' : 'Potvrdit'}</button>
            <button
              type="button"
              onClick={() => { setOpen(false); setErr(null); }}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs bg-white border border-ink-300 text-ink-600 hover:bg-cream-100"
            >Zrušit</button>
          </div>
        </div>
      )}
    </div>
  );
}
