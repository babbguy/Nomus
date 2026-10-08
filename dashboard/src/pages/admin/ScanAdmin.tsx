import { useEffect, useState } from 'react';
import { getAdminScanSummary, type AdminScanSummary } from '../../api/scans';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import SeverityBadge from '../../components/domain/SeverityBadge';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import { SkeletonStats, SkeletonTable } from '../../components/ui/Skeleton';
import { apiErrorMessage } from '../../lib/errors';
import { GitBranch, ShieldAlert, CheckCircle } from 'lucide-react';

/** Scan findings uploaded by every organization (platform-wide view). */
export default function ScanAdmin() {
  const [summary, setSummary] = useState<AdminScanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    getAdminScanSummary()
      .then(setSummary)
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load scan data')))
      .finally(() => setLoading(false));
  }, [retryKey]);

  if (loadError) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-text-primary mb-6">Scan Administration</h1>
        <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); setRetryKey((k) => k + 1); }} />
      </div>
    );
  }

  const totals = summary?.totals;
  const repos = summary?.repos ?? [];
  const recentFindings = summary?.recentFindings ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-semibold text-text-primary">Scan Administration</h1>
      </div>
      <p className="text-sm text-text-muted mb-6">
        Findings uploaded by scanners and the GitHub Action, across all organizations.
      </p>

      {/* Aggregate stats */}
      {loading || !totals ? (
        <SkeletonStats count={4} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Repositories</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{totals.repos}</p>
            <p className="text-xs text-text-muted mt-1">{totals.organizations} organization{totals.organizations === 1 ? '' : 's'}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Open Findings</p>
            <p className="text-2xl font-bold text-warning mt-1">{totals.openFindings}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Critical Open</p>
            <p className="text-2xl font-bold text-danger mt-1">{totals.criticalOpen}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">All Findings</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{totals.totalFindings}</p>
            <p className="text-xs text-text-muted mt-1">open, resolved and dismissed</p>
          </Card>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Repos table */}
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <GitBranch size={16} />
            Repositories
          </h2>
          {loading ? (
            <SkeletonTable rows={5} />
          ) : repos.length === 0 ? (
            <EmptyState title="No repos scanned" />
          ) : (
            <div className="space-y-2">
              {repos.map((repo) => (
                <div
                  key={`${repo.orgId}:${repo.repo}`}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-surface-hover transition"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary truncate">{repo.repo}</p>
                    <p className="text-[11px] text-text-muted truncate">
                      {repo.orgName ?? 'Unknown organization'} · last scanned {new Date(repo.lastScanned).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {repo.criticalOpen > 0 && <Badge variant="danger">{repo.criticalOpen} critical</Badge>}
                    {repo.openFindings > 0 ? (
                      <Badge variant="warning">{repo.openFindings} open</Badge>
                    ) : (
                      <Badge variant="success">Clean</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Recent open findings */}
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <ShieldAlert size={16} />
            Recent Open Findings
          </h2>
          {loading ? (
            <SkeletonTable rows={5} />
          ) : recentFindings.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-text-muted">
              <CheckCircle size={32} className="mb-2 text-success opacity-60" />
              <p className="text-sm">All clear — no open findings</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentFindings.slice(0, 10).map((f) => (
                <div key={f.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-surface-hover transition">
                  <SeverityBadge severity={f.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text-primary truncate">{f.ruleKey}</p>
                    <p className="text-[11px] text-text-muted truncate">{f.orgName ?? 'Unknown organization'} · {f.repo} · {f.filePath}:{f.lineNumber}</p>
                  </div>
                </div>
              ))}
              {recentFindings.length > 10 && (
                <p className="text-xs text-text-muted text-center pt-1">Showing the 10 most recent of {totals?.openFindings ?? recentFindings.length} open</p>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
