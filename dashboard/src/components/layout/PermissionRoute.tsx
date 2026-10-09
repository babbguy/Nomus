import { Navigate, useLocation } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import ErrorState from '../ui/ErrorState';
import { useCpgMe } from '../../hooks/useCpgMe';
import { guardDecision, missingPermissions, type PermissionRequirement } from '../../lib/cpg-permissions';

/** Router state the governance overview reads to explain a redirect. */
export interface GovernanceDeniedState {
  denied: { from: string; missing: string[] };
}

/**
 * Route guard for governance pages, driven by GET /cpg/me. Without the
 * permission it redirects to /governance, which explains what is missing;
 * the guarded page never mounts, so it never makes a call that would 403.
 *
 *   <PermissionRoute all={['audit.read']}>...</PermissionRoute>
 *   <PermissionRoute all={['org.members.read']} any={['rbac.users.manage', 'rbac.roles.manage']}>...</PermissionRoute>
 */
export default function PermissionRoute({ all, any, children }: PermissionRequirement & { children: React.ReactNode }) {
  const location = useLocation();
  const { me, status, error, reload } = useCpgMe();
  const decision = guardDecision({ status, me }, { all, any });

  if (decision === 'loading') {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }
  if (decision === 'error') {
    return <ErrorState message={error ?? 'Could not load your governance permissions'} onRetry={reload} />;
  }
  if (decision === 'deny') {
    const state: GovernanceDeniedState = { denied: { from: location.pathname, missing: missingPermissions(me, { all, any }) } };
    return <Navigate to="/governance" replace state={state} />;
  }
  return <>{children}</>;
}
