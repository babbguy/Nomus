import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Visible load-failure state (warnings over silence).
 *
 * Renders an unmistakable "this is a load failure, not empty data" block.
 * Use this — never EmptyState — whenever a fetch failed. EmptyState is
 * reserved for genuine emptiness (the request succeeded and returned zero
 * records).
 *
 * - Default: full-height block for page/card bodies (mirrors EmptyState's
 *   footprint so swapping states does not shift layout).
 * - `compact`: single-row inline variant for secondary panels/widgets.
 */
export default function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const text = message || 'Failed to load data.';

  if (compact) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-danger" role="alert">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="min-w-0">{text}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-accent transition shrink-0"
          >
            <RefreshCw size={12} /> Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3" role="alert">
      <AlertTriangle size={40} className="text-danger opacity-60" />
      <p className="text-sm font-medium text-danger">{text}</p>
      <p className="text-xs text-text-muted">This is a load failure — data may exist but could not be retrieved.</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition flex items-center gap-2"
        >
          <RefreshCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}
