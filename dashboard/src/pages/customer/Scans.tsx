import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getScanRepos, type ScanRepo } from '../../api/scans';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { apiErrorMessage } from '../../lib/errors';
import { GitBranch, Clock } from 'lucide-react';

export default function Scans() {
  const [repos, setRepos] = useState<ScanRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  function fetchRepos() {
    getScanRepos()
      .then((r) => {
        setRepos(r.repos);
        setFetchedAt(new Date().toISOString());
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load scan history')))
      .finally(() => setLoading(false));
  }

  function load() {
    setLoading(true);
    setLoadError(null);
    fetchRepos();
  }

  useEffect(() => {
    fetchRepos();
  }, []);

  const totalFindings = repos.reduce((sum, r) => sum + r.openFindings, 0);
  const totalRepos = repos.length;

  // Real data timestamp: most recent scan across all repos
  const lastScanTime = repos.reduce<string | null>((max, r) => {
    if (!r.lastScanned || Number.isNaN(new Date(r.lastScanned).getTime())) return max;
    return !max || new Date(r.lastScanned) > new Date(max) ? r.lastScanned : max;
  }, null);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Scan History</h1>
          <DataFreshness fetchedAt={fetchedAt} dataTimestamp={lastScanTime} className="mt-1" />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Repos Scanned</p>
          <p className="text-2xl font-bold text-text-primary mt-1">{loading || loadError ? '—' : totalRepos}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Open Findings</p>
          <p className="text-2xl font-bold text-warning mt-1">{loading || loadError ? '—' : totalFindings}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Last Scan</p>
          <p className="text-sm font-medium text-text-primary mt-2">
            {loading || loadError ? '—' : repos[0] ? new Date(repos[0].lastScanned).toLocaleDateString() : 'Never'}
          </p>
        </Card>
      </div>

      {/* Repo list */}
      {loading ? (
        <SkeletonTable rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : repos.length === 0 ? (
        <EmptyState title="No scans yet" description="Run your first scan with the Nomus Scanner CLI or GitHub Action." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Repository</th>
                <th className="px-4 py-3 font-medium">Open</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Last Scanned</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.repo} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      to={`/scans/${encodeURIComponent(repo.repo)}`}
                      className="flex items-center gap-2 text-accent hover:underline"
                    >
                      <GitBranch size={14} />
                      {repo.repo}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {repo.openFindings > 0 ? (
                      <Badge variant="warning">{repo.openFindings}</Badge>
                    ) : (
                      <Badge variant="success">0</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{repo.totalFindings}</td>
                  <td className="px-4 py-3 text-text-muted text-xs">
                    <span className="flex items-center gap-1">
                      <Clock size={12} />
                      {new Date(repo.lastScanned).toLocaleString()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
