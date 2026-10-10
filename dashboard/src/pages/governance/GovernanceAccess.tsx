import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { listOrgUsers, listPermissions, listRoles, listTeams } from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useCpgLoad } from '../../hooks/useCpgLoad';
import { useAuthStore } from '../../stores/authStore';
import { cpgErrorMessage } from '../../lib/cpg-errors';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import { cn } from '../../lib/cn';
import GovernanceHeader from './GovernanceHeader';
import UsersPanel from './access/UsersPanel';
import RolesPanel from './access/RolesPanel';
import TeamsPanel from './access/TeamsPanel';
import type { AccessData } from './access/helpers';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'roles', label: 'Roles' },
  { id: 'teams', label: 'Teams' },
] as const;
type TabId = typeof TABS[number]['id'];

/**
 * /governance/access (E2–E14): org users and their role grants (org-, team-
 * or repository-scoped), custom roles with a permission matrix, and teams.
 * Reads need org.members.read; each kind of change needs its own manage
 * permission, and controls the user cannot use are not shown.
 */
export default function GovernanceAccess() {
  const { me, reload: reloadMe } = useCpgMe();
  const orgName = useAuthStore((s) => s.org?.name ?? null);
  const [params, setParams] = useSearchParams();
  const tab: TabId = (TABS.find((t) => t.id === params.get('tab'))?.id) ?? 'users';

  const { data, error, fetchedAt, reload, retry } = useCpgLoad(async (): Promise<AccessData> => {
    const [users, roles, teams, permissions] = await Promise.all([listOrgUsers(), listRoles(), listTeams(), listPermissions()]);
    return { users, roles, teams, permissions };
  }, 'Failed to load users, roles and teams', [], cpgErrorMessage);

  /** After a change: refetch everything, and the caller's own permissions (they may have changed). */
  const refresh = useCallback(() => {
    reload();
    reloadMe();
  }, [reload, reloadMe]);

  return (
    <div>
      <GovernanceHeader icon={KeyRound} title="Access" subtitle={`Who can do what in ${orgName ?? 'your organization'}`} />

      <div className="flex gap-1 border-b border-border mb-6" role="tablist" aria-label="Access sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'users' ? {} : { tab: t.id }, { replace: true })}
            className={cn(
              'px-4 py-2 text-sm -mb-px border-b-2 transition',
              tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
          >
            {t.label}{data ? ` (${t.id === 'users' ? data.users.length : t.id === 'roles' ? data.roles.length : data.teams.length})` : ''}
          </button>
        ))}
      </div>

      {error && !data ? (
        <ErrorState message={error} onRetry={retry} />
      ) : !data || !me ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          {error && <ErrorState compact message={`${error}. Showing the last loaded data.`} onRetry={retry} />}
          {tab === 'users' && (
            <UsersPanel data={data} meUserId={me.user.id} canManage={hasOrgPermission(me, 'rbac.users.manage')} onChanged={refresh} />
          )}
          {tab === 'roles' && (
            <RolesPanel data={data} canManage={hasOrgPermission(me, 'rbac.roles.manage')} onChanged={refresh} />
          )}
          {tab === 'teams' && (
            <TeamsPanel data={data} canManage={hasOrgPermission(me, 'rbac.teams.manage')} onChanged={refresh} />
          )}
          <DataFreshness fetchedAt={fetchedAt} className="mt-4" />
        </>
      )}
    </div>
  );
}
