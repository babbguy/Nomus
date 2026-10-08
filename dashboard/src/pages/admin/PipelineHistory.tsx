import { useEffect, useState, useCallback } from 'react';

import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import {
  getPipelineRuns,
  getStagedContent,
  approveStagedContent,
  rejectStagedContent,
  retryStagedContent,
} from '../../api/admin';
import type { StagedItem } from '../../api/admin';
import { formatDateTime, formatCents } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

interface PipelineRun {
  id: string;
  sourceId: string;
  sourceName: string | null;
  status: string;
  stepReached: number;
  diffDetected: boolean;
  classification: string | null;
  rulesCreated: number;
  rulesUpdated: number;
  llmProvider: string | null;
  llmModel: string | null;
  llmTokensIn: number | null;
  llmTokensOut: number | null;
  llmCostCents: number | null;
  errorMessage: string | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

type Tab = 'staged' | 'history';

const statusColors: Record<string, 'success' | 'info' | 'warning' | 'danger'> = {
  completed: 'success',
  no_change: 'info',
  typo_only: 'warning',
  error: 'danger',
};

const stagedStatusColors: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'default' | 'accent'> = {
  pending: 'default',
  cleaning: 'info',
  cleaned: 'info',
  verifying: 'info',
  verified: 'info',
  scoring: 'info',
  scored: 'info',
  extracting: 'accent',
  extracted: 'accent',
  promoting: 'accent',
  promoted: 'success',
  rejected: 'danger',
  needs_review: 'warning',
  needs_intervention: 'danger',
};

const gradeColors: Record<string, 'success' | 'info' | 'warning' | 'danger'> = {
  A: 'success',
  B: 'success',
  C: 'warning',
  D: 'danger',
  F: 'danger',
};

export default function PipelineHistory() {
  const [tab, setTab] = useState<Tab>('staged');
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    return getPipelineRuns(100)
      .then((r) => {
        setRuns(r.runs);
        setError(null);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load pipeline history.'));
      })
      .finally(() => setLoading(false));
  }, []);

  const loadStaged = useCallback(() => {
    return getStagedContent()
      .then((r) => {
        setStaged(r.staged);
        setError(null);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load staged content.'));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (tab === 'staged') loadStaged();
    else loadHistory();
  }, [tab, loadStaged, loadHistory]);

  async function handleApprove(id: string) {
    setActionLoading(id);
    try {
      await approveStagedContent(id);
      loadStaged();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to approve staged content.'));
    }
    setActionLoading(null);
  }

  async function handleReject(id: string) {
    setActionLoading(id);
    try {
      await rejectStagedContent(id);
      loadStaged();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to reject staged content.'));
    }
    setActionLoading(null);
  }

  async function handleRetry(id: string) {
    setActionLoading(id);
    try {
      await retryStagedContent(id);
      loadStaged();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to retry staged content.'));
    }
    setActionLoading(null);
  }

  if (error) {
    const handleRetry = () => {
      setError(null);
      setLoading(true);
      if (tab === 'staged') loadStaged();
      else loadHistory();
    };
    return (
      <div className="flex flex-col items-center py-20 gap-3">
        <p className="text-sm text-danger">{error}</p>
        <button
          onClick={handleRetry}
          className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Pipeline History</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setTab('staged')}
            className={`px-4 py-2 text-sm rounded-lg transition ${
              tab === 'staged'
                ? 'bg-accent text-accent-text font-semibold'
                : 'bg-surface-raised text-text-secondary hover:bg-surface-hover'
            }`}
          >
            Staged
            {staged.filter((s) => !['promoted', 'rejected'].includes(s.pipelineStatus)).length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center w-5 h-5 text-xs rounded-full bg-warning/20 text-warning">
                {staged.filter((s) => !['promoted', 'rejected'].includes(s.pipelineStatus)).length}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('history')}
            className={`px-4 py-2 text-sm rounded-lg transition ${
              tab === 'history'
                ? 'bg-accent text-accent-text font-semibold'
                : 'bg-surface-raised text-text-secondary hover:bg-surface-hover'
            }`}
          >
            History
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : tab === 'staged' ? (
        <StagedTable
          items={staged}
          actionLoading={actionLoading}
          onApprove={handleApprove}
          onReject={handleReject}
          onRetry={handleRetry}
        />
      ) : (
        <HistoryTable runs={runs} />
      )}
    </div>
  );
}

// ─── Staged Content Table ─────────────────────────────────────

function StagedTable({
  items,
  actionLoading,
  onApprove,
  onReject,
  onRetry,
}: {
  items: StagedItem[];
  actionLoading: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (items.length === 0) {
    return <EmptyState title="No staged content" description="Content will appear here when the pipeline scrapes a source." />;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={item.id} className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-text-primary truncate">
                  {item.sourceName ?? item.sourceId.slice(0, 12)}
                </span>
                {item.sourceJurisdiction && (
                  <Badge variant="default">{item.sourceJurisdiction}</Badge>
                )}
                <Badge variant={stagedStatusColors[item.pipelineStatus] ?? 'default'}>
                  {item.pipelineStatus.replace(/_/g, ' ')}
                </Badge>
                {item.qualityGrade && (
                  <Badge variant={gradeColors[item.qualityGrade] ?? 'default'}>
                    Grade {item.qualityGrade}
                  </Badge>
                )}
                <Badge variant="default">
                  {item.source === 'upload' ? 'Upload' : 'Scrape'}
                </Badge>
              </div>

              {/* Step progress bar */}
              <PipelineSteps step={item.pipelineStep} status={item.pipelineStatus} />

              <div className="flex items-center gap-4 text-xs text-text-muted mt-1">
                <span>{item.wordCount.toLocaleString()} words</span>
                {item.extractedCount > 0 && (
                  <span>{item.extractedCount} extracted</span>
                )}
                {item.scoredCount > 0 && (
                  <span className="text-success">{item.scoredCount} accepted</span>
                )}
                {item.rejectedCount > 0 && (
                  <span className="text-danger">{item.rejectedCount} rejected</span>
                )}
                {item.llmCostCents > 0 && (
                  <span className="font-mono">{formatCents(item.llmCostCents)}</span>
                )}
                <span>{formatDateTime(item.updatedAt)}</span>
                {item.retryCount > 0 && (
                  <span className="text-warning">Retry #{item.retryCount}</span>
                )}
              </div>

              {/* Verification stats */}
              <VerificationInfo item={item} />

              {item.pipelineError && (
                <p className="text-xs text-danger mt-2 bg-danger/5 rounded px-2 py-1">
                  {item.pipelineError}
                </p>
              )}

              {item.qualityDiagnostic && item.pipelineStatus !== 'promoted' && (
                <p className="text-xs text-text-muted mt-1 bg-surface-hover rounded px-2 py-1">
                  Diagnostic: {item.qualityDiagnostic}
                </p>
              )}

              {item.healingAttempted && (
                <HealingInfo strategy={item.healingStrategy} log={item.healingLog} />
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {item.pipelineStatus === 'needs_review' && (
                <>
                  <Button
                    variant="primary"
                    className="text-xs px-3 py-1"
                    disabled={actionLoading === item.id}
                    onClick={() => onApprove(item.id)}
                  >
                    {actionLoading === item.id ? 'Processing...' : 'Approve'}
                  </Button>
                  <Button
                    variant="danger"
                    className="text-xs px-3 py-1"
                    disabled={actionLoading === item.id}
                    onClick={() => onReject(item.id)}
                  >
                    Reject
                  </Button>
                </>
              )}
              {(item.pipelineStatus === 'needs_intervention' || item.pipelineStatus === 'rejected') && (
                <Button
                  variant="secondary"
                  className="text-xs px-3 py-1"
                  disabled={actionLoading === item.id}
                  onClick={() => onRetry(item.id)}
                >
                  {actionLoading === item.id ? 'Retrying...' : 'Retry'}
                </Button>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Healing Info Component ──────────────────────────────────

interface HealingLogEntry {
  strategy: string;
  result: 'success' | 'failed' | 'skipped';
  grade: string | null;
  durationMs: number;
  error?: string;
}

function HealingInfo({ strategy, log }: { strategy: string | null; log: string | null }) {
  const [expanded, setExpanded] = useState(false);

  let entries: HealingLogEntry[] = [];
  try {
    entries = log ? JSON.parse(log) : [];
  } catch {
    entries = [];
  }

  if (entries.length === 0) return null;

  const succeeded = strategy !== null;
  const label = succeeded
    ? `Healed via ${strategy}`
    : `Healing failed (${entries.length} strategies tried)`;

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`text-xs px-2 py-1 rounded flex items-center gap-1 transition ${
          succeeded
            ? 'bg-success/10 text-success hover:bg-success/20'
            : 'bg-warning/10 text-warning hover:bg-warning/20'
        }`}
      >
        <span>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-2 space-y-1">
          {entries.map((entry, i) => (
            <div
              key={i}
              className="text-xs flex items-center gap-2 text-text-muted"
            >
              <span className={
                entry.result === 'success' ? 'text-success' :
                entry.result === 'skipped' ? 'text-text-muted' : 'text-danger'
              }>
                {entry.result === 'success' ? '\u2713' : entry.result === 'skipped' ? '\u2014' : '\u2717'}
              </span>
              <span className="font-medium">{entry.strategy.replace(/_/g, ' ')}</span>
              {entry.grade && <span>Grade {entry.grade}</span>}
              <span className="font-mono">{entry.durationMs}ms</span>
              {entry.error && <span className="text-danger truncate max-w-[200px]" title={entry.error}>{entry.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Pipeline Steps Indicator ──────────────────────────────────

const STEP_LABELS = ['Scrape', 'Clean', 'Verify', 'Extract', 'Promote'];

function PipelineSteps({ step, status }: { step: number; status: string }) {
  const isTerminal = ['promoted', 'rejected', 'needs_review', 'needs_intervention'].includes(status);

  return (
    <div className="flex items-center gap-1 mt-2 mb-1">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        const isComplete = step > stepNum || (step === stepNum && status === 'promoted' && stepNum === 5);
        const isCurrent = step === stepNum && !isComplete;
        const isFailed = isCurrent && isTerminal && status !== 'promoted';

        let bg = 'bg-surface-hover text-text-muted';
        if (isComplete) bg = 'bg-success/20 text-success';
        else if (isFailed) bg = 'bg-danger/20 text-danger';
        else if (isCurrent) bg = 'bg-accent/20 text-accent';

        return (
          <div key={label} className="flex items-center gap-1">
            {i > 0 && (
              <div className={`w-3 h-px ${isComplete ? 'bg-success/40' : 'bg-border'}`} />
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${bg}`}>
              {stepNum}. {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Verification Info Component ──────────────────────────────

interface VerificationStats {
  articlesFound: number;
  sectionsFound: number;
  crossRefsFound: number;
  crossRefsResolved: number;
  estimatedCompleteness: number;
}

interface VerificationIssueEntry {
  type: string;
  severity: 'error' | 'warning';
  description: string;
  location?: string;
}

function VerificationInfo({ item }: { item: StagedItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.pipelineStep < 3 || !item.verificationStats) return null;

  let stats: VerificationStats;
  try {
    stats = JSON.parse(item.verificationStats);
  } catch {
    return null;
  }

  let issues: VerificationIssueEntry[] = [];
  try {
    issues = item.verificationIssues ? JSON.parse(item.verificationIssues) : [];
  } catch {
    issues = [];
  }

  const passed = item.verificationPassed;
  const completeness = Math.round((stats.estimatedCompleteness ?? 0) * 100);
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`text-xs px-2 py-1 rounded flex items-center gap-2 transition ${
          passed
            ? 'bg-success/10 text-success hover:bg-success/20'
            : passed === false
              ? 'bg-danger/10 text-danger hover:bg-danger/20'
              : 'bg-info/10 text-info hover:bg-info/20'
        }`}
      >
        <span>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>
          {passed ? 'Verified' : passed === false ? 'Verification Failed' : 'Verifying'}
          {' \u2014 '}
          {stats.articlesFound} articles, {stats.crossRefsResolved}/{stats.crossRefsFound} refs, {completeness}% complete
        </span>
        {item.llmSpotCheckUsed && (
          <span className="text-warning">(LLM spot-check)</span>
        )}
      </button>
      {expanded && issues.length > 0 && (
        <div className="mt-1 ml-2 space-y-1">
          {errors.map((issue, i) => (
            <div key={`e${i}`} className="text-xs flex items-start gap-2 text-danger">
              <span className="flex-shrink-0">\u2717</span>
              <span>{issue.description}{issue.location ? ` (${issue.location})` : ''}</span>
            </div>
          ))}
          {warnings.map((issue, i) => (
            <div key={`w${i}`} className="text-xs flex items-start gap-2 text-warning">
              <span className="flex-shrink-0">\u26A0</span>
              <span>{issue.description}{issue.location ? ` (${issue.location})` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Pipeline History Table (original) ────────────────────────

function HistoryTable({ runs }: { runs: PipelineRun[] }) {
  if (runs.length === 0) {
    return <EmptyState title="No pipeline runs yet" description="Trigger a scrape from the Sources page to see results here." />;
  }

  return (
    <Card className="p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Step</th>
            <th className="px-4 py-3 font-medium">Classification</th>
            <th className="px-4 py-3 font-medium">Rules</th>
            <th className="px-4 py-3 font-medium">Cost</th>
            <th className="px-4 py-3 font-medium">Duration</th>
            <th className="px-4 py-3 font-medium">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-surface-hover transition">
              <td className="px-4 py-3 text-text-primary text-xs font-medium max-w-[200px] truncate" title={run.sourceName ?? run.sourceId}>
                {run.sourceName ?? <span className="text-text-muted font-mono">{run.sourceId.slice(0, 8)}</span>}
              </td>
              <td className="px-4 py-3">
                <Badge variant={statusColors[run.status] ?? 'default'}>{run.status}</Badge>
              </td>
              <td className="px-4 py-3 text-text-secondary">Step {run.stepReached}/5</td>
              <td className="px-4 py-3 text-text-secondary">{run.classification ?? '\u2014'}</td>
              <td className="px-4 py-3 text-text-primary">
                {run.rulesCreated > 0 && <span className="text-success">+{run.rulesCreated}</span>}
                {run.rulesUpdated > 0 && <span className="text-info ml-1">~{run.rulesUpdated}</span>}
                {run.rulesCreated === 0 && run.rulesUpdated === 0 && '\u2014'}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                {run.llmCostCents ? formatCents(run.llmCostCents) : '$0.00'}
              </td>
              <td className="px-4 py-3 text-text-muted text-xs">{run.durationMs}ms</td>
              <td className="px-4 py-3 text-text-muted text-xs">{formatDateTime(run.completedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
