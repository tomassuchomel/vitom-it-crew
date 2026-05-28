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
import PageHeader from '../components/PageHeader.jsx';
import { useTeams } from '../teams.jsx';
import { notes as notesApi } from '../api.js';

export default function Notes() {
  const { currentTeam } = useTeams();
  const [scope, setScope] = useState('team'); // 'team' | 'personal'
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);   // poznámka v editoru
  const [activeMainId, setActiveMainId] = useState(null); // vybraná hlavní (root) poznámka → sloupec 2
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [aiOpen, setAiOpen] = useState(false);

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

  // Postav strom z flat listu
  const tree = useMemo(() => buildTree(items), [items]);
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
            <button onClick={() => setAiOpen(true)}
              className="px-3 py-1.5 border border-accent-400 text-accent-700 rounded-lg text-sm font-medium hover:bg-accent-50">
              🤖 Zeptat se AI
            </button>
            <button onClick={addRoot}
              className="px-3 py-1.5 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600">
              + Nová poznámka
            </button>
          </div>
        }
      />

      {/* Scope toggle: Týmové / Moje */}
      <div className="px-6 pt-4">
        <div className="inline-flex rounded-lg border border-cream-300 overflow-hidden text-sm">
          <button
            onClick={() => setScope('team')}
            className={`px-4 py-1.5 ${scope === 'team' ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 hover:bg-cream-50'}`}
          >👥 Týmové</button>
          <button
            onClick={() => setScope('personal')}
            className={`px-4 py-1.5 ${scope === 'personal' ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 hover:bg-cream-50'}`}
          >🔒 Moje</button>
        </div>
        <span className="ml-3 text-xs text-ink-400">
          {scope === 'team' ? 'Vidí všichni v týmu.' : 'Vidíš jen ty.'}
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
              <ColumnHeader title="Hlavní poznámky" onAdd={addRoot} addTitle="Nová hlavní poznámka" />
              <ul className="overflow-y-auto flex-1 p-1">
                {tree.map(n => (
                  <MainNoteRow
                    key={n.id}
                    note={n}
                    active={n.id === activeMainId}
                    selected={n.id === selectedId}
                    onSelect={() => selectMain(n.id)}
                    onDelete={() => remove(n.id)}
                  />
                ))}
              </ul>
            </div>

            {/* Sloupec 2 — Podpoznámky vybrané hlavní */}
            <div className="bg-white border border-cream-200 rounded-xl overflow-hidden max-h-[calc(100vh-220px)] flex flex-col">
              <ColumnHeader
                title="Podpoznámky"
                onAdd={activeMain ? () => addChild(activeMain.id) : null}
                addTitle="Nová podpoznámka"
                disabled={!activeMain}
              />
              <div className="overflow-y-auto flex-1 p-1">
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
                  onSaved={() => load(true)}
                  onAddChild={() => addChild(selected.id)}
                  onDelete={() => remove(selected.id)}
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

      {aiOpen && <AiAssistantModal onClose={() => setAiOpen(false)} teamName={currentTeam?.name} />}
    </div>
  );
}

// AI asistent – chat modal. Posílá otázku + historii na /api/notes/ai-ask.
// Backend přidá kontext (poznámky + úkoly + projekty + členové) a vrátí odpověď.
function AiAssistantModal({ onClose, teamName }) {
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

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-stretch justify-end md:items-center md:justify-center" onClick={onClose}>
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
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
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

// Řádek hlavní (root) poznámky ve sloupci 1. Zobrazuje › pokud má podpoznámky,
// jejich počet a hover akci smazat.
function MainNoteRow({ note, active, selected, onSelect, onDelete }) {
  const childCount = note.children?.length || 0;
  return (
    <li
      onClick={onSelect}
      className={`group flex items-center gap-2 px-2 py-2 rounded cursor-pointer transition ${
        active ? 'bg-brand-50' : selected ? 'bg-cream-100' : 'hover:bg-cream-50'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${active ? 'text-brand-700 font-medium' : 'text-ink-800'}`}>
          {note.title || <span className="text-ink-400 italic">(bez názvu)</span>}
        </div>
        {childCount > 0 && (
          <div className="text-[10px] text-ink-400">{childCount} podpoznámek</div>
        )}
      </div>
      {childCount > 0 && <span className="text-ink-300 text-xs">›</span>}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-red-600 text-xs px-1"
        title="Smazat"
      >×</button>
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

              {/* Title – click selects */}
              <button
                onClick={() => onSelect(n.id)}
                className="flex-1 text-left text-sm py-1 truncate"
                title={n.title}
              >
                {n.title || <span className="text-ink-400 italic">(bez názvu)</span>}
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

// Editor vybrané poznámky. Auto-save on blur (title i content). Debounce není
// potřeba — ukládáme při opuštění pole.
function NoteEditor({ note, onSaved, onAddChild, onDelete }) {
  const [title, setTitle] = useState(note.title || '');
  const [content, setContent] = useState(note.content || '');
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    setTitle(note.title || '');
    setContent(note.content || '');
    dirtyRef.current = false;
  }, [note.id]);

  const save = async () => {
    if (!dirtyRef.current) return;
    setSaving(true);
    try {
      await notesApi.update(note.id, { title, content });
      setSavedAt(new Date());
      dirtyRef.current = false;
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-cream-200 rounded-xl p-5">
      <input
        value={title}
        onChange={(e) => { setTitle(e.target.value); dirtyRef.current = true; }}
        onBlur={save}
        placeholder="Název poznámky"
        className="w-full text-xl font-bold text-ink-800 border-0 border-b border-transparent focus:border-cream-300 focus:outline-none pb-1 mb-3"
      />
      <textarea
        value={content}
        onChange={(e) => { setContent(e.target.value); dirtyRef.current = true; }}
        onBlur={save}
        placeholder="Sem piš obsah poznámky… (do budoucna z toho AI vytvoří úkoly)"
        rows={16}
        className="w-full text-sm text-ink-700 border border-cream-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-brand-400 resize-y leading-relaxed"
      />
      <div className="flex items-center justify-between mt-3">
        <div className="text-xs text-ink-400">
          {saving ? 'Ukládám…' : savedAt ? `Uloženo ${savedAt.toLocaleTimeString('cs-CZ')}` : 'Uloží se automaticky při opuštění pole'}
          {note.author_name && <span> · autor {note.author_name}</span>}
        </div>
        <div className="flex items-center gap-2">
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
    </div>
  );
}
