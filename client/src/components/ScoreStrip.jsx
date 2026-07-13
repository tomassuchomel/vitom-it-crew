// Score Strip — kompaktní horizontální pruh na Timeline. Snapshot úspěšnosti
// členů current teamu. Top 5 podle objemu (done_on_time + done_late) +
// vždy vlastní řádek (zvýrazněný cerise).
//
// Šířka bar segmentu odpovídá objemu (normalizováno na max v týmu).
// Zelené = včas, oranžové = po termínu. Vpravo: procenta + otevřené.

import { useEffect, useMemo, useState } from 'react';
import Avatar from './Avatar.jsx';
import { scoreboard as scoreboardApi } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useTeams } from '../teams.jsx';

export default function ScoreStrip({ teamName }) {
  const { user } = useAuth();
  const { currentTeam } = useTeams();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Re-fetch při přepnutí týmu — jinak by strip zobrazoval starý tým.
  useEffect(() => {
    setLoading(true);
    scoreboardApi.list()
      .then(d => setUsers(d.users || []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [currentTeam?.id]);

  // Výběr: top 5 dle objemu + já (pokud nejsem v top 5). Preserve pořadí:
  // top 5 nahoře seřazeno, já na konci pokud přidán extra.
  const shown = useMemo(() => {
    if (!users || users.length === 0) return [];
    const withVolume = users.map(u => ({ ...u, _volume: (u.done_on_time || 0) + (u.done_late || 0) }));
    const byVolume = [...withVolume].sort((a, b) => b._volume - a._volume || a.name.localeCompare(b.name));
    const top = byVolume.slice(0, 5);
    const me = withVolume.find(u => u.user_id === user?.id);
    if (me && !top.some(u => u.user_id === me.user_id)) top.push(me);
    return top;
  }, [users, user?.id]);

  // Škála baru: normalizuj šířku na max volume v tomto podmnožině.
  // Když nikdo nemá dokončený úkol, bar prázdný.
  const maxVolume = useMemo(
    () => Math.max(1, ...shown.map(u => u._volume || 0)),
    [shown]
  );

  if (loading) {
    return <div className="text-xs text-ink-400 px-4 py-2">Načítám skóre…</div>;
  }
  if (shown.length === 0) {
    return (
      <div className="text-xs text-ink-400 px-4 py-2">
        Zatím žádná data pro skóre {teamName ? `týmu ${teamName}` : ''}.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {shown.map(u => (
        <ScoreRow key={u.user_id} u={u} maxVolume={maxVolume} isMe={u.user_id === user?.id} />
      ))}
    </div>
  );
}

function ScoreRow({ u, maxVolume, isMe }) {
  const done = (u.done_on_time || 0) + (u.done_late || 0);
  const onTimePct = done > 0 ? (u.done_on_time / done) * 100 : 0;
  const latePct   = done > 0 ? (u.done_late    / done) * 100 : 0;
  // Šířka bar containeru vůči max objemu — normalizace „kdo toho stihl víc".
  const barTotalPct = (u._volume / maxVolume) * 100;
  const openCount = (u.in_progress || 0) + (u.overdue || 0);

  return (
    <div className={`flex items-center gap-3 px-3 py-1.5 rounded ${
      isMe ? 'bg-accent-50 border border-accent-200' : 'hover:bg-cream-50'
    }`}>
      <Avatar user={{ id: u.user_id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={24} />
      <div className={`text-sm w-32 truncate ${isMe ? 'font-semibold text-accent-700' : 'text-ink-800'}`}>
        {u.name}{isMe && <span className="ml-1 text-[10px] text-accent-500">(já)</span>}
      </div>

      {/* Bar: šířka = objem, uvnitř segmenty on_time / late */}
      <div className="flex-1 min-w-[80px] h-3 bg-cream-100 rounded overflow-hidden relative">
        <div className="h-full flex" style={{ width: `${barTotalPct}%` }}>
          {onTimePct > 0 && <div className="h-full bg-emerald-500" style={{ width: `${onTimePct}%` }} />}
          {latePct   > 0 && <div className="h-full bg-amber-500"   style={{ width: `${latePct}%`   }} />}
        </div>
      </div>

      {/* Meta vpravo — 3 kompaktní hodnoty */}
      <div className="flex items-center gap-3 text-xs shrink-0 tabular-nums">
        <span className="text-emerald-700 font-semibold" title="Dokončeno včas / celkem dokončeno">
          ✅ {u.done_on_time}/{done}
        </span>
        <span className={`px-1.5 py-0.5 rounded font-semibold ${
          u.success_rate == null ? 'text-ink-400'
            : u.success_rate >= 90 ? 'text-emerald-700'
            : u.success_rate >= 70 ? 'text-brand-600'
            : u.success_rate >= 50 ? 'text-amber-700'
            : 'text-red-600'
        }`}>
          {u.success_rate == null ? '—' : `${u.success_rate}%`}
        </span>
        <span className="text-ink-500" title="Otevřené (rozpracované + po termínu)">
          🔓 {openCount}
        </span>
      </div>
    </div>
  );
}
