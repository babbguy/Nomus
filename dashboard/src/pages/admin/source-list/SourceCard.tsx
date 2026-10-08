import {
  Play, FileText, Pencil, Trash2, X, Loader2, Upload, GitCompareArrows, Eye,
  CheckCircle2, AlertCircle, Clock, ShieldCheck, ShieldAlert, ListChecks, RotateCcw,
} from 'lucide-react';
import Card from '../../../components/ui/Card';
import Button from '../../../components/ui/Button';
import Badge from '../../../components/ui/Badge';
import JurisdictionTag from '../../../components/domain/JurisdictionTag';
import { formatRelative } from '../../../lib/formatters';
import type { RegulatorySource } from '../../../api/sources';
import type { PipelineProgress } from '../../../stores/pipelineStore';
import { ORIGIN_LABELS, type ScrapeResult } from './types';
import InlineProgress from './InlineProgress';
import ScrapeResultBanner from './ScrapeResultBanner';
import AuditIndicator from './AuditIndicator';
import UploadDropZone from './UploadDropZone';

// ---------------------------------------------------------------------------
// A single regulatory source card
// ---------------------------------------------------------------------------
export default function SourceCard({
  source,
  progress,
  result,
  isScraping,
  isScrapeActive,
  isEditing,
  editForm,
  registerFileInput,
  onNavigate,
  onToggle,
  onUploadClick,
  onFileChange,
  onEditToggle,
  onDelete,
  onRestoreDefaults,
  onScrape,
  onReload,
  onDismissResult,
  onShowError,
}: {
  source: RegulatorySource;
  progress: PipelineProgress | null;
  result: ScrapeResult | undefined;
  isScraping: boolean;
  isScrapeActive: boolean;
  isEditing: boolean;
  editForm: React.ReactNode;
  registerFileInput: (sourceId: string, el: HTMLInputElement | null) => void;
  onNavigate: (path: string) => void;
  onToggle: (id: string, isActive: boolean) => void;
  onUploadClick: (id: string) => void;
  onFileChange: (id: string, e: React.ChangeEvent<HTMLInputElement>) => void;
  onEditToggle: () => void;
  onDelete: (id: string, name: string) => void;
  onRestoreDefaults: (id: string, name: string) => void;
  onScrape: (id: string) => void;
  onReload: () => void;
  onDismissResult: (id: string) => void;
  onShowError: (source: RegulatorySource, error: string, stepReached?: number) => void;
}) {
  const isThisInProgress = isScraping || (progress != null && progress.step < 4);
  const isFirstScrape = !source.lastScrapedAt;
  const pendingFile = (source as unknown as { pendingUploadFile?: string | null }).pendingUploadFile ?? null;
  const hasPendingUpload = !!pendingFile;
  const isManual = (source.ingestionMode ?? 'auto') === 'manual';
  const origin = source.origin ? ORIGIN_LABELS[source.origin] : null;

  return (
    <div>
      {/* Inline edit form — appears right above the card being edited */}
      {isEditing && <div className="mb-2">{editForm}</div>}

      <Card className={
        isEditing ? 'border border-accent/20 opacity-60'
        : progress && progress.step < 4 ? 'border border-accent/30'
        : (source.consecutiveFailures ?? 0) >= 2 ? 'border border-danger/30'
        : ''
      }>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <div className={`p-2 rounded-lg mt-0.5 ${
              (source.consecutiveFailures ?? 0) >= 2 ? 'bg-danger/10'
              : source.auditResult?.overallVerdict === 'pass' ? 'bg-success/10'
              : source.lastScrapedAt ? 'bg-success/10'
              : 'bg-surface-hover'
            }`}>
              {(source.consecutiveFailures ?? 0) >= 2
                ? <AlertCircle size={16} className="text-danger" />
                : source.auditResult?.overallVerdict === 'pass'
                  ? <ShieldCheck size={16} className="text-success" />
                  : source.auditResult
                    ? <ShieldAlert size={16} className="text-warning" />
                    : source.lastScrapedAt
                      ? <CheckCircle2 size={16} className="text-success" />
                      : <Clock size={16} className="text-text-muted" />
              }
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">{source.name}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <JurisdictionTag code={source.jurisdiction} />
                <button
                  onClick={() => onToggle(source.id, source.isActive)}
                  title={source.isActive
                    ? 'Click to deactivate: the source stops being scraped and its rules stop applying'
                    : 'Click to reactivate: rules retired by deactivating this source apply again'}
                >
                  <Badge variant={source.isActive ? 'success' : 'default'}>
                    {source.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </button>
                {origin && (
                  <span title={origin.hint}>
                    <Badge variant={origin.variant}>{origin.label}</Badge>
                  </span>
                )}
                <Badge variant={isManual ? 'warning' : 'info'}>
                  {isManual ? 'MANUAL' : 'AUTO'}
                </Badge>
                <Badge variant="default">{source.parserType.toUpperCase()}</Badge>
                {source.contentVerification === 'verified' && (
                  <Badge variant="success" className="flex items-center gap-1">
                    <ShieldCheck size={10} /> Verified
                  </Badge>
                )}
                {source.contentVerification === 'cleaned' && (
                  <Badge variant="warning" className="flex items-center gap-1">
                    <ShieldAlert size={10} /> Auto-fixed
                  </Badge>
                )}
                {source.contentVerification === 'failed' && (
                  <Badge variant="danger" className="flex items-center gap-1">
                    <AlertCircle size={10} /> Failed
                  </Badge>
                )}
              </div>
              <p className="text-xs text-text-muted mt-1.5 truncate">{source.url}</p>
              {hasPendingUpload ? (
                <p className="text-xs text-accent mt-0.5 flex items-center gap-1">
                  <Upload size={10} />
                  File ready: <span className="font-medium">{pendingFile}</span>
                  <span className="text-text-muted">— click "Process File" to extract rules</span>
                </p>
              ) : (
                <p className="text-xs text-text-muted mt-0.5">
                  {source.lastScrapedAt ? `Last scraped ${formatRelative(source.lastScrapedAt)}` : 'Never scraped'}
                  {!isManual && <>{' · '}Every {source.scrapeFrequencyHours}h</>}
                </p>
              )}
              {/* Consecutive failure warning */}
              {(source.consecutiveFailures ?? 0) >= 2 && (
                <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded-md bg-danger/10 border border-danger/20">
                  <AlertCircle size={12} className="text-danger shrink-0" />
                  <span className="text-[11px] text-danger font-medium">
                    Failed {source.consecutiveFailures}x consecutively
                  </span>
                  <span className="text-[11px] text-danger/70">—</span>
                  <button
                    onClick={() => {
                      const connErr = (source as unknown as { connectivityError?: string }).connectivityError;
                      onShowError(
                        source,
                        connErr || `Source has failed ${source.consecutiveFailures} consecutive times. The URL may be unreachable, blocked, or returning invalid content.`,
                      );
                    }}
                    className="text-[11px] text-danger font-medium underline underline-offset-2 hover:text-danger/80 transition"
                  >
                    View error
                  </button>
                  <span className="text-[11px] text-danger/70">|</span>
                  <button
                    onClick={() => onUploadClick(source.id)}
                    className="text-[11px] text-danger font-medium underline underline-offset-2 hover:text-danger/80 transition"
                  >
                    Upload manually
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Audit / Inspect button */}
            <button
              onClick={() => onNavigate(`/admin/sources/${source.id}`)}
              className="p-1.5 rounded-lg hover:bg-surface-overlay hover:border-border-bright text-text-muted hover:text-accent active:scale-[0.98] transition"
              title="View regulation text & extracted rules"
            >
              <Eye size={14} />
            </button>
            {/* Rules button */}
            <button
              onClick={() => onNavigate(`/admin/sources/${source.id}/rules`)}
              className="p-1.5 rounded-lg hover:bg-surface-overlay hover:border-border-bright text-text-muted hover:text-accent active:scale-[0.98] transition"
              title="Manage rules"
            >
              <ListChecks size={14} />
            </button>
            {/* Restore built-in defaults (edited built-in sources only) */}
            {source.origin === 'customized' && (
              <button
                onClick={() => onRestoreDefaults(source.id, source.name)}
                className="p-1.5 rounded-lg hover:bg-surface-overlay hover:border-border-bright text-text-muted hover:text-warning active:scale-[0.98] transition"
                title="Restore built-in defaults"
              >
                <RotateCcw size={14} />
              </button>
            )}
            {/* Diff viewer button */}
            {source.lastScrapedAt && (
              <button
                onClick={() => onNavigate(`/admin/diffs/${source.id}`)}
                className="p-1.5 rounded-lg hover:bg-surface-overlay hover:border-border-bright text-text-muted hover:text-accent active:scale-[0.98] transition"
                title="View regulation diff"
              >
                <GitCompareArrows size={14} />
              </button>
            )}
            {/* Upload button (for auto sources, small icon; manual sources use drop zone below) */}
            {!isManual && (
              <>
                <button
                  onClick={() => onUploadClick(source.id)}
                  className="p-1.5 rounded-lg hover:bg-surface-overlay hover:border-border-bright text-text-muted hover:text-text-primary active:scale-[0.98] transition"
                  title="Upload file"
                >
                  <Upload size={14} />
                </button>
                <input
                  ref={(el) => { registerFileInput(source.id, el); }}
                  type="file"
                  accept=".html,.htm,.pdf,.txt"
                  className="hidden"
                  onChange={(e) => onFileChange(source.id, e)}
                />
              </>
            )}
            {/* Edit button */}
            <button
              onClick={onEditToggle}
              className={`p-1.5 rounded-lg hover:bg-surface-overlay hover:border-border-bright active:scale-[0.98] transition ${
                isEditing ? 'text-accent bg-accent-dim' : 'text-text-muted hover:text-text-primary'
              }`}
              title={isEditing ? 'Cancel edit' : 'Edit'}
            >
              {isEditing ? <X size={14} /> : <Pencil size={14} />}
            </button>
            {/* Deactivate (active sources) or reactivate (inactive sources) */}
            {source.isActive ? (
              <button
                onClick={() => onDelete(source.id, source.name)}
                className="p-1.5 rounded-lg hover:bg-danger/10 text-text-muted hover:text-danger active:scale-[0.98] transition"
                title="Deactivate (its rules stop applying)"
              >
                <Trash2 size={14} />
              </button>
            ) : (
              <button
                onClick={() => onToggle(source.id, source.isActive)}
                className="p-1.5 rounded-lg hover:bg-success/10 text-text-muted hover:text-success active:scale-[0.98] transition"
                title="Reactivate (rules retired by deactivating it apply again)"
              >
                <RotateCcw size={14} />
              </button>
            )}
            {/* Scrape / Process File button (auto sources & pending uploads) */}
            {(!isManual || hasPendingUpload) && (
              <Button
                variant={hasPendingUpload ? 'primary' : 'secondary'}
                onClick={() => onScrape(source.id)}
                disabled={isScrapeActive}
                className="text-xs ml-1"
              >
                {isThisInProgress ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Processing...
                  </>
                ) : hasPendingUpload ? (
                  <>
                    <FileText size={12} />
                    Process File
                  </>
                ) : (
                  <>
                    <Play size={12} />
                    Scrape
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Upload drop zone for manual sources (always visible) */}
        {isManual && !hasPendingUpload && (
          <UploadDropZone sourceId={source.id} onUploaded={onReload} />
        )}

        {/* Manual source: hidden file input for the "Upload manually" link */}
        {isManual && (
          <input
            ref={(el) => { registerFileInput(source.id, el); }}
            type="file"
            accept=".html,.htm,.pdf,.txt"
            className="hidden"
            onChange={(e) => onFileChange(source.id, e)}
          />
        )}

        {/* Inline pipeline progress */}
        {progress && (
          <InlineProgress progress={progress} isFirstScrape={isFirstScrape} />
        )}

        {/* Scrape result (shown after pipeline SSE progress has cleared) */}
        {result && !progress && (
          <ScrapeResultBanner
            result={result}
            onDismiss={() => onDismissResult(source.id)}
            onShowError={result.error ? () => onShowError(source, result.error!, result.stepReached) : undefined}
          />
        )}

        {/* Audit quality indicator */}
        <AuditIndicator audit={source.auditResult} />
      </Card>
    </div>
  );
}
