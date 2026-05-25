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

  const refreshMe = async () => {
    try {
      const d = await authApi.me();
      setUser(d.user);
      return d.user;
    } catch {
      setUser(null);
      return null;
    }
  };

  const value = {
    user,
    loading,
    setUser,
    refreshMe,
    login: async (email, password) => {
      const d = await authApi.login(email, password);
      setUser(d.user);
      return d.user;
    },
    devLogin: async (userId) => {
      const d = await authApi.devLogin(userId);
      setUser(d.user);
      return d.user;
    },
    changePassword: async (currentPassword, newPassword) => {
      await authApi.changePassword(currentPassword, newPassword);
      await refreshMe();
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
  deleteUsers:    (u) => u && ['admin', 'manager'].includes(u.role),
  // Review tasku: admin vidí vše, manager jen své projekty.
  // Vyžaduje task obsahuje project_manager_id (vrací API tasks/mine, projects/:id, review-queue).
  reviewTask:     (u, task) => u && (u.role === 'admin' || (task && task.project_manager_id === u.id)),
};

export const ROLE_LABELS = {
  admin:        'Admin',
  manager:      'Project Manager',
  senior_dev:   'Senior programátor',
  external_dev: 'Externí programátor',
};
