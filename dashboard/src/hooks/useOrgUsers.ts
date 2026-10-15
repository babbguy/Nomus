import { useEffect, useState } from 'react';
import { listOrgUsers, type OrgUser } from '../api/cpg';
import { cpgErrorMessage } from '../lib/cpg-errors';

/**
 * The organization's users (GET /cpg/users), for names of authors, voters
 * and board members. Loaded only when `enabled` (the caller holds
 * org.members.read), so it never makes a call the server would refuse. A
 * failure is reported, and pages fall back to full user ids.
 */
export function useOrgUsers(enabled: boolean): { users: OrgUser[] | null; byId: ReadonlyMap<string, { name: string; email: string }>; error: string | null; reload: () => void } {
  const [users, setUsers] = useState<OrgUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listOrgUsers()
      .then((list) => { if (!cancelled) { setUsers(list); setError(null); } })
      .catch((err) => { if (!cancelled) setError(cpgErrorMessage(err, 'Could not load user names')); });
    return () => { cancelled = true; };
  }, [enabled, key]);

  const byId = new Map((users ?? []).map((u) => [u.id, { name: u.name, email: u.email }]));
  return { users, byId, error, reload: () => setKey((k) => k + 1) };
}
