/**
 * Clause Map — visual heuristic → clause correlation matrix.
 *
 * Left: matrix of codebase heuristics (rows) × frameworks (columns); each
 * cell is a clause chip heat-colored by the mapping's learned confidence
 * (Beta posterior). Clicking a cell opens the detail panel: clause text,
 * rationale, prior vs learned confidence, and the learning trajectory.
 *
 * Below: this org's clause matches with Confirm / Dismiss actions — the
 * feedback that drives the learning loop.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  getClauseMappings,
  getClauseMatches,
  getMappingHistory,
  submitClauseFeedback,
  type ClauseMapping,
  type ClauseMatch,
  type ClauseFramework,
  type LearningEvent,
} from '../../api/clause-map';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { apiErrorMessage } from '../../lib/errors';
import { BookOpenCheck, Brain, Check, ExternalLink, TrendingUp, TrendingDown, X } from 'lucide-react';

const FRAMEWORKS: Array<{ key: ClauseFramework; label: string }> = [
  { key: 'EU_AI_ACT', label: 'EU AI Act' },
  { key: 'HIPAA', label: 'HIPAA' },
  { key: 'GDPR', label: 'GDPR' },
];

/** Heat color for a learned-confidence value (0..1). */
function confidenceClasses(p: number): string {
  if (p >= 0.75) return 'bg-danger/20 text-danger border-danger/40';
  if (p >= 0.55) return 'bg-warning/20 text-warning border-warning/40';
  if (p >= 0.35) return 'bg-info/15 text-info border-info/30';
  return 'bg-surface-hover text-text-muted border-border';
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function LearnedDelta({ mapping }: { mapping: ClauseMapping }) {
  const delta = mapping.posterior - mapping.priorMean;
  if (mapping.observations === 0) {
    return <span className="text-xs text-text-muted">no feedback yet — showing prior</span>;
  }
  const up = delta >= 0;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${up ? 'text-success' : 'text-danger'}`}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {up ? '+' : ''}{(delta * 100).toFixed(1)} pts from {mapping.observations.toFixed(0)} feedback signal{mapping.observations === 1 ? '' : 's'}
    </span>
  );
}

function MappingDetail({ mapping, onClose }: { mapping: ClauseMapping; onClose: () => void }) {
  const [history, setHistory] = useState<LearningEvent[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // When a different mapping is shown in the same instance, reset to the loading
  // state during render (not inside the effect) so the effect sets no state
  // synchronously and no stale history is presented for the new mapping.
  const [loadedMapping, setLoadedMapping] = useState(mapping.id);
  if (loadedMapping !== mapping.id) {
    setLoadedMapping(mapping.id);
    setHistory(null);
    setHistoryError(null);
  }

  useEffect(() => {
    getMappingHistory(mapping.id)
      .then((r) => setHistory(r.events))
      .catch((err) => setHistoryError(apiErrorMessage(err, 'Failed to load learning history')));
  }, [mapping.id]);

  return (
    <Card className="border-accent/40">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="accent">{FRAMEWORKS.find((f) => f.key === mapping.framework)?.label}</Badge>
            <span className="font-mono text-sm text-text-primary">{mapping.clauseCitation}</span>
            {mapping.clauseUrl && (
              <a href={mapping.clauseUrl} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">
                <ExternalLink size={13} />
              </a>
            )}
          </div>
          <h3 className="text-sm font-semibold text-text-primary">{mapping.clauseTitle}</h3>
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close detail">
          <X size={16} />
        </button>
      </div>

      <p className="text-sm text-text-secondary mt-3">{mapping.rationale}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide">Heuristic</p>
          <p className="text-sm text-text-primary mt-0.5">{mapping.heuristicLabel}</p>
          <p className="text-xs text-text-muted mt-0.5 font-mono">
            {mapping.heuristic.requires.map((r) => r.capability).join(' + ')}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide">Learned Confidence</p>
          <p className="text-lg font-bold text-text-primary mt-0.5">{pct(mapping.posterior)}</p>
          <LearnedDelta mapping={mapping} />
        </div>
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide">Fired / Evaluated</p>
          <p className="text-lg font-bold text-text-primary mt-0.5">
            {mapping.firedCount} <span className="text-sm font-normal text-text-muted">/ {mapping.evaluatedCount} scans</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide">Your Matches</p>
          <p className="text-sm text-text-primary mt-0.5">
            {mapping.orgMatches.open} open · {mapping.orgMatches.confirmed} confirmed · {mapping.orgMatches.dismissed} dismissed
          </p>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Learning Trajectory</p>
        {historyError ? (
          <ErrorState compact message={historyError} />
        ) : history === null ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-text-muted">No events recorded.</p>
        ) : (
          <ul className="space-y-1 max-h-40 overflow-y-auto pr-2">
            {history.slice(0, 20).map((e, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className="text-text-muted w-36 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
                <Badge
                  variant={
                    e.eventType === 'feedback_confirm' ? 'success'
                    : e.eventType === 'feedback_dismiss' ? 'danger'
                    : e.eventType === 'scan_fired' ? 'info'
                    : 'default'
                  }
                >
                  {e.eventType.replace(/_/g, ' ')}
                </Badge>
                {e.posteriorBefore !== e.posteriorAfter && (
                  <span className="text-text-secondary font-mono">
                    {pct(e.posteriorBefore)} → {pct(e.posteriorAfter)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export default function ClauseMap() {
  const [mappings, setMappings] = useState<ClauseMapping[]>([]);
  const [matches, setMatches] = useState<ClauseMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ClauseMapping | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'confirmed' | 'dismissed'>('open');
  const [busyMatch, setBusyMatch] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const fetchClauseMap = () => {
    Promise.all([getClauseMappings(), getClauseMatches({ status: statusFilter })])
      .then(([m, ma]) => {
        setMappings(m.mappings);
        setMatches(ma.matches);
        setSelected((prev) => (prev ? m.mappings.find((x) => x.id === prev.id) ?? null : null));
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load clause map')))
      .finally(() => setLoading(false));
  };

  const load = () => {
    setLoadError(null);
    fetchClauseMap();
  };

  // Clear a prior load error during render when the status filter changes, so
  // the effect body sets no state synchronously.
  const [loadedFilter, setLoadedFilter] = useState(statusFilter);
  if (loadedFilter !== statusFilter) {
    setLoadedFilter(statusFilter);
    setLoadError(null);
  }

  useEffect(fetchClauseMap, [statusFilter]);

  const heuristicRows = useMemo(() => {
    const byLabel = new Map<string, Partial<Record<ClauseFramework, ClauseMapping>>>();
    for (const m of mappings) {
      const row = byLabel.get(m.heuristicLabel) ?? {};
      row[m.framework] = m;
      byLabel.set(m.heuristicLabel, row);
    }
    return Array.from(byLabel.entries());
  }, [mappings]);

  const openMatches = mappings.reduce((s, m) => s + m.orgMatches.open, 0);
  const totalObservations = mappings.reduce((s, m) => s + m.observations, 0);
  const avgConfidence = mappings.length
    ? mappings.reduce((s, m) => s + m.posterior, 0) / mappings.length
    : 0;

  const feedback = async (match: ClauseMatch, verdict: 'confirm' | 'dismiss') => {
    setBusyMatch(match.id);
    setFeedbackError(null);
    try {
      await submitClauseFeedback(match.id, verdict);
      load();
    } catch (err) {
      setFeedbackError(apiErrorMessage(err, `Failed to ${verdict} clause match`));
    } finally {
      setBusyMatch(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Clause Map</h1>
          <p className="text-sm text-text-muted mt-1">
            Codebase heuristics correlated to specific clauses — confidence learns from every scan and your feedback.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Mappings</p>
          <p className="text-2xl font-bold text-text-primary mt-1">{loading ? '—' : mappings.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Open Clause Matches</p>
          <p className="text-2xl font-bold text-warning mt-1">{loading ? '—' : openMatches}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Avg Learned Confidence</p>
          <p className="text-2xl font-bold text-text-primary mt-1">{loading ? '—' : pct(avgConfidence)}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide flex items-center gap-1">
            <Brain size={12} /> Feedback Signals
          </p>
          <p className="text-2xl font-bold text-accent mt-1">{loading ? '—' : totalObservations.toFixed(0)}</p>
        </Card>
      </div>

      {feedbackError && <ErrorState compact message={feedbackError} />}

      {loading ? (
        <SkeletonTable rows={6} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => { setLoading(true); load(); }} />
      ) : mappings.length === 0 ? (
        <EmptyState
          title="Clause map not seeded"
          description="The engine seeds the clause mapping dataset on startup. Check engine logs."
        />
      ) : (
        <>
          {/* Matrix */}
          <Card className="p-0 overflow-hidden mb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="px-4 py-3 font-medium">Codebase Heuristic</th>
                    {FRAMEWORKS.map((f) => (
                      <th key={f.key} className="px-4 py-3 font-medium">{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heuristicRows.map(([label, row]) => (
                    <tr key={label} className="border-b border-border/50">
                      <td className="px-4 py-3 text-text-secondary max-w-xs">{label}</td>
                      {FRAMEWORKS.map((f) => {
                        const m = row[f.key];
                        return (
                          <td key={f.key} className="px-4 py-3">
                            {m ? (
                              <button
                                onClick={() => setSelected(m)}
                                title={`${m.clauseTitle} — learned confidence ${pct(m.posterior)}`}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-mono transition-colors hover:brightness-110 ${confidenceClasses(m.posterior)} ${selected?.id === m.id ? 'ring-1 ring-accent' : ''}`}
                              >
                                {m.clauseCitation}
                                <span className="font-sans font-semibold">{pct(m.posterior)}</span>
                                {m.orgMatches.open > 0 && (
                                  <span className="font-sans bg-warning/30 text-warning rounded-full px-1.5">
                                    {m.orgMatches.open}
                                  </span>
                                )}
                              </button>
                            ) : (
                              <span className="text-text-muted/40">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Detail panel */}
          {selected && (
            <div className="mb-6">
              <MappingDetail mapping={selected} onClose={() => setSelected(null)} />
            </div>
          )}

          {/* Matches */}
          <div className="flex items-center justify-between mb-3 mt-6">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <BookOpenCheck size={16} /> Clause Matches in Your Repos
            </h2>
            <div className="flex gap-1">
              {(['open', 'confirmed', 'dismissed'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={statusFilter === s ? 'secondary' : 'ghost'}
                  onClick={() => setStatusFilter(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>

          {matches.length === 0 ? (
            <EmptyState
              title={`No ${statusFilter} clause matches`}
              description="Clause matches appear here when a scan upload correlates detector findings to framework clauses."
            />
          ) : (
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="px-4 py-3 font-medium">Clause</th>
                    <th className="px-4 py-3 font-medium">Location</th>
                    <th className="px-4 py-3 font-medium">Evidence</th>
                    <th className="px-4 py-3 font-medium">Confidence</th>
                    <th className="px-4 py-3 font-medium text-right">Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((match) => (
                    <tr key={match.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="accent">
                            {FRAMEWORKS.find((f) => f.key === match.mapping.framework)?.label}
                          </Badge>
                          <span className="font-mono text-xs text-text-primary">{match.mapping.clauseCitation}</span>
                        </div>
                        <p className="text-xs text-text-muted mt-1">{match.mapping.heuristicLabel}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-text-secondary">
                        <p className="font-mono">{match.filePath}:{match.lineNumber}</p>
                        <p className="text-text-muted mt-0.5">{match.repo}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {match.evidence.map((e, i) => (
                            <Badge key={i} variant="info" className="font-mono">
                              {e.capability}:{e.line}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${confidenceClasses(match.confidence)}`}>
                          {pct(match.confidence)}
                        </span>
                        {Math.abs(match.livePosterior - match.confidence) > 0.001 && (
                          <p className="text-[10px] text-text-muted mt-0.5">now {pct(match.livePosterior)}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {match.status === 'open' ? (
                          <div className="inline-flex gap-1">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busyMatch === match.id}
                              onClick={() => feedback(match, 'confirm')}
                              title="Confirm: this clause applies here (raises mapping confidence)"
                            >
                              <Check size={13} className="mr-1" /> Applies
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busyMatch === match.id}
                              onClick={() => feedback(match, 'dismiss')}
                              title="Dismiss: not applicable (lowers mapping confidence, suppresses re-fires here)"
                            >
                              <X size={13} className="mr-1" /> Not applicable
                            </Button>
                          </div>
                        ) : (
                          <Badge variant={match.status === 'confirmed' ? 'success' : 'default'}>
                            {match.status}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
