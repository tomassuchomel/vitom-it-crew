// Auth context – drží přihlášeného uživatele a poskytuje login/logout helpery
import { createContext, useContext, useEffect, useState } from 'react';
import { auth as authApi } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi.me()
      .then(d => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const value = {
    user,
    loading,
    setUser,
    devLogin: async (userId) => {
      const d = await authApi.devLogin(userId);
      setUser(d.user);
      return d.user;
    },
    logout: async () => {
      await authApi.logout();
      setUser(null);
    },
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth musí být uvnitř AuthProvider');
  return ctx;
}

// Kontroly oprávnění – zrcadlí backend
export const can = {
  manageProjects: (u) => u && ['admin', 'manager'].includes(u.role),
  createTasks:    (u) => u && ['admin', 'manager', 'senior_dev'].includes(u.role),
  seeAllHours:    (u) => u && ['admin', 'manager'].includes(u.role),
  seeCosts:       (u) => u && ['admin', 'manager'].includes(u.role),
  manageUsers:    (u) => u && u.role === 'admin',
};

export const ROLE_LABELS = {
  admin:        'Admin',
  manager:      'Project Manager',
  senior_dev:   'Senior programátor',
  external_dev: 'Externí programátor',
};
