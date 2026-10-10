import { useEffect, useState } from 'react';
import { Scale, ShieldCheck, Pencil } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import {
  getQuorum, getQuorumVersion, listBoards, listPolicies, listQuorumVersions,
  type QuorumConfig, type QuorumVersion,
} from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useOrgUsers } from '../../hooks/useOrgUsers';
import { useCpgLoad } from '../../hooks/useCpgLoad';
import { formatActor, hasOrgPermission } from '../../lib/cpg-permissions';
import { formatUtc, policyErrorMessage, TIER_LABEL } from '../../lib/cpg-policy';
import { EDITABLE_TIERS, SCOPE_LABEL, quorumChanges, slotSummary } from '../../lib/cpg-quorum-form';
import { QUORUM_SCOPES } from '../../api/cpg-quorum';
import GovernanceHeader from './GovernanceHeader';
import QuorumEditor from './quorum/QuorumEditor';
import FixedRules from './quorum/FixedRules';
import { Mono } from './policies/parts';

type Names = ReadonlyMap<string, { name: string; email: string }>;

/**
 * /governance/quorum (E25–E28): the versioned, signed approval quorum.
 * Everyone with policy.read sees the configuration in force; quorum.manage
 * holders edit it (every save is a new signed version); history needs
 * audit.read or quorum.manage.
 */
export default function GovernanceQuorum() {
  const { me } = useCpgMe();
  const canManage = hasOrgPermission(me, 'quorum.manage');
  const canHistory = canManage || hasOrgPermission(me, 'audit.read');
  const { byId: names } = useOrgUsers(hasOrgPermission(me, 'org.members.read'));
  const { data, error, fetchedAt, reload, retry } = useCpgLoad(
    () => Promise.all([getQuorum(), listBoards(), listPolicies()]), 'Failed to load the quorum configuration');
  const [current, boards, policies] = data ?? [null, [], []];
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const boardNames = new Map(boards.map((b) => [b.id, b.name]));
  const policyNames = new Map(policies.map((p) => [p.policyId, p.policyKey]));

  return (
    <div>
      <GovernanceHeader
        icon={Scale}
        title="Approval quorum"
        subtitle="Who must approve what. Every change is a new signed version; decisions record the version that applied."
        actions={canManage && current && !editing ? <Button size="sm" onClick={() => { setNotice(null); setEditing(true); }}><Pencil size={14} /> Edit</Button> : undefined}
      />
      {notice && <p className="text-sm text-success mb-3" role="status" data-testid="quorum-notice">{notice}</p>}
      {error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : !current ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : editing ? (
        <QuorumEditor
          current={current}
          boards={boards}
          policies={policies}
          onCancel={() => setEditing(false)}
          onSaved={(v) => { setEditing(false); setNotice(`Saved as version ${v.version}. It applies to every decision from now on.`); reload(); }}
        />
      ) : (
        <div className="space-y-4">
          <QuorumView version={current} boardNames={boardNames} policyNames={policyNames} names={names} />
          {canHistory && <QuorumHistory currentVersion={current.version} names={names} policyNames={policyNames} />}
          <DataFreshness fetchedAt={fetchedAt} />
        </div>
      )}
    </div>
  );
}

export function QuorumView({ version, boardNames, policyNames, names }: {
  version: QuorumVersion;
  boardNames: ReadonlyMap<string, string>;
  policyNames: ReadonlyMap<string, string>;
  names: Names;
}) {
  const c = version.config;
  const overrides = Object.entries(c.policyOverrides);
  return (
    <div className="space-y-4" data-testid="quorum-view">
      <Card>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Version {version.version} (in force)</h2>
            <p className="text-xs text-text-muted mt-0.5">
              {formatActor(version.createdBy, names)} · {formatUtc(version.createdAt)}{version.changeNote ? ` · "${version.changeNote}"` : ''}
            </p>
          </div>
          <Badge variant="success"><ShieldCheck size={12} className="mr-1" /> Signed</Badge>
        </div>
        <details className="mt-2 text-xs">
          <summary className="text-text-secondary cursor-pointer hover:text-accent">Hash and signature</summary>
          <p className="mt-1 text-text-muted">Config hash (sha256)</p>
          <Mono className="text-text-secondary">{version.configHash}</Mono>
          <p className="mt-1 text-text-muted">Ed25519 signature (base64)</p>
          <Mono className="text-text-secondary">{version.signature}</Mono>
        </details>
      </Card>

      <FixedRules />

      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-sm" data-testid="quorum-tiers">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Scope</th>
              {EDITABLE_TIERS.map((t) => <th key={t} className="px-4 py-3 font-medium">{TIER_LABEL[t]}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {QUORUM_SCOPES.map((s) => (
              <tr key={s} className="align-top">
                <td className="px-4 py-3 text-text-primary whitespace-nowrap">{SCOPE_LABEL[s]}</td>
                {EDITABLE_TIERS.map((t) => (
                  <td key={t} className="px-4 py-3 text-xs text-text-secondary">
                    {t === 'prohibited' && s === 'bulk' ? 'Never allowed (fixed)' : slotSummary(c.tiers[t][s], boardNames)}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="px-4 py-3 text-text-primary">Advisory tier</td>
              <td colSpan={2} className="px-4 py-3 text-xs text-text-secondary">Never blocks; no review (fixed)</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <h3 className="text-xs text-text-muted mb-1">Policy approval</h3>
          <p className="text-sm text-text-primary">{c.policyApproval.approvals} approval{c.policyApproval.approvals === 1 ? '' : 's'} by Policy Approvers who did not write or compile the version</p>
          <p className="text-xs text-text-muted mt-1">Proposals lapse after {c.proposalLapseDays} days without a decision.</p>
        </Card>
        <Card>
          <h3 className="text-xs text-text-muted mb-1">Standing exceptions</h3>
          <p className="text-sm text-text-primary">Expiry up to {c.standingExceptions.maxExpiryDays} days (default {c.standingExceptions.defaultExpiryDays})</p>
          <p className="text-xs text-text-muted mt-1">Organization-wide repository patterns: {c.standingExceptions.allowOrgWideRepoPatterns ? 'allowed' : 'not allowed'}</p>
        </Card>
        <Card>
          <h3 className="text-xs text-text-muted mb-1">Grace period defaults</h3>
          <p className="text-sm text-text-primary">New policy: {c.gracePeriod.newPolicyDefaultDays} day{c.gracePeriod.newPolicyDefaultDays === 1 ? '' : 's'}</p>
          <p className="text-sm text-text-primary">New version: {c.gracePeriod.newVersionDefaultDays} day{c.gracePeriod.newVersionDefaultDays === 1 ? '' : 's'}</p>
        </Card>
      </div>

      <Card>
        <h3 className="text-sm font-semibold text-text-primary mb-2">Per-policy overrides</h3>
        {overrides.length === 0 ? (
          <p className="text-xs text-text-muted">None: every policy follows its tier.</p>
        ) : (
          <ul className="space-y-2 text-xs" data-testid="quorum-overrides">
            {overrides.map(([policyId, o]) => (
              <li key={policyId}>
                <p className="font-mono text-text-primary">{policyNames.get(policyId) ?? policyId}</p>
                {QUORUM_SCOPES.filter((s) => o[s]).map((s) => (
                  <p key={s} className="text-text-secondary">{SCOPE_LABEL[s]}: {slotSummary(o[s], boardNames)}</p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function QuorumHistory({ currentVersion, names, policyNames }: { currentVersion: number; names: Names; policyNames: ReadonlyMap<string, string> }) {
  const { data: items, error, retryKeepingData } = useCpgLoad(listQuorumVersions, 'Failed to load the quorum history', [currentVersion]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pair, setPair] = useState<{ v: QuorumVersion; prev: QuorumVersion | null } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    Promise.all([getQuorumVersion(selected), selected > 1 ? getQuorumVersion(selected - 1) : Promise.resolve(null)])
      .then(([v, prev]) => { if (!cancelled) { setPair({ v, prev }); setPairError(null); } })
      .catch((err) => { if (!cancelled) setPairError(policyErrorMessage(err, `Failed to load version ${selected}`)); });
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <Card>
      <h2 className="text-sm font-semibold text-text-primary mb-2">Version history</h2>
      {error ? <ErrorState compact message={error} onRetry={retryKeepingData} /> : items === null ? (
        <div className="flex justify-center py-4"><Spinner className="w-5 h-5" /></div>
      ) : items.length === 0 ? (
        <EmptyState title="No versions yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="quorum-history">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-2 py-2 font-medium">Version</th>
                <th className="px-2 py-2 font-medium">Created</th>
                <th className="px-2 py-2 font-medium">By</th>
                <th className="px-2 py-2 font-medium">Change note</th>
                <th className="px-2 py-2 font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...items].reverse().map((v) => (
                <tr key={v.version} className="align-top">
                  <td className="px-2 py-2 text-text-primary">v{v.version}{v.version === currentVersion ? ' (in force)' : ''}</td>
                  <td className="px-2 py-2 text-xs text-text-secondary whitespace-nowrap">{formatUtc(v.createdAt)}</td>
                  <td className="px-2 py-2 text-xs text-text-secondary">{formatActor(v.createdBy, names)}</td>
                  <td className="px-2 py-2 text-xs text-text-secondary">{v.changeNote || '—'}</td>
                  <td className="px-2 py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => { setPair(null); setSelected(selected === v.version ? null : v.version); }}>
                      {selected === v.version ? 'Hide' : v.version === 1 ? 'Show' : 'Changes'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected !== null && (
        <div className="mt-3 border-t border-border pt-3" data-testid="quorum-version-changes">
          {pairError ? <ErrorState compact message={pairError} /> : !pair ? (
            <div className="flex justify-center py-4"><Spinner className="w-5 h-5" /></div>
          ) : (
            <VersionChanges v={pair.v} prev={pair.prev} policyNames={policyNames} />
          )}
        </div>
      )}
    </Card>
  );
}

function VersionChanges({ v, prev, policyNames }: { v: QuorumVersion; prev: QuorumVersion | null; policyNames: ReadonlyMap<string, string> }) {
  if (!prev) {
    return <p className="text-xs text-text-secondary">Version 1 is the initial configuration (hash <Mono>{v.configHash}</Mono>).</p>;
  }
  const rows = quorumChanges(prev.config as QuorumConfig, v.config as QuorumConfig, policyNames);
  if (rows.length === 0) return <p className="text-xs text-text-secondary">Version {v.version} repeats version {prev.version} (for example a rollback).</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-text-muted">
          <th className="px-2 py-1 font-medium">Setting</th>
          <th className="px-2 py-1 font-medium">v{prev.version}</th>
          <th className="px-2 py-1 font-medium">v{v.version}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.field}>
            <td className="px-2 py-1 text-text-secondary">{r.field}</td>
            <td className="px-2 py-1 text-danger break-all">{r.before}</td>
            <td className="px-2 py-1 text-success break-all">{r.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
