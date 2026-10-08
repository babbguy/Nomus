import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatRelative } from '../../lib/formatters';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Data-freshness stamp (never present stale data as current).
 *
 * Shows "Data as of {relative}" using the best available timestamp:
 * - `dataTimestamp`: a real timestamp from the API (computed/updated time of
 *   the underlying data). Preferred when available; also drives the stale
 *   badge — data older than 7 days gets an amber "Stale" marker.
 * - `fetchedAt`: when the fetch completed. Used as the display fallback and
 *   never used to infer staleness (a fresh fetch of old data is what's stale,
 *   not the fetch itself).
 */
export default function DataFreshness({
  fetchedAt,
  dataTimestamp,
  className = '',
}: {
  fetchedAt: string | null;
  dataTimestamp?: string | null;
  className?: string;
}) {
  // Capture "now" once on mount rather than reading the clock during render
  // (render must stay pure). The 7-day staleness threshold makes a mount-time
  // reference indistinguishable from a per-render one.
  const [now] = useState(() => Date.now());

  const valid = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    return Number.isNaN(new Date(iso).getTime()) ? null : iso;
  };
  const dataTs = valid(dataTimestamp);
  const shown = dataTs ?? valid(fetchedAt);
  if (!shown) return null;

  const isStale = dataTs !== null && now - new Date(dataTs).getTime() > STALE_THRESHOLD_MS;

  return (
    <div className={`flex items-center gap-2 text-xs text-text-muted ${className}`}>
      <span>Data as of {formatRelative(shown)}</span>
      {isStale && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
          <AlertTriangle size={11} /> Stale — over 7 days old
        </span>
      )}
    </div>
  );
}
