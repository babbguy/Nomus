import { useEffect, useState } from 'react';
import { Radar as RadarIcon, ExternalLink } from 'lucide-react';

import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import DataFreshness from '../../components/ui/DataFreshness';
import { getSignals, type RegulatorySignal } from '../../api/radar';
import { formatDate } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

function latestTimestamp(items: Array<{ updatedAt?: string }>): string | null {
  return items.reduce<string | null>((max, item) => {
    const ts = item.updatedAt;
    if (!ts || Number.isNaN(new Date(ts).getTime())) return max;
    return !max || new Date(ts) > new Date(max) ? ts : max;
  }, null);
}

const STAGES = ['signal', 'draft', 'committee', 'adopted', 'active'] as const;

const stageConfig: Record<string, { label: string; color: string; bg: string }> = {
  signal: { label: 'Signal', color: 'text-text-muted', bg: 'bg-surface-hover' },
  draft: { label: 'Draft Bill', color: 'text-info', bg: 'bg-info/15' },
  committee: { label: 'Committee', color: 'text-warning', bg: 'bg-warning/15' },
  adopted: { label: 'Adopted', color: 'text-accent', bg: 'bg-accent-dim' },
  active: { label: 'Active Law', color: 'text-success', bg: 'bg-success/15' },
};

function SignalCard({ signal }: { signal: RegulatorySignal }) {
  return (
    <div className="p-3 rounded-lg bg-surface border border-border hover:border-border-bright transition">
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-sm font-medium text-text-primary leading-snug">{signal.title}</p>
        {signal.sourceUrl && (
          <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer"
             className="text-text-muted hover:text-accent transition shrink-0">
            <ExternalLink size={12} />
          </a>
        )}
      </div>
      <p className="text-xs text-text-secondary mb-2 line-clamp-2">{signal.summary}</p>
      <div className="flex items-center justify-between">
        <JurisdictionTag code={signal.jurisdiction} />
        <div className="flex items-center gap-2">
          {signal.likelihoodPercent > 0 && (
            <span className="text-[10px] text-text-muted">{signal.likelihoodPercent}% likely</span>
          )}
          {signal.expectedEffectiveDate && (
            <span className="text-[10px] text-text-muted">~{formatDate(signal.expectedEffectiveDate)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Radar() {
  const [signals, setSignals] = useState<RegulatorySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  function fetchSignals() {
    getSignals()
      .then((r) => {
        setSignals(r.signals);
        setFetchedAt(new Date().toISOString());
        setLoading(false);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load radar signals.'));
        setLoading(false);
      });
  }

  function load() {
    setLoading(true);
    setError(null);
    fetchSignals();
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center py-20 gap-3">
        <p className="text-sm text-danger">{error}</p>
        <button onClick={load} className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition">Retry</button>
      </div>
    );
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  const byStage = STAGES.reduce((acc, stage) => {
    acc[stage] = signals.filter((s) => s.stage === stage);
    return acc;
  }, {} as Record<string, RegulatorySignal[]>);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <RadarIcon size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Regulatory Radar</h1>
          <p className="text-sm text-text-secondary">Track upcoming AI regulations before they become law</p>
          <DataFreshness fetchedAt={fetchedAt} dataTimestamp={latestTimestamp(signals)} className="mt-1" />
        </div>
      </div>

      {signals.length === 0 ? (
        <EmptyState title="No regulatory signals yet" description="Signals will appear here as upcoming regulations are detected." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {STAGES.map((stage) => {
            const config = stageConfig[stage];
            const stageSignals = byStage[stage];
            return (
              <div key={stage}>
                <div className={`flex items-center gap-2 mb-3 px-2`}>
                  <div className={`w-2 h-2 rounded-full ${config.bg} border ${config.color}`} />
                  <span className={`text-xs font-semibold uppercase tracking-wider ${config.color}`}>
                    {config.label}
                  </span>
                  <Badge variant="default">{stageSignals.length}</Badge>
                </div>
                <div className="space-y-2">
                  {stageSignals.map((s) => (
                    <SignalCard key={s.id} signal={s} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
