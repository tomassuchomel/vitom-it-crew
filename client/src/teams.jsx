// TeamContext – globální state pro multi-team support.
//
// API:
//   const { teams, currentTeam, switchTeam, loading, refresh } = useTeams();
//
//   - teams: array všech teamů, ve kterých je user členem (+ admin vidí všechny)
//   - currentTeam: aktuálně přepnutý team (objekt včetně features)
//   - switchTeam(teamId): přepne, uloží do localStorage, reloadne data
//   - refresh(): znovu načte seznam (po add/remove member apod.)
//
// Persistence: current_team_id v localStorage. Interceptor v api.js ho posílá
// jako X-Team-Id header na backend, který validuje členství.
//
// Použití: <TeamProvider> obal v App.jsx kolem ProtectedRoutes (uvnitř AuthProvider,
// aby useAuth() bylo dostupné).

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { teams as teamsApi } from './api.js';
import { useAuth } from './auth.jsx';

const TeamContext = createContext({
  teams: [],
  currentTeam: null,
  switchTeam: () => {},
  refresh: () => {},
  loading: true,
});

export function TeamProvider({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [teams, setTeams] = useState([]);
  const [currentTeamId, setCurrentTeamId] = useState(() => {
    const v = localStorage.getItem('current_team_id');
    return v ? Number(v) : null;
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) { setTeams([]); setLoading(false); return; }
    try {
      const d = await teamsApi.list();
      setTeams(d.teams || []);
      // Pokud localStorage má team, ale user už v něm není (např. vyhozený),
      // resetuj na první team, kterého je členem.
      const valid = (d.teams || []).find(t => t.id === currentTeamId);
      if (!valid && d.teams?.length) {
        const first = d.teams[0];
        localStorage.setItem('current_team_id', String(first.id));
        setCurrentTeamId(first.id);
      } else if (!d.teams?.length) {
        localStorage.removeItem('current_team_id');
        setCurrentTeamId(null);
      }
    } catch (e) {
      // Při unauthorized neházíme nahoru – auth už nás vyhodí na /login
      setTeams([]);
    } finally {
      setLoading(false);
    }
  }, [user, currentTeamId]);

  // Reload teamů, kdykoli se user změní (přihlášení / odhlášení).
  useEffect(() => {
    if (authLoading) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading]);

  const switchTeam = useCallback((teamId) => {
    if (!teamId) return;
    localStorage.setItem('current_team_id', String(teamId));
    setCurrentTeamId(Number(teamId));
    // Vynucený reload stránky – nejjednodušší způsob, jak refreshnout všechna
    // data všech komponent (projects, tasks, …). Bez reload by každá stránka
    // musela explicitně refetchovat, což je rozsáhlejší změna.
    window.location.reload();
  }, []);

  const currentTeam = teams.find(t => t.id === currentTeamId) || null;

  return (
    <TeamContext.Provider value={{ teams, currentTeam, switchTeam, refresh: load, loading }}>
      {children}
    </TeamContext.Provider>
  );
}

export function useTeams() {
  return useContext(TeamContext);
}

// Helper: má current team danou featuru zapnutou?
// Použití: const aiOn = useFeature('ai_agent');
export function useFeature(featureKey) {
  const { currentTeam } = useTeams();
  const features = currentTeam?.features || {};
  return !!features[featureKey];
}
