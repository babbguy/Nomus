import { useEffect, useState } from 'react';
import { Eye, Check, X, ExternalLink } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import ErrorState from '../../components/ui/ErrorState';
import { getItems, getStats, acceptItem, rejectItem, bulkReview, type ScoutItem, type ScoutStats } from '../../api/scout';
import { formatDateTime } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

const STATUS_TABS = ['pending', 'auto_promoted', 'accepted', 'rejected'] as const;

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-danger';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-surface-hover rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-text-muted">{pct}%</span>
    </div>
  );
}

export default function ScoutReview() {
  const [items, setItems] = useState<ScoutItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [stats, setStats] = useState<ScoutStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  function load() {
    setLoading(true);
    setRetryKey((k) => k + 1);
  }

  // Clear a prior load error during render when the tab changes or a retry is
  // requested, so the effect body sets no state synchronously.
  const reviewKey = `${activeTab}|${retryKey}`;
  const [loadedReview, setLoadedReview] = useState(reviewKey);
  if (loadedReview !== reviewKey) {
    setLoadedReview(reviewKey);
    setLoadError(null);
  }

  useEffect(() => {
    Promise.all([
      getItems({ status: activeTab, limit: 100 }),
      getStats(),
    ]).then(([itemsRes, statsRes]) => {
      setItems(itemsRes.items);
      setTotalItems(itemsRes.total ?? itemsRes.items.length);
      setStats(statsRes);
      setSelected(new Set());
      setLoading(false);
    }).catch((err) => {
      setLoadError(apiErrorMessage(err, 'Failed to load Scout items'));
      setLoading(false);
    });
  }, [activeTab, retryKey]);

  async function handleAccept(id: string) {
    setActionError(null);
    try {
      await acceptItem(id);
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to accept item'));
    }
  }

  async function handleReject(id: string) {
    setActionError(null);
    try {
      await rejectItem(id);
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to reject item'));
    }
  }

  async function handleBulkAccept() {
    if (selected.size === 0) return;
    setActionError(null);
    try {
      await bulkReview('accept', Array.from(selected));
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to bulk-accept items'));
    }
  }

  async function handleBulkReject() {
    if (selected.size === 0) return;
    setActionError(null);
    try {
      await bulkReview('reject', Array.from(selected));
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to bulk-reject items'));
    }
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((i) => i.id)));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-dim">
            <Eye size={20} className="text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary">Scout Review</h1>
        </div>
        {stats && (
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <span>{stats.activeFeeds} feeds</span>
            <span>{stats.itemsByStatus['pending'] ?? 0} pending</span>
            <span>{stats.itemsByStatus['auto_promoted'] ?? 0} auto-promoted</span>
            <span>${((stats.monthlyLlmCostCents ?? 0) / 100).toFixed(2)}/mo LLM</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-2 text-sm border-b-2 transition ${
              activeTab === tab
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {tab.replace('_', ' ')}
            {stats?.itemsByStatus[tab] ? ` (${stats.itemsByStatus[tab]})` : ''}
          </button>
        ))}
      </div>

      {/* Bulk actions */}
      {activeTab === 'pending' && items.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
            <input type="checkbox" checked={selected.size === items.length && items.length > 0} onChange={toggleAll}
              className="rounded border-border" />
            Select all ({items.length}){totalItems > items.length ? ` · showing the newest ${items.length} of ${totalItems}` : ''}
          </label>
          {selected.size > 0 && (
            <>
              <Button variant="ghost" onClick={handleBulkAccept} className="text-xs text-success">
                <Check size={12} /> Accept {selected.size}
              </Button>
              <Button variant="ghost" onClick={handleBulkReject} className="text-xs text-danger">
                <X size={12} /> Reject {selected.size}
              </Button>
            </>
          )}
        </div>
      )}

      {actionError && <ErrorState compact message={actionError} />}

      {loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : items.length === 0 ? (
        <EmptyState title={`No ${activeTab.replace('_', ' ')} items`} description="Scout items will appear here as feeds are processed." />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id}>
              <div className="flex items-start gap-3">
                {activeTab === 'pending' && (
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)}
                    className="mt-1 rounded border-border" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a href={item.url} target="_blank" rel="noopener noreferrer"
                      className="text-sm font-medium text-text-primary hover:text-accent transition flex items-center gap-1">
                      {item.title} <ExternalLink size={12} />
                    </a>
                  </div>

                  {item.rawSnippet && (
                    <p className="text-xs text-text-secondary mt-1 line-clamp-2">{item.rawSnippet}</p>
                  )}

                  {item.extractedSignal && (
                    <div className="mt-2 p-2 bg-surface-hover rounded-lg">
                      <p className="text-xs font-medium text-text-primary">{item.extractedSignal.title}</p>
                      <p className="text-xs text-text-secondary mt-0.5">{item.extractedSignal.summary}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <JurisdictionTag code={item.extractedSignal.jurisdiction} />
                        <Badge variant="accent">{item.extractedSignal.stage}</Badge>
                        <span className="text-xs text-text-muted">{item.extractedSignal.likelihoodPercent}% likely</span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3 mt-2">
                    {item.keywordScore !== null && (
                      <span className="text-xs text-text-muted">KW: {Math.round(item.keywordScore * 100)}%</span>
                    )}
                    <ConfidenceBar value={item.confidenceScore} />
                    {item.publishedAt && (
                      <span className="text-xs text-text-muted">{formatDateTime(item.publishedAt)}</span>
                    )}
                    <Badge variant={
                      item.status === 'auto_promoted' ? 'success' :
                      item.status === 'accepted' ? 'success' :
                      item.status === 'rejected' ? 'danger' : 'accent'
                    }>{item.status.replace('_', ' ')}</Badge>
                  </div>
                </div>

                {activeTab === 'pending' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => handleAccept(item.id)}
                      className="p-1.5 rounded text-success hover:bg-success/10 transition" title="Accept → Radar">
                      <Check size={16} />
                    </button>
                    <button onClick={() => handleReject(item.id)}
                      className="p-1.5 rounded text-danger hover:bg-danger/10 transition" title="Reject">
                      <X size={16} />
                    </button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
