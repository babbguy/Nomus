import { useEffect, useState } from 'react';
import { Workflow } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Spinner from '../../../components/ui/Spinner';
import ErrorState from '../../../components/ui/ErrorState';
import { listCaseCiRuns, type CiRun, type CiRunList } from '../../../api/cpg';
import { formatUtc, policyErrorMessage } from '../../../lib/cpg-policy';
import { PullRequest } from './parts';
import { TableHead } from '../parts';

/**
 * The case's CI runs (E63), newest first: the server's verdict, the commit,
 * the pull request, when it ran and whether its signed verdict verifies.
 * `reloadKey` refetches with the case.
 */
export function CiRunsCard({ caseId, repo, reloadKey }: { caseId: string; repo: string; reloadKey: string }) {
  const [state, setState] = useState<{ key: string; data: CiRunList } | { key: string; error: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${reloadKey}|${retry}`;

  useEffect(() => {
    let cancelled = false;
    listCaseCiRuns(caseId)
      .then((data) => { if (!cancelled) setState({ key, data }); })
      .catch((err) => { if (!cancelled) setState({ key, error: policyErrorMessage(err, 'Failed to load the CI runs') }); });
    return () => { cancelled = true; };
  }, [caseId, key]);

  const current = state?.key === key ? state : null;
  return (
    <Card className="p-0 overflow-x-auto">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Workflow size={16} className="text-accent" /> CI runs</h2>
        <p className="text-xs text-text-muted">The corporate policy gate&apos;s verdicts for this branch, each signed by Nomus.</p>
      </div>
      {!current ? <div className="flex justify-center py-6"><Spinner /></div>
        : 'error' in current ? <div className="px-4 pb-4"><ErrorState compact message={current.error} onRetry={() => setRetry((r) => r + 1)} /></div>
          : current.data.items.length === 0 ? <p className="px-4 pb-4 text-sm text-text-muted">No CI run has evaluated this branch yet.</p>
            : <CiRunTable runs={current.data.items} repo={repo} />}
      {current && 'data' in current && current.data.nextCursor && (
        <p className="px-4 pb-3 text-xs text-text-muted">Showing the 50 newest runs.</p>
      )}
    </Card>
  );
}

export function CiRunTable({ runs, repo }: { runs: CiRun[]; repo: string }) {
  return (
    <table className="w-full text-sm" data-testid="case-ci-runs">
      <TableHead dense columns={['Verdict', 'Head commit', 'Pull request', 'Evaluated', 'Signature']} />
      <tbody className="divide-y divide-border">
        {runs.map((r) => (
          <tr key={r.id} className="hover:bg-surface-hover">
            <td className="px-4 py-2">
              <Badge variant={r.verdict === 'pass' ? 'success' : 'danger'}>{r.verdict === 'pass' ? 'Passed' : 'Failed'}</Badge>
              <span className="ml-2 text-xs text-text-muted">{r.counts.blocking} blocking</span>
            </td>
            <td className="px-4 py-2"><span className="block max-w-[10rem] truncate font-mono text-xs" title={r.headSha}>{r.headSha}</span></td>
            <td className="px-4 py-2 text-xs"><PullRequest repo={repo} prNumber={r.prNumber} closed /></td>
            <td className="px-4 py-2 text-xs text-text-secondary whitespace-nowrap">{formatUtc(r.evaluatedAt)}</td>
            <td className="px-4 py-2">
              <Badge variant={r.signatureValid ? 'success' : 'danger'}>{r.signatureValid ? 'Verified' : 'Does not verify'}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
