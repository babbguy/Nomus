import { useState } from 'react';
import { ShieldCheck, Play, CheckCircle, XCircle, MinusCircle } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import { triggerShadowTest, verifyIntegrity, computeStateHash } from '../../api/admin';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';

interface ShadowResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    expected: string;
    actual: string;
    reason?: string;
  }>;
}

interface IntegrityResult {
  total: number;
  valid: number;
  corrupted: string[];
}

export default function IntegrityCheck() {
  const [shadowResult, setShadowResult] = useState<ShadowResult | null>(null);
  const [integrityResult, setIntegrityResult] = useState<IntegrityResult | null>(null);
  const [stateHash, setStateHash] = useState<{ hash: string; ruleCount: number } | null>(null);
  const [loading, setLoading] = useState({ shadow: false, integrity: false, hash: false });
  const [actionError, setActionError] = useState<string | null>(null);

  async function runShadow() {
    setLoading((l) => ({ ...l, shadow: true }));
    setActionError(null);
    try {
      const result = await triggerShadowTest();
      setShadowResult(result);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Shadow tests failed to run'));
    }
    setLoading((l) => ({ ...l, shadow: false }));
  }

  async function runIntegrity() {
    setLoading((l) => ({ ...l, integrity: true }));
    setActionError(null);
    try {
      const result = await verifyIntegrity();
      setIntegrityResult(result);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Integrity verification failed to run'));
    }
    setLoading((l) => ({ ...l, integrity: false }));
  }

  async function runHash() {
    setLoading((l) => ({ ...l, hash: true }));
    setActionError(null);
    try {
      const result = await computeStateHash();
      setStateHash(result);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'State hash computation failed to run'));
    }
    setLoading((l) => ({ ...l, hash: false }));
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <ShieldCheck size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Integrity & Self-Audit</h1>
          <p className="text-sm text-text-secondary">Nomus verifies its own rule integrity</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card>
          <h3 className="text-sm font-semibold text-text-secondary mb-3">Shadow Tests</h3>
          <p className="text-xs text-text-muted mb-3">Run automated test fixtures against policy rules to verify they fire correctly.</p>
          <Button variant="secondary" onClick={runShadow} disabled={loading.shadow} className="text-xs">
            <Play size={12} /> {loading.shadow ? 'Running...' : 'Run Shadow Tests'}
          </Button>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-secondary mb-3">Signature Verification</h3>
          <p className="text-xs text-text-muted mb-3">Verify Ed25519 signatures on all active policy rules to detect tampering.</p>
          <Button variant="secondary" onClick={runIntegrity} disabled={loading.integrity} className="text-xs">
            <Play size={12} /> {loading.integrity ? 'Verifying...' : 'Verify Integrity'}
          </Button>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-secondary mb-3">State Hash</h3>
          <p className="text-xs text-text-muted mb-3">Compute SHA-256 hash of all active rules for point-in-time integrity proof.</p>
          <Button variant="secondary" onClick={runHash} disabled={loading.hash} className="text-xs">
            <Play size={12} /> {loading.hash ? 'Computing...' : 'Compute Hash'}
          </Button>
        </Card>
      </div>

      {actionError && <ErrorState compact message={actionError} />}

      {/* Results */}
      {shadowResult && (
        <Card className="mb-4">
          <h3 className="text-sm font-semibold text-text-secondary mb-3">
            Shadow Test Results — {shadowResult.passed} passed, {shadowResult.failed} failed
            {shadowResult.skipped > 0 && `, ${shadowResult.skipped} skipped`}
          </h3>
          <div className="space-y-2">
            {shadowResult.results.map((r, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div className="flex items-center gap-2">
                  {r.status === 'passed' && <CheckCircle size={14} className="text-success" />}
                  {r.status === 'failed' && <XCircle size={14} className="text-danger" />}
                  {r.status === 'skipped' && <MinusCircle size={14} className="text-text-muted" />}
                  <span className="text-sm text-text-primary">{r.name}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-muted">Expected: {r.expected}</span>
                  {r.status === 'failed' && <span className="text-danger">Got: {r.actual}</span>}
                  {r.status === 'skipped' && <span className="text-text-muted">Skipped: {r.reason}</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {integrityResult && (
        <Card className="mb-4">
          <h3 className="text-sm font-semibold text-text-secondary mb-2">Integrity Verification</h3>
          <div className="flex items-center gap-3">
            {integrityResult.corrupted.length === 0 ? (
              <Badge variant="success">All {integrityResult.total} rules verified</Badge>
            ) : (
              <Badge variant="danger">{integrityResult.corrupted.length} corrupted rules detected</Badge>
            )}
          </div>
          {integrityResult.corrupted.length > 0 && (
            <div className="mt-2 text-xs text-danger font-mono">
              {integrityResult.corrupted.join(', ')}
            </div>
          )}
        </Card>
      )}

      {stateHash && (
        <Card>
          <h3 className="text-sm font-semibold text-text-secondary mb-2">State Hash</h3>
          <p className="font-mono text-xs text-accent break-all">{stateHash.hash}</p>
          <p className="text-xs text-text-muted mt-1">{stateHash.ruleCount} rules in hash</p>
        </Card>
      )}
    </div>
  );
}
