import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface AppState {
  sidebarOpen: boolean;
  activeContext: 'nomus' | 'modus';
  theme: Theme;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
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

/** Below Tailwind's md breakpoint the sidebar is an overlay over the page. */
export const NARROW_VIEWPORT = '(max-width: 767px)';
export const isNarrowViewport = () => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW_VIEWPORT).matches;

const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useAppStore = create<AppState>((set) => ({
  // Expanded on wide screens; on narrow ones the overlay starts closed so it never covers the page.
  sidebarOpen: !isNarrowViewport(),
  activeContext: 'nomus',
  theme: initialTheme,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setContext: (activeContext) => set({ activeContext }),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return { theme: next };
    }),
}));
