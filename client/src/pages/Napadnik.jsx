// Nápadník - interní Wishlist (Fáze 1).
// Fáze 2 přidá workflow tranzice, F3 analýzu, F4 dashboard, F5 export.

import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { ideas as ideasApi } from '../api.js';

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

  const load = () => {
    setLoading(true);
    ideasApi.list()
      .then(d => setIdeas(d.ideas || []))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

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
                            <IdeaDetail data={detail} onChanged={() => { load(); toggleExpand(i.id); }} />
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

// Placeholder pro rozbalený detail — v F2 přidáme workflow tlačítka.
function IdeaDetail({ data }) {
  const { idea, events } = data;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
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
        </div>
      </div>

      <div className="bg-white border border-cream-200 rounded-lg p-3">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">Workflow (Fáze 2)</div>
        <div className="text-xs text-ink-500 italic">
          Tlačítka pro posun stavu, editace garanta / doporučení PM
          a komentáře přijdou ve Fázi 2.
        </div>
      </div>

      <div className="bg-white border border-cream-200 rounded-lg p-3">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-2">Historie ({events.length})</div>
        <ul className="space-y-1.5 text-xs">
          {events.slice(0, 8).map(ev => (
            <li key={ev.id} className="border-l-2 border-cream-300 pl-2">
              <div className="text-ink-700">
                {ev.action}{ev.to_state ? ` → ${ev.to_state}` : ''}
              </div>
              <div className="text-ink-400 text-[10px]">
                {fmtDate(ev.created_at)}{ev.user_name ? ` · ${ev.user_name}` : ''}
              </div>
              {ev.comment && <div className="text-ink-500 mt-0.5">{ev.comment.slice(0, 120)}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
