import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, can, ROLE_LABELS } from '../auth.jsx';
import { questions as questionsApi } from '../api.js';
import VitomLogo from './VitomLogo.jsx';
import Avatar from './Avatar.jsx';
import AIAdvisor from './AIAdvisor.jsx';

const NAV = [
  { to: '/',          label: 'Timeline',           icon: '📅' },
  { to: '/projects',  label: 'Projekty',           icon: '📁' },
  { to: '/my-tasks',  label: 'Moje úkoly',         icon: '✅' },
  { to: '/questions', label: 'Dotazy k vyřešení',  icon: '💬', badge: 'inboxPending' },
  { to: '/time',      label: 'Hodiny',             icon: '⏱️' },
  { to: '/reports',   label: 'Reporty',            icon: '📊', requireSeeAll: true },
  { to: '/ai',        label: 'AI Coach',           icon: '🤖', requireSeeAll: true },
  { to: '/team',      label: 'Tým',                icon: '👥' },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [counts, setCounts] = useState({ inboxPending: 0, sentPending: 0 });

  // Načítáme počet nevyřízených dotazů – periodicky a při změně stránky
  useEffect(() => {
    let mounted = true;
    const refresh = () => questionsApi.counts()
      .then(d => { if (mounted) setCounts(d); })
      .catch(() => {});
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => { mounted = false; clearInterval(t); };
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    nav('/login');
  };

  return (
    <div className="flex h-full">
      <aside className="w-64 bg-brand-500 text-cream-100 flex flex-col">
        <div className="px-6 py-6 border-b border-brand-700/50 flex items-center gap-3">
          <div className="text-cream-50">
            <VitomLogo size={40} color="currentColor" />
          </div>
          <div>
            <div className="text-xl font-bold tracking-tight text-cream-50 leading-tight">
              VITOM
            </div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-accent-400 leading-tight mt-0.5">
              IT Crew
            </div>
          </div>
        </div>
        <nav className="flex-1 py-4">
          {NAV.filter(n => !n.requireSeeAll || can.seeAllHours(user)).map(item => {
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
      <main className="flex-1 overflow-auto bg-cream-100">
        {children}
      </main>
      {/* Vždy viditelný AI poradce – jen pro admin/manager */}
      <AIAdvisor />
    </div>
  );
}
