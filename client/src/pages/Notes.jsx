// Poznámky – hierarchický blok (množina/podmnožina) ve stylu profi note appů.
//
// Layout: dva panely.
//   Levý:  strom poznámek (titulky, odsazené dle hloubky, collapse/expand,
//          + podpoznámka, smazat). Klik vybere poznámku.
//   Pravý: editor vybrané poznámky (title + content textarea, auto-save on blur).
//
// Data: GET /api/notes vrací flat array, tady poskládáme strom přes parent_id.
// Team-scoped — poznámky se mění podle aktuálně přepnutého teamu.
//
// Fáze 2 (návazně): tlačítko "🤖 Vytvořit úkoly z poznámky" pošle strom AI
// agentovi, který navrhne úkoly do projektů. Zatím placeholder.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import RichTextEditor from '../components/RichTextEditor.jsx';
import VoiceMeetingModal from '../components/VoiceMeetingModal.jsx';
import DrawingLayer from '../components/DrawingLayer.jsx';
import SuggestedTasksModal from '../components/SuggestedTasksModal.jsx';
import { useTeams } from '../teams.jsx';
import { useAuth } from '../auth.jsx';
import { notes as notesApi, users as usersApi } from '../api.js';

export default function Notes() {
  const { currentTeam } = useTeams();
  const { user } = useAuth();
  const [scope, setScope] = useState('team'); // 'team' | 'personal' | 'shared'
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);   // poznámka v editoru
  const [activeMainId, setActiveMainId] = useState(null); // vybraná hlavní (root) poznámka → sloupec 2
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMinimized, setAiMinimized] = useState(false);
  const [shareNote, setShareNote] = useState(null); // poznámka pro share modal
  const [voiceOpen, setVoiceOpen] = useState(false); // hlasová porada modal

  const load = (silent = false, selectAfter = null) => {
    if (!silent) setLoading(true);
    return notesApi.list(scope)
      .then(d => {
        setItems(d.notes || []);
        if (selectAfter != null) setSelectedId(selectAfter);
      })
      .finally(() => setLoading(false));
  };
  // reload při změně teamu i scope
  useEffect(() => { setSelectedId(null); setActiveMainId(null); load(); /* eslint-disable-next-line */ }, [currentTeam?.id, scope]);

  // Postav strom z flat listu. U sdílených poznámek ignorujeme parent_id
  // (sdílí se jednotlivé poznámky, ne celý strom) → všechny jsou top-level.
  const tree = useMemo(() => {
    const src = scope === 'shared' ? items.map(n => ({ ...n, parent_id: null })) : items;
    return buildTree(src);
  }, [items, scope]);
  const selected = items.find(n => n.id === selectedId) || null;

  // Mapa id → rodič, pro výpočet root předka libovolné poznámky
  const parentOf = useMemo(() => {
    const m = new Map();
    for (const n of items) m.set(n.id, n.parent_id);
    return m;
  }, [items]);
  const rootAncestorId = (id) => {
    let cur = id;
    while (cur != null && parentOf.get(cur) != null) cur = parentOf.get(cur);
    return cur;
  };

  // Hlavní (root) poznámka aktivní ve sloupci 1 → její podstrom jde do sloupce 2
  const activeMain = tree.find(n => n.id === activeMainId) || null;

  // Klik na hlavní poznámku: aktivuje sloupec 2 + otevře ji v editoru
  const selectMain = (id) => { setActiveMainId(id); setSelectedId(id); };
  // Klik na podpoznámku: jen otevře v editoru (sloupec 1 zůstane)
  const selectSub = (id) => setSelectedId(id);

  const addRoot = async () => {
    // Nová root poznámka dědí aktuální scope (týmová vs osobní)
    const d = await notesApi.create({ title: 'Nová poznámka', visibility: scope });
    await load(true, d.note.id);
    setActiveMainId(d.note.id);
  };
  // Z přepisu porady vytvoř novou poznámku (shared scope nemá zápis → padne do team)
  const createFromVoice = async (title, html) => {
    const vis = scope === 'shared' ? 'team' : scope;
    const d = await notesApi.create({ title, content: html, visibility: vis });
    if (scope === 'shared') setScope('team'); // přepni na team, ať je poznámka vidět
    await load(true, d.note.id);
    setActiveMainId(d.note.id);
  };
  const addChild = async (parentId) => {
    // Podpoznámka dědí visibility rodiče (backend to vynutí)
    const d = await notesApi.create({ title: 'Nová podpoznámka', parent_id: parentId });
    // Rozbal rodiče, ať je nová podpoznámka vidět; aktivuj jeho root ve sloupci 1
    setCollapsed(prev => { const n = new Set(prev); n.delete(parentId); return n; });
    setActiveMainId(rootAncestorId(parentId));
    await load(true, d.note.id);
  };
  const remove = async (id) => {
    const node = items.find(n => n.id === id);
    const childCount = items.filter(n => n.parent_id === id).length;
    const msg = childCount > 0
      ? `Smazat poznámku „${node?.title}" a všech ${childCount} podpoznámek?`
      : `Smazat poznámku „${node?.title}"?`;
    if (!confirm(msg)) return;
    await notesApi.remove(id);
    if (selectedId === id) setSelectedId(null);
    if (activeMainId === id) setActiveMainId(null);
    await load(true);
  };
  const toggleCollapse = (id) => {
    setCollapsed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div>
      <PageHeader
        title="📝 Poznámky"
        subtitle={`Hierarchický blok pro ${currentTeam?.name || 'tým'} — množina a podmnožiny.`}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setVoiceOpen(true)}
              className="px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50">
              🎙️ Porada
            </button>
            <button onClick={() => setAiOpen(true)}
              className="px-3 py-1.5 border border-accent-400 text-accent-700 rounded-lg text-sm font-medium hover:bg-accent-50">
              🤖 Zeptat se AI
            </button>
            {scope !== 'shared' && (
              <button onClick={addRoot}
                className="px-3 py-1.5 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                + Nová poznámka
              </button>
            )}
          </div>
        }
      />

      {/* Scope toggle: Týmové / Moje / Sdílené */}
      <div className="px-6 pt-4">
        <div className="inline-flex rounded-lg border border-cream-300 overflow-hidden text-sm">
          <button
            onClick={() => setScope('team')}
            className={`px-4 py-1.5 ${scope === 'team' ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 hover:bg-cream-50'}`}
          >👥 Týmové</button>
          <button
            onClick={() => setScope('personal')}
            className={`px-4 py-1.5 border-l border-cream-300 ${scope === 'personal' ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 hover:bg-cream-50'}`}
          >🔒 Moje</button>
          <button
            onClick={() => setScope('shared')}
            className={`px-4 py-1.5 border-l border-cream-300 ${scope === 'shared' ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 hover:bg-cream-50'}`}
          >🔗 Sdílené</button>
        </div>
        <span className="ml-3 text-xs text-ink-400">
          {scope === 'team' ? 'Vidí všichni v týmu.'
            : scope === 'personal' ? 'Vidíš jen ty.'
            : 'Poznámky, které s tebou někdo sdílel (jen ke čtení).'}
        </span>
      </div>

      <div className="p-6">
        {loading ? (
          <div className="text-ink-500">Načítám…</div>
        ) : items.length === 0 ? (
          <div className="bg-cream-50 border border-cream-200 rounded-xl p-8 text-center">
            <div className="text-3xl mb-2">📝</div>
            <div className="text-ink-700 font-medium">Zatím žádné poznámky</div>
            <div className="text-sm text-ink-500 mt-1">Klikni „+ Nová poznámka" a začni psát. Můžeš vytvářet podpoznámky.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[260px_280px_1fr] gap-4 items-start">
            {/* Sloupec 1 — Hlavní poznámky (top-level) */}
            <div className="bg-white border border-cream-200 rounded-xl overflow-hidden max-h-[calc(100vh-220px)] flex flex-col">
              <ColumnHeader
                title={scope === 'shared' ? 'Sdílené se mnou' : 'Hlavní poznámky'}
                onAdd={scope === 'shared' ? null : addRoot}
                addTitle="Nová hlavní poznámka"
              />
              <ul className="overflow-y-auto flex-1">
                {tree.map(n => (
                  <MainNoteRow
                    key={n.id}
                    note={n}
                    active={n.id === activeMainId}
                    selected={n.id === selectedId}
                    onSelect={() => selectMain(n.id)}
                    onDelete={scope === 'shared' ? null : () => remove(n.id)}
                  />
                ))}
              </ul>
            </div>

            {/* Sloupec 2 — Podpoznámky vybrané hlavní */}
            <div className="bg-white border border-cream-200 rounded-xl overflow-hidden max-h-[calc(100vh-220px)] flex flex-col">
              <ColumnHeader
                title="Podpoznámky"
                onAdd={(activeMain && scope !== 'shared') ? () => addChild(activeMain.id) : null}
                addTitle="Nová podpoznámka"
                disabled={!activeMain}
              />
              <div className="overflow-y-auto flex-1 p-1.5">
                {!activeMain ? (
                  <div className="text-xs text-ink-400 italic p-3 text-center">
                    Vyber hlavní poznámku vlevo
                  </div>
                ) : activeMain.children.length === 0 ? (
                  <div className="text-xs text-ink-400 italic p-3 text-center">
                    Žádné podpoznámky. Přidej tlačítkem +
                  </div>
                ) : (
                  <NoteTree
                    nodes={activeMain.children}
                    depth={0}
                    selectedId={selectedId}
                    collapsed={collapsed}
                    onSelect={selectSub}
                    onAddChild={addChild}
                    onDelete={remove}
                    onToggle={toggleCollapse}
                  />
                )}
              </div>
            </div>

            {/* Sloupec 3 — Editor */}
            <div>
              {selected ? (
                <NoteEditor
                  key={selected.id}
                  note={selected}
                  currentUserId={user?.id}
                  onSaved={() => load(true)}
                  onAddChild={() => addChild(selected.id)}
                  onDelete={() => remove(selected.id)}
                  onShare={(n) => setShareNote(n)}
                />
              ) : (
                <div className="bg-cream-50 border border-cream-200 rounded-xl p-8 text-center text-ink-400">
                  Vyber poznámku, nebo vytvoř novou.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {aiOpen && (
        <AiAssistantModal
          teamName={currentTeam?.name}
          minimized={aiMinimized}
          onMinimize={() => setAiMinimized(true)}
          onRestore={() => setAiMinimized(false)}
          onClose={() => { setAiOpen(false); setAiMinimized(false); }}
        />
      )}
      {shareNote && <ShareNoteModal note={shareNote} onClose={() => setShareNote(null)} />}
      {voiceOpen && <VoiceMeetingModal onClose={() => setVoiceOpen(false)} onCreateNote={createFromVoice} />}
    </div>
  );
}

// Modal pro sdílení poznámky s jiným uživatelem. Načte členy current teamu
// (přes /api/users team-scoped) + aktuální sdílení; umožní přidat/odebrat.
function ShareNoteModal({ note, onClose }) {
  const [users, setUsers] = useState([]);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => {
    Promise.all([usersApi.list(), notesApi.shares(note.id)])
      .then(([u, s]) => { setUsers(u.users || []); setShares(s.shares || []); })
      .finally(() => setLoading(false));
  };
  useEffect(load, [note.id]);

  const sharedIds = new Set(shares.map(s => s.user_id));
  const addShare = async (userId) => {
    setBusy(true);
    try { await notesApi.share(note.id, userId); load(); } finally { setBusy(false); }
  };
  const removeShare = async (userId) => {
    setBusy(true);
    try { await notesApi.unshare(note.id, userId); load(); } finally { setBusy(false); }
  };

  const candidates = users.filter(u => !sharedIds.has(u.id));

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-cream-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink-800">🔗 Sdílet poznámku</h2>
            <div className="text-xs text-ink-500 truncate max-w-xs">{note.title}</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4 text-sm">
          {loading ? <div className="text-ink-400">Načítám…</div> : (
            <>
              {/* Aktuálně sdíleno */}
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-ink-500 mb-1">Sdíleno s</div>
                {shares.length === 0 ? (
                  <div className="text-xs text-ink-400 italic">Zatím s nikým.</div>
                ) : (
                  <ul className="space-y-1">
                    {shares.map(s => (
                      <li key={s.user_id} className="flex items-center justify-between bg-cream-50 border border-cream-200 rounded px-2 py-1.5">
                        <span>{s.name} <span className="text-ink-400 text-xs">({s.email})</span></span>
                        <button onClick={() => removeShare(s.user_id)} disabled={busy}
                          className="text-ink-400 hover:text-red-600 text-xs">odebrat</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {/* Přidat */}
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-ink-500 mb-1">Přidat uživatele</div>
                {candidates.length === 0 ? (
                  <div className="text-xs text-ink-400 italic">Všichni členové týmu už mají přístup.</div>
                ) : (
                  <select
                    onChange={(e) => { if (e.target.value) { addShare(Number(e.target.value)); e.target.value = ''; } }}
                    defaultValue="" disabled={busy}
                    className="w-full border border-ink-300 rounded px-2 py-1.5 text-sm"
                  >
                    <option value="" disabled>— Vyber uživatele —</option>
                    {candidates.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                  </select>
                )}
                <div className="text-[11px] text-ink-400 mt-1">
                  Příjemce poznámku uvidí v sekci „🔗 Sdílené" jen ke čtení.
                </div>
              </div>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-cream-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600">Hotovo</button>
        </div>
      </div>
    </div>
  );
}

// AI asistent – chat modal. Posílá otázku + historii na /api/notes/ai-ask.
// Backend přidá kontext (poznámky + úkoly + projekty + členové) a vrátí odpověď.
function AiAssistantModal({ onClose, teamName, minimized = false, onMinimize, onRestore }) {
  const [messages, setMessages] = useState([]); // {role, content}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const scrollRef = useRef(null);

  const SUGGESTIONS = [
    'Co jsme tento týden dělali?',
    'Jaké jsou teď priority?',
    'Co je rozpracované a co dokončené?',
    'Shrň, co je v poznámkách.',
  ];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setErr(null);
    const newMessages = [...messages, { role: 'user', content: q }];
    setMessages(newMessages);
    setInput('');
    setBusy(true);
    try {
      // historie BEZ poslední otázky (tu pošleme zvlášť jako question)
      const d = await notesApi.aiAsk(q, messages);
      setMessages([...newMessages, { role: 'assistant', content: d.reply || '(prázdná odpověď)' }]);
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'AI dotaz selhal');
      // odeber neúspěšnou user zprávu? necháme ji, ať vidí co se ptal
    } finally {
      setBusy(false);
    }
  };

  // Minimalizovaný stav – plovoucí proužek vpravo dole. Komponenta zůstává
  // mountnutá (Notes drží aiOpen=true), takže konverzace zůstane zachovaná.
  if (minimized) {
    return (
      <button
        onClick={onRestore}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-white border border-cream-300 shadow-lg rounded-full pl-4 pr-3 py-2 hover:shadow-xl transition"
        title="Rozbalit AI asistenta"
      >
        <span className="text-lg">🤖</span>
        <span className="text-sm font-medium text-ink-800">AI asistent</span>
        {messages.length > 0 && (
          <span className="text-[10px] bg-accent-500 text-white rounded-full px-1.5 py-0.5">{messages.length}</span>
        )}
        {busy && <span className="text-xs text-ink-400 animate-pulse">…</span>}
        <span
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="ml-1 text-ink-400 hover:text-red-600 text-lg leading-none"
          title="Zavřít"
        >×</span>
      </button>
    );
  }

  return (
    // V minimalizovatelném režimu nemá overlay zavírat na klik mimo (jen
    // minimalizovat), ať user nepřijde o konverzaci omylem.
    <div className="fixed inset-0 bg-black/40 z-50 flex items-stretch justify-end md:items-center md:justify-center" onClick={onMinimize}>
      <div className="bg-white w-full md:max-w-2xl md:rounded-xl shadow-2xl flex flex-col md:max-h-[85vh] h-full md:h-auto"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-cream-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink-800">🤖 AI asistent</h2>
            <div className="text-xs text-ink-500">
              Ptej se na cokoliv o týmu {teamName} — úkoly, priority, poznámky.
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onMinimize}
              className="w-8 h-8 flex items-center justify-center text-ink-400 hover:text-ink-700 hover:bg-cream-100 rounded"
              title="Minimalizovat">
              {/* podtržítko = minimalizovat */}
              <span className="text-xl leading-none mb-2">_</span>
            </button>
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center text-ink-400 hover:text-ink-700 hover:bg-cream-100 rounded text-2xl leading-none"
              title="Zavřít">×</button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-3 min-h-[300px]">
          {messages.length === 0 ? (
            <div className="text-center text-ink-400 mt-6">
              <div className="text-3xl mb-2">💬</div>
              <div className="text-sm">Zeptej se třeba:</div>
              <div className="flex flex-wrap gap-2 justify-center mt-3">
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} onClick={() => send(s)}
                    className="px-3 py-1.5 text-xs border border-cream-300 rounded-full hover:bg-cream-50 text-ink-600">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-brand-500 text-white rounded-br-sm'
                    : 'bg-cream-100 text-ink-800 rounded-bl-sm'
                }`}>
                  {m.content}
                </div>
              </div>
            ))
          )}
          {busy && (
            <div className="flex justify-start">
              <div className="bg-cream-100 text-ink-500 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm">
                <span className="animate-pulse">přemýšlím…</span>
              </div>
            </div>
          )}
          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        </div>

        {/* Input */}
        <div className="border-t border-cream-200 p-3">
          <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Napiš dotaz…"
              autoFocus
              className="flex-1 border border-cream-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-400"
            />
            <button type="submit" disabled={busy || !input.trim()}
              className="px-4 py-2 bg-accent-500 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              Poslat
            </button>
          </form>
          <div className="text-[10px] text-ink-400 mt-1.5 px-1">
            AI čte týmové poznámky, tvoje osobní poznámky, úkoly a projekty tohoto týmu. Nemůže nic měnit.
          </div>
        </div>
      </div>
    </div>
  );
}

// Hlavička sloupce s názvem a [+] ikonou pro přidání poznámky na dané úrovni.
function ColumnHeader({ title, onAdd, addTitle, disabled = false }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-cream-200 bg-cream-50">
      <span className="text-xs font-bold uppercase tracking-wide text-ink-500">{title}</span>
      {onAdd && (
        <button
          onClick={onAdd}
          disabled={disabled}
          title={addTitle || 'Nová poznámka'}
          className="w-6 h-6 flex items-center justify-center rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-base leading-none"
        >+</button>
      )}
    </div>
  );
}

// Náhled obsahu poznámky – strhne HTML tagy, vrátí prvních ~50 znaků čistého textu.
function notePreview(html, max = 50) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}
// Krátké datum úpravy (Apple list styl): „14:32" dnes, jinak „26. 5."
function noteDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
}

// Řádek hlavní (root) poznámky ve sloupci 1 — Apple Notes styl:
// titulek (tučně) + náhled textu + datum. Plošší (jen spodní oddělovač).
function MainNoteRow({ note, active, selected, onSelect, onDelete }) {
  const childCount = note.children?.length || 0;
  const sharedWithMe = !!note.shared;
  const iShareIt = (note.share_count || 0) > 0;
  const preview = notePreview(note.content);
  return (
    <li
      onClick={onSelect}
      className={`group px-3 py-2.5 cursor-pointer border-b border-cream-100 last:border-0 transition ${
        active || selected ? 'bg-brand-50' : 'hover:bg-cream-50'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Titulek tučně */}
          <div className="text-sm font-semibold text-ink-800 truncate flex items-center gap-1">
            {(sharedWithMe || iShareIt) && <span title={sharedWithMe ? 'Sdíleno s tebou' : 'Sdílíš s ostatními'}>🔗</span>}
            <span className="truncate">{note.title || <span className="text-ink-400 italic font-normal">(bez názvu)</span>}</span>
          </div>
          {/* Náhled + meta řádek */}
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ink-400">
            <span className="whitespace-nowrap">{noteDate(note.updated_at || note.created_at)}</span>
            <span className="truncate">{preview || (childCount > 0 ? `${childCount} podpoznámek` : 'žádný text')}</span>
          </div>
          {sharedWithMe && note.author_name && (
            <div className="text-[10px] text-ink-400 mt-0.5">od {note.author_name}</div>
          )}
        </div>
        {childCount > 0 && <span className="text-ink-300 text-sm mt-0.5">›</span>}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-red-600 text-xs px-1"
            title="Smazat"
          >×</button>
        )}
      </div>
    </li>
  );
}

// Postaví strom z flat listu přes parent_id. Zachovává pořadí (data jsou už
// seřazená backendem dle position).
function buildTree(items) {
  const byParent = new Map();
  for (const it of items) {
    const key = it.parent_id || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(it);
  }
  const build = (parentKey) => (byParent.get(parentKey) || []).map(n => ({
    ...n,
    children: build(n.id),
  }));
  return build('root');
}

// Rekurzivní strom – odsazení dle hloubky, collapse/expand.
function NoteTree({ nodes, depth, selectedId, collapsed, onSelect, onAddChild, onDelete, onToggle }) {
  return (
    <ul className={depth === 0 ? '' : 'ml-3 border-l border-cream-200'}>
      {nodes.map(n => {
        const hasChildren = n.children.length > 0;
        const isCollapsed = collapsed.has(n.id);
        const isSelected = n.id === selectedId;
        return (
          <li key={n.id}>
            <div
              className={`group flex items-center gap-1 pr-1 rounded transition ${
                isSelected ? 'bg-brand-50 text-brand-700' : 'hover:bg-cream-50'
              }`}
              style={{ paddingLeft: depth * 4 }}
            >
              {/* Collapse toggle */}
              <button
                onClick={() => hasChildren && onToggle(n.id)}
                className={`w-4 text-xs ${hasChildren ? 'text-ink-400 hover:text-ink-700' : 'text-transparent'}`}
              >{hasChildren ? (isCollapsed ? '▸' : '▾') : '•'}</button>

              {/* Title + datum – click selects */}
              <button
                onClick={() => onSelect(n.id)}
                className="flex-1 text-left py-1.5 min-w-0"
                title={n.title}
              >
                <div className="text-sm truncate">
                  {n.title || <span className="text-ink-400 italic">(bez názvu)</span>}
                </div>
                <div className="text-[10px] text-ink-400 truncate">
                  {noteDate(n.updated_at || n.created_at)}
                  {notePreview(n.content) ? ` · ${notePreview(n.content, 30)}` : ''}
                </div>
              </button>

              {/* Hover akce */}
              <button
                onClick={() => onAddChild(n.id)}
                className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-brand-500 text-xs px-1"
                title="Přidat podpoznámku"
              >+</button>
              <button
                onClick={() => onDelete(n.id)}
                className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-red-600 text-xs px-1"
                title="Smazat"
              >×</button>
            </div>

            {hasChildren && !isCollapsed && (
              <NoteTree
                nodes={n.children}
                depth={depth + 1}
                selectedId={selectedId}
                collapsed={collapsed}
                onSelect={onSelect}
                onAddChild={onAddChild}
                onDelete={onDelete}
                onToggle={onToggle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Editor vybrané poznámky. Bohatý text (RichTextEditor) + debounced auto-save.
// Když je poznámka sdílená a current user není autor → read-only náhled.
function NoteEditor({ note, onSaved, onAddChild, onDelete, currentUserId, onShare }) {
  const [title, setTitle] = useState(note.title || '');
  const [content, setContent] = useState(note.content || '');
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  // AI zpracování poznámky
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null); // { action, text } (summarize)
  const [aiErr, setAiErr] = useState(null);
  const [taskSuggest, setTaskSuggest] = useState(null); // { tasks, projectId, projectName }
  const [createdInfo, setCreatedInfo] = useState(null);  // { count, projectId } po založení
  // Kreslení (tužka)
  const [drawing, setDrawing] = useState(note.drawing || null);
  const [drawMode, setDrawMode] = useState(false);
  const [penColor, setPenColor] = useState('#dc2626');
  const [penWidth, setPenWidth] = useState(3);
  const [eraser, setEraser] = useState(false);
  const [drawKey, setDrawKey] = useState(0); // změna = remount canvasu (clear)
  const dirtyRef = useRef(false);
  const latestRef = useRef({ title, content, drawing: note.drawing || null });
  const timerRef = useRef(null);

  // Sdílená poznámka, kterou nevlastním → jen čtu (nemůžu editovat)
  const readOnly = note.shared && note.user_id !== currentUserId;

  useEffect(() => {
    setTitle(note.title || '');
    setContent(note.content || '');
    setDrawing(note.drawing || null);
    setDrawMode(false);
    latestRef.current = { title: note.title || '', content: note.content || '', drawing: note.drawing || null };
    dirtyRef.current = false;
    setSavedAt(null);
    setAiResult(null); setAiErr(null); setTaskSuggest(null); setCreatedInfo(null);
  }, [note.id]);

  const doSave = async () => {
    if (!dirtyRef.current || readOnly) return;
    setSaving(true);
    try {
      await notesApi.update(note.id, {
        title: latestRef.current.title,
        content: latestRef.current.content,
        drawing: latestRef.current.drawing,
      });
      setSavedAt(new Date());
      dirtyRef.current = false;
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  // Debounce: ulož 1.2s po poslední změně
  const scheduleSave = () => {
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSave, 1200);
  };
  const changeTitle = (v) => { setTitle(v); latestRef.current.title = v; scheduleSave(); };
  const changeContent = (html) => { setContent(html); latestRef.current.content = html; scheduleSave(); };
  const changeDrawing = (dataUrl) => { setDrawing(dataUrl); latestRef.current.drawing = dataUrl; scheduleSave(); };
  const clearDrawing = () => {
    setDrawing(null); latestRef.current.drawing = null;
    setDrawKey(k => k + 1); // remount canvasu → čistý
    scheduleSave();
  };

  // AI zpracování – nejdřív flush rozepsaných změn, ať AI vidí aktuální obsah
  const runAi = async (action) => {
    if (dirtyRef.current) await doSave();
    setAiBusy(true); setAiErr(null); setAiResult(null); setTaskSuggest(null); setCreatedInfo(null);
    try {
      const d = await notesApi.aiProcess(note.id, action);
      if (action === 'suggest_tasks') {
        // Strukturovaný návrh → otevři review modal
        setTaskSuggest({
          tasks: d.tasks || [],
          projectId: d.suggested_project_id || '',
          projectName: d.suggested_project_name || null,
        });
      } else {
        setAiResult({ action, text: d.reply || '(prázdná odpověď)' });
      }
    } catch (e) {
      setAiErr(e.response?.data?.message || e.response?.data?.error || 'AI zpracování selhalo');
    } finally { setAiBusy(false); }
  };

  // Flush při odchodu z poznámky / unmountu
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current && !readOnly) {
      notesApi.update(note.id, {
        title: latestRef.current.title,
        content: latestRef.current.content,
        drawing: latestRef.current.drawing,
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  if (readOnly) {
    return (
      <div className="bg-white border border-cream-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-100 text-accent-800 font-semibold">🔗 Sdíleno s tebou</span>
          {note.author_name && <span className="text-xs text-ink-500">od {note.author_name}</span>}
        </div>
        <h2 className="text-xl font-bold text-ink-800 mb-3">{note.title}</h2>
        <div className="relative">
          <div className="rte-readonly text-sm text-ink-800 leading-relaxed"
               dangerouslySetInnerHTML={{ __html: note.content || '<p class="text-ink-400">(prázdná poznámka)</p>' }} />
          {note.drawing && (
            <img src={note.drawing} alt="kresba" className="absolute inset-0 w-full h-full pointer-events-none" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-cream-200 rounded-xl p-5">
      {/* Prominentní nadpis (Apple styl) + decentní meta řádek */}
      <input
        value={title}
        onChange={(e) => changeTitle(e.target.value)}
        onBlur={doSave}
        placeholder="Název poznámky"
        className="w-full text-2xl font-extrabold text-ink-800 border-0 focus:outline-none pb-0.5"
      />
      <div className="text-[11px] text-ink-400 mb-3">
        {note.author_name && <>autor {note.author_name} · </>}
        {saving ? 'ukládám…' : savedAt ? `uloženo ${savedAt.toLocaleTimeString('cs-CZ')}` : 'ukládá se automaticky'}
      </div>

      {/* Editor + kreslicí overlay ve společném relativním kontejneru */}
      <div className="relative">
        <RichTextEditor value={content} onChange={changeContent} />
        <DrawingLayer
          key={`${note.id}-${drawKey}`}
          value={drawing}
          editing={drawMode}
          color={penColor}
          width={penWidth}
          eraser={eraser}
          onChange={changeDrawing}
        />
      </div>

      {/* Kreslicí toolbar */}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button onClick={() => setDrawMode(m => !m)}
          className={`px-2.5 py-1 text-xs rounded border font-medium ${
            drawMode ? 'bg-brand-500 text-white border-brand-500' : 'border-cream-300 text-ink-600 hover:bg-cream-50'
          }`}>
          ✏️ {drawMode ? 'Kreslení zapnuté' : 'Kreslit'}
        </button>
        {drawMode && (
          <>
            {/* Tloušťky */}
            {[2, 4, 8].map((w, i) => (
              <button key={w} onClick={() => { setPenWidth(w); setEraser(false); }}
                title={['tenká', 'střední', 'tlustá'][i]}
                className={`w-7 h-7 flex items-center justify-center rounded border ${
                  penWidth === w && !eraser ? 'border-brand-500 bg-brand-50' : 'border-cream-300'
                }`}>
                <span className="rounded-full bg-ink-800" style={{ width: w + 2, height: w + 2 }} />
              </button>
            ))}
            {/* Barvy */}
            {['#0c363e', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#9333ea'].map(c => (
              <button key={c} onClick={() => { setPenColor(c); setEraser(false); }}
                className={`w-6 h-6 rounded-full border-2 ${penColor === c && !eraser ? 'border-ink-800' : 'border-cream-300'}`}
                style={{ background: c }} aria-label={`barva ${c}`} />
            ))}
            {/* Guma + smazat */}
            <button onClick={() => setEraser(e => !e)}
              className={`px-2 py-1 text-xs rounded border ${eraser ? 'border-brand-500 bg-brand-50' : 'border-cream-300 hover:bg-cream-50'}`}>
              🧽 Guma
            </button>
            <button onClick={clearDrawing}
              className="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50">
              Smazat kresbu
            </button>
            <span className="text-[10px] text-ink-400">Kreslení blokuje psaní textu — vypni ho pro úpravu textu.</span>
          </>
        )}
      </div>

      {/* AI zpracování poznámky */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-ink-500">🤖 AI:</span>
        <button onClick={() => runAi('summarize')} disabled={aiBusy}
          className="px-2.5 py-1 text-xs border border-accent-300 text-accent-700 rounded hover:bg-accent-50 disabled:opacity-50">
          Sumarizovat
        </button>
        <button onClick={() => runAi('suggest_tasks')} disabled={aiBusy}
          className="px-2.5 py-1 text-xs border border-accent-300 text-accent-700 rounded hover:bg-accent-50 disabled:opacity-50">
          Navrhnout úkoly
        </button>
        {aiBusy && <span className="text-xs text-ink-400 animate-pulse">přemýšlím…</span>}
      </div>
      {aiErr && <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{aiErr}</div>}
      {aiResult && (
        <div className="mt-2 bg-accent-50/50 border border-accent-200 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-accent-700 uppercase tracking-wide">📝 Shrnutí</span>
            <button onClick={() => setAiResult(null)} className="text-ink-400 hover:text-ink-700 text-xs">zavřít</button>
          </div>
          <div className="text-sm text-ink-800 whitespace-pre-wrap">{aiResult.text}</div>
        </div>
      )}
      {createdInfo && (
        <div className="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2.5 flex items-center justify-between">
          <span>✅ Založeno {createdInfo.count} úkol(ů).{' '}
            <Link to={`/projects/${createdInfo.projectId}`} className="underline font-medium">Otevřít projekt</Link>
          </span>
          <button onClick={() => setCreatedInfo(null)} className="text-ink-400 hover:text-ink-700">×</button>
        </div>
      )}

      <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
        <div className="text-xs text-ink-400">
          {saving ? 'Ukládám…' : savedAt ? `Uloženo ${savedAt.toLocaleTimeString('cs-CZ')}` : ''}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onShare?.(note)}
            className="px-3 py-1.5 text-xs border border-accent-300 text-accent-700 rounded hover:bg-accent-50">
            🔗 Sdílet
          </button>
          <button onClick={onAddChild}
            className="px-3 py-1.5 text-xs border border-brand-300 text-brand-600 rounded hover:bg-brand-50">
            + Podpoznámka
          </button>
          <button onClick={onDelete}
            className="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50">
            🗑 Smazat
          </button>
        </div>
      </div>

      {/* Review + založení AI-navržených úkolů */}
      {taskSuggest && (
        <SuggestedTasksModal
          suggestion={taskSuggest}
          onClose={() => setTaskSuggest(null)}
          onCreated={(count, projectId) => setCreatedInfo({ count, projectId })}
        />
      )}
    </div>
  );
}
