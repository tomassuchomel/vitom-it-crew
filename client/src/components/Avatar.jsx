// Avatar – kruhový obrázek uživatele. Fallback na iniciály na barevném pozadí.
// Props:
//   user – { id, name, first_name, last_name, avatar_updated_at } (stačí id + name)
//   size – px (default 32)
//   ring – přidá kontrastní rámeček
import { useEffect, useState } from 'react';
import { users as usersApi } from '../api.js';

// Stabilní barva podle ID uživatele (Tailwind paleta)
const COLORS = [
  'bg-rose-500', 'bg-pink-500', 'bg-fuchsia-500', 'bg-purple-500',
  'bg-violet-500', 'bg-indigo-500', 'bg-blue-500', 'bg-sky-500',
  'bg-cyan-500', 'bg-teal-500', 'bg-emerald-500', 'bg-green-500',
  'bg-lime-600', 'bg-amber-500', 'bg-orange-500',
];
function colorForId(id) {
  const n = Number(id) || 0;
  return COLORS[n % COLORS.length];
}

function initialsFor(user) {
  if (!user) return '?';
  if (user.first_name || user.last_name) {
    return `${(user.first_name || '')[0] || ''}${(user.last_name || '')[0] || ''}`.toUpperCase() || '?';
  }
  const parts = String(user.name || '').trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
  return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase() || '?';
}

export default function Avatar({ user, size = 32, ring = false, className = '' }) {
  const [errored, setErrored] = useState(false);
  const url = user?.id ? usersApi.avatarUrl(user) : null;

  // Reset error state if user/avatar version changes
  useEffect(() => { setErrored(false); }, [url]);

  const fontSize = Math.max(10, Math.floor(size * 0.4));
  const ringCls = ring ? 'ring-2 ring-white shadow-sm' : '';
  const baseStyle = { width: size, height: size, fontSize };

  if (url && !errored) {
    return (
      <img
        src={url}
        alt={user?.name || ''}
        title={user?.name || ''}
        onError={() => setErrored(true)}
        className={`inline-block rounded-full object-cover ${ringCls} ${className}`}
        style={baseStyle}
      />
    );
  }

  const bg = colorForId(user?.id);
  return (
    <span
      title={user?.name || ''}
      className={`inline-flex items-center justify-center rounded-full font-semibold text-white select-none ${bg} ${ringCls} ${className}`}
      style={baseStyle}
    >
      {initialsFor(user)}
    </span>
  );
}
