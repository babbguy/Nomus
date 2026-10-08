import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Plus, Copy, Trash2, ArrowLeft, Key } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import { SkeletonStats } from '../../components/ui/Skeleton';
import ErrorState from '../../components/ui/ErrorState';
import { getTenant, getApiKeys, generateApiKey, revokeApiKey, type Tenant, type ApiKeyInfo } from '../../api/tenants';
import { formatDateTime } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState(['read:policies', 'stream', 'evaluate']);
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoadError(null);
    try {
      const [t, k] = await Promise.all([getTenant(id), getApiKeys(id)]);
      setTenant(t);
      setKeys(k.keys);
    } catch (err) {
      setLoadError(apiErrorMessage(err, 'Failed to load tenant'));
    }
    setLoading(false);
  }

  // Clear a prior load error during render when the tenant id changes, keeping
  // the effect body free of synchronous state updates.
  const tenantKey = id ?? '';
  const [loadedTenant, setLoadedTenant] = useState(tenantKey);
  if (loadedTenant !== tenantKey) {
    setLoadedTenant(tenantKey);
    setLoadError(null);
  }

  useEffect(() => {
    if (!id) return;
    Promise.all([getTenant(id), getApiKeys(id)])
      .then(([t, k]) => {
        setTenant(t);
        setKeys(k.keys);
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load tenant')))
      .finally(() => setLoading(false));
  }, [id]);

  async function createKey() {
    if (!id || !newKeyLabel) return;
    setKeyError(null);
    try {
      const result = await generateApiKey(id, { label: newKeyLabel, scopes: newKeyScopes });
      setNewKeyResult(result.key);
      setNewKeyLabel('');
      await load();
    } catch (err) {
      // Keep the label so the user can retry
      setKeyError(apiErrorMessage(err, 'Failed to generate API key'));
    }
  }

  async function handleRevoke(keyId: string) {
    if (!id || !confirm('Revoke this API key? This cannot be undone.')) return;
    setKeyError(null);
    try {
      await revokeApiKey(id, keyId);
      await load();
    } catch (err) {
      setKeyError(apiErrorMessage(err, 'Failed to revoke API key'));
    }
  }

  if (loading) return <div className="py-20"><SkeletonStats count={3} /></div>;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { setLoading(true); load(); }} />;
  if (!tenant) return <div className="text-text-muted py-20 text-center">Tenant not found</div>;

  return (
    <div>
      <Link to="/admin/tenants" className="flex items-center gap-1 text-sm text-text-muted hover:text-accent transition mb-4">
        <ArrowLeft size={14} /> Back to Tenants
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{tenant.name}</h1>
          <p className="text-sm font-mono text-text-muted">{tenant.slug}</p>
        </div>
        <Badge variant={tenant.isActive ? 'success' : 'default'}>{tenant.isActive ? 'Active' : 'Inactive'}</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card><p className="text-xs text-text-muted mb-1">Status</p><p className="text-lg font-semibold text-text-primary">{tenant.isActive ? 'Active' : 'Inactive'}</p></Card>
        <Card><p className="text-xs text-text-muted mb-1">Created</p><p className="text-lg font-semibold text-text-primary">{new Date(tenant.createdAt).toLocaleDateString()}</p></Card>
      </div>

      <Card className="mb-6">
        <p className="text-xs text-text-muted mb-1">Created</p>
        <p className="text-sm text-text-secondary">{formatDateTime(tenant.createdAt)}</p>
        <p className="text-xs text-text-muted mt-3 mb-1">Organization ID</p>
        <p className="text-sm font-mono text-text-secondary">{tenant.id}</p>
      </Card>

      {/* API Keys */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Key size={16} /> API Keys</h2>
          <Badge variant="default">{keys.filter((k) => (k.status ?? (k.isActive ? 'active' : 'revoked')) === 'active').length} active</Badge>
        </div>

        {/* Create Key Form */}
        <div className="flex items-end gap-3 mb-4 pb-4 border-b border-border flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-text-muted mb-1">Label</label>
            <input value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} placeholder="production, staging..."
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Scopes</label>
            <div className="flex gap-1 flex-wrap">
              {['read:policies', 'stream', 'evaluate', 'admin'].map((scope) => (
                <button key={scope}
                  onClick={() => setNewKeyScopes((s) => s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope])}
                  className={`px-2 py-1 text-[10px] rounded border transition ${newKeyScopes.includes(scope) ? 'bg-accent-dim text-accent border-accent-border' : 'bg-surface text-text-muted border-border'}`}>
                  {scope}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={createKey} disabled={!newKeyLabel} className="text-xs"><Plus size={14} /> Generate</Button>
        </div>

        {keyError && <ErrorState compact message={keyError} />}

        {newKeyResult && (
          <div className="mb-4 p-3 bg-accent-dim border border-accent-border rounded-lg">
            <p className="text-xs text-accent font-semibold mb-1">New API Key — save now, shown only once:</p>
            <div className="flex items-center gap-2">
              <p className="font-mono text-sm text-text-primary break-all select-all flex-1">{newKeyResult}</p>
              <button onClick={() => navigator.clipboard.writeText(newKeyResult)} className="p-1.5 rounded text-text-muted hover:text-accent transition shrink-0"><Copy size={14} /></button>
            </div>
          </div>
        )}

        {/* Key List */}
        {keys.length === 0 ? (
          <p className="text-xs text-text-muted py-4 text-center">No API keys yet. Generate one above.</p>
        ) : (
          <div className="space-y-2">
            {keys.map((key) => (
              <div key={key.id} className="flex items-center justify-between p-3 rounded-lg bg-surface-hover/50">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-text-primary">{key.label}</p>
                    <Badge variant={(key.status ?? (key.isActive ? 'active' : 'revoked')) === 'active' ? 'success' : key.status === 'expired' ? 'warning' : 'default'}>{key.status === 'expired' ? 'Expired' : key.isActive ? 'Active' : 'Revoked'}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-text-muted mt-1">
                    <span className="font-mono">{key.keyPrefix}...</span>
                    <span>Scopes: {key.scopes.join(', ')}</span>
                    <span>Created {formatDateTime(key.createdAt)}</span>
                    {key.lastUsedAt && <span>Last used {formatDateTime(key.lastUsedAt)}</span>}
                  </div>
                </div>
                {key.isActive && (
                  <button onClick={() => handleRevoke(key.id)}
                    className="p-1.5 rounded-lg hover:bg-danger/10 text-text-muted hover:text-danger transition" title="Revoke">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
