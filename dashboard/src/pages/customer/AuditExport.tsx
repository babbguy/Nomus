import { useState, useEffect } from 'react';
import { FileText, FileJson, Filter, Loader2, ClipboardCheck } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage, blobApiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface AuditEntry {
  timestamp: string;
  type: string;
  action: string;
  result: string;
  jurisdiction: string | null;
  details: string;
}

const TYPE_COLORS: Record<string, string> = {
  attestation: 'bg-accent/15 text-accent',
  scan: 'bg-warning/15 text-warning',
  score: 'bg-success/15 text-success',
};

export default function AuditExport() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  // Per-type totals for the filters (the cards counted the visible page only).
  const [totals, setTotals] = useState<{ attestation: number; scan: number; score: number } | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // Clear a prior load error during render whenever a new fetch is triggered
  // (filter change or retry), keeping the effect body free of synchronous
  // state updates.
  const exportKey = `${typeFilter}|${since}|${until}|${retryKey}`;
  const [loadedExport, setLoadedExport] = useState(exportKey);
  if (loadedExport !== exportKey) {
    setLoadedExport(exportKey);
    setLoadError(null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (typeFilter) params.set('type', typeFilter);
        if (since) params.set('since', new Date(since).toISOString());
        if (until) params.set('until', `${until}T23:59:59.999Z`);
        params.set('limit', '200');
        const r = await api.get(`/audit-export?${params}`);
        if (!cancelled) {
          setEntries(r.data.entries);
          setTotals(r.data.totals ?? null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(apiErrorMessage(err, 'Failed to load audit log'));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [typeFilter, since, until, retryKey]);

  async function handleExport(format: 'csv' | 'json') {
    setExporting(format);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (since) params.set('since', new Date(since).toISOString());
      if (until) params.set('until', `${until}T23:59:59.999Z`);

      const r = await api.get(`/audit-export/${format}?${params}`, { responseType: 'blob' });
      const blob = new Blob([r.data], { type: format === 'csv' ? 'text/csv' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nomus-audit-log-${new Date().toISOString().split('T')[0]}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      const truncatedAt = r.headers?.['x-nomus-truncated'];
      setExportNotice(truncatedAt
        ? `The export holds the newest ${truncatedAt} entries; narrow the date range to export the rest.`
        : null);
    } catch (err) {
      setExportError(await blobApiErrorMessage(err, `Failed to export ${format.toUpperCase()}`));
    }
    setExporting(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Audit Log</h1>
          <p className="text-sm text-text-muted mt-1">
            Unified compliance audit trail. Export for SOC 2, ISO 27001, or internal reviews.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleExport('csv')}
            disabled={exporting !== null}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-surface border border-border rounded-lg hover:bg-surface-hover transition disabled:opacity-50"
          >
            {exporting === 'csv' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            Export CSV
          </button>
          <button
            onClick={() => handleExport('json')}
            disabled={exporting !== null}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-surface border border-border rounded-lg hover:bg-surface-hover transition disabled:opacity-50"
          >
            {exporting === 'json' ? <Loader2 size={14} className="animate-spin" /> : <FileJson size={14} />}
            Export JSON
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-text-muted" />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="text-sm bg-surface border border-border rounded-lg px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent"
          >
            <option value="">All types</option>
            <option value="attestation">Attestations</option>
            <option value="scan">Scan Findings</option>
            <option value="score">Compliance Scores</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted">From</label>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="text-sm bg-surface border border-border rounded-lg px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted">To</label>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="text-sm bg-surface border border-border rounded-lg px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        {['attestation', 'scan', 'score'].map((type) => {
          const count = totals ? totals[type as keyof typeof totals] : entries.filter((e) => e.type === type).length;
          const label = type === 'attestation' ? 'Attestations' : type === 'scan' ? 'Findings' : 'Score Snapshots';
          return (
            <div key={type} className="glass rounded-xl p-4">
              <p className="text-xs text-text-muted">{label}</p>
              <p className="text-2xl font-semibold text-text-primary mt-1">{count}</p>
            </div>
          );
        })}
      </div>

      {exportError && <ErrorState compact message={exportError} />}
      {exportNotice && <p className="text-xs text-warning" role="status">{exportNotice}</p>}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="animate-spin text-accent" size={20} />
        </div>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => { setLoading(true); setRetryKey((k) => k + 1); }} />
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 text-text-muted">
          <ClipboardCheck size={32} className="mb-2 opacity-50" />
          <p className="text-sm">No audit entries found for the selected filters.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs">
                <th className="text-left py-2 pr-4">Timestamp</th>
                <th className="text-left py-2 pr-4">Type</th>
                <th className="text-left py-2 pr-4">Action</th>
                <th className="text-left py-2 pr-4">Result</th>
                <th className="text-left py-2 pr-4">Jurisdiction</th>
                <th className="text-left py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className="border-b border-border/50 hover:bg-surface-hover/50">
                  <td className="py-2 pr-4 text-xs text-text-muted whitespace-nowrap">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[e.type] ?? ''}`}>
                      {e.type}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-xs font-mono">{e.action}</td>
                  <td className="py-2 pr-4 text-xs font-medium">{e.result}</td>
                  <td className="py-2 pr-4 text-xs">{e.jurisdiction ?? '-'}</td>
                  <td className="py-2 text-xs text-text-secondary max-w-lg truncate">{e.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
