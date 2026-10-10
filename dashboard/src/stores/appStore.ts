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

/** Below Tailwind's md breakpoint the sidebar is an overlay over the page. */
export const isNarrowViewport = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches;

const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useAppStore = create<AppState>((set) => ({
  // Expanded on wide screens; on narrow ones the overlay starts closed so it never covers the page.
  sidebarOpen: !isNarrowViewport(),
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
