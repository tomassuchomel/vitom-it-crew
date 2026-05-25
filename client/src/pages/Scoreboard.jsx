// Scoreboard – gamifikovaný přehled úspěšnosti uživatelů v dokončování úkolů.
// Visible všem členům current teamu (transparentnost = gamifikace).
//
// Tabulka má řazení podle success_rate. Top 3 mají barevné medaile.
// User vidí pro každého: assigned/done_on_time/done_late/overdue/in_progress/success_rate.
//
// Aktivní jen pro teamy s feature flag success_metrics: true (zatím Management).
// Když ho team nemá zapnutý, stránka ukáže info "feature nezapnut".

import { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import { useTeams, useFeature } from '../teams.jsx';
import { scoreboard as scoreboardApi } from '../api.js';

const MEDAL = ['🥇', '🥈', '🥉'];

// Barva success rate badge dle hodnoty
function rateClass(rate) {
  if (rate == null) return 'bg-slate-100 text-slate-500';
  if (rate >= 90)   return 'bg-emerald-100 text-emerald-800';
  if (rate >= 70)   return 'bg-brand-100 text-brand-700';
  if (rate >= 50)   return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-700';
}

export default function Scoreboard() {
  const { currentTeam } = useTeams();
  const featureOn = useFeature('success_metrics');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!featureOn) { setLoading(false); return; }
    setLoading(true);
    scoreboardApi.list()
      .then(d => setUsers(d.users || []))
      .finally(() => setLoading(false));
  }, [featureOn, currentTeam?.id]);

  if (!featureOn) {
    return (
      <div>
        <PageHeader title="Skóre" subtitle="Úspěšnost dokončování úkolů v termínu" />
        <div className="p-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
            <div className="text-2xl mb-2">🔒</div>
            <div className="text-amber-800 font-medium">Skóre není pro tento team zapnuto.</div>
            <div className="text-sm text-amber-700 mt-1">
              Admin může v <a href="/admin" className="underline">Admin → Teamy</a> zaškrtnout feature
              flag <code>success_metrics</code>.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <div className="p-6 text-ink-500">Načítám…</div>;

  return (
    <div>
      <PageHeader
        title="🏆 Skóre"
        subtitle={`Úspěšnost dokončování úkolů v termínu — ${currentTeam?.name}`}
      />
      <div className="p-6 space-y-4">
        {users.length === 0 ? (
          <div className="text-ink-400 italic">V teamu zatím není dost dat. Zadejte úkoly s termíny a pak teprve uvidíte skóre.</div>
        ) : (
          <>
            {/* Legend */}
            <div className="text-xs text-ink-500 flex flex-wrap gap-x-4 gap-y-1">
              <span><span className="inline-block w-2 h-2 bg-emerald-500 rounded-full mr-1"></span>Včas (≤ termín)</span>
              <span><span className="inline-block w-2 h-2 bg-red-500 rounded-full mr-1"></span>Pozdě (po termínu)</span>
              <span><span className="inline-block w-2 h-2 bg-amber-500 rounded-full mr-1"></span>Po termínu, ještě nedokončené</span>
              <span><span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-1"></span>Pracuje na</span>
            </div>

            {/* Žebříček */}
            <div className="bg-white border border-cream-200 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead className="bg-cream-100 text-xs uppercase tracking-wide text-ink-600">
                  <tr>
                    <th className="px-3 py-2 text-left w-12">#</th>
                    <th className="px-3 py-2 text-left">Uživatel</th>
                    <th className="px-3 py-2 text-center" title="Úspěšnost = včas / (včas + pozdě + po termínu)">Úspěšnost</th>
                    <th className="px-3 py-2 text-center" title="Včas dokončeno">✅ Včas</th>
                    <th className="px-3 py-2 text-center" title="Pozdě dokončeno">⏰ Pozdě</th>
                    <th className="px-3 py-2 text-center" title="Po termínu, stále nedokončeno">🔥 Po termínu</th>
                    <th className="px-3 py-2 text-center" title="Pracuje, ještě v termínu">🛠 Pracuje</th>
                    <th className="px-3 py-2 text-center" title="Dokončeno bez termínu">📦 Bez termínu</th>
                    <th className="px-3 py-2 text-center">Celkem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cream-100">
                  {users.map((u, i) => (
                    <tr key={u.user_id} className={i < 3 ? 'bg-amber-50/30' : 'hover:bg-cream-50'}>
                      <td className="px-3 py-3 text-center">
                        {i < 3 ? <span className="text-xl">{MEDAL[i]}</span> : <span className="text-ink-400">{i + 1}.</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Avatar user={{ id: u.user_id, name: u.name, avatar_updated_at: u.avatar_updated_at }} size={32} />
                          <div>
                            <div className="font-medium text-ink-800">{u.name}</div>
                            <div className="text-[10px] uppercase tracking-wide text-ink-500">{u.team_role}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-block px-3 py-1 rounded-full font-bold text-sm ${rateClass(u.success_rate)}`}>
                          {u.success_rate == null ? '—' : `${u.success_rate}%`}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center font-semibold text-emerald-700">{u.done_on_time}</td>
                      <td className="px-3 py-3 text-center font-semibold text-red-600">{u.done_late}</td>
                      <td className="px-3 py-3 text-center font-semibold text-amber-700">{u.overdue}</td>
                      <td className="px-3 py-3 text-center text-blue-600">{u.in_progress}</td>
                      <td className="px-3 py-3 text-center text-ink-500">{u.done_no_deadline}</td>
                      <td className="px-3 py-3 text-center font-medium text-ink-700">{u.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Vysvětlivka */}
            <div className="text-xs text-ink-500 bg-cream-50 border border-cream-200 rounded p-3">
              <strong>Jak se počítá úspěšnost?</strong> Včas / (Včas + Pozdě + Po termínu).
              Úkoly bez termínu se do úspěšnosti nezapočítávají.
              Stejné pravidlo platí pro všechny — žebříček vidí každý člen teamu.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
