import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getScanFindings, dismissFinding, type ScanFinding } from '../../api/scans';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import SeverityBadge from '../../components/domain/SeverityBadge';
import EffectBadge from '../../components/domain/EffectBadge';
import DetectorBadge from '../../components/domain/DetectorBadge';
import FrameworkBadge, { RiskTierBadge } from '../../components/domain/FrameworkBadge';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { apiErrorMessage } from '../../lib/errors';
import { ArrowLeft, FileCode, XCircle, CheckCircle } from 'lucide-react';

export default function ScanRepo() {
  const { repo } = useParams<{ repo: string }>();
  const decodedRepo = decodeURIComponent(repo ?? '');
  const [findings, setFindings] = useState<ScanFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('open');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // Clear any prior load error the instant a new fetch is triggered (filter
  // change, repo change, or retry) — done during render, not in the effect, so
  // no state is set synchronously inside the effect body.
  const fetchKey = `${decodedRepo}|${severity}|${status}|${retryKey}`;
  const [loadedKey, setLoadedKey] = useState(fetchKey);
  if (loadedKey !== fetchKey) {
    setLoadedKey(fetchKey);
    setLoadError(null);
  }

  useEffect(() => {
    const params: Record<string, string> = { repo: decodedRepo };
    if (severity) params.severity = severity;
    if (status) params.status = status;
    getScanFindings(params)
      .then((r) => setFindings(r.findings))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load scan findings')))
      .finally(() => setLoading(false));
  }, [decodedRepo, severity, status, retryKey]);

  const handleDismiss = async (id: string, newStatus: 'dismissed' | 'resolved') => {
    setActionError(null);
    try {
      await dismissFinding(id, newStatus);
      setFindings((prev) => prev.map((f) => f.id === id ? { ...f, status: newStatus } : f));
    } catch (err) {
      setActionError(apiErrorMessage(err, `Failed to mark finding as ${newStatus}`));
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/scans" className="text-text-muted hover:text-text-primary transition">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-xl font-semibold text-text-primary">{decodedRepo}</h1>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
        >
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
        >
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </select>
      </div>

      {actionError && <ErrorState compact message={actionError} />}

      {/* Findings */}
      {loading ? (
        <SkeletonTable rows={8} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => { setLoading(true); setRetryKey((k) => k + 1); }} />
      ) : findings.length === 0 ? (
        <EmptyState title="No obligations found" description="No applicable regulatory obligations match your filters." />
      ) : (
        <div className="space-y-3">
          {findings.map((f) => (
            <Card key={f.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <SeverityBadge severity={f.severity} />
                    <EffectBadge effect={f.effect} />
                    <FrameworkBadge ruleKey={f.ruleKey} legalReference={f.legalReference} />
                    <RiskTierBadge ruleKey={f.ruleKey} />
                    <DetectorBadge source={f.detectorSource} />
                    <span className="text-xs text-text-muted font-mono">{f.ruleKey}</span>
                  </div>
                  <p className="text-sm text-text-primary mb-1">{f.humanSummary}</p>
                  <div className="flex items-center gap-3 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <FileCode size={12} />
                      {f.filePath}:{f.lineNumber}
                    </span>
                    <span>SDK: {f.capabilityDetected}</span>
                    {f.legalReference && <span className="font-medium">{f.legalReference}</span>}
                    {f.commitSha && <span>Commit: {f.commitSha.slice(0, 8)}</span>}
                  </div>
                  {f.suggestion && (
                    <details className="mt-2">
                      <summary className="text-xs text-accent cursor-pointer">Suggested fix</summary>
                      <pre className="mt-1 text-xs bg-surface-hover rounded p-2 overflow-x-auto text-text-secondary">{f.suggestion}</pre>
                    </details>
                  )}
                </div>
                {f.status === 'open' && (
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => handleDismiss(f.id, 'resolved')}
                      className="p-1.5 rounded-lg hover:bg-success/15 text-text-muted hover:text-success transition"
                      title="Mark resolved"
                    >
                      <CheckCircle size={16} />
                    </button>
                    <button
                      onClick={() => handleDismiss(f.id, 'dismissed')}
                      className="p-1.5 rounded-lg hover:bg-danger/15 text-text-muted hover:text-danger transition"
                      title="Dismiss"
                    >
                      <XCircle size={16} />
                    </button>
                  </div>
                )}
                {f.status !== 'open' && (
                  <Badge variant={f.status === 'resolved' ? 'success' : 'default'}>{f.status}</Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
