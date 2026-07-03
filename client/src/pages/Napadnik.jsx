// Nápadník - interní Wishlist (Fáze 1).
// Fáze 2 přidá workflow tranzice, F3 analýzu, F4 dashboard, F5 export.

import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { ideas as ideasApi, users as usersApi } from '../api.js';
import { useTeams } from '../teams.jsx';
import { useAuth } from '../auth.jsx';

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
  const [tab, setTab] = useState('wishlist');
  const { user } = useAuth();
  const { teams } = useTeams();
  // perms z BE — pravdivý zdroj (Management OR PM Nápadníku).
  // Před načtením padáme na klientský team check, aby menu neproblíklo.
  const [perms, setPerms] = useState(null);
  useEffect(() => { ideasApi.perms().then(setPerms).catch(() => setPerms({ is_management: false, is_idea_pm: false })); }, []);
  const clientMgmtFallback = user?.role === 'admin' || (teams || []).some(t => t.slug === 'management');
  const isMgmt = perms?.is_management ?? clientMgmtFallback;
  const isIdeaPM = !!perms?.is_idea_pm;
  const canManageIdea = isMgmt || isIdeaPM;
  const isAdmin = user?.role === 'admin';
  // Přístup do Nápadníku vůbec — vidí ho jen Management + PM Nápadníku.
  const hasAccess = canManageIdea;

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

  // Před načtením perms nic neblikni; kdyby BE 403 → hasAccess=false.
  if (perms === null) return <div className="p-8 text-ink-500">Načítám…</div>;
  if (!hasAccess) {
    return (
      <div className="p-8">
        <div className="max-w-lg bg-white border border-cream-200 rounded-xl p-6 text-center">
          <div className="text-4xl mb-2">🔒</div>
          <div className="text-lg font-semibold text-ink-800 mb-1">Nápadník je vyhrazený</div>
          <div className="text-sm text-ink-500">
            Přístup mají členové Managementu a PM Nápadníku. Pokud potřebuješ přístup,
            řekni administrátorovi.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Nápadník"
        subtitle={tab === 'report'
          ? 'Management report — přehled a rozhodnutí'
          : `${filtered.length} z ${ideas.length} nápadů — sběr, schvalování a řízení`}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            {canManageIdea && (
              <a href={ideasApi.exportCsvUrl()} download
                className="px-3 py-1.5 text-sm bg-white border border-ink-300 text-ink-700 rounded-lg hover:bg-cream-50">
                ⬇ Export CSV
              </a>
            )}
            <button type="button" onClick={() => window.print()}
              className="px-3 py-1.5 text-sm bg-white border border-ink-300 text-ink-700 rounded-lg hover:bg-cream-50">
              🖨 Tisk / PDF
            </button>
            <a href="/napadnik-form" target="_blank" rel="noreferrer"
              className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-lg hover:bg-brand-600">
              🔗 Veřejný formulář
            </a>
          </div>
        }
      />
      <div className="px-6 pt-4 flex gap-2 border-b border-cream-200 overflow-x-auto">
        <button onClick={() => setTab('wishlist')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
            tab === 'wishlist' ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-500 hover:text-ink-700'
          }`}>💡 Wishlist</button>
        <button onClick={() => setTab('dashboard')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
            tab === 'dashboard' ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-500 hover:text-ink-700'
          }`}>📈 Dashboard</button>
        {canManageIdea && (
          <button onClick={() => setTab('report')}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === 'report' ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-500 hover:text-ink-700'
            }`}>📊 Report</button>
        )}
      </div>
      {tab === 'report' ? (
        <ReportPanel isAdmin={isAdmin} />
      ) : tab === 'dashboard' ? (
        <DashboardPanel />
      ) : (
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
      )}
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

  const showAnalysis = ['schvaleno_ceka_na_analyzu', 'ke_schvaleni_analyzy', 'schvalena_analyza', 'rozpracovano', 'hotovo'].includes(idea.state);
  const canEditAnalysis =
    ['schvaleno_ceka_na_analyzu', 'ke_schvaleni_analyzy'].includes(idea.state) &&
    (transitions?.isManagement || transitions?.isGarant);

  return (
    <div className="space-y-4 text-sm">
      {showAnalysis && (
        <AnalysisPanel
          ideaId={idea.id}
          analysis={state.analysis}
          canEdit={!!canEditAnalysis}
          onSaved={reload}
        />
      )}
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

// AnalysisPanel — celo-šířkový panel nad grid. Ve stavech čeká-na-analýzu /
// ke_schvaleni_analyzy a s právy garant/Management umožní editaci; jinak
// jen read-only zobrazení (pokud analýza existuje).
function AnalysisPanel({ ideaId, analysis, canEdit, onSaved }) {
  const [expanded, setExpanded] = useState(canEdit || !!analysis);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(() => analysisFormInit(analysis));

  useEffect(() => { setForm(analysisFormInit(analysis)); }, [analysis]);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await ideasApi.saveAnalysis(ideaId, form);
      await onSaved();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setSaving(false); }
  };

  const savedH = (analysis && analysis.time_current_h_per_month != null && analysis.time_after_h_per_month != null)
    ? Math.max(0, Number(analysis.time_current_h_per_month) - Number(analysis.time_after_h_per_month))
    : null;

  return (
    <div className="bg-white border border-cream-200 rounded-lg">
      <button
        type="button"
        onClick={() => setExpanded(x => !x)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-cream-50"
      >
        <span className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
          📊 Analýza dopadu
          {savedH != null && <span className="ml-2 text-emerald-600 normal-case">· úspora {savedH} h/měs</span>}
          {!analysis && !canEdit && <span className="ml-2 text-ink-400 italic normal-case">— zatím nevyplněno</span>}
        </span>
        <span className="text-ink-400 text-xs">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="border-t border-cream-100 p-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <NumField label="Hodin/měs teď" val={form.time_current_h_per_month} onChange={set('time_current_h_per_month')} disabled={!canEdit} />
          <NumField label="Hodin/měs po řešení" val={form.time_after_h_per_month} onChange={set('time_after_h_per_month')} disabled={!canEdit} />
          <NumField label="Jednorázové náklady (Kč)" val={form.onetime_costs_kc} onChange={set('onetime_costs_kc')} disabled={!canEdit} />
          <TextField label="Fin. úspora (odhad)" val={form.financial_savings} onChange={set('financial_savings')} disabled={!canEdit} />
          <TextField label="Interní hodinovka" val={form.internal_hourly_cost} onChange={set('internal_hourly_cost')} disabled={!canEdit} />
          <TextField label="Měs. / roční náklady" val={form.monthly_annual_costs} onChange={set('monthly_annual_costs')} disabled={!canEdit} />
          <TextField label="Cíl. datum realizace" val={form.target_date} onChange={set('target_date')} disabled={!canEdit} />
          <label className="block">
            <span className="text-ink-500">Složitost</span>
            <select value={form.complexity || ''} onChange={set('complexity')} disabled={!canEdit}
              className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-xs">
              <option value="">—</option>
              <option value="low">nízká</option>
              <option value="medium">střední</option>
              <option value="high">vysoká</option>
            </select>
          </label>
          <TextField label="Závislosti" val={form.dependencies} onChange={set('dependencies')} disabled={!canEdit} />
          <div className="md:col-span-3">
            <TextArea label="Rizika" val={form.risks} onChange={set('risks')} disabled={!canEdit} />
          </div>
          <div className="md:col-span-3">
            <TextArea label="Souhrn / doporučení PM" val={form.summary} onChange={set('summary')} disabled={!canEdit} />
          </div>
          {canEdit && (
            <div className="md:col-span-3 flex items-center gap-2 pt-1">
              <button type="button" onClick={save} disabled={saving}
                className="px-3 py-1.5 bg-brand-500 text-white rounded text-xs hover:bg-brand-600 disabled:opacity-50">
                {saving ? 'Ukládám…' : 'Uložit analýzu'}
              </button>
              {err && <span className="text-red-600 text-xs">{err}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function analysisFormInit(a) {
  return {
    time_current_h_per_month: a?.time_current_h_per_month ?? '',
    time_after_h_per_month:   a?.time_after_h_per_month ?? '',
    financial_savings:        a?.financial_savings ?? '',
    internal_hourly_cost:     a?.internal_hourly_cost ?? '',
    onetime_costs_kc:         a?.onetime_costs_kc ?? '',
    monthly_annual_costs:     a?.monthly_annual_costs ?? '',
    target_date:              a?.target_date ?? '',
    complexity:               a?.complexity ?? '',
    dependencies:             a?.dependencies ?? '',
    risks:                    a?.risks ?? '',
    summary:                  a?.summary ?? '',
  };
}

function NumField({ label, val, onChange, disabled }) {
  return (
    <label className="block">
      <span className="text-ink-500">{label}</span>
      <input type="number" step="0.5" value={val ?? ''} onChange={onChange} disabled={disabled}
        className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-xs disabled:bg-cream-50" />
    </label>
  );
}
function TextField({ label, val, onChange, disabled }) {
  return (
    <label className="block">
      <span className="text-ink-500">{label}</span>
      <input type="text" value={val ?? ''} onChange={onChange} disabled={disabled}
        className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-xs disabled:bg-cream-50" />
    </label>
  );
}
function TextArea({ label, val, onChange, disabled }) {
  return (
    <label className="block">
      <span className="text-ink-500">{label}</span>
      <textarea value={val ?? ''} onChange={onChange} disabled={disabled} rows={2}
        className="mt-0.5 w-full border border-ink-300 rounded px-2 py-1 text-xs resize-y disabled:bg-cream-50" />
    </label>
  );
}

// Management report — přehled + akční fronty.
function ReportPanel({ isAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    ideasApi.report().then(setData).catch(e => setErr(e.response?.data?.error || e.message));
  }, []);
  if (err) return <div className="p-6 text-red-600 text-sm">{err}</div>;
  if (!data) return <div className="p-6 text-ink-500 text-sm">Načítám report…</div>;

  const s = data.by_state || {};
  const savings = data.savings || {};

  return (
    <div className="p-6 space-y-6">
      <PmPanel isAdmin={isAdmin} />
      {/* KPI karty */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Ke schválení" value={(s.ke_schvaleni || 0) + (s.ke_schvaleni_analyzy || 0)} color="text-blue-600" />
        <Kpi label="Čekají na analýzu" value={s.schvaleno_ceka_na_analyzu || 0} color="text-indigo-600" />
        <Kpi label="Rozpracované" value={s.rozpracovano || 0} color="text-purple-600" />
        <Kpi label="Hotové" value={s.hotovo || 0} color="text-emerald-600" />
      </div>

      {/* Úspory */}
      <div className="bg-white border border-cream-200 rounded-lg p-4">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">Souhrn úspor (aktivní nápady)</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-2xl font-bold text-emerald-600">
              {Math.round(savings.total_saved_h_per_month || 0)} h/měs
            </div>
            <div className="text-xs text-ink-500">celková úspora času</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-brand-600">
              {(savings.total_onetime_kc || 0).toLocaleString('cs-CZ')} Kč
            </div>
            <div className="text-xs text-ink-500">jednorázové náklady na realizaci</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-ink-700">{savings.n_with_analysis || 0}</div>
            <div className="text-xs text-ink-500">nápadů s analýzou</div>
          </div>
        </div>
      </div>

      {/* Akční fronty */}
      <ReportList title="🎯 Vyžadují schválení" items={data.awaiting_approval} empty="Nic nečeká." />
      <ReportList title="🔍 Čekají na analýzu" items={data.waiting_analysis} empty="Nic nečeká na analýzu." />
      <ReportList title="🚀 Rozpracované projekty" items={data.active} empty="Zatím žádný projekt v realizaci." showProject />
    </div>
  );
}

function Kpi({ label, value, color }) {
  return (
    <div className="bg-white border border-cream-200 rounded-lg p-3">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-ink-500">{label}</div>
    </div>
  );
}

// Dashboard grafy — SVG bez závislostí. Vidí každý (jsou to public agregace).
function DashboardPanel() {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    ideasApi.stats().then(setStats).catch(e => setErr(e.response?.data?.error || e.message));
  }, []);
  if (err) return <div className="p-6 text-red-600 text-sm">{err}</div>;
  if (!stats) return <div className="p-6 text-ink-500 text-sm">Načítám statistiky…</div>;

  const stateEntries = Object.entries(stats.by_state || {})
    .map(([k, v]) => ({ label: STATE_META[k]?.label || k, n: v, color: stateColor(k) }))
    .sort((a, b) => b.n - a.n);
  const total = stateEntries.reduce((s, x) => s + x.n, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="text-xs text-ink-500">Celkem nápadů: <strong className="text-ink-800">{total}</strong></div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard title="Podle stavu">
          <BarChart data={stateEntries} />
        </ChartCard>

        <ChartCard title="Přírůstek — posledních 6 měsíců">
          <MonthlyBars data={stats.monthly_intake || []} />
        </ChartCard>

        <ChartCard title="Podle oddělení">
          <BarChart data={(stats.by_department || []).map(r => ({ label: r.department, n: r.n, color: '#0c363e' }))} />
        </ChartCard>

        <ChartCard title="Podle kategorie">
          <BarChart data={(stats.by_category || []).map(r => ({ label: r.category, n: r.n, color: '#e72b78' }))} />
        </ChartCard>

        <ChartCard title="Doporučení PM">
          <BarChart data={(stats.by_pm_recommendation || []).map(r => ({
            label: r.rec === '?' ? 'bez doporučení' : `${r.rec} – ${PM_REC_META[r.rec]?.label.split('–')[1]?.trim() || ''}`,
            n: r.n,
            color: r.rec === 'A' ? '#dc2626' : r.rec === 'B' ? '#059669' : r.rec === 'C' ? '#94a3b8' : r.rec === 'D' ? '#ea580c' : '#cbd5e1',
          }))} />
        </ChartCard>

        <ChartCard title="Nejaktivnější navrhovatelé">
          <BarChart data={(stats.top_proposers || []).map(r => ({ label: r.proposer_name, n: r.n, color: '#f59e0b' }))} />
        </ChartCard>
      </div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-3">{title}</div>
      {children}
    </div>
  );
}

// Vodorovný bar chart. Škáluje podle maxima.
function BarChart({ data }) {
  if (!data || data.length === 0) return <div className="text-ink-400 text-xs italic">Žádná data.</div>;
  const max = Math.max(...data.map(d => d.n)) || 1;
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-32 truncate text-ink-600 shrink-0" title={d.label}>{d.label}</div>
          <div className="flex-1 bg-cream-100 rounded h-4 relative overflow-hidden">
            <div
              className="h-full rounded transition-all"
              style={{ width: `${(d.n / max) * 100}%`, background: d.color || '#0c363e' }}
            />
          </div>
          <div className="w-8 text-right text-ink-700 tabular-nums shrink-0">{d.n}</div>
        </div>
      ))}
    </div>
  );
}

// Sloupcový graf pro měsíční přírůstek. SVG, jednoduchý.
function MonthlyBars({ data }) {
  if (!data || data.length === 0) return <div className="text-ink-400 text-xs italic">Zatím žádná data.</div>;
  const max = Math.max(...data.map(d => d.n)) || 1;
  const w = 300, h = 100, gap = 4;
  const barW = (w - gap * (data.length - 1)) / data.length;
  return (
    <svg viewBox={`0 0 ${w} ${h + 22}`} className="w-full h-32">
      {data.map((d, i) => {
        const bh = (d.n / max) * h;
        const x = i * (barW + gap);
        return (
          <g key={d.ym}>
            <rect x={x} y={h - bh} width={barW} height={bh} fill="#0c363e" rx="2" />
            <text x={x + barW / 2} y={h + 12} textAnchor="middle" className="fill-ink-500" style={{ fontSize: 10 }}>{d.ym.slice(5)}</text>
            <text x={x + barW / 2} y={h - bh - 3} textAnchor="middle" className="fill-ink-700" style={{ fontSize: 10 }}>{d.n}</text>
          </g>
        );
      })}
    </svg>
  );
}

function stateColor(state) {
  return ({
    zadano:                    '#94a3b8',
    ke_schvaleni:              '#3b82f6',
    schvaleno_ceka_na_analyzu: '#6366f1',
    ke_schvaleni_analyzy:      '#f97316',
    schvalena_analyza:         '#10b981',
    rozpracovano:              '#a855f7',
    hotovo:                    '#059669',
    zamitnuto:                 '#dc2626',
    odlozeno:                  '#f59e0b',
  })[state] || '#94a3b8';
}

function ReportList({ title, items, empty, showProject }) {
  return (
    <div className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">{title} ({items?.length || 0})</div>
      {(!items || items.length === 0) ? (
        <div className="text-ink-400 text-xs italic">{empty}</div>
      ) : (
        <ul className="divide-y divide-cream-100 text-sm">
          {items.map(i => (
            <li key={i.id} className="py-1.5 flex items-center gap-3">
              <span className="text-[10px] text-ink-400 w-10">#{i.id}</span>
              <span className="flex-1 truncate">{i.title}</span>
              <span className="text-xs text-ink-500 truncate max-w-[160px]">{i.department}</span>
              {showProject && i.linked_project_name && (
                <span className="text-xs text-emerald-700 truncate max-w-[180px]">→ {i.linked_project_name}</span>
              )}
              <span className={`text-[10px] px-2 py-0.5 rounded border ${STATE_META[i.state]?.cls || ''}`}>
                {STATE_META[i.state]?.label || i.state}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Panel „PM Nápadníku" v Report tabu. Zobrazuje seznam PMek; admin může
// přidat/odebrat. Ostatní vidí jen seznam (kontext, kdo za Nápadník odpovídá).
function PmPanel({ isAdmin }) {
  const [pms, setPms] = useState([]);
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState('');

  const load = () => ideasApi.pmsList().then(d => setPms(d.pms || [])).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!isAdmin || !showAdd) return;
    usersApi.listAcrossMyTeams()
      .then(d => setUsers(d.users || []))
      .catch(() => usersApi.list().then(d => setUsers(d.users || [])).catch(() => {}));
  }, [isAdmin, showAdd]);

  const add = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try { await ideasApi.pmAdd(Number(selected)); setSelected(''); setShowAdd(false); await load(); }
    catch (e) { setErr(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };
  const remove = async (userId, name) => {
    if (!window.confirm(`Odebrat ${name} jako PM Nápadníku?`)) return;
    setBusy(true); setErr(null);
    try { await ideasApi.pmRemove(userId); await load(); }
    catch (e) { setErr(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  // Kandidáti pro přidání = users, kteří ještě nejsou PM.
  const pmIds = new Set(pms.map(p => p.user_id));
  const candidates = users.filter(u => !pmIds.has(u.id));

  return (
    <div className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
          🎯 PM Nápadníku ({pms.length})
        </div>
        {isAdmin && !showAdd && (
          <button type="button" onClick={() => setShowAdd(true)}
            className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">
            + Přidat
          </button>
        )}
      </div>
      {pms.length === 0 ? (
        <div className="text-ink-400 text-xs italic">Zatím nikdo. {isAdmin && 'Přidej PM Nápadníku, který bude Nápadník sledovat, vyhodnocovat a reportovat.'}</div>
      ) : (
        <ul className="divide-y divide-cream-100 text-sm">
          {pms.map(p => (
            <li key={p.user_id} className="py-1.5 flex items-center gap-3">
              <span className="flex-1 truncate">{p.name}</span>
              <span className="text-xs text-ink-500 truncate max-w-[200px]">{p.email}</span>
              {isAdmin && (
                <button type="button" disabled={busy} onClick={() => remove(p.user_id, p.name)}
                  className="text-xs text-red-600 hover:underline">Odebrat</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {showAdd && (
        <div className="mt-3 pt-3 border-t border-cream-100 flex items-center gap-2 flex-wrap">
          <select value={selected} onChange={e => setSelected(e.target.value)}
            className="border border-ink-300 rounded px-2 py-1 text-sm flex-1 min-w-[180px]">
            <option value="">— vyber uživatele —</option>
            {candidates.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button type="button" onClick={add} disabled={busy || !selected}
            className="px-3 py-1 bg-brand-500 text-white rounded text-xs hover:bg-brand-600 disabled:opacity-50">
            Přidat
          </button>
          <button type="button" onClick={() => { setShowAdd(false); setSelected(''); }}
            className="px-3 py-1 text-xs text-ink-500 hover:text-ink-700">Zrušit</button>
        </div>
      )}
      {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
      <div className="mt-2 text-[11px] text-ink-400">
        PM Nápadníku sleduje, vyhodnocuje a reportuje. Vidí Report/Dashboard, exportuje CSV,
        edituje garanty a doporučení, může posunout analýzu a vytvořit projekt.
        Neschvaluje a nezamítá — to zůstává Managementu.
      </div>
    </div>
  );
}
