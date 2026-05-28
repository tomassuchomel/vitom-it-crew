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
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());

  const load = (silent = false, selectAfter = null) => {
    if (!silent) setLoading(true);
    return notesApi.list()
      .then(d => {
        setItems(d.notes || []);
        if (selectAfter != null) setSelectedId(selectAfter);
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* reload při změně teamu */ }, [currentTeam?.id]);

  // Postav strom z flat listu
  const tree = useMemo(() => buildTree(items), [items]);
  const selected = items.find(n => n.id === selectedId) || null;

  const addRoot = async () => {
    const d = await notesApi.create({ title: 'Nová poznámka' });
    await load(true, d.note.id);
  };
  const addChild = async (parentId) => {
    const d = await notesApi.create({ title: 'Nová podpoznámka', parent_id: parentId });
    // Rozbal rodiče, ať je nová podpoznámka vidět
    setCollapsed(prev => { const n = new Set(prev); n.delete(parentId); return n; });
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
    await load(true);
  };
  const toggleCollapse = (id) => {
    setCollapsed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div>
      <PageHeader
        title="📝 Poznámky"
        subtitle={`Hierarchický blok pro ${currentTeam?.name || 'tým'} — množina a podmnožiny. Do budoucna z nich AI vytvoří úkoly.`}
        actions={
          <button onClick={addRoot}
            className="px-3 py-1.5 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600">
            + Nová poznámka
          </button>
        }
      />

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
          <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
            {/* Strom */}
            <div className="bg-white border border-cream-200 rounded-xl p-2 self-start max-h-[calc(100vh-220px)] overflow-y-auto">
              <NoteTree
                nodes={tree}
                depth={0}
                selectedId={selectedId}
                collapsed={collapsed}
                onSelect={setSelectedId}
                onAddChild={addChild}
                onDelete={remove}
                onToggle={toggleCollapse}
              />
            </div>

            {/* Editor */}
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
                  Vyber poznámku vlevo, nebo vytvoř novou.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
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
