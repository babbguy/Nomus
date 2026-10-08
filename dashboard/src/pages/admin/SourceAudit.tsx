import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, FileText, Shield, Search, ExternalLink } from 'lucide-react';
import api from '../../api/client';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';

interface SourceContent {
  content: string | null;
  scrapedAt: string | null;
  contentHash: string | null;
  wordCount: number;
  sourceName: string;
  jurisdiction: string;
  url: string;
  message?: string;
}

interface SourceRule {
  id: string;
  ruleKey: string;
  humanSummary: string;
  legalReference: string;
  severity: string;
  effect: string;
  category: string;
  isActive: boolean;
}

interface PipelineStats {
  sourceName: string;
  jurisdiction: string;
  contentQualityGrade: string | null;
  staged: {
    qualityGrade: string | null;
    scoredCount: number;
    rejectedCount: number;
    extractedCount: number;
    pipelineStatus: string;
  } | null;
  runs: Array<{
    status: string;
    stepReached: number;
    rulesCreated: number;
    rulesUpdated: number;
    durationMs: number;
    startedAt: string;
    errorMessage: string | null;
  }>;
}

const severityColors = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'default',
} as const;

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export default function SourceAudit() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const [content, setContent] = useState<SourceContent | null>(null);
  const [rules, setRules] = useState<SourceRule[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [ruleCount, setRuleCount] = useState(0);
  const [partErrors, setPartErrors] = useState<string[]>([]);
  const [allFailed, setAllFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // Clear prior partial/aggregate errors during render whenever a new fetch is
  // triggered (source change or retry), so the effect sets no state synchronously.
  const auditKey = `${sourceId ?? ''}|${retryKey}`;
  const [loadedAudit, setLoadedAudit] = useState(auditKey);
  if (loadedAudit !== auditKey) {
    setLoadedAudit(auditKey);
    setPartErrors([]);
    setAllFailed(false);
  }

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    const errors: string[] = [];

    Promise.all([
      api.get(`/sources/${sourceId}/content`).then((r) => r.data).catch((err) => {
        errors.push(apiErrorMessage(err, 'Failed to load source content'));
        return null;
      }),
      api.get(`/sources/${sourceId}/rules`).then((r) => r.data).catch((err) => {
        errors.push(apiErrorMessage(err, 'Failed to load extracted rules'));
        return { rules: [], ruleCount: 0, failed: true };
      }),
      api.get(`/sources/${sourceId}/pipeline`).then((r) => r.data).catch((err) => {
        errors.push(apiErrorMessage(err, 'Failed to load pipeline stats'));
        return null;
      }),
    ]).then(([c, r, p]) => {
      if (cancelled) return;
      setContent(c);
      setRules(r?.rules ?? []);
      setRuleCount(r?.ruleCount ?? 0);
      setPipeline(p);
      setPartErrors(errors);
      setAllFailed(errors.length === 3);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [sourceId, retryKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner />
      </div>
    );
  }

  if (allFailed) {
    return (
      <ErrorState
        message={partErrors[0] ?? 'Failed to load source audit data'}
        onRetry={() => { setLoading(true); setRetryKey((k) => k + 1); }}
      />
    );
  }

  const sourceName = content?.sourceName ?? pipeline?.sourceName ?? 'Source';
  const jurisdiction = content?.jurisdiction ?? pipeline?.jurisdiction ?? '';

  function highlightContent(text: string): string {
    if (!searchTerm && !selectedRule) return text;

    if (searchTerm) {
      return text.replaceAll(searchTerm, '<<<HIGHLIGHT_START>>>' + searchTerm + '<<<HIGHLIGHT_END>>>');
    }

    return text;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Partial load failures (never silently empty a section) */}
      {partErrors.length > 0 && (
        <div className="px-6 pt-3">
          {partErrors.map((e, i) => (
            <ErrorState key={i} compact message={e} onRetry={() => { setLoading(true); setRetryKey((k) => k + 1); }} />
          ))}
        </div>
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-surface-secondary">
        <div className="flex items-center gap-3 mb-2">
          <Link to="/admin/sources" className="text-text-muted hover:text-text-primary">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-lg font-semibold text-text-primary">{sourceName}</h1>
          <Badge variant="info">{jurisdiction}</Badge>
          {pipeline?.contentQualityGrade && (
            <Badge variant={['A', 'B'].includes(pipeline.contentQualityGrade) ? 'success' : 'warning'}>
              Quality {pipeline.contentQualityGrade}
            </Badge>
          )}
          <span className="text-xs text-text-muted ml-auto">
            {/* Retired rules are listed too, so the count says which are live. */}
            {rules.filter((x) => x.isActive).length} active rules{ruleCount > rules.filter((x) => x.isActive).length ? ` (${ruleCount - rules.filter((x) => x.isActive).length} retired)` : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-2.5 text-text-muted" />
            <input
              type="text"
              placeholder="Search regulation text..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm bg-surface border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          {content?.url && (
            <a href={content.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-accent hover:underline">
              <ExternalLink size={12} /> Original source
            </a>
          )}
          {content?.scrapedAt && (
            <span className="text-xs text-text-muted">
              Scraped {new Date(content.scrapedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: Full regulatory text */}
        <div className="flex-1 overflow-y-auto border-r border-border">
          {content?.content ? (
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <FileText size={16} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text-secondary">
                  Full Regulatory Text
                </h2>
                <span className="text-xs text-text-muted">
                  {content.wordCount?.toLocaleString()} words
                </span>
              </div>
              <pre className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap font-mono break-words">
                {highlightContent(content.content).split('<<<HIGHLIGHT_START>>>').map((part, i) => {
                  if (i === 0) return part;
                  const [highlighted, rest] = part.split('<<<HIGHLIGHT_END>>>');
                  return (
                    <span key={i}>
                      <mark className="bg-accent/30 text-text-primary px-0.5 rounded">{highlighted}</mark>
                      {rest}
                    </span>
                  );
                })}
              </pre>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-text-muted">
                <FileText size={48} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">No scrape data</p>
                <p className="text-xs mt-1">Run a scrape on this source first</p>
              </div>
            </div>
          )}
        </div>

        {/* Right panel: Extracted rules */}
        <div className="w-[420px] shrink-0 overflow-y-auto bg-surface-secondary">
          <div className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <Shield size={16} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text-secondary">
                Extracted Rules ({rules.length})
              </h2>
            </div>

            {rules.length === 0 ? (
              <div className="text-center text-text-muted py-8">
                <p className="text-sm">No rules extracted yet</p>
              </div>
            ) : (
              <div className="space-y-3">
                {rules.map((rule) => (
                  <button
                    key={rule.id}
                    onClick={() => {
                      setSelectedRule(selectedRule === rule.id ? null : rule.id);
                      setSearchTerm('');
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedRule === rule.id
                        ? 'border-accent bg-accent/10'
                        : 'border-border bg-surface hover:border-accent/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <Badge variant={(severityColors[rule.severity as keyof typeof severityColors] ?? 'default') as BadgeVariant}>
                        {rule.severity}
                      </Badge>
                      <Badge variant="default">{rule.effect}</Badge>
                      {!rule.isActive && <Badge variant="warning">retired</Badge>}
                    </div>
                    <p className="text-xs font-medium text-accent mb-1">{rule.legalReference}</p>
                    <p className="text-xs text-text-primary leading-relaxed">{rule.humanSummary}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Pipeline stats footer */}
          {pipeline?.staged && (
            <div className="p-4 border-t border-border">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Pipeline Stats</h3>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-text-muted">Extracted:</span>{' '}
                  <span className="text-text-primary font-medium">{pipeline.staged.extractedCount}</span>
                </div>
                <div>
                  <span className="text-text-muted">Scored:</span>{' '}
                  <span className="text-text-primary font-medium">{pipeline.staged.scoredCount}</span>
                </div>
                <div>
                  <span className="text-text-muted">Rejected:</span>{' '}
                  <span className="text-text-primary font-medium">{pipeline.staged.rejectedCount}</span>
                </div>
                <div>
                  <span className="text-text-muted">Status:</span>{' '}
                  <span className="text-text-primary font-medium">{pipeline.staged.pipelineStatus}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
