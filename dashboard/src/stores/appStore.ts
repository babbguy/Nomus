import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface AppState {
  sidebarOpen: boolean;
  activeContext: 'nomus' | 'modus';
  theme: Theme;
  toggleSidebar: () => void;
  setContext: (ctx: 'nomus' | 'modus') => void;
  toggleTheme: () => void;
}

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem('nomus-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark';
}

function applyTheme(theme: Theme) {
  if (theme === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }
  localStorage.setItem('nomus-theme', theme);
}

const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  activeContext: 'nomus',
  theme: initialTheme,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setContext: (activeContext) => set({ activeContext }),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return { theme: next };
    }),
}));
