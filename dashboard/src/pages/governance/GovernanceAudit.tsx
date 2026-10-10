import { Fragment, useEffect, useMemo, useState } from 'react';
import { Download, History, ShieldCheck, ShieldX, ChevronDown, ChevronRight } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonTable } from '../../components/ui/Skeleton';
import {
  exportGovernanceAudit, listAuditEvents, listOrgUsers, listRoles, listTeams, type AuditEvent, type AuditQuery,
} from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { cpgErrorMessage } from '../../lib/cpg-errors';
import { formatActor, hasOrgPermission } from '../../lib/cpg-permissions';
import { formatDateTime } from '../../lib/formatters';
import { AUDIT_ACTIONS, auditFilterQuery, type AuditFilters } from '../../lib/cpg-audit';
import GovernanceHeader from './GovernanceHeader';
import { TableHead } from './parts';

type Names = { users: Map<string, { name: string; email: string }>; roles: Map<string, string>; teams: Map<string, string> };

/**
 * /governance/audit (E17): the organization's hash-chained governance audit
 * log, newest first, with the chain verification the server runs on every read.
 * Holders of audit.export download the signed export (E73).
 */
export default function GovernanceAudit() {
  const { me } = useCpgMe();
  const canReadNames = hasOrgPermission(me, 'org.members.read');
  const [filters, setFilters] = useState<AuditFilters>({ action: '', since: '', until: '' });
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [chainValid, setChainValid] = useState<boolean | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [names, setNames] = useState<Names | null>(null);
  const [namesError, setNamesError] = useState<string | null>(null);

  const query = auditFilterQuery(filters);
  const queryKey = JSON.stringify(query);

  // Reset the list during render when the query changes (no synchronous setState in the effect).
  const fetchKey = `${queryKey}|${retryKey}`;
  const [loadedKey, setLoadedKey] = useState(fetchKey);
  if (loadedKey !== fetchKey) {
    setLoadedKey(fetchKey);
    setLoading(true);
    setError(null);
    setMoreError(null);
  }

  useEffect(() => {
    const q = JSON.parse(queryKey) as AuditQuery | { error: string };
    let cancelled = false;
    (async () => {
      if ('error' in q) {
        if (!cancelled) { setItems([]); setNextCursor(null); setLoading(false); }
        return;
      }
      try {
        const page = await listAuditEvents(q);
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setChainValid(page.chainValid);
        setFetchedAt(new Date().toISOString());
      } catch (err) {
        if (!cancelled) setError(cpgErrorMessage(err, 'Failed to load the audit log'));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [queryKey, retryKey]);

  // Names for actors and targets (best effort, reported if it fails).
  useEffect(() => {
    if (!canReadNames) return;
    let cancelled = false;
    (async () => {
      try {
        const [users, roles, teams] = await Promise.all([listOrgUsers(), listRoles(), listTeams()]);
        if (cancelled) return;
        setNames({
          users: new Map(users.map((u) => [u.id, { name: u.name, email: u.email }])),
          roles: new Map(roles.map((r) => [r.id, r.name])),
          teams: new Map(teams.map((t) => [t.id, t.name])),
        });
      } catch (err) {
        if (!cancelled) setNamesError(cpgErrorMessage(err, 'Could not load user, role and team names'));
      }
    })();
    return () => { cancelled = true; };
  }, [canReadNames]);

  async function loadMore() {
    if (!nextCursor || 'error' in query) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listAuditEvents({ ...query, cursor: nextCursor });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      setChainValid(page.chainValid);
      setFetchedAt(new Date().toISOString());
    } catch (err) {
      setMoreError(cpgErrorMessage(err, 'Failed to load more events'));
    }
    setLoadingMore(false);
  }

  const inputCls = 'px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-primary';
  const filtered = !!(filters.action || filters.since || filters.until);

  return (
    <div>
      <GovernanceHeader
        icon={History}
        title="Governance audit log"
        subtitle="Every access and settings change, newest first, hash-chained"
        actions={hasOrgPermission(me, 'audit.export') ? <AuditExportButton /> : undefined}
      />

      {chainValid !== null && !error && <ChainStatus valid={chainValid} />}

      <Card className="mb-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label htmlFor="audit-action" className="block text-xs text-text-muted mb-1">Action</label>
            <select id="audit-action" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} className={inputCls}>
              <option value="">All actions</option>
              {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="audit-since" className="block text-xs text-text-muted mb-1">From (UTC)</label>
            <input id="audit-since" type="date" value={filters.since} onChange={(e) => setFilters({ ...filters, since: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label htmlFor="audit-until" className="block text-xs text-text-muted mb-1">To (UTC)</label>
            <input id="audit-until" type="date" value={filters.until} onChange={(e) => setFilters({ ...filters, until: e.target.value })} className={inputCls} />
          </div>
          {filtered && <Button variant="ghost" size="sm" onClick={() => setFilters({ action: '', since: '', until: '' })}>Clear filters</Button>}
        </div>
        {'error' in query && <p className="text-xs text-danger mt-2" role="alert">{query.error}</p>}
      </Card>

      {namesError && <ErrorState compact message={`${namesError}; ids are shown instead.`} />}

      {'error' in query ? null : loading ? (
        <SkeletonTable rows={6} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No audit events match these filters' : 'No audit events yet'}
          description={filtered ? 'Change or clear the filters.' : 'Access and settings changes will appear here.'}
        />
      ) : (
        <>
          <AuditTable items={items} names={names} />
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <p className="text-xs text-text-muted">
              Showing {items.length} event{items.length === 1 ? '' : 's'}{nextCursor ? '; older events are available.' : '.'}
            </p>
            {nextCursor && (
              <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load older events'}
              </Button>
            )}
          </div>
          {moreError && <ErrorState compact message={moreError} onRetry={() => void loadMore()} />}
          <DataFreshness fetchedAt={fetchedAt} className="mt-2" />
        </>
      )}
    </div>
  );
}

/** E73: downloads the signed governance audit export (the server checks audit.export). */
export function AuditExportButton() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downloadExport() {
    setExporting(true);
    setError(null);
    try {
      const signed = await exportGovernanceAudit();
      const url = URL.createObjectURL(new Blob([JSON.stringify(signed, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `nomus-governance-audit-${signed.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to export the audit log'));
    }
    setExporting(false);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" onClick={() => void downloadExport()} disabled={exporting}
        title="The whole audit chain and every signed decision, revocation, closure record and CI verdict, signed for offline verification">
        <Download size={14} /> {exporting ? 'Exporting...' : 'Export signed audit (JSON)'}
      </Button>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

export function ChainStatus({ valid }: { valid: boolean }) {
  return valid ? (
    <Card className="mb-4 border-success/30">
      <p className="text-sm text-success flex items-center gap-2" data-testid="audit-chain-status">
        <ShieldCheck size={16} /> Chain verified: every event links to the one before it, so none was changed or removed.
      </p>
    </Card>
  ) : (
    <Card className="mb-4 border-danger/40">
      <p className="text-sm text-danger flex items-center gap-2 font-medium" data-testid="audit-chain-status" role="alert">
        <ShieldX size={16} /> Chain broken: the audit log was altered outside Nomus (for example by editing the database).
      </p>
      <p className="text-xs text-text-muted mt-1">Treat these events as untrusted and investigate before relying on them.</p>
    </Card>
  );
}

function targetLabel(e: AuditEvent, names: Names | null): string {
  if (!e.targetId) return e.targetType;
  const id = e.targetId;
  if (e.targetType === 'user') {
    const u = names?.users.get(id);
    if (u) return `user ${u.email}`;
  } else if (e.targetType === 'role') {
    const r = names?.roles.get(id);
    if (r) return `role ${r}`;
  } else if (e.targetType === 'team') {
    const t = names?.teams.get(id);
    if (t) return `team ${t}`;
  } else if (e.targetType === 'settings') {
    return 'settings';
  } else if (e.targetType === 'org') {
    return 'organization';
  } else if (e.targetType === 'grant') {
    // grant.created / grant.revoked payloads carry the role and the user.
    const roleKey = typeof e.payload.roleKey === 'string' ? e.payload.roleKey : null;
    const userId = typeof e.payload.userId === 'string' ? e.payload.userId : null;
    const u = userId ? names?.users.get(userId) : undefined;
    if (roleKey) return `grant ${roleKey} to ${u ? u.email : (userId ? `user ${userId}` : 'a user')}`;
  }
  return `${e.targetType} ${id}`;
}

export function AuditTable({ items, names }: { items: AuditEvent[]; names: Names | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const users = useMemo(() => names?.users, [names]);
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full text-sm" data-testid="audit-table">
        <TableHead columns={[{ label: null, className: 'w-8', ariaLabel: 'Details' }, '#', 'Time', 'Action', 'Actor', 'Target']} />
        <tbody className="divide-y divide-border">
          {items.map((e) => {
            const expanded = open === e.id;
            return (
              <Fragment key={e.id}>
                <tr className="hover:bg-surface-hover transition cursor-pointer" onClick={() => setOpen(expanded ? null : e.id)}>
                  <td className="px-4 py-3 text-text-muted">
                    <button type="button" aria-label={expanded ? 'Hide details' : 'Show details'} aria-expanded={expanded} className="flex">
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">{e.seq}</td>
                  <td className="px-4 py-3 text-text-secondary whitespace-nowrap" title={e.createdAt}>{formatDateTime(e.createdAt)}</td>
                  <td className="px-4 py-3"><Badge variant="accent" className="font-mono">{e.action}</Badge></td>
                  <td className="px-4 py-3 text-text-secondary">{formatActor(e.actor, users)}</td>
                  <td className="px-4 py-3 text-text-secondary break-all">{targetLabel(e, names)}</td>
                </tr>
                {expanded && (
                  <tr className="bg-surface-raised/40">
                    <td />
                    <td colSpan={5} className="px-4 py-3">
                      <p className="text-xs text-text-muted mb-1">Details</p>
                      <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-all bg-surface border border-border rounded-lg p-3">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-2 text-xs">
                        <dt className="text-text-muted">Event id</dt><dd className="font-mono text-text-secondary break-all">{e.id}</dd>
                        <dt className="text-text-muted">Recorded (UTC)</dt><dd className="font-mono text-text-secondary">{e.createdAt}</dd>
                        <dt className="text-text-muted">Actor</dt><dd className="font-mono text-text-secondary break-all">{e.actor}</dd>
                        <dt className="text-text-muted">Hash</dt><dd className="font-mono text-text-secondary break-all">{e.hash}</dd>
                        <dt className="text-text-muted">Previous hash</dt><dd className="font-mono text-text-secondary break-all">{e.prevHash}</dd>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
