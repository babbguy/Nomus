import { CheckCircle2, Loader2 } from 'lucide-react';
import type { PipelineProgress } from '../../../stores/pipelineStore';

// ---------------------------------------------------------------------------
// Progress description helper
// ---------------------------------------------------------------------------
function getProgressDescription(p: PipelineProgress, isFirstScrape: boolean): string {
  if (p.step === 1) return 'Fetching regulatory source content...';
  if (p.step === 2) return isFirstScrape
    ? 'First scrape — processing full content...'
    : 'Analyzing content changes...';
  if (p.step === 3) {
    if (p.stepName?.includes('Scoring') || p.candidateRules) {
      return `Scoring ${p.candidateRules ?? ''} candidate rules...`;
    }
    if (p.batch && p.totalBatches) {
      return `Extracting requirements — chunk ${p.batch} of ${p.totalBatches} (each takes ~10s)...`;
    }
    return `Chunking content into processable segments (${p.chunks ?? '...'} chunks)...`;
  }
  if (p.step === 4) {
    const parts: string[] = ['Complete'];
    if (p.rulesCreated != null) parts.push(`${p.rulesCreated} rules created`);
    if (p.rulesUpdated != null) parts.push(`${p.rulesUpdated} updated`);
    return parts.join(' — ');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Inline progress bar rendered inside a source card
// ---------------------------------------------------------------------------
export default function InlineProgress({ progress, isFirstScrape }: { progress: PipelineProgress; isFirstScrape: boolean }) {
  const isComplete = progress.step === 4;
  const percent = progress.percentComplete ?? (progress.step / 4 * 100);

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      {/* Description */}
      <p className={`text-xs ${isComplete ? 'text-success' : 'text-accent'} mb-1.5`}>
        {isComplete
          ? <CheckCircle2 size={12} className="inline -mt-0.5 mr-1" />
          : <Loader2 size={12} className="inline -mt-0.5 mr-1 animate-spin" />}
        {getProgressDescription(progress, isFirstScrape)}
      </p>

      {/* Bar */}
      <div className="w-full h-1.5 bg-surface-hover rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${isComplete ? 'bg-success' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-text-muted mt-1.5">
        {progress.batch != null && progress.totalBatches != null && (
          <span>Batch: <span className="text-text-secondary font-medium">{progress.batch}/{progress.totalBatches}</span></span>
        )}
        {progress.chunks != null && progress.chunks > 0 && (
          <span>Chunks: <span className="text-text-secondary font-medium">{progress.chunks}</span></span>
        )}
        {progress.requirementsSoFar != null && progress.requirementsSoFar > 0 && (
          <span>Requirements: <span className="text-text-secondary font-medium">{progress.requirementsSoFar}</span></span>
        )}
        {progress.rulesCreated != null && (
          <span>Created: <span className="text-success font-medium">{progress.rulesCreated}</span></span>
        )}
        {progress.rulesUpdated != null && (
          <span>Updated: <span className="text-accent font-medium">{progress.rulesUpdated}</span></span>
        )}
        {progress.durationMs != null && (
          <span>Duration: <span className="text-text-secondary font-medium">{(progress.durationMs / 1000).toFixed(1)}s</span></span>
        )}
      </div>
    </div>
  );
}
