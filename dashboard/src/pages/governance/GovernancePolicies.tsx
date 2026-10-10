import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScrollText, Plus } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { listPolicies, type PolicyHead } from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useCpgLoad } from '../../hooks/useCpgLoad';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import {
  STATE_LABEL, enforcementSummary, matchesPolicyFilter, pendingLabel, policyFilterCounts, type PolicyFilter,
} from '../../lib/cpg-policy';
import GovernanceHeader from './GovernanceHeader';
import { FilterTabs, InfoNote, TableHead } from './parts';
import { StateBadge, TierBadge } from './policies/parts';

const FILTERS: Array<{ value: PolicyFilter; label: string }> = [
  { value: '', label: 'All' },
  { value: 'awaiting', label: 'Awaiting approval' },
  { value: 'active', label: STATE_LABEL.active },
  { value: 'draft', label: STATE_LABEL.draft },
  { value: 'retired', label: STATE_LABEL.retired },
];

/** /governance/policies (E31): the corporate policy log. */
export default function GovernancePolicies() {
  const { me } = useCpgMe();
  const navigate = useNavigate();
  const canAuthor = hasOrgPermission(me, 'policy.author');
  const { data: items, error, fetchedAt, retry } = useCpgLoad(listPolicies, 'Failed to load the policy log');
  const [filter, setFilter] = useState<PolicyFilter>('');
  const [now] = useState(() => Date.now());

  const shown = (items ?? []).filter((p) => matchesPolicyFilter(p, filter));
  const counts = items ? policyFilterCounts(items) : null;

  return (
    <div>
      <GovernanceHeader
        icon={ScrollText}
        title="Corporate policies"
        subtitle="Company-defined rules, each version approved by someone other than its author"
        actions={canAuthor ? <Button size="sm" onClick={() => navigate('/governance/policies/new')}><Plus size={14} /> New policy</Button> : undefined}
      />

      {me && !me.cpgEnabled && (
        <InfoNote role="status">
          Governance is off for this organization. Policies can be written and approved now, but scanners receive none of them until an Org Admin turns governance on.
        </InfoNote>
      )}

      <FilterTabs
        label="Filter by state"
        className="mb-4"
        options={FILTERS.map((f) => ({ value: f.value, label: `${f.label}${counts ? ` (${counts[f.value]})` : ''}` }))}
        value={filter}
        onChange={setFilter}
      />

      {error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : items === null ? (
        <SkeletonTable rows={5} />
      ) : (
        <>
          <PolicyTable items={shown} now={now} filtered={!!filter} canAuthor={canAuthor} />
          <DataFreshness fetchedAt={fetchedAt} className="mt-2" />
        </>
      )}
    </div>
  );
}

export function PolicyTable({ items, now, filtered, canAuthor }: { items: PolicyHead[]; now: number; filtered: boolean; canAuthor: boolean }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title={filtered ? 'No policies in this state' : 'No corporate policies yet'}
        description={filtered ? 'Choose another filter.' : canAuthor
          ? 'Write one in plain English with New policy; it is compiled into a deterministic rule and needs another person\'s approval.'
          : 'Policy Authors write policies; Policy Approvers approve them.'}
      />
    );
  }
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full text-sm" data-testid="policy-table">
        <TableHead columns={['Policy', 'State', 'Tier', 'Owning boards', 'Version', 'Enforcement']} />
        <tbody className="divide-y divide-border">
          {items.map((p) => {
            const enforcement = enforcementSummary(p, now);
            return (
              <tr key={p.policyId} className="align-top hover:bg-surface-hover transition">
                <td className="px-4 py-3">
                  <Link to={`/governance/policies/${p.policyId}`} className="text-text-primary font-medium hover:text-accent">{p.title}</Link>
                  <p className="font-mono text-xs text-text-muted">{p.policyKey}</p>
                </td>
                <td className="px-4 py-3"><StateBadge state={p.state} /></td>
                <td className="px-4 py-3"><TierBadge tier={p.tier} /></td>
                <td className="px-4 py-3 text-xs text-text-secondary">
                  {p.owningBoards.length === 0 ? '—' : p.owningBoards.map((b) => b.name || b.id).join(', ')}
                </td>
                <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">
                  <p>{p.activeVersion !== null ? `v${p.activeVersion} ${p.state === 'retired' ? '(retirement)' : 'active'}` : 'none active'}</p>
                  {pendingLabel(p) && <p className="text-accent">{pendingLabel(p)}</p>}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={enforcement.variant}>{enforcement.label}</Badge>
                  <p className="text-xs text-text-muted mt-1 max-w-xs">{enforcement.detail}</p>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
