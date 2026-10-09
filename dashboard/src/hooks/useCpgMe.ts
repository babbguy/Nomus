import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCpgStore, type CpgStatus } from '../stores/cpgStore';
import type { CpgMe } from '../api/cpg';

/**
 * The signed-in user's governance identity. Loads GET /cpg/me once per user
 * (never while a temporary password is pending: that call would be refused).
 * State left over from another user is reported as loading, never shown.
 */
export function useCpgMe(): { me: CpgMe | null; status: CpgStatus; error: string | null; reload: () => void } {
  const user = useAuthStore((s) => s.user);
  const { userId, me, status, error, load } = useCpgStore();
  const eligible = !!user && !user.mustChangePassword;

  useEffect(() => {
    if (eligible && user) void load(user.id);
  }, [eligible, user, load]);

  const current = eligible && user && userId === user.id;
  return {
    me: current ? me : null,
    status: current ? status : 'loading',
    error: current ? error : null,
    reload: () => { if (user) void load(user.id, { force: true }); },
  };
}
