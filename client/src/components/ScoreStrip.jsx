// Score Strip — kompaktní grid dlaždic na Timeline. Snapshot úspěšnosti
// členů current teamu. Top 5 podle objemu + vždy vlastní řádek.
//
// Jedna dlaždice = avatar + jméno + procento. Klik → /scoreboard s detailem.
// Vejde se ~6 dlaždic na řádek (podle šířky), takže sekce zabírá minimum.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar.jsx';
import { scoreboard as scoreboardApi } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useTeams } from '../teams.jsx';

export default function ScoreStrip({ teamName }) {
  const { user } = useAuth();
  const { currentTeam } = useTeams();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    scoreboardApi.list()
      .then(d => setUsers(d.users || []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [currentTeam?.id]);

  const shown = useMemo(() => {
    if (!users || users.length === 0) return [];
    const withVolume = users.map(u => ({ ...u, _volume: (u.done_on_time || 0) + (u.done_late || 0) }));
    const byVolume = [...withVolume].sort((a, b) => b._volume - a._volume || a.name.localeCompare(b.name));
    const top = byVolume.slice(0, 5);
    const me = withVolume.find(u => u.user_id === user?.id);
    if (me && !top.some(u => u.user_id === me.user_id)) top.push(me);
    return top;
  }, [users, user?.id]);

  if (loading) return <div className="text-xs text-ink-400 px-2 py-1">Načítám skóre…</div>;
  if (shown.length === 0) {
    return (
      <div className="text-xs text-ink-400 px-2 py-1">
        Zatím žádná data pro skóre {teamName ? `týmu ${teamName}` : ''}.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {shown.map(u => (
        <ScoreTile key={u.user_id} u={u} isMe={u.user_id === user?.id} />
      ))}
    </div>
  );
}

function ScoreTile({ u, isMe }) {
  const pct = u.success_rate;
  const pctCls = pct == null ? 'text-ink-400'
    : pct >= 90 ? 'text-emerald-700'
    : pct >= 70 ? 'text-brand-600'
    : pct >= 50 ? 'text-amber-700'
    : 'text-red-600';
  return (
    <Link
      to="/scoreboard"
      title="Klik pro detail — kolik má dokončeno, pozdě, po termínu"
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition ${
        isMe
          ? 'bg-accent-50 border-accent-300 hover:bg-accent-100'
          : 'bg-white border-cream-200 hover:border-cream-300 hover:bg-cream-50'
      }`}
    >
      <Avatar user={{ id: u.user_id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={22} />
      <span className={`text-xs truncate max-w-[100px] ${isMe ? 'font-semibold text-accent-700' : 'text-ink-800'}`}>
        {u.name}
      </span>
      <span className={`text-xs font-bold tabular-nums ${pctCls}`}>
        {pct == null ? '—' : `${pct}%`}
      </span>
    </Link>
  );
}
