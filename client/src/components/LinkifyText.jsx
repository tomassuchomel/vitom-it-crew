// Autolink helper: text s URL detekuje a vyrenderuje URLs jako klikatelné odkazy.
//
// Použití: <LinkifyText text={task.description} onInternalNav={() => onClose()} />
//
// Detekce:
//   - https?://...   → <a target="_blank">
//   - /notes?…       → React Router Link, případně close callback (zavři modal)
//   - /projects/N    → tamtéž
//   - jiné /...      → tamtéž (broadly anything starting with / that looks like a path)

import { Link } from 'react-router-dom';

// Match buď absolutní URL nebo cesta začínající /<path>. Stop na whitespace, závorkách, „/.
const URL_REGEX = /(\bhttps?:\/\/[^\s<>"')]+|\/(?:notes|projects|my-tasks|questions|review|needs-fix|email|admin|profile|time|reports|ai|scoreboard|team)(?:\/[^\s<>"')]*)?(?:\?[^\s<>"')]*)?)/g;

export default function LinkifyText({ text, onInternalNav, className = '' }) {
  if (!text) return null;
  const parts = [];
  let lastIdx = 0;
  for (const m of String(text).matchAll(URL_REGEX)) {
    const url = m[0];
    const start = m.index;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));
    if (url.startsWith('http')) {
      parts.push(
        <a key={start} href={url} target="_blank" rel="noreferrer"
           className="text-brand-500 hover:underline break-all">{url}</a>
      );
    } else {
      parts.push(
        <Link key={start} to={url} onClick={onInternalNav}
              className="text-brand-500 hover:underline break-all">{url}</Link>
      );
    }
    lastIdx = start + url.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <span className={className}>{parts}</span>;
}
