import { Loader2, Zap } from 'lucide-react';
import Card from '../../../components/ui/Card';
import type { PipelineProgress } from '../../../stores/pipelineStore';

// ---------------------------------------------------------------------------
// Scrape All progress banner
// ---------------------------------------------------------------------------
export default function ScrapeAllBanner({ isRunning, progress, sourceName }: {
  isRunning: boolean;
  progress: PipelineProgress | null;
  sourceName?: string;
}) {
  if (!isRunning) return null;

  return (
    <Card className="mb-4 border border-accent/30">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-accent-dim">
          <Zap size={16} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            Scraping all auto sources...
          </p>
          {progress && sourceName && (
            <p className="text-xs text-text-muted mt-0.5">
              Currently processing: <span className="text-text-secondary font-medium">{sourceName}</span>
              {!progress.done && ` — Step ${progress.step}/5`}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
