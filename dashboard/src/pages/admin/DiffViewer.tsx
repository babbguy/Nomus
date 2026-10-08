import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Minus, GitCompareArrows, Columns2, AlignJustify } from 'lucide-react';
import Card from '../../components/ui/Card';
import Spinner from '../../components/ui/Spinner';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import ErrorState from '../../components/ui/ErrorState';
import { getSourceDiff, getSourceSnapshots, type DiffResponse, type DiffSection, type SnapshotListItem } from '../../api/diffs';
import { formatDateTime } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

type ViewMode = 'unified' | 'side-by-side';

// ---------------------------------------------------------------------------
// Diff line component
// ---------------------------------------------------------------------------
function DiffLine({ section }: { section: DiffSection }) {
  const styles: Record<DiffSection['type'], string> = {
    added: 'bg-success/10 text-success border-l-2 border-success',
    removed: 'bg-danger/10 text-danger border-l-2 border-danger',
    context: 'text-text-secondary border-l-2 border-transparent',
  };

  const prefixes: Record<DiffSection['type'], string> = {
    added: '+',
    removed: '-',
    context: ' ',
  };

  return (
    <div className={`flex items-stretch font-mono text-xs ${styles[section.type]}`}>
      <span className="w-12 shrink-0 text-right pr-2 py-0.5 text-text-muted/60 select-none border-r border-border/30">
        {section.lineNumber}
      </span>
      <span className="w-5 shrink-0 text-center py-0.5 text-text-muted/60 select-none">
        {prefixes[section.type]}
      </span>
      <span className="py-0.5 pr-4 whitespace-pre-wrap break-all min-w-0">
        {section.content || '\u00A0'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side-by-side view
// ---------------------------------------------------------------------------
function SideBySideView({ sections }: { sections: DiffSection[] }) {
  const leftLines: (DiffSection | null)[] = [];
  const rightLines: (DiffSection | null)[] = [];

  let i = 0;
  while (i < sections.length) {
    const section = sections[i];

    if (section.type === 'context') {
      leftLines.push(section);
      rightLines.push(section);
      i++;
    } else if (section.type === 'removed') {
      const removedStart = i;
      while (i < sections.length && sections[i].type === 'removed') i++;
      const addedStart = i;
      while (i < sections.length && sections[i].type === 'added') i++;

      const removedCount = addedStart - removedStart;
      const addedCount = i - addedStart;
      const maxCount = Math.max(removedCount, addedCount);

      for (let k = 0; k < maxCount; k++) {
        leftLines.push(k < removedCount ? sections[removedStart + k] : null);
        rightLines.push(k < addedCount ? sections[addedStart + k] : null);
      }
    } else if (section.type === 'added') {
      leftLines.push(null);
      rightLines.push(section);
      i++;
    }
  }

  return (
    <div className="flex border border-border rounded-lg overflow-hidden">
      <div className="flex-1 min-w-0 border-r border-border">
        <div className="px-3 py-1.5 bg-danger/5 border-b border-border">
          <span className="text-[11px] font-medium text-danger/80">Previous</span>
        </div>
        <div className="divide-y divide-border/20">
          {leftLines.map((line, idx) => (
            <div key={idx}>
              {line ? <DiffLine section={line} /> : <div className="h-[22px] bg-surface-hover/30" />}
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="px-3 py-1.5 bg-success/5 border-b border-border">
          <span className="text-[11px] font-medium text-success/80">Current</span>
        </div>
        <div className="divide-y divide-border/20">
          {rightLines.map((line, idx) => (
            <div key={idx}>
              {line ? <DiffLine section={line} /> : <div className="h-[22px] bg-surface-hover/30" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified view
// ---------------------------------------------------------------------------
function UnifiedView({ sections }: { sections: DiffSection[] }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden divide-y divide-border/20">
      {sections.map((section, idx) => (
        <DiffLine key={idx} section={section} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------
function StatsBar({ diff }: { diff: DiffResponse }) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="flex items-center gap-1.5">
        <Plus size={14} className="text-success" />
        <span className="text-sm font-medium text-success">{diff.linesAdded}</span>
        <span className="text-xs text-text-muted">added</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Minus size={14} className="text-danger" />
        <span className="text-sm font-medium text-danger">{diff.linesRemoved}</span>
        <span className="text-xs text-text-muted">removed</span>
      </div>
      <div className="flex items-center gap-1.5">
        <GitCompareArrows size={14} className="text-accent" />
        <span className="text-sm font-medium text-accent">{diff.sectionsChanged}</span>
        <span className="text-xs text-text-muted">sections changed</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function DiffViewer() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('unified');
  const [selectedSnapshot, setSelectedSnapshot] = useState<string>(searchParams.get('snapshotId') ?? '');
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);

  // Clear a prior snapshot-list error during render whenever a new fetch is
  // triggered (source or selected-snapshot change), so the effect body sets no
  // state synchronously.
  const diffKey = `${sourceId ?? ''}|${selectedSnapshot}`;
  const [loadedDiff, setLoadedDiff] = useState(diffKey);
  if (loadedDiff !== diffKey) {
    setLoadedDiff(diffKey);
    setSnapshotsError(null);
  }

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;

    Promise.all([
      getSourceDiff(sourceId, selectedSnapshot || undefined).catch((err) => {
        if (cancelled) return null;
        const msg = err?.response?.data?.error ?? 'Failed to load diff';
        setError(msg);
        return null;
      }),
      getSourceSnapshots(sourceId).catch((err) => {
        if (!cancelled) {
          setSnapshotsError(apiErrorMessage(err, 'Failed to load snapshot list — snapshot picker unavailable'));
        }
        return null;
      }),
    ]).then(([diffData, snapshotsData]) => {
      if (cancelled) return;
      setDiff(diffData);
      if (snapshotsData) setSnapshots(snapshotsData.snapshots);
      if (diffData) setError(null);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [sourceId, selectedSnapshot]);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  if (error) {
    return (
      <div>
        <button onClick={() => navigate('/admin/sources')} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition mb-4">
          <ArrowLeft size={14} />
          Back to Sources
        </button>
        <Card>
          <div className="text-center py-12">
            <GitCompareArrows size={40} className="mx-auto mb-4 text-text-muted/40" />
            <p className="text-sm font-medium text-text-secondary">{error}</p>
            <p className="text-xs text-text-muted mt-1">This source needs at least 2 scrape snapshots to show a diff.</p>
          </div>
        </Card>
      </div>
    );
  }

  if (!diff) return null;

  const hasChanges = diff.sections.length > 0;

  return (
    <div>
      {snapshotsError && <ErrorState compact message={snapshotsError} />}

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <button onClick={() => navigate('/admin/sources')} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition mb-2">
            <ArrowLeft size={14} />
            Back to Sources
          </button>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <GitCompareArrows size={20} className="text-accent" />
            {diff.sourceName}
          </h1>
          <div className="flex items-center gap-2 mt-1.5">
            <JurisdictionTag code={diff.jurisdiction} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('unified')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition ${
                viewMode === 'unified'
                  ? 'bg-accent-dim text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              <AlignJustify size={12} />
              Unified
            </button>
            <button
              onClick={() => setViewMode('side-by-side')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition border-l border-border ${
                viewMode === 'side-by-side'
                  ? 'bg-accent-dim text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              <Columns2 size={12} />
              Side by Side
            </button>
          </div>
        </div>
      </div>

      {/* Snapshot info + stats */}
      <Card className="mb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Previous</p>
              <p className="text-sm text-text-primary">{formatDateTime(diff.previousSnapshot.date)}</p>
              <p className="text-[11px] text-text-muted font-mono">{diff.previousSnapshot.hash.slice(0, 12)}</p>
            </div>
            <GitCompareArrows size={18} className="text-text-muted" />
            <div>
              <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Current</p>
              <p className="text-sm text-text-primary">{formatDateTime(diff.currentSnapshot.date)}</p>
              <p className="text-[11px] text-text-muted font-mono">{diff.currentSnapshot.hash.slice(0, 12)}</p>
            </div>
          </div>
          <StatsBar diff={diff} />
        </div>

        {snapshots.length > 2 && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <label className="text-[11px] uppercase tracking-wider text-text-muted mb-1 block">Compare snapshot</label>
            <select
              value={selectedSnapshot}
              onChange={(e) => setSelectedSnapshot(e.target.value)}
              className="px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-primary focus:border-accent focus:ring-1 focus:ring-accent/50 outline-none transition"
            >
              <option value="">Latest</option>
              {/* The oldest snapshot has nothing before it to compare with (the API
                  answers 400), so it is not offered. Snapshots are newest first. */}
              {snapshots.slice(0, -1).map((snap) => (
                <option key={snap.id} value={snap.id}>
                  {formatDateTime(snap.scrapedAt)} ({snap.contentHash.slice(0, 8)})
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>

      {/* Diff content */}
      {hasChanges ? (
        <div className="overflow-x-auto">
          {viewMode === 'unified' ? (
            <UnifiedView sections={diff.sections} />
          ) : (
            <SideBySideView sections={diff.sections} />
          )}
        </div>
      ) : (
        <Card>
          <div className="text-center py-12">
            <GitCompareArrows size={40} className="mx-auto mb-4 text-text-muted/40" />
            <p className="text-sm font-medium text-text-secondary">No differences found</p>
            <p className="text-xs text-text-muted mt-1">The two snapshots have identical content.</p>
          </div>
        </Card>
      )}
    </div>
  );
}
