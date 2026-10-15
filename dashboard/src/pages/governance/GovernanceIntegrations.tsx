import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plug, Plus } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonCard } from '../../components/ui/Skeleton';
import {
  listBoards, listDeliveries, listIntegrations, retryDelivery, testIntegration, updateIntegration,
  type Board, type Delivery, type DeliveryStatus, type Integration, type IntegrationWithSecret,
} from '../../api/cpg';
import { cpgErrorMessage } from '../../lib/cpg-errors';
import { EVENT_OPTIONS, KIND_LABELS, lastError, openFailures, secretLabel } from '../../lib/cpg-integrations';
import { formatUtc } from '../../lib/cpg-policy';
import GovernanceHeader from './GovernanceHeader';
import { NoticeLine, type Notice } from './parts';
import { IntegrationEditor, RotateModal, SecretOnceModal } from './integrations/IntegrationEditor';
import { DeliveryTable, StatusBadge } from './integrations/DeliveryLog';
import WebhookHelp from './integrations/WebhookHelp';

/** The inline result of a Send test: the delivery, or why the request itself failed. */
export type TestResult = Delivery | { error: string };
const FILTERS: Array<{ value: DeliveryStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All deliveries' }, { value: 'failed', label: 'Failed' }, { value: 'pending', label: 'Pending' },
  { value: 'delivered', label: 'Delivered' }, { value: 'cancelled', label: 'Cancelled' },
];
const PAGE = 100;

/** /governance/integrations (E64 to E70): email, Jira and webhook notifications, and the delivery log. */
export default function GovernanceIntegrations() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [failed, setFailed] = useState<Delivery[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [filter, setFilter] = useState<DeliveryStatus | 'all'>('all');
  const [editing, setEditing] = useState<Integration | 'new' | null>(null);
  const [rotating, setRotating] = useState<Integration | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | 'sending'>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([listIntegrations(), listDeliveries({ limit: PAGE }), listDeliveries({ status: 'failed', limit: 200 }), listBoards().catch(() => [] as Board[])])
      .then(([i, d, f, b]) => {
        if (cancelled) return;
        setIntegrations(i); setDeliveries(d.items); setNextCursor(d.nextCursor); setFailed(f.items); setBoards(b); setError(null); setFetchedAt(new Date().toISOString());
      })
      .catch((err) => { if (!cancelled) setError(cpgErrorMessage(err, 'Failed to load the integrations')); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const byId = useMemo(() => new Map((integrations ?? []).map((i) => [i.id, i])), [integrations]);
  const retriedIds = useMemo(() => new Set(deliveries.map((d) => d.retryOf).filter((x): x is string => !!x)), [deliveries]);
  const unresolved = useMemo(() => openFailures([...deliveries, ...failed.filter((f) => !deliveries.some((d) => d.id === f.id))]), [failed, deliveries]);
  const shown = filter === 'all' ? deliveries : deliveries.filter((d) => d.status === filter);

  async function act(action: () => Promise<unknown>, ok: string, fail: string) {
    setNotice(null);
    try { await action(); setNotice({ type: 'ok', text: ok }); reload(); } catch (err) { setNotice({ type: 'err', text: cpgErrorMessage(err, fail) }); }
  }

  async function sendTest(i: Integration) {
    setNotice(null);
    setTests((t) => ({ ...t, [i.id]: 'sending' }));
    try {
      const result = await testIntegration(i.id);
      setTests((t) => ({ ...t, [i.id]: result }));
      reload();
    } catch (err) {
      setTests((t) => ({ ...t, [i.id]: { error: cpgErrorMessage(err, 'The test could not be sent') } }));
    }
  }

  async function loadOlder() {
    if (!nextCursor) return;
    try {
      const page = await listDeliveries({ limit: PAGE, cursor: nextCursor });
      setDeliveries((d) => [...d, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setNotice({ type: 'err', text: cpgErrorMessage(err, 'Failed to load older deliveries') });
    }
  }

  const showSecret = (r: IntegrationWithSecret) => { if (r.secret) setSecret({ name: r.integration.name, value: r.secret }); };

  return (
    <div className="space-y-4">
      <GovernanceHeader
        icon={Plug}
        title="Integrations"
        subtitle="Notify people by email, Jira and webhook when a review case needs them"
        actions={<Button size="sm" onClick={() => { setNotice(null); setEditing('new'); }}><Plus size={14} /> Add integration</Button>}
      />
      {unresolved.length > 0 && (
        <div role="alert" data-testid="failure-banner" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3">
          <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" />
          <div className="text-sm text-text-primary flex-1">
            <p className="font-medium">{unresolved.length} {unresolved.length === 1 ? 'delivery has' : 'deliveries have'} failed permanently.</p>
            <p className="text-text-secondary">Nomus stopped trying. Fix the integration, then retry them from the delivery log.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setFilter('failed')}>Show failed</Button>
        </div>
      )}
      <NoticeLine notice={notice} className="text-sm" testId="integrations-notice" />

      {error ? (
        <ErrorState message={error} onRetry={() => { setError(null); setIntegrations(null); reload(); }} />
      ) : integrations === null ? (
        <><SkeletonCard /><SkeletonCard /></>
      ) : (
        <>
          {integrations.length === 0 ? (
            <EmptyState title="No integrations yet" description="Add an email, Jira or webhook integration to be told when a review case needs attention." />
          ) : (
            <div className="space-y-3" data-testid="integrations">
              {integrations.map((i) => (
                <IntegrationCard key={i.id} integration={i} boards={boards} test={tests[i.id]}
                  onTest={() => void sendTest(i)} onEdit={() => setEditing(i)} onRotate={() => setRotating(i)}
                  onToggle={() => void act(() => updateIntegration(i.id, { enabled: !i.enabled }), `${i.name} ${i.enabled ? 'disabled' : 'enabled'}.`, `Failed to update ${i.name}`)} />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
            <h2 className="text-base font-semibold text-text-primary">Delivery log</h2>
            <select aria-label="Filter deliveries" value={filter} onChange={(e) => setFilter(e.target.value as DeliveryStatus | 'all')}
              className="px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-primary">
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          {shown.length === 0 ? (
            <EmptyState title={deliveries.length === 0 ? 'No deliveries yet' : 'No deliveries match this filter'}
              description={deliveries.length === 0 ? 'Deliveries appear here when a review case sends its first notification, or when you send a test.' : 'Choose another status to see the rest.'} />
          ) : (
            <DeliveryTable items={shown} integrations={byId} retriedIds={retriedIds} canRetry
              onRetry={(d) => void act(async () => { await retryDelivery(d.id); setTests(({ [d.integrationId]: _old, ...rest }) => rest); }, 'Retry queued.', 'Failed to retry the delivery')} />
          )}
          {nextCursor && <div className="flex justify-center"><Button variant="secondary" size="sm" onClick={() => void loadOlder()}>Load older deliveries</Button></div>}
          <DataFreshness fetchedAt={fetchedAt} />
          <WebhookHelp />
        </>
      )}

      {editing && (
        <IntegrationEditor
          integration={editing === 'new' ? null : editing} boards={boards} onClose={() => setEditing(null)}
          onSaved={(r, created) => { setEditing(null); showSecret(r); setNotice({ type: 'ok', text: `${r.integration.name} ${created ? 'added' : 'saved'}.` }); reload(); }}
        />
      )}
      {rotating && (
        <RotateModal integration={rotating} onClose={() => setRotating(null)}
          onRotated={(r) => { setRotating(null); showSecret(r); setNotice({ type: 'ok', text: `${secretLabel(r.integration.kind)} of ${r.integration.name} replaced.` }); reload(); }} />
      )}
      {secret && <SecretOnceModal name={secret.name} secret={secret.value} onClose={() => setSecret(null)} />}
    </div>
  );
}

export function TestOutcome({ test }: { test: TestResult | 'sending' }) {
  if (test === 'sending') return <p className="text-xs text-text-muted" role="status">Sending a test...</p>;
  if ('error' in test) return <p className="text-xs text-danger" role="alert">{test.error}</p>;
  const error = lastError(test);
  return (
    <p className="text-xs text-text-secondary flex items-center gap-2 flex-wrap" role="status" data-testid="test-result">
      <StatusBadge status={test.status} />
      <span>
        {test.status === 'delivered' ? `Test delivered on attempt ${test.attempts}.`
          : test.status === 'pending' ? `Test not delivered yet${error ? `: ${error}` : ''}. Nomus will retry at ${formatUtc(test.nextAttemptAt)}.`
            : `Test failed${error ? `: ${error}` : ''}.`}
      </span>
    </p>
  );
}

export function IntegrationCard({ integration: i, boards, test, onTest, onEdit, onRotate, onToggle }: {
  integration: Integration;
  boards: Board[];
  test?: TestResult | 'sending';
  onTest: () => void;
  onEdit: () => void;
  onRotate: () => void;
  onToggle: () => void;
}) {
  const c = i.config;
  const names = i.boardIds.map((id) => boards.find((b) => b.id === id)?.name ?? 'Unknown board');
  const target = i.kind === 'webhook' ? String(c.url ?? '') : String(c.baseUrl ?? '');
  const extra = Array.isArray(c.extraRecipients) ? c.extraRecipients.length : 0;
  const label = secretLabel(i.kind);
  const rows: Array<[string, React.ReactNode]> = [
    i.kind === 'email'
      ? ['Sends to', [c.includeBoardMembers !== false && 'board members', c.notifyDevelopers !== false && 'developers on change requests', extra > 0 && `${extra} extra recipient${extra === 1 ? '' : 's'}`].filter(Boolean).join(', ') || 'nobody']
      : ['Target', <span key="t" className="font-mono text-xs break-words">{target}</span>],
    ...(i.kind === 'jira' ? [['Project', String(c.projectKey ?? '')] as [string, React.ReactNode]] : []),
    ['Events', EVENT_OPTIONS.filter((o) => i.events.includes(o.value)).map((o) => o.label).join(', ')],
    ['Boards', names.length === 0 ? 'Every board' : names.join(', ')],
    ...(label ? [[label, i.secretLast4 ? <span key="s" className="font-mono text-xs">{`••••${i.secretLast4}`} <span className="font-sans text-text-muted">stored encrypted</span></span> : 'Not set'] as [string, React.ReactNode]] : []),
  ];
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-text-primary flex items-center gap-2 flex-wrap">
          {i.name} <Badge variant="info">{KIND_LABELS[i.kind]}</Badge> <Badge variant={i.enabled ? 'success' : 'default'}>{i.enabled ? 'Enabled' : 'Disabled'}</Badge>
        </h3>
        <div className="flex gap-1 flex-wrap">
          <Button size="sm" variant="secondary" disabled={!i.enabled || test === 'sending'} title={i.enabled ? undefined : 'Enable the integration to send a test'} onClick={onTest} aria-label={`Send a test through ${i.name}`}>Send test</Button>
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`Edit ${i.name}`}>Edit</Button>
          {label && <Button size="sm" variant="secondary" onClick={onRotate} aria-label={`${i.kind === 'jira' ? 'Replace the token of' : 'Rotate the secret of'} ${i.name}`}>{i.kind === 'jira' ? 'Replace token' : 'Rotate secret'}</Button>}
          <Button size="sm" variant="ghost" onClick={onToggle} aria-label={`${i.enabled ? 'Disable' : 'Enable'} ${i.name}`}>{i.enabled ? 'Disable' : 'Enable'}</Button>
        </div>
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 mt-3 text-sm">
        {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-text-muted">{k}</dt><dd className="text-text-primary min-w-0">{v}</dd></div>))}
      </dl>
      {test && <div className="mt-3 pt-3 border-t border-border"><TestOutcome test={test} /></div>}
    </Card>
  );
}
