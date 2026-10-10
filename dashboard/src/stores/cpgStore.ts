import { create } from 'zustand';
import { getCpgMe, type CpgMe } from '../api/cpg';
import { cpgErrorMessage } from '../lib/cpg-errors';

/**
 * The signed-in user's governance identity (GET /api/v1/cpg/me), loaded once
 * per user after the session check. It drives the Governance sidebar group
 * and the permission-guarded routes, so pages never call an endpoint the
 * user cannot use (no 4xx by design). The engine re-checks every request.
 */
export type CpgStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CpgState {
  /** The user the state belongs to; a different signed-in user triggers a reload. */
  userId: string | null;
  me: CpgMe | null;
  status: CpgStatus;
  error: string | null;
  /** Load /cpg/me for this user unless it is already loaded or loading. `force` reloads. */
  load: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Reflect a settings change without a round trip. */
  setCpgEnabled: (enabled: boolean) => void;
  reset: () => void;
}

const initial = { userId: null, me: null, status: 'idle' as CpgStatus, error: null };

// Ignore responses from a load that a newer load (or a reset) superseded.
let generation = 0;

export const useCpgStore = create<CpgState>((set, get) => ({
  ...initial,

  load: async (userId, opts = {}) => {
    const s = get();
    if (!opts.force && s.userId === userId && (s.status === 'loading' || s.status === 'ready')) return;
    const mine = ++generation;
    // A forced refresh of a loaded user keeps showing the current state until
    // the answer arrives, so guarded pages stay mounted while it runs.
    const refreshing = opts.force && s.userId === userId && s.status === 'ready' && s.me !== null;
    if (!refreshing) set({ userId, status: 'loading', error: null, ...(s.userId === userId ? {} : { me: null }) });
    try {
      const me = await getCpgMe();
      if (mine !== generation) return;
      if (me.user.id !== userId) {
        // The session changed under us (another tab signed in as someone else).
        set({ me: null, status: 'error', error: 'Your session changed. Reload the page.' });
        return;
      }
      set({ me, status: 'ready', error: null });
    } catch (err) {
      if (mine !== generation) return;
      set({ me: null, status: 'error', error: cpgErrorMessage(err, 'Could not load your governance permissions') });
    }
  },

  setCpgEnabled: (enabled) => {
    const { me } = get();
    if (me) set({ me: { ...me, cpgEnabled: enabled } });
  },

  reset: () => {
    generation++;
    set({ ...initial });
  },
}));
