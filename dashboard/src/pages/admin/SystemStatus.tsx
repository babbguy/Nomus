import { Fragment, useEffect, useState, useCallback } from 'react';
import { Server, ChevronDown, ChevronUp } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface SourceHealth {
  name: string;
  jurisdiction: string;
  lastRunStatus: string;
  lastRunAt: string | null;
  lastError: string | null;
}

interface RecentError {
  sourceName: string;
  stepReached: number;
  completedAt: string;
  errorMessage: string;
}

interface StatusData {
  server: {
    uptimeSeconds: number;
    memoryMB: { rss: number; heapUsed: number; heapTotal: number };
    nodeVersion: string;
  };
  sseClients: number | unknown[];
  sources: SourceHealth[];
  recentErrors: RecentError[];
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const statusColors: Record<string, string> = {
  completed: 'bg-success/15 text-success',
  no_change: 'bg-accent/15 text-accent',
  // Pipeline run statuses as the engine records them (it never writes
  // 'failed' or 'running'; errors were shown in neutral grey).
  typo_only: 'bg-accent/15 text-accent',
  error: 'bg-danger/15 text-danger',
  failed: 'bg-danger/15 text-danger',
  running: 'bg-warning/15 text-warning',
};

export default function SystemStatus() {
  const [data, setData] = useState<StatusData | null>(null);
  const [expandedSource, setExpandedSource] = useState<number | null>(null);
  const [expandedError, setExpandedError] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get('/admin/status')
      .then((r) => {
        setData(r.data);
        setLoadError(null);
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load system status')));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  if (!data) {
    if (loadError) {
      return <ErrorState message={loadError} onRetry={load} />;
    }
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 animate-page">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim text-accent">
          <Server size={20} />
        </div>
        <h1 className="text-xl font-semibold text-text-primary">System Status</h1>
      </div>

      {loadError && (
        <ErrorState compact message={`${loadError} — the data below may be stale.`} onRetry={load} />
      )}

      {/* Sources Health + Server + SSE in 3-col row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Sources Health — spans 2 cols */}
        <div className="glass rounded-xl p-5 md:col-span-2">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Sources Health</h2>
        <div className="max-h-tile overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-muted text-xs border-b border-border">
                <th className="text-left py-2 font-medium">Source</th>
                <th className="text-left py-2 font-medium">Jurisdiction</th>
                <th className="text-left py-2 font-medium">Status</th>
                <th className="text-left py-2 font-medium">Last Run</th>
                <th className="text-left py-2 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s, i) => (
                <Fragment key={i}>
                  <tr className="border-b border-border/50 last:border-0">
                    <td className="py-2 text-text-primary">{s.name}</td>
                    <td className="py-2 text-text-secondary">{s.jurisdiction}</td>
                    <td className="py-2">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${statusColors[s.lastRunStatus] || 'bg-surface-hover text-text-muted'}`}>
                        {s.lastRunStatus || 'never'}
                      </span>
                    </td>
                    <td className="py-2 text-text-muted">
                      {s.lastRunAt ? timeAgo(s.lastRunAt) : 'never'}
                    </td>
                    <td className="py-2">
                      {s.lastError && (
                        <button
                          onClick={() => setExpandedSource(expandedSource === i ? null : i)}
                          className="text-text-muted hover:text-text-primary transition"
                        >
                          {expandedSource === i ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedSource === i && s.lastError && (
                    <tr key={`${i}-err`}>
                      <td colSpan={5} className="py-2 px-4">
                        <pre className="text-xs text-danger bg-danger/5 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                          {s.lastError}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        </div>

        {/* Server + SSE stacked in 1 col */}
        <div className="flex flex-col gap-4">
          <div className="glass rounded-xl p-5">
            <h2 className="text-sm font-semibold text-text-secondary mb-3">Server</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Uptime</span>
                <span className="text-text-primary">{formatUptime(data.server.uptimeSeconds)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Memory (RSS)</span>
                <span className="text-text-primary">{data.server.memoryMB.rss} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Memory (Heap)</span>
                <span className="text-text-primary">{data.server.memoryMB.heapUsed} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Node Version</span>
                <span className="text-text-primary">{data.server.nodeVersion}</span>
              </div>
            </div>
          </div>

          <div className="glass rounded-xl p-5">
            <h2 className="text-sm font-semibold text-text-secondary mb-3">SSE Connections</h2>
            <p className="text-3xl font-semibold text-text-primary">{Array.isArray(data.sseClients) ? data.sseClients.length : data.sseClients}</p>
            <p className="text-xs text-text-muted mt-1">Connected clients</p>
          </div>
        </div>
      </div>

      {/* Recent Errors */}
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Recent Errors</h2>
        <div className="max-h-tile overflow-y-auto">
          {data.recentErrors.length === 0 ? (
            <p className="text-sm text-text-muted">No recent errors.</p>
          ) : (
            <div className="space-y-2">
              {data.recentErrors.map((e, i) => (
                <div key={i} className="border border-border/50 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-text-primary">{e.sourceName}</span>
                      <span className="text-xs text-text-muted px-2 py-0.5 bg-surface-hover rounded">
                        Step {e.stepReached}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted">{e.completedAt ? timeAgo(e.completedAt) : ''}</span>
                      <button
                        onClick={() => setExpandedError(expandedError === i ? null : i)}
                        className="text-text-muted hover:text-text-primary transition"
                      >
                        {expandedError === i ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    </div>
                  </div>
                  {expandedError === i && (
                    <pre className="text-xs text-danger bg-danger/5 rounded-lg p-3 mt-2 overflow-x-auto whitespace-pre-wrap">
                      {e.errorMessage}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
