import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderGit2, Info } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { listBoards, listCases, type Board, type CaseList, type CaseState, type CaseSummary } from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import { formatUtc, policyErrorMessage } from '../../lib/cpg-policy';
import { CASE_STATE_LABEL, actorLabel, pageNote, relativeTime } from '../../lib/cpg-cases';
import GovernanceHeader from './GovernanceHeader';
import { CaseStateBadge, LaneList, PullRequest, RepoBranch } from './cases/parts';

const PAGE_SIZE = 25;
const STATES: Array<CaseState | ''> = ['', 'open', 'in_review', 'changes_requested', 'decided', 'closed'];

/** /governance/cases (E41): review cases, newest first, filtered by state and board. */
export default function GovernanceCases() {
  const { me } = useCpgMe();
  const canListBoards = hasOrgPermission(me, 'policy.read');
  const [state, setState] = useState<CaseState | ''>('');
  const [boardId, setBoardId] = useState('');
  const [boards, setBoards] = useState<Board[]>([]);
  /** Cursors of the pages visited so far; the last one is the page shown ('' is the first page). */
  const [cursors, setCursors] = useState<string[]>(['']);
  const [loaded, setLoaded] = useState<{ key: string; list: CaseList } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const cursor = cursors[cursors.length - 1];
  const query = JSON.stringify([state, boardId, cursor, retryKey]);
  const page = loaded?.key === query ? loaded.list : null;

  useEffect(() => {
    if (!canListBoards) return;
    let cancelled = false;
    listBoards().then((b) => { if (!cancelled) setBoards(b.filter((x) => !x.archivedAt)); }).catch(() => { /* the filter is optional */ });
    return () => { cancelled = true; };
  }, [canListBoards]);

  useEffect(() => {
    let cancelled = false;
    listCases({ state: state || undefined, boardId: boardId || undefined, cursor: cursor || undefined, limit: PAGE_SIZE })
      .then((list) => { if (!cancelled) { setLoaded({ key: query, list }); setError(null); setFetchedAt(new Date().toISOString()); } })
      .catch((err) => { if (!cancelled) setError(policyErrorMessage(err, 'Failed to load the review cases')); });
    return () => { cancelled = true; };
  }, [state, boardId, cursor, query]);

  const refilter = (apply: () => void) => { apply(); setCursors(['']); };
  const note = page ? pageNote(page.items.length, PAGE_SIZE, page.nextCursor !== null) : null;

  return (
    <div>
      <GovernanceHeader icon={FolderGit2} title="Review cases" subtitle="One case per branch: its corporate findings, the developer's justifications and each owning board's review" />

      {me && !me.cpgEnabled && (
        <Card className="mb-4 border-info/30">
          <p className="text-sm text-text-secondary flex items-start gap-2" role="status">
            <Info size={16} className="text-info shrink-0 mt-0.5" />
            Governance is off for this organization, so no cases are listed. An Org Admin can turn it on in Settings.
          </p>
        </Card>
      )}

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Filter by state">
          {STATES.map((s) => (
            <button
              key={s || 'all'}
              role="tab"
              aria-selected={state === s}
              onClick={() => refilter(() => setState(s))}
              className={`px-3 py-1.5 text-xs rounded-lg transition ${state === s ? 'bg-accent-dim text-accent' : 'text-text-secondary hover:bg-surface-hover'}`}
            >
              {s ? CASE_STATE_LABEL[s] : 'All'}
            </button>
          ))}
        </div>
        {boards.length > 0 && (
          <select
            aria-label="Filter by board"
            value={boardId}
            onChange={(e) => refilter(() => setBoardId(e.target.value))}
            className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-primary"
          >
            <option value="">Every board</option>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => { setError(null); setRetryKey((k) => k + 1); }} />
      ) : page === null ? (
        <SkeletonTable rows={5} />
      ) : (
        <>
          {note && (
            <p className={`text-xs text-text-secondary flex items-start gap-2 ${page.items.length === 0 ? 'glass rounded-xl p-5' : 'mb-2'}`} role="status" data-testid="page-note">
              <Info size={14} className="text-info shrink-0" />{note}
            </p>
          )}
          {page.items.length > 0 ? <CaseTable items={page.items} now={fetchedAt ? Date.parse(fetchedAt) : Number.NaN} /> : !note && (
            <EmptyState
              title={cursors.length > 1 ? 'No more cases' : state || boardId ? 'No cases match these filters' : 'No review cases yet'}
              description={cursors.length > 1 ? 'Go back to the previous page.' : state || boardId ? 'Choose another state or board.'
                : 'A case opens when a developer requests review of a branch\'s corporate findings from VS Code (Nomus: Request Policy Review).'}
            />
          )}
          {(cursors.length > 1 || page.nextCursor) && (
            <div className="flex items-center justify-end gap-2 mt-3" aria-label="Pages">
              <span className="text-xs text-text-muted">Page {cursors.length}</span>
              <Button size="sm" variant="secondary" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={!page.nextCursor} onClick={() => setCursors((c) => [...c, page.nextCursor!])}>Next</Button>
            </div>
          )}
          <DataFreshness fetchedAt={fetchedAt} className="mt-2" />
        </>
      )}
    </div>
  );
}

/** A compact relative time with the full UTC time on hover. */
function When({ iso, now, prefix = '' }: { iso: string; now: number; prefix?: string }) {
  return <time dateTime={iso} title={formatUtc(iso)} className="whitespace-nowrap">{prefix}{relativeTime(iso, now)}</time>;
}

/** The case list; times are relative to `now` (when the page was fetched). */
export function CaseTable({ items, now }: { items: CaseSummary[]; now: number }) {
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full text-sm" data-testid="case-table">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-4 py-3 font-medium">Case</th>
            <th className="px-4 py-3 font-medium">Repository @ branch</th>
            <th className="px-4 py-3 font-medium">State</th>
            <th className="px-4 py-3 font-medium" title="Each owning board's review: its state and decided/blocking findings">Lanes</th>
            <th className="px-4 py-3 font-medium whitespace-nowrap">Opened by</th>
            <th className="px-4 py-3 font-medium whitespace-nowrap">Last activity</th>
            <th className="px-4 py-3 font-medium whitespace-nowrap">Pull request</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((c) => (
            <tr key={c.id} className="align-top hover:bg-surface-hover transition">
              <td className="px-4 py-3 whitespace-nowrap">
                <Link to={`/governance/cases/${c.id}`} className="font-mono text-text-primary font-medium hover:text-accent">{c.ref}</Link>
                <p className="text-xs text-text-muted">{c.latestRevision === 0 ? 'no revision yet' : `revision ${c.latestRevision}`} · <When iso={c.openedAt} now={now} prefix="opened " /></p>
              </td>
              <td className="px-4 py-3"><RepoBranch repo={c.repo} branch={c.branch} /></td>
              <td className="px-4 py-3"><CaseStateBadge state={c.state} closeReason={c.closeReason} /></td>
              <td className="px-4 py-3">{c.state === 'closed' ? <span className="text-xs text-text-muted">—</span> : <LaneList lanes={c.lanes} compact />}</td>
              <td className="px-4 py-3 text-xs text-text-secondary" title={`Opened ${formatUtc(c.openedAt)}`}>{actorLabel(c.openedBy)}</td>
              <td className="px-4 py-3 text-xs text-text-secondary"><When iso={c.updatedAt} now={now} /></td>
              <td className="px-4 py-3 text-xs whitespace-nowrap"><PullRequest repo={c.repo} prNumber={c.prNumber} closed={c.state === 'closed'} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
