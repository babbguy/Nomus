import { create } from 'zustand';
import { useCpgStore } from './cpgStore';
import { login as apiLogin, logout as apiLogout, getMe, forceChangePassword as apiForceChange, type User, type Org } from '../api/auth';

interface AuthState {
  user: User | null;
  org: Org | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  forceChangePassword: (password: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  org: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (email, password) => {
    const { user, org } = await apiLogin(email, password);
    set({ user, org, isAuthenticated: true, isLoading: false });
  },

  logout: async () => {
    try { await apiLogout(); } catch { /* ignore */ }
    useCpgStore.getState().reset();
    set({ user: null, org: null, isAuthenticated: false, isLoading: false });
  },

  checkSession: async () => {
    try {
      const { user, org } = await getMe();
      set({ user, org, isAuthenticated: true, isLoading: false });
    } catch {
      set({ user: null, org: null, isAuthenticated: false, isLoading: false });
    }
  },

  forceChangePassword: async (password) => {
    await apiForceChange(password);
    const { user } = get();
    if (user) set({ user: { ...user, mustChangePassword: false } });
  },
}));
