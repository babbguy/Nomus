import { useEffect, useState } from 'react';
import Modal from '../../../components/ui/Modal';
import Badge from '../../../components/ui/Badge';
import Spinner from '../../../components/ui/Spinner';
import ErrorState from '../../../components/ui/ErrorState';
import { formatDateTime } from '../../../lib/formatters';
import { apiErrorMessage } from '../../../lib/errors';
import { getRule, type AdminRuleDetail, type RuleHistoryEntry } from '../../../api/rules';

function describe(entry: RuleHistoryEntry): { label: string; variant: 'success' | 'info' | 'danger' | 'default' } {
  const p = entry.payload;
  if (entry.eventType === 'policy.created') return { label: p?.manual ? 'Created by an admin' : 'Extracted', variant: 'success' };
  if (entry.eventType === 'policy.revoked') {
    return { label: p?.reason === 'source_deactivated' ? 'Retired (source deactivated)' : 'Retired', variant: 'danger' };
  }
  if (entry.eventType === 'policy.updated' && p?.reactivated) return { label: 'Reactivated', variant: 'info' };
  if (entry.eventType === 'policy.updated') return { label: p?.manual ? 'Edited by an admin' : 'Re-extracted', variant: 'info' };
  return { label: entry.eventType, variant: 'default' };
}

/** Version history of a rule, newest first, from GET /admin/rules/:id. */
export default function RuleHistory({ ruleId, onClose }: { ruleId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<AdminRuleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!ruleId) return;
    let cancelled = false;
    getRule(ruleId)
      .then((d) => { if (!cancelled) { setDetail(d); setError(null); setLoadedFor(ruleId); } })
      .catch((err) => { if (!cancelled) { setError(apiErrorMessage(err, 'Failed to load rule history')); setLoadedFor(ruleId); } });
    return () => { cancelled = true; };
  }, [ruleId]);

  const loading = ruleId !== null && loadedFor !== ruleId;

  return (
    <Modal open={ruleId !== null} onClose={onClose} title="Rule history" width="max-w-2xl">
      {loading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!loading && error && <ErrorState compact message={error} />}
      {!loading && !error && detail && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-mono text-text-primary">{detail.ruleKey}</p>
            <p className="text-xs text-text-muted mt-0.5">
              Version {detail.version} · {detail.isActive ? 'active' : 'retired'} · {detail.locked ? 'locked (edited by an admin)' : 'managed by the extraction pipeline'}
            </p>
          </div>
          {detail.history.length === 0 ? (
            <p className="text-sm text-text-muted">No recorded changes.</p>
          ) : (
            <ol className="space-y-3">
              {detail.history.map((h) => {
                const d = describe(h);
                return (
                  <li key={h.id} className="border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={d.variant}>{d.label}</Badge>
                      <span className="text-xs text-text-muted">{formatDateTime(h.createdAt)}</span>
                    </div>
                    <p className="text-xs text-text-secondary mt-2">
                      Version {h.payload?.version ?? '?'}
                      {h.payload?.actor ? <> · by <span className="font-mono">{h.payload.actor}</span></> : null}
                      {h.payload?.changedFields?.length ? <> · changed: {h.payload.changedFields.join(', ')}</> : null}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </Modal>
  );
}
