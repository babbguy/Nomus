import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScrollText, Plus, Info } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { listPolicies, type PolicyHead } from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import {
  STATE_LABEL, enforcementSummary, matchesPolicyFilter, pendingLabel, policyErrorMessage, policyFilterCounts, type PolicyFilter,
} from '../../lib/cpg-policy';
import GovernanceHeader from './GovernanceHeader';
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
  const [items, setItems] = useState<PolicyHead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [filter, setFilter] = useState<PolicyFilter>('');
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    listPolicies()
      .then((list) => { if (!cancelled) { setItems(list); setError(null); setFetchedAt(new Date().toISOString()); } })
      .catch((err) => { if (!cancelled) setError(policyErrorMessage(err, 'Failed to load the policy log')); });
    return () => { cancelled = true; };
  }, [retryKey]);

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
        <Card className="mb-4 border-info/30">
          <p className="text-sm text-text-secondary flex items-start gap-2" role="status">
            <Info size={16} className="text-info shrink-0 mt-0.5" />
            Governance is off for this organization. Policies can be written and approved now, but scanners receive none of them until an Org Admin turns governance on.
          </p>
        </Card>
      )}

      <div className="flex gap-1 mb-4 flex-wrap" role="tablist" aria-label="Filter by state">
        {FILTERS.map((f) => (
          <button
            key={f.value || 'all'}
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 text-xs rounded-lg transition ${filter === f.value ? 'bg-accent-dim text-accent' : 'text-text-secondary hover:bg-surface-hover'}`}
          >
            {f.label}{counts ? ` (${counts[f.value]})` : ''}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => { setError(null); setItems(null); setRetryKey((k) => k + 1); }} />
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
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-4 py-3 font-medium">Policy</th>
            <th className="px-4 py-3 font-medium">State</th>
            <th className="px-4 py-3 font-medium">Tier</th>
            <th className="px-4 py-3 font-medium">Owning boards</th>
            <th className="px-4 py-3 font-medium">Version</th>
            <th className="px-4 py-3 font-medium">Enforcement</th>
          </tr>
        </thead>
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
