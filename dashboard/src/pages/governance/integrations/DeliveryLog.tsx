import { Link } from 'react-router-dom';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import type { Delivery, DeliveryStatus, Integration } from '../../../api/cpg';
import { formatUtc } from '../../../lib/cpg-policy';
import { deliveryCaseRef, eventLabel, KIND_LABELS, lastError } from '../../../lib/cpg-integrations';

const STATUS: Record<DeliveryStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'default' }> = {
  delivered: { label: 'Delivered', variant: 'success' },
  pending: { label: 'Pending', variant: 'warning' },
  failed: { label: 'Failed', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'default' },
};
export const StatusBadge = ({ status }: { status: DeliveryStatus }) => <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>;

/** The delivery log: one row per delivery, newest first. A failed delivery can be retried when no retry names it yet. */
export function DeliveryTable({ items, integrations, retriedIds, canRetry, onRetry }: {
  items: Delivery[];
  integrations: Map<string, Integration>;
  retriedIds: ReadonlySet<string>;
  canRetry: boolean;
  onRetry: (d: Delivery) => void;
}) {
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm" data-testid="delivery-log">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-4 py-3 font-medium">Event</th>
            <th className="px-4 py-3 font-medium">Integration</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium text-right">Attempts</th>
            <th className="px-4 py-3 font-medium">Last error</th>
            <th className="px-4 py-3 font-medium">Next retry</th>
            <th className="px-4 py-3 font-medium">Created</th>
            <th className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((d) => {
            const integration = integrations.get(d.integrationId);
            const ref = deliveryCaseRef(d);
            const error = lastError(d);
            return (
              <tr key={d.id} className="align-top">
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="text-text-primary">{eventLabel(d.event)}</span>
                  {d.caseId && ref && <Link to={`/governance/cases/${d.caseId}`} className="block font-mono text-xs text-accent hover:underline">{ref}</Link>}
                  {d.retryOf && <span className="block text-xs text-text-muted">Retry of an earlier delivery</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-text-secondary">{integration?.name ?? 'Deleted integration'} <span className="text-xs text-text-muted">{KIND_LABELS[d.channel]}</span></td>
                <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={d.status} /></td>
                <td className="px-4 py-3 text-right tabular-nums">{d.attempts}</td>
                <td className="px-4 py-3 text-text-secondary min-w-[12rem] max-w-[22rem]">{error ?? <span className="text-text-muted">—</span>}</td>
                <td className="px-4 py-3 whitespace-nowrap text-text-secondary">{d.status === 'pending' ? formatUtc(d.nextAttemptAt) : '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap text-text-secondary">{formatUtc(d.createdAt)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-right">
                  {d.status === 'failed' && (retriedIds.has(d.id)
                    ? <span className="text-xs text-text-muted">Retried</span>
                    : canRetry && <Button size="sm" variant="secondary" onClick={() => onRetry(d)} aria-label={`Retry the ${eventLabel(d.event)} delivery`}>Retry</Button>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
