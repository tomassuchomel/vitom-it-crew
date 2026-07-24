import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, can, ROLE_LABELS } from '../auth.jsx';
import { useTeams } from '../teams.jsx';
// Helper – nav item s feature flag dependency je viditelný jen když current team má flag
// zapnut. Funkce useFeature() z teams.jsx by potřebovala flag jako argument; tady to
// uděláme inline přes currentTeam.features.
const teamHasFeature = (team, key) => !!team?.features?.[key];
import { ideas as ideasApi, navCounts as navCountsApi } from '../api.js';
import VitomLogo from './VitomLogo.jsx';
import Avatar from './Avatar.jsx';
import AIAdvisor from './AIAdvisor.jsx';
import QuickCaptureFAB from './QuickCaptureFAB.jsx';

const NAV = [
  { to: '/',          label: 'Timeline',           icon: '📅' },
  { to: '/projects',  label: 'Projekty',           icon: '📁' },
  { to: '/my-tasks',  label: 'Moje úkoly',         icon: '✅', badge: 'myTasks', hasTeamSubmenu: true },
  { to: '/find-tasks', label: 'Hledat úkoly',      icon: '🔍' },
  { to: '/needs-fix', label: 'Vrácené k opravě',   icon: '🔄', badge: 'needsFix', hasTeamSubmenu: true },
  { to: '/review',    label: 'Review k dokončení', icon: '👀', badge: 'reviewQueue', requireManager: true, hasTeamSubmenu: true },
  { to: '/questions', label: 'Dotazy k vyřešení',  icon: '💬', badge: 'inboxPending', hasTeamSubmenu: true },
  { to: '/answers',   label: 'Odpovědi na dotazy', icon: '📩', badge: 'answersUnread', hasTeamSubmenu: true },
  { to: '/due-requests', label: 'Žádosti o zm. termínu', icon: '📅', badge: 'dueRequests' },
  { to: '/notes',     label: 'Poznámky',           icon: '📝' },
  { to: '/porady',    label: 'Porady',             icon: '🗓' },
  { to: '/mzv',       label: 'MZV',                icon: '🎯', requireManager: true },
  { to: '/napadnik',  label: 'Nápadník',           icon: '💡', requireIdeaAccess: true },
  { to: '/email',     label: 'Email',              icon: '📧' },
  { to: '/time',      label: 'Hodiny',             icon: '⏱️' },
  { to: '/reports',   label: 'Reporty',            icon: '📊', requireSeeAll: true },
  { to: '/ai',        label: 'AI Coach',           icon: '🤖', requireSeeAll: true },
  { to: '/team',      label: 'Tým',                icon: '👥' },
  { to: '/scoreboard',label: 'Skóre',              icon: '🏆' },
  { to: '/admin',     label: 'Admin',              icon: '⚙️', requireAdmin: true },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const { currentTeam, teams } = useTeams();
  // Sjednocené counts z /api/nav-counts. Každá kategorie:
  //   { total, byTeam: { <team_id>: <count> } }
  // Prázdný default aby přístupy .total/.byTeam v renderu nespadly.
  const emptyCat = { total: 0, byTeam: {} };
  const [counts, setCounts] = useState({
    myTasks: emptyCat, needsFix: emptyCat, reviewQueue: emptyCat,
    inboxPending: emptyCat, answersUnread: emptyCat,
  });
  // Nápadník je vyhrazený Managementu a PM Nápadníku. Menu se skryje pro ostatní.
  const [ideaAccess, setIdeaAccess] = useState(false);
  useEffect(() => {
    ideasApi.perms()
      .then(p => setIdeaAccess(!!p.is_management || !!p.is_idea_pm))
      .catch(() => setIdeaAccess(false));
  }, [user?.id]);
  // Mobile drawer: na malých obrazovkách je sidebar schovaný; hamburger ho otevře.
  // lg+ má sidebar pořád viditelný (původní desktop UX).
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);
  // Rozbalené submenu (per-item path). Ukládá stav napříč renderama.
  const [expandedSubmenu, setExpandedSubmenu] = useState(() => new Set());
  const toggleSubmenu = (path) => setExpandedSubmenu(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  // Sjednocený endpoint /api/nav-counts — jedno volání pro všechny badge.
  // Periodicky 30s + při navigaci, ať čísla svítí aktuální.
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const d = await navCountsApi.get();
        if (mounted) setCounts(d);
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
        <div className="font-bold text-sm tracking-tight leading-tight">
          Intelligent Task
          <div className="text-[9px] font-normal text-accent-400 leading-none">by VITOM</div>
        </div>
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
            <div className="text-lg font-bold tracking-tight text-cream-50 leading-tight">
              Intelligent Task
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-accent-400 leading-tight mt-0.5">by VITOM</div>
            <TeamSwitcher />
          </div>
        </div>
        <nav className="flex-1 py-4">
          {NAV.filter(n =>
            (!n.requireSeeAll || can.seeAllHours(user)) &&
            (!n.requireManager || can.manageProjects(user)) &&
            (!n.requireAdmin || user?.role === 'admin') &&
            (!n.requireFeature || teamHasFeature(currentTeam, n.requireFeature)) &&
            (!n.requireIdeaAccess || ideaAccess)
          ).map(item => {
            // counts[item.badge] je { total, byTeam } (nebo undefined u položek bez badge).
            const cat = item.badge ? counts[item.badge] : null;
            const badgeNum = cat?.total || 0;
            const byTeam = cat?.byTeam || {};
            // Submenu jen dává smysl, když je user aspoň ve 2 týmech (přepínání)
            const showSubmenu = item.hasTeamSubmenu && teams?.length >= 2;
            const isExpanded = expandedSubmenu.has(item.to);
            return (
              <div key={item.to}>
                <div className="flex items-stretch">
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `flex-1 flex items-center gap-3 px-6 py-2.5 text-sm hover:bg-brand-600 transition ${
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
                  {showSubmenu && (
                    <button
                      onClick={() => toggleSubmenu(item.to)}
                      className="px-3 text-cream-100/60 hover:text-cream-50 hover:bg-brand-600 transition"
                      title={isExpanded ? 'Sbalit podmenu' : 'Rozbalit podle týmů'}
                    >{isExpanded ? '▾' : '▸'}</button>
                  )}
                </div>
                {showSubmenu && isExpanded && (
                  <div className="bg-brand-700/40">
                    <NavLink
                      to={item.to}
                      end
                      className={({ isActive }) => `flex items-center pl-14 pr-6 py-1.5 text-[13px] transition ${
                        isActive && !new URLSearchParams(location.search).get('team')
                          ? 'text-white font-medium' : 'text-cream-100/70 hover:text-cream-50'
                      }`}
                    >
                      <span className="flex-1">Vše (napříč týmy)</span>
                      {badgeNum > 0 && <span className="text-[11px] text-cream-100/50 ml-2">{badgeNum}</span>}
                    </NavLink>
                    {teams.map(t => {
                      const n = byTeam[t.id] || 0;
                      return (
                        <NavLink
                          key={t.id}
                          to={`${item.to}?team=${t.id}`}
                          className={({ isActive }) => {
                            const activeThis = isActive && Number(new URLSearchParams(location.search).get('team')) === t.id;
                            return `flex items-center pl-14 pr-6 py-1.5 text-[13px] transition ${
                              activeThis ? 'text-white font-medium' : 'text-cream-100/70 hover:text-cream-50'
                            }`;
                          }}
                        >
                          <span className="flex-1">· {t.name}</span>
                          {n > 0 && <span className="text-[11px] text-cream-100/50 ml-2">{n}</span>}
                        </NavLink>
                      );
                    })}
                    {/* Cross-team úkoly (hidden subtask assignee apod.) — jen info řádek,
                        součet za nečlenské týmy. Bez odkazu, filtrovací klik na 'Vše'
                        je stejně ukáže. */}
                    {(cat?.other || 0) > 0 && (
                      <div
                        className="flex items-center pl-14 pr-6 py-1.5 text-[13px] text-cream-100/60 italic"
                        title="Úkoly/dotazy mimo tvé týmy (např. cross-team subtask). Klikni na 'Vše' pro zobrazení."
                      >
                        <span className="flex-1">· Ostatní</span>
                        <span className="text-[11px] text-cream-100/50 ml-2">{cat.other}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
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
      {/* Mobil: pt = výška topbaru (3rem) + iOS safe area. lg+ žádný topbar → pt-0.
          pb dole zajišťuje, že poslední obsah stránky není překryt FAB tlačítky
          (AIAdvisor + QuickCapture jsou fixed bottom-4 right-4 s ~60 px výškou)
          ani PWA update toastem. Bez tohohle na dlouhých seznamech (Scoreboard
          tabulka) poslední řádek mizí za tlačítky. */}
      <main className="flex-1 overflow-auto bg-cream-100 pt-[calc(3rem+env(safe-area-inset-top))] lg:pt-0 pb-24 lg:pb-8">
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
