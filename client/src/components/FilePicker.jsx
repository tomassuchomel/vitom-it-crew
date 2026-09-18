// Výběr příloh před odesláním formuláře — seznam, velikost, náhled obrázku
// a odebrání. Sdílí ho veřejný formulář nápadu i interní „Přidat nápad".
//
// Limity drží stejné hodnoty jako backend (server/src/ideaAttachments.js).
// Kontrola tady je jen pro rychlou zpětnou vazbu; rozhoduje vždy server.

import { useEffect, useState } from 'react';

export const MAX_MB = 10;
export const MAX_FILES = 5;
export const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv';

export default function FilePicker({ files, onChange, label = '📎 Přílohy' }) {
  const [err, setErr] = useState(null);

  const add = (picked) => {
    const next = [...files];
    let problem = null;
    for (const f of picked) {
      if (next.length >= MAX_FILES) { problem = `Najednou lze přiložit nejvýš ${MAX_FILES} souborů.`; break; }
      if (f.size > MAX_MB * 1024 * 1024) { problem = `„${f.name}" je větší než ${MAX_MB} MB.`; continue; }
      next.push(f);
    }
    setErr(problem);
    onChange(next);
  };

  return (
    <div>
      <div className="text-xs text-ink-500 mb-1">
        {label} — obrázky, PDF, Word, Excel, TXT (max {MAX_MB} MB na soubor, {MAX_FILES} souborů)
      </div>
      <input type="file" multiple accept={ACCEPT}
        onChange={e => { add(Array.from(e.target.files || [])); e.target.value = ''; }}
        className="text-sm" />
      {err && <div className="text-[11px] text-amber-700 mt-1">{err}</div>}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}
              className="flex items-center gap-2 text-sm bg-cream-50 border border-cream-200 rounded px-2 py-1">
              <Thumb file={f} />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-[11px] text-ink-400">{(f.size / 1024).toFixed(0)} kB</span>
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="text-red-500 text-xs px-1" title="Odebrat">×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Náhled obrázku. Object URL uvolňujeme, aby po odebrání souboru nezůstal
// viset v paměti.
function Thumb({ file }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return undefined;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  if (!url) return <span className="w-8 text-center">📄</span>;
  return <img src={url} alt="" className="w-8 h-8 object-cover rounded" />;
}
