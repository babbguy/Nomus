import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getScanRepos, getScanFindings, type ScanRepo, type ScanFinding } from '../../api/scans';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import SeverityBadge from '../../components/domain/SeverityBadge';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import { SkeletonStats, SkeletonTable } from '../../components/ui/Skeleton';
import { apiErrorMessage } from '../../lib/errors';
import { GitBranch, ShieldAlert, CheckCircle } from 'lucide-react';

export default function ScanAdmin() {
  const [repos, setRepos] = useState<ScanRepo[]>([]);
  const [recentFindings, setRecentFindings] = useState<ScanFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    Promise.all([
      getScanRepos(),
      getScanFindings({ status: 'open', limit: '20' }),
    ]).then(([repoData, findingsData]) => {
      setRepos(repoData.repos);
      setRecentFindings(findingsData.findings);
    }).catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load scan data')))
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

  const totalOpen = repos.reduce((sum, r) => sum + r.openFindings, 0);
  const totalAll = repos.reduce((sum, r) => sum + r.totalFindings, 0);
  const criticalCount = recentFindings.filter((f) => f.severity === 'critical').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Scan Administration</h1>
      </div>

      {/* Aggregate stats */}
      {loading ? (
        <SkeletonStats count={4} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Total Repos</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{repos.length}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Open Findings</p>
            <p className="text-2xl font-bold text-warning mt-1">{totalOpen}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Critical</p>
            <p className="text-2xl font-bold text-danger mt-1">{criticalCount}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wide">Total Scanned</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{totalAll}</p>
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
                <Link
                  key={repo.repo}
                  to={`/scans/${encodeURIComponent(repo.repo)}`}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-surface-hover transition"
                >
                  <span className="text-sm text-text-primary">{repo.repo}</span>
                  <div className="flex items-center gap-2">
                    {repo.openFindings > 0 ? (
                      <Badge variant="warning">{repo.openFindings} open</Badge>
                    ) : (
                      <Badge variant="success">Clean</Badge>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* Recent critical/high findings */}
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
                    <p className="text-[11px] text-text-muted truncate">{f.repo} · {f.filePath}</p>
                  </div>
                </div>
              ))}
              {recentFindings.length > 10 && (
                <p className="text-xs text-text-muted text-center pt-1">+{recentFindings.length - 10} more</p>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
