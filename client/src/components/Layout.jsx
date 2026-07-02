import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, can, ROLE_LABELS } from '../auth.jsx';
import { useTeams } from '../teams.jsx';
// Helper – nav item s feature flag dependency je viditelný jen když current team má flag
// zapnut. Funkce useFeature() z teams.jsx by potřebovala flag jako argument; tady to
// uděláme inline přes currentTeam.features.
const teamHasFeature = (team, key) => !!team?.features?.[key];
import { questions as questionsApi, reviews as reviewsApi } from '../api.js';
import VitomLogo from './VitomLogo.jsx';
import Avatar from './Avatar.jsx';
import AIAdvisor from './AIAdvisor.jsx';
import QuickCaptureFAB from './QuickCaptureFAB.jsx';

const NAV = [
  { to: '/',          label: 'Timeline',           icon: '📅' },
  { to: '/projects',  label: 'Projekty',           icon: '📁' },
  { to: '/my-tasks',  label: 'Moje úkoly',         icon: '✅' },
  { to: '/needs-fix', label: 'Vrácené k opravě',   icon: '🔄', badge: 'needsFix' },
  { to: '/review',    label: 'Review k dokončení', icon: '👀', badge: 'reviewQueue', requireManager: true },
  { to: '/questions', label: 'Dotazy k vyřešení',  icon: '💬', badge: 'inboxPending' },
  { to: '/answers',   label: 'Odpovědi na dotazy', icon: '📩', badge: 'answersUnread' },
  { to: '/notes',     label: 'Poznámky',           icon: '📝' },
  { to: '/napadnik',  label: 'Nápadník',           icon: '💡' },
  { to: '/email',     label: 'Email',              icon: '📧' },
  { to: '/time',      label: 'Hodiny',             icon: '⏱️' },
  { to: '/reports',   label: 'Reporty',            icon: '📊', requireSeeAll: true },
  { to: '/ai',        label: 'AI Coach',           icon: '🤖', requireSeeAll: true },
  { to: '/team',      label: 'Tým',                icon: '👥' },
  { to: '/scoreboard',label: 'Skóre',              icon: '🏆', requireFeature: 'success_metrics' },
  { to: '/admin',     label: 'Admin',              icon: '⚙️', requireAdmin: true },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const { currentTeam } = useTeams();
  const [counts, setCounts] = useState({ inboxPending: 0, sentPending: 0, reviewQueue: 0, needsFix: 0, answersUnread: 0 });
  // Mobile drawer: na malých obrazovkách je sidebar schovaný; hamburger ho otevře.
  // lg+ má sidebar pořád viditelný (původní desktop UX).
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

  // Načítáme počet nevyřízených dotazů + review fronty + vrácených úkolů.
  // Periodicky (30s) a při změně stránky, ať badge svítí aktuální číslo.
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [q, r, nf] = await Promise.all([
          questionsApi.counts(),
          can.manageProjects(user) ? reviewsApi.queue().catch(() => ({ tasks: [] })) : Promise.resolve({ tasks: [] }),
          reviewsApi.needsFix().catch(() => ({ tasks: [] })),
        ]);
        if (mounted) setCounts({
          ...q,
          reviewQueue: r.tasks?.length || 0,
          needsFix: nf.tasks?.length || 0,
        });
      } catch {/* ignore */}
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => { mounted = false; clearInterval(t); };
  }, [location.pathname, user]);

  const handleLogout = async () => {
    await logout();
    nav('/login');
  };

  // Sidebar styles: na lg+ statické, na mobilu fixed slide-in drawer.
  const sidebarClasses = [
    'w-64 bg-brand-500 text-cream-100 flex-col',
    'lg:flex lg:static lg:translate-x-0',
    'fixed inset-y-0 left-0 z-40 flex transition-transform duration-200',
    mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
  ].join(' ');

  return (
    <div className="flex h-full">
      {/* Mobile topbar — jen pod lg breakpointem. Obsahuje hamburger + název current teamu. */}
      <div
        className="lg:hidden fixed top-0 inset-x-0 z-30 bg-brand-500 text-cream-50 flex items-center gap-3 px-3 h-12 shadow-md"
        style={{ paddingTop: 'env(safe-area-inset-top)', height: 'calc(3rem + env(safe-area-inset-top))' }}
      >
        <button
          onClick={() => setMobileMenuOpen(true)}
          className="p-2 -ml-1 rounded hover:bg-brand-600 active:bg-brand-700"
          aria-label="Menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
        </button>
        <div className="font-bold text-sm tracking-tight">VITOM</div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-accent-400 truncate">
          {currentTeam?.name || ''}
        </div>
      </div>

      {/* Backdrop pro otevřený drawer */}
      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-0 bg-black/40 z-30" onClick={() => setMobileMenuOpen(false)} />
      )}

      <aside className={sidebarClasses}>
        <div className="px-6 py-6 border-b border-brand-700/50 flex items-center gap-3">
          <div className="text-cream-50">
            <VitomLogo size={40} color="currentColor" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xl font-bold tracking-tight text-cream-50 leading-tight">
              VITOM
            </div>
            <TeamSwitcher />
          </div>
        </div>
        <nav className="flex-1 py-4">
          {NAV.filter(n =>
            (!n.requireSeeAll || can.seeAllHours(user)) &&
            (!n.requireManager || can.manageProjects(user)) &&
            (!n.requireAdmin || user?.role === 'admin') &&
            (!n.requireFeature || teamHasFeature(currentTeam, n.requireFeature))
          ).map(item => {
            const badgeNum = item.badge ? counts[item.badge] : 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-6 py-2.5 text-sm hover:bg-brand-600 transition ${
                    isActive ? 'bg-brand-600 text-white border-l-4 border-accent-500 pl-5' : 'text-cream-100/85'
                  }`
                }
              >
                <span className="text-base">{item.icon}</span>
                <span className="flex-1">{item.label}</span>
                {badgeNum > 0 && (
                  <span className="bg-accent-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                    {badgeNum}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="p-5 border-t border-brand-700/50 text-xs">
          <NavLink to="/profile" className="flex items-center gap-3 hover:bg-brand-600/40 -mx-2 px-2 py-1.5 rounded-lg transition">
            <Avatar user={user} size={36} ring />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-cream-50 truncate">{user?.name}</div>
              <div className="text-cream-100/70 truncate">{ROLE_LABELS[user?.role]}</div>
            </div>
          </NavLink>
          <button
            onClick={handleLogout}
            className="mt-2 text-accent-400 hover:text-accent-300 underline"
          >Odhlásit</button>
        </div>
      </aside>
      {/* Mobil: pt = výška topbaru (3rem) + iOS safe area. lg+ žádný topbar → pt-0. */}
      <main className="flex-1 overflow-auto bg-cream-100 pt-[calc(3rem+env(safe-area-inset-top))] lg:pt-0">
        {children}
      </main>
      {/* Vždy viditelný AI poradce – jen pro admin/manager */}
      <AIAdvisor />
      {/* Quick Capture — hlasovka → AI klasifikuje → akce */}
      <QuickCaptureFAB />
    </div>
  );
}

// TeamSwitcher – dropdown pod logem v sidebaru. Pokud má user 1 team, jen ho zobrazí
// jako label (žádné menu, není co přepínat). U 2+ teamů ukáže select.
// Po výběru zavolá switchTeam() z TeamContextu, který uloží do localStorage a reloadne.
function TeamSwitcher() {
  const { teams, currentTeam, switchTeam, loading } = useTeams();

  if (loading) {
    return <div className="text-[10px] uppercase tracking-[0.25em] text-accent-400 leading-tight mt-0.5">…</div>;
  }
  if (!teams.length) {
    return <div className="text-[10px] uppercase tracking-[0.25em] text-accent-400 leading-tight mt-0.5">no team</div>;
  }
  if (teams.length === 1) {
    return (
      <div className="text-[10px] uppercase tracking-[0.25em] text-accent-400 leading-tight mt-0.5">
        {currentTeam?.name || teams[0].name}
      </div>
    );
  }
  return (
    <select
      value={currentTeam?.id || teams[0].id}
      onChange={(e) => switchTeam(Number(e.target.value))}
      className="mt-0.5 bg-transparent text-[10px] uppercase tracking-[0.18em] text-accent-400 border border-accent-400/40 rounded px-1 py-0.5 hover:border-accent-400 focus:outline-none cursor-pointer w-full"
      title="Přepnout team"
    >
      {teams.map(t => (
        <option key={t.id} value={t.id} className="bg-brand-700 text-cream-100">
          {t.name}
        </option>
      ))}
    </select>
  );
}
