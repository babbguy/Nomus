import { useState, useEffect, useCallback } from 'react';
import { Link2, RefreshCw, Check, X, ArrowRightLeft, Shield, Activity } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface ModusStatus {
  configured: boolean;
  modus_url: string | null;
  reachable: boolean;
  modus_version: string | null;
  latency_ms: number | null;
  nomus_rules: number;
  state_hash: string;
  last_webhook_at: string | null;
  last_webhook_event: string | null;
  modus_status: Record<string, unknown> | null;
}

interface ComplianceReport {
  nomus: {
    total_rules: number;
    state_hash: string;
    generated_at: string;
    by_jurisdiction: Record<string, { total: number; critical: number; high: number; medium: number; low: number }>;
    by_severity: Record<string, number>;
    by_category: Record<string, number>;
  };
  modus: Record<string, unknown> | null;
  combined: {
    nomus_rules_active: number;
    modus_connected: boolean;
    modus_policies_synced: number;
    modus_sync_status: string;
    modus_last_sync: string | null;
    in_sync: boolean;
  };
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

const severityColors: Record<string, string> = {
  critical: 'bg-danger/15 text-danger',
  high: 'bg-warning/15 text-warning',
  medium: 'bg-info/15 text-info',
  low: 'bg-accent/15 text-accent',
};

export default function ModusIntegration() {
  const [status, setStatus] = useState<ModusStatus | null>(null);
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [statusRes, reportRes] = await Promise.all([
        api.get('/admin/modus/status'),
        api.get('/admin/modus/compliance-report'),
      ]);
      setStatus(statusRes.data);
      setReport(reportRes.data);
      setLoadError(null);
      setReportError(null);
    } catch (firstErr) {
      // The report endpoint may fail independently — retry status alone,
      // but surface whichever part failed (no silent partial loads).
      try {
        const { data } = await api.get('/admin/modus/status');
        setStatus(data);
        setLoadError(null);
        setReportError(apiErrorMessage(firstErr, 'Failed to load compliance report'));
      } catch (err) {
        setLoadError(apiErrorMessage(err, 'Failed to load Modus integration status'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post('/admin/modus/test');
      setTestResult({
        ok: data.reachable,
        message: data.reachable
          ? `Connected (${data.latency_ms}ms) — Modus ${data.modus_version ?? 'unknown'}`
          : data.error ?? 'Unreachable',
      });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setTestResult({ ok: false, message: axiosErr?.response?.data?.error ?? 'Request failed' });
    } finally {
      setTesting(false);
    }
  }

  async function triggerSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const { data } = await api.post('/admin/modus/trigger-sync');
      setSyncResult({
        ok: data.success,
        message: data.success
          ? `Sync triggered — Modus acknowledged`
          : data.error ?? 'Sync failed',
      });
      if (data.success) load();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setSyncResult({ ok: false, message: axiosErr?.response?.data?.error ?? 'Request failed' });
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 animate-page">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim text-accent">
          <Link2 size={20} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Modus Integration</h1>
          <p className="text-sm text-text-muted">Manage connection to Modus for runtime rule enforcement</p>
        </div>
      </div>

      {loadError && <ErrorState compact message={loadError} onRetry={load} />}
      {reportError && <ErrorState compact message={reportError} onRetry={load} />}

      {/* Connection Status + Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Connection Status */}
        <div className="glass rounded-xl p-5 md:col-span-2">
          <h2 className="text-sm font-semibold text-text-secondary mb-3">Connection Status</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Configured</span>
              <span className={`inline-flex items-center gap-1.5 text-sm ${status?.configured ? 'text-success' : 'text-text-muted'}`}>
                {status?.configured ? <Check size={14} /> : <X size={14} />}
                {status?.configured ? 'Yes' : 'Not configured'}
              </span>
            </div>
            {status?.modus_url && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">Modus URL</span>
                <span className="text-sm text-text-primary font-mono">{status.modus_url}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Reachable</span>
              <span className={`inline-flex items-center gap-1.5 text-sm ${status?.reachable ? 'text-success' : 'text-danger'}`}>
                {status?.reachable ? <Check size={14} /> : <X size={14} />}
                {status?.reachable ? `Yes (${status.latency_ms}ms)` : 'No'}
              </span>
            </div>
            {status?.modus_version && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">Modus Version</span>
                <span className="text-sm text-text-primary">{status.modus_version}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Nomus Rules (Active)</span>
              <span className="text-sm text-text-primary font-semibold">{status?.nomus_rules ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">State Hash</span>
              <span className="text-xs text-text-secondary font-mono">{status?.state_hash?.slice(0, 16)}...</span>
            </div>
            {status?.last_webhook_at && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">Last Webhook</span>
                <span className="text-sm text-text-secondary">
                  {status.last_webhook_event} — {timeAgo(status.last_webhook_at)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-4">
          <div className="glass rounded-xl p-5">
            <h2 className="text-sm font-semibold text-text-secondary mb-3">Actions</h2>
            <div className="space-y-3">
              <button
                onClick={testConnection}
                disabled={testing || !status?.configured}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-surface-raised border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition disabled:opacity-50"
              >
                {testing ? <RefreshCw size={14} className="animate-spin" /> : <Activity size={14} />}
                Test Connection
              </button>
              <button
                onClick={triggerSync}
                disabled={syncing || !status?.configured || !status?.reachable}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-surface-raised border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition disabled:opacity-50"
              >
                {syncing ? <RefreshCw size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                Trigger Sync
              </button>
              <button
                onClick={load}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-surface-raised border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition"
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            </div>
            {testResult && (
              <div className={`mt-3 text-xs ${testResult.ok ? 'text-success' : 'text-danger'}`}>
                {testResult.message}
              </div>
            )}
            {syncResult && (
              <div className={`mt-3 text-xs ${syncResult.ok ? 'text-success' : 'text-danger'}`}>
                {syncResult.message}
              </div>
            )}
          </div>

          {!status?.configured && (
            <div className="glass rounded-xl p-5 border border-warning/30">
              <p className="text-xs text-warning">
                Set <span className="font-mono">NOMUS_MODUS_API_URL</span> and{' '}
                <span className="font-mono">NOMUS_MODUS_API_KEY</span> in your environment to enable the Modus integration.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Combined Compliance Report */}
      {report && (
        <>
          {/* Sync Status Banner */}
          <div className={`glass rounded-xl p-4 mb-6 border ${report.combined.in_sync ? 'border-success/30' : report.combined.modus_connected ? 'border-warning/30' : 'border-border'}`}>
            <div className="flex items-center gap-3">
              <Shield size={18} className={report.combined.in_sync ? 'text-success' : report.combined.modus_connected ? 'text-warning' : 'text-text-muted'} />
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {report.combined.in_sync
                    ? 'Nomus and Modus are in sync'
                    : report.combined.modus_connected
                      ? 'Nomus and Modus are out of sync'
                      : 'Modus not connected'}
                </p>
                <p className="text-xs text-text-muted">
                  {report.combined.nomus_rules_active} Nomus rules active
                  {report.combined.modus_connected && ` — ${report.combined.modus_policies_synced} synced to Modus`}
                  {report.combined.modus_last_sync && ` — last sync ${timeAgo(report.combined.modus_last_sync)}`}
                </p>
              </div>
            </div>
          </div>

          {/* Rule Breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {/* By Severity */}
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold text-text-secondary mb-3">Rules by Severity</h2>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(report.nomus.by_severity).map(([severity, count]) => (
                  <div key={severity} className="flex items-center justify-between p-2 rounded-lg bg-surface">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${severityColors[severity] ?? 'bg-surface-hover text-text-muted'}`}>
                      {severity}
                    </span>
                    <span className="text-sm font-semibold text-text-primary">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* By Category */}
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold text-text-secondary mb-3">Rules by Category</h2>
              <div className="max-h-tile overflow-y-auto space-y-1">
                {Object.entries(report.nomus.by_category)
                  .sort(([, a], [, b]) => b - a)
                  .map(([category, count]) => (
                    <div key={category} className="flex items-center justify-between py-1.5">
                      <span className="text-sm text-text-secondary">{category.replace(/_/g, ' ')}</span>
                      <span className="text-sm font-medium text-text-primary">{count}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* By Jurisdiction */}
          <div className="glass rounded-xl p-5">
            <h2 className="text-sm font-semibold text-text-secondary mb-3">Rules by Jurisdiction</h2>
            <div className="max-h-tile overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-muted text-xs border-b border-border">
                    <th className="text-left py-2 font-medium">Jurisdiction</th>
                    <th className="text-right py-2 font-medium">Total</th>
                    <th className="text-right py-2 font-medium">Critical</th>
                    <th className="text-right py-2 font-medium">High</th>
                    <th className="text-right py-2 font-medium">Medium</th>
                    <th className="text-right py-2 font-medium">Low</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.nomus.by_jurisdiction)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .map(([jurisdiction, data]) => (
                      <tr key={jurisdiction} className="border-b border-border/50 last:border-0">
                        <td className="py-2 text-text-primary font-medium">{jurisdiction}</td>
                        <td className="py-2 text-right text-text-primary">{data.total}</td>
                        <td className="py-2 text-right">
                          {data.critical > 0 && <span className="text-danger font-medium">{data.critical}</span>}
                        </td>
                        <td className="py-2 text-right">
                          {data.high > 0 && <span className="text-warning font-medium">{data.high}</span>}
                        </td>
                        <td className="py-2 text-right text-text-secondary">{data.medium || ''}</td>
                        <td className="py-2 text-right text-text-muted">{data.low || ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {Object.keys(report.nomus.by_jurisdiction).length === 0 && (
                <p className="text-sm text-text-muted py-4 text-center">No active rules. Run the pipeline to generate rules.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
