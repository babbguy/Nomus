import { useEffect, useState } from 'react';
import { Download, ExternalLink, ShieldOff, X } from 'lucide-react';
import {
  getAttestations,
  revokeAttestation,
  exportAttestation,
  deriveLifecycle,
  type Attestation,
} from '../../api/attestations';
import Card from '../../components/ui/Card';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ComplianceStatusBadge from '../../components/domain/ComplianceStatusBadge';
import LifecycleBadge from '../../components/domain/LifecycleBadge';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import DataFreshness from '../../components/ui/DataFreshness';
import { formatDateTime } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Attestations() {
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // Revoke modal state
  const [revokeTarget, setRevokeTarget] = useState<Attestation | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Export state — failures surface visibly, never silently
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null); // `${id}:${format}`

  useEffect(() => {
    const params: Record<string, string> = { limit: '100' };
    if (filter) params.result = filter;
    getAttestations(params)
      .then((r) => {
        setAttestations(r.attestations);
        setFetchedAt(new Date().toISOString());
        setLoading(false);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load attestations.'));
        setLoading(false);
      });
  }, [filter, retryKey]);

  function openRevoke(a: Attestation) {
    setRevokeTarget(a);
    setRevokeReason('');
    setRevokeError(null);
  }

  async function handleRevoke(e: React.FormEvent) {
    e.preventDefault();
    if (!revokeTarget) return;
    const reason = revokeReason.trim();
    if (reason.length < 5) {
      setRevokeError('A revocation reason is required (at least 5 characters). It becomes part of the public record.');
      return;
    }
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeAttestation(revokeTarget.id, reason);
      const revokedAt = new Date().toISOString();
      // Server confirmed the revocation — reflect it in the list immediately.
      setAttestations((prev) => prev.map((a) =>
        a.id === revokeTarget.id
          ? { ...a, status: 'revoked' as const, revokedAt, revocationReason: reason }
          : a,
      ));
      setRevokeTarget(null);
    } catch (err: unknown) {
      setRevokeError(apiErrorMessage(err, 'Failed to revoke attestation.'));
    }
    setRevoking(false);
  }

  async function handleExport(a: Attestation, format: 'json' | 'html') {
    const key = `${a.id}:${format}`;
    setExporting(key);
    setExportError(null);
    try {
      const blob = await exportAttestation(a.id, format);
      triggerDownload(blob, `attestation-${a.id}.${format}`);
    } catch (err: unknown) {
      setExportError(
        `Export (${format.toUpperCase()}) failed for attestation ${a.id.slice(0, 8)}…: ${apiErrorMessage(err, 'request failed')}`,
      );
    }
    setExporting(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Attestation History</h1>
          <DataFreshness
            fetchedAt={fetchedAt}
            dataTimestamp={attestations.reduce<string | null>((max, a) => {
              if (!a.evaluatedAt || Number.isNaN(new Date(a.evaluatedAt).getTime())) return max;
              return !max || new Date(a.evaluatedAt) > new Date(max) ? a.evaluatedAt : max;
            }, null)}
            className="mt-1"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
        >
          <option value="">All Results</option>
          <option value="compliant">Obligations Clear</option>
          <option value="non_compliant">Obligations Identified</option>
          <option value="requires_review">Review Required</option>
        </select>
      </div>

      {exportError && (
        <div className="flex items-start justify-between gap-3 mb-4 px-4 py-3 bg-danger/10 border border-danger/30 rounded-lg">
          <p className="text-sm text-danger">{exportError}</p>
          <button
            onClick={() => setExportError(null)}
            className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition shrink-0"
            aria-label="Dismiss export error"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {error ? (
        <div className="flex flex-col items-center py-20 gap-3">
          <p className="text-sm text-danger">{error}</p>
          <button onClick={() => setRetryKey((k) => k + 1)} className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition">Retry</button>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : attestations.length === 0 ? (
        <EmptyState title="No attestations found" description="Run a regulatory evaluation via the API to generate attestation receipts." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Lifecycle</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Jurisdiction</th>
                  <th className="px-4 py-3 font-medium">Rules Checked</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Signature</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {attestations.map((a) => {
                  const lifecycle = deriveLifecycle(a);
                  return (
                    <tr key={a.id} className="hover:bg-surface-hover transition">
                      <td className="px-4 py-3"><ComplianceStatusBadge status={a.result} /></td>
                      <td className="px-4 py-3">
                        <LifecycleBadge lifecycle={lifecycle} reason={a.revocationReason} />
                      </td>
                      <td className="px-4 py-3 text-text-primary">{a.actionContext.action || '—'}</td>
                      <td className="px-4 py-3"><JurisdictionTag code={a.jurisdiction} /></td>
                      <td className="px-4 py-3 text-text-secondary">{a.rulesEvaluated.length}</td>
                      <td className="px-4 py-3 text-text-muted text-xs">{formatDateTime(a.evaluatedAt)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-text-muted truncate max-w-[120px]">
                        {a.signature.slice(0, 16)}...
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <a
                            href={`/verify/${a.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open the public verification page (shareable)"
                            className="p-1.5 rounded-lg hover:bg-surface-hover text-text-muted hover:text-text-primary transition"
                          >
                            <ExternalLink size={14} />
                          </a>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Download attestation bundle (JSON)"
                            disabled={exporting === `${a.id}:json`}
                            onClick={() => handleExport(a, 'json')}
                          >
                            <Download size={12} /> JSON
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Download attestation bundle (HTML)"
                            disabled={exporting === `${a.id}:html`}
                            onClick={() => handleExport(a, 'html')}
                          >
                            <Download size={12} /> HTML
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            title={lifecycle === 'revoked' ? 'Already revoked' : 'Revoke this attestation'}
                            disabled={lifecycle === 'revoked'}
                            onClick={() => openRevoke(a)}
                          >
                            <ShieldOff size={12} /> Revoke
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Revoke confirmation modal */}
      <Modal
        open={revokeTarget !== null}
        onClose={() => { if (!revoking) setRevokeTarget(null); }}
        title="Revoke attestation"
      >
        {revokeTarget && (
          <form onSubmit={handleRevoke}>
            <p className="text-sm text-text-secondary mb-3">
              Revoking is permanent. Anyone who checks the public verification page for{' '}
              <span className="font-mono text-xs text-text-primary">{revokeTarget.id}</span>{' '}
              will see it marked <span className="text-danger font-semibold">REVOKED</span>, along
              with the reason you enter below. Subscribers will be notified.
            </p>
            <label className="block text-xs text-text-muted mb-1">Reason (required, becomes public) *</label>
            <textarea
              value={revokeReason}
              onChange={(e) => { setRevokeReason(e.target.value); setRevokeError(null); }}
              rows={3}
              required
              placeholder="e.g. Evaluated against an outdated policy state; superseded by a re-evaluation"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary mb-2"
            />
            {revokeError && <p className="text-sm text-danger mb-2">{revokeError}</p>}
            <div className="flex justify-end gap-2 mt-2">
              <Button type="button" variant="secondary" disabled={revoking} onClick={() => setRevokeTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={revoking}>
                {revoking ? 'Revoking…' : 'Revoke permanently'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
