import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Gavel, ShieldAlert, ArrowRight } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import EmptyState from '../../components/ui/EmptyState';
import type { GovernanceDeniedState } from '../../components/layout/PermissionRoute';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useAuthStore } from '../../stores/authStore';
import { hasOrgPermission, pageByPath, visibleGovernancePages } from '../../lib/cpg-permissions';
import { listTeams, type CpgMe, type MePermission } from '../../api/cpg';
import GovernanceHeader from './GovernanceHeader';

/** /governance: the user's governance status and access (spec §14.2; later phases add the review queue). */
export default function GovernanceOverview() {
  const { me, status, error, reload } = useCpgMe();
  const orgName = useAuthStore((s) => s.org?.name ?? null);
  const location = useLocation();
  const denied = (location.state as GovernanceDeniedState | null)?.denied ?? null;
  const teamNames = useTeamNames(me);

  return (
    <div>
      <GovernanceHeader icon={Gavel} title="Governance" subtitle={`Corporate policy governance for ${orgName ?? 'your organization'}`} />
      {status === 'error' ? (
        <ErrorState message={error ?? 'Could not load your governance permissions'} onRetry={reload} />
      ) : status !== 'ready' || !me ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <OverviewView me={me} orgName={orgName} denied={denied} teamNames={teamNames} />
      )}
    </div>
  );
}

/** Names of the teams the user's team-scoped grants refer to (needs org.members.read; ids are shown otherwise). */
function useTeamNames(me: CpgMe | null): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = !!me && hasOrgPermission(me, 'org.members.read') && me.permissions.some((p) => p.scope === 'team');
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    listTeams()
      .then((teams) => { if (!cancelled) setNames(new Map(teams.map((t) => [t.id, t.name]))); })
      // Best effort: without names the team id is shown, which is still correct.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [wanted]);
  return names;
}

function scopeLabel(p: MePermission, teamNames: ReadonlyMap<string, string>): string {
  if (p.scope === 'org') return 'organization';
  if (p.scope === 'team') return `team ${(p.scopeId && teamNames.get(p.scopeId)) || p.scopeId || 'unknown'}`;
  return `repository ${p.scopeId ?? 'unknown'}`;
}

export function OverviewView({ me, orgName, denied, teamNames = new Map() }: {
  me: CpgMe;
  orgName: string | null;
  denied: GovernanceDeniedState['denied'] | null;
  teamNames?: ReadonlyMap<string, string>;
}) {
  const pages = visibleGovernancePages(me).filter((p) => p.to !== '/governance');
  const canEnable = hasOrgPermission(me, 'org.settings.manage');
  const org = orgName ?? 'your organization';

  // One row per permission key, with every scope it is held at.
  const byKey = new Map<string, string[]>();
  for (const p of me.permissions) byKey.set(p.key, [...(byKey.get(p.key) ?? []), scopeLabel(p, teamNames)]);
  const permissionRows = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      {denied && (
        <Card className="border-warning/40" >
          <div className="flex items-start gap-3" role="status" data-testid="governance-denied">
            <ShieldAlert size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="text-text-primary font-medium">
                You don&apos;t have access to {pageByPath(denied.from)?.label ?? denied.from}.
              </p>
              <p className="text-text-secondary mt-1">
                It needs {denied.missing.map((m, i) => (
                  <span key={m}>{i > 0 && ', '}<span className="font-mono text-xs">{m}</span></span>
                ))}. Ask an Org Admin of {org} to grant you a role that includes it.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-text-secondary mb-1">Status</h2>
            <p className="text-sm text-text-muted">
              {me.cpgEnabled
                ? `Corporate policy governance is on for ${org}.`
                : `Corporate policy governance is off for ${org}. Nothing changes for developers or scans until it is turned on.`}
              {!me.cpgEnabled && (canEnable
                ? ' You can turn it on in Settings once roles and teams are set up.'
                : ' An Org Admin can turn it on.')}
            </p>
          </div>
          <Badge variant={me.cpgEnabled ? 'success' : 'default'}>{me.cpgEnabled ? 'On' : 'Off'}</Badge>
        </div>
      </Card>

      {pages.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {pages.map((p) => (
            <Link key={p.to} to={p.to} className="glass rounded-xl p-5 hover:bg-surface-hover transition group">
              <p className="text-sm font-semibold text-text-primary flex items-center gap-2">
                {p.label} <ArrowRight size={14} className="text-text-muted group-hover:text-accent transition" />
              </p>
              <p className="text-xs text-text-muted mt-1">{p.description}</p>
            </Link>
          ))}
        </div>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-text-secondary mb-1">Your governance permissions</h2>
        <p className="text-xs text-text-muted mb-4">Signed in as {me.user.email}. Permissions come from the roles an Org Admin granted you.</p>
        {permissionRows.length === 0 ? (
          <EmptyState
            title="You hold no governance permissions in this organization"
            description={me.isPlatformAdmin
              ? 'Platform administrators get no organization role. An Org Admin of the organization grants governance access.'
              : 'Ask an Org Admin to grant you a role.'}
          />
        ) : (
          <div className="divide-y divide-border" data-testid="governance-permissions">
            {permissionRows.map(([key, scopes]) => (
              <div key={key} className="flex items-center justify-between py-2 gap-4">
                <span className="font-mono text-xs text-text-primary">{key}</span>
                <span className="text-xs text-text-muted text-right">{scopes.join(', ')}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
