import { CheckCircle2, AlertCircle, Clock, X } from 'lucide-react';
import type { ScrapeResult } from './types';

// ---------------------------------------------------------------------------
// Scrape result banner rendered inside a source card
// ---------------------------------------------------------------------------
export default function ScrapeResultBanner({ result, onDismiss, onShowError }: {
  result: ScrapeResult;
  onDismiss: () => void;
  onShowError?: () => void;
}) {
  const isSuccess = result.status === 'completed' && !result.noChanges;
  const isNoChange = result.status === 'completed' && result.noChanges;
  const isError = result.status !== 'completed';

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      {isSuccess && (
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-success font-medium flex items-center gap-1">
              <CheckCircle2 size={12} />
              Pipeline completed
            </p>
            <div className="flex gap-3 text-[11px] text-text-muted mt-1">
              {result.rulesCreated != null && (
                <span>Rules created: <span className="text-text-secondary font-medium">{result.rulesCreated}</span></span>
              )}
              {result.rulesUpdated != null && (
                <span>Rules updated: <span className="text-text-secondary font-medium">{result.rulesUpdated}</span></span>
              )}
              {result.durationMs != null && (
                <span>Duration: <span className="text-text-secondary font-medium">{(result.durationMs / 1000).toFixed(1)}s</span></span>
              )}
            </div>
          </div>
          <button onClick={onDismiss} className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition" title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      {isNoChange && (
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-info font-medium flex items-center gap-1">
              <Clock size={12} />
              No changes detected
            </p>
            {result.durationMs != null && (
              <p className="text-[11px] text-text-muted mt-1">
                Duration: <span className="text-text-secondary font-medium">{(result.durationMs / 1000).toFixed(1)}s</span>
              </p>
            )}
          </div>
          <button onClick={onDismiss} className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition" title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      {isError && (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-danger font-medium flex items-center gap-1">
              <AlertCircle size={12} />
              Pipeline failed{result.stepReached ? ` at step ${result.stepReached}` : ''}
            </p>
            {result.error && (
              <p className="text-[11px] text-danger/70 mt-1 truncate">{result.error}</p>
            )}
            {onShowError && (
              <button
                onClick={onShowError}
                className="text-[11px] text-danger font-medium underline underline-offset-2 hover:text-danger/80 transition mt-1"
              >
                View full error details
              </button>
            )}
          </div>
          <button onClick={onDismiss} className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition shrink-0" title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
