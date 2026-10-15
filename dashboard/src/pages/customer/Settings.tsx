import { useEffect, useState, useCallback } from 'react';
import { Plus, Download, Save, Copy, Check } from 'lucide-react';
import { JURISDICTIONS } from '@nomus/shared';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import ApiKeyRow from '../../components/domain/ApiKeyRow';
import { useAuthStore } from '../../stores/authStore';
import { useCpgMe } from '../../hooks/useCpgMe';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  label: string;
  scopes: string[];
  isActive: boolean;
  status?: 'active' | 'revoked' | 'expired';
  lastUsedAt: string | null;
  createdAt: string;
}

/** Scopes a member may grant to their own keys (admin is never offered). */
const KEY_SCOPES: Array<{ value: string; hint: string }> = [
  { value: 'read:policies', hint: 'Fetch active regulations and policy bundles (scanner, CI, MCP)' },
  { value: 'evaluate', hint: 'Request signed compliance attestations' },
  { value: 'stream', hint: 'Subscribe to live regulation change events' },
];

// Values match the industry tags carried by regulatory rules, so the dashboard
// can filter the impact map by them.
const INDUSTRIES: Array<{ value: string; label: string }> = [
  { value: 'healthcare', label: 'Healthcare & Life Sciences' },
  { value: 'finance', label: 'Financial Services & Insurance' },
  { value: 'education', label: 'Education & EdTech' },
  { value: 'government', label: 'Government & Public Sector' },
  { value: 'media', label: 'Media & Entertainment' },
  { value: 'advertising', label: 'Advertising & Marketing' },
  { value: 'critical_infrastructure', label: 'Critical Infrastructure (Energy, Transport, Telecom)' },
  { value: 'other', label: 'Other' },
];

const jurisdictionEntries = Object.entries(JURISDICTIONS) as Array<[string, string]>;

export default function Settings() {
  const { org, user, checkSession } = useAuthStore();
  // Organization permissions (GET /cpg/me). Platform administrators keep their
  // v1.1.0 access to /org/*; everyone else needs the permission, so the page
  // never offers an action the API would refuse with 403.
  const { me, status: permStatus, error: permError, reload: reloadPerms } = useCpgMe();
  const isPlatformAdmin = user?.role === 'platform_admin';
  const permsKnown = isPlatformAdmin || permStatus === 'ready';
  const canManageKeys = isPlatformAdmin || hasOrgPermission(me, 'org.api_keys.manage');
  const canEditOrg = isPlatformAdmin || hasOrgPermission(me, 'org.profile.update');
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(['read:policies', 'evaluate']);
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyInfo | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Org profile form
  const [industry, setIndustry] = useState('');
  const [subIndustry, setSubIndustry] = useState('');
  const [jurisdictions, setJurisdictions] = useState<string[]>([]);
  const [showOnVerify, setShowOnVerify] = useState(false);
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgMsg, setOrgMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyActionError, setKeyActionError] = useState<string | null>(null);
  const [orgLoadError, setOrgLoadError] = useState<string | null>(null);

  const loadKeys = useCallback(
    () =>
      api.get('/org/api-keys')
        .then(({ data }) => {
          const list: ApiKeyInfo[] = Array.isArray(data?.keys) ? data.keys : [];
          setKeys(list.filter((k) => k.isActive));
          setKeysError(null);
        })
        .catch((err) => setKeysError(apiErrorMessage(err, 'Failed to load API keys')))
        .finally(() => setLoading(false)),
    [],
  );

  const loadOrgInfo = useCallback(
    () =>
      api.get('/org')
        .then(({ data }) => {
          setIndustry(data.industry ?? '');
          setSubIndustry(data.subIndustry ?? '');
          setJurisdictions(Array.isArray(data.jurisdictionAccess) ? data.jurisdictionAccess : []);
          setShowOnVerify(!!data.showOrgOnPublicVerify);
          setOrgLoadError(null);
        })
        .catch((err) => setOrgLoadError(apiErrorMessage(err, 'Failed to load organization info'))),
    [],
  );

  useEffect(() => {
    void loadOrgInfo();
  }, [loadOrgInfo]);

  useEffect(() => {
    if (permsKnown && canManageKeys) void loadKeys();
  }, [permsKnown, canManageKeys, loadKeys]);

  function toggleScope(scope: string) {
    setNewKeyScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function createKey() {
    const label = newKeyLabel.trim();
    if (!label || newKeyScopes.length === 0) return;
    setCreating(true);
    setKeyActionError(null);
    setCopied(false);
    try {
      const { data } = await api.post('/org/api-keys', { label, scopes: newKeyScopes });
      setNewKeyResult({ key: data.key, label: data.label });
      setNewKeyLabel('');
      await loadKeys();
    } catch (err) {
      // Keep the label so the user can retry
      setKeyActionError(apiErrorMessage(err, 'Failed to generate API key'));
    }
    setCreating(false);
  }

  async function copyKey() {
    if (!newKeyResult) return;
    try {
      await navigator.clipboard.writeText(newKeyResult.key);
      setCopied(true);
    } catch {
      setKeyActionError('Could not copy automatically. Select the key and copy it manually.');
    }
  }

  async function confirmRevoke() {
    if (!pendingRevoke) return;
    setRevoking(true);
    setKeyActionError(null);
    try {
      await api.delete(`/org/api-keys/${pendingRevoke.id}`);
      setPendingRevoke(null);
      await loadKeys();
    } catch (err) {
      setKeyActionError(apiErrorMessage(err, 'Failed to revoke API key'));
      setPendingRevoke(null);
    }
    setRevoking(false);
  }

  async function saveOrgInfo() {
    setSavingOrg(true);
    setOrgMsg(null);
    try {
      await api.patch('/org', {
        industry: industry || null,
        subIndustry: subIndustry.trim() || null,
        jurisdictionAccess: jurisdictions,
        showOrgOnPublicVerify: showOnVerify,
      });
      await checkSession();
      setOrgMsg({ type: 'ok', text: 'Organization info saved.' });
    } catch (err) {
      setOrgMsg({ type: 'err', text: apiErrorMessage(err, 'Failed to save.') });
    }
    setSavingOrg(false);
  }

  function exportDiagnostics() {
    const diagnostics = {
      _note: 'Attach this file when contacting support',
      generatedAt: new Date().toISOString(),
      browser: {
        userAgent: navigator.userAgent,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      },
      user: user ? { id: user.id, email: user.email, name: user.name, role: user.role } : null,
      org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      apiUrl: '/api/v1',
      url: window.location.href,
    };

    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nomus-diagnostics-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const inputCls =
    'w-full text-sm bg-surface border border-border rounded-lg px-3 py-2 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition';

  // An industry saved before the list was normalized still shows up as an option
  const industryKnown = !industry || INDUSTRIES.some((i) => i.value === industry);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>

      {/* Org Info */}
      <Card className="mb-6">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Organization</h2>
        {orgLoadError && <ErrorState compact message={orgLoadError} onRetry={() => void loadOrgInfo()} />}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-muted">Name</p>
              <p className="text-text-secondary">{org?.name}</p>
            </div>
            <div>
              <p className="text-text-muted">Slug</p>
              <p className="font-mono text-text-secondary">{org?.slug}</p>
            </div>
          </div>

          <div>
            <label htmlFor="org-industry" className="block text-xs text-text-muted mb-1">Industry</label>
            <select
              id="org-industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className={inputCls}
            >
              <option value="">Select industry...</option>
              {!industryKnown && <option value={industry}>{industry}</option>}
              {INDUSTRIES.map((ind) => (
                <option key={ind.value} value={ind.value}>{ind.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="org-sub-industry" className="block text-xs text-text-muted mb-1">Sub-industry</label>
            <input
              id="org-sub-industry"
              value={subIndustry}
              onChange={(e) => setSubIndustry(e.target.value)}
              className={inputCls}
              placeholder="e.g. Clinical Trials, Insurtech, etc."
              maxLength={100}
            />
          </div>

          <fieldset>
            <legend className="block text-xs text-text-muted mb-1">Jurisdictions you operate in</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 max-h-48 overflow-y-auto border border-border rounded-lg p-3">
              {jurisdictionEntries.map(([code, name]) => (
                <label key={code} className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={jurisdictions.includes(code)}
                    onChange={() =>
                      setJurisdictions((prev) => (prev.includes(code) ? prev.filter((j) => j !== code) : [...prev, code]))
                    }
                  />
                  <span>{name}</span>
                  <span className="text-xs text-text-muted font-mono">{code}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-start gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              className="mt-1"
              checked={showOnVerify}
              onChange={(e) => setShowOnVerify(e.target.checked)}
            />
            <span>
              Show my organization name on the public attestation verification page
              <span className="block text-xs text-text-muted">Off by default. Verification pages stay anonymous unless you opt in.</span>
            </span>
          </label>

          {orgMsg && (
            <p className={`text-xs ${orgMsg.type === 'ok' ? 'text-success' : 'text-danger'}`}>
              {orgMsg.text}
            </p>
          )}

          {permsKnown && !canEditOrg && (
            <p className="text-xs text-text-muted" data-testid="org-profile-read-only">
              Read only: changing the organization profile needs the <span className="font-mono">org.profile.update</span> permission. Ask an Org Admin.
            </p>
          )}
          <Button onClick={saveOrgInfo} disabled={savingOrg || !permsKnown || !canEditOrg} className="text-xs">
            <Save size={14} /> {savingOrg ? 'Saving...' : 'Save Organization'}
          </Button>
        </div>
      </Card>

      {/* API Keys */}
      <Card className="mb-6">
        <h2 className="text-sm font-semibold text-text-secondary mb-1">API Keys</h2>
        <p className="text-xs text-text-muted mb-4">
          Keys let the scanner, GitHub Action, VS Code extension and MCP server read policies and request
          attestations for {org?.name ?? 'your organization'}.{canManageKeys ? ' You can create and revoke them.' : ''}
        </p>

        {!permsKnown ? (
          permStatus === 'error' ? (
            <ErrorState compact message={permError ?? 'Could not load your permissions'} onRetry={reloadPerms} />
          ) : (
            <div className="flex justify-center py-8"><Spinner className="w-6 h-6" /></div>
          )
        ) : !canManageKeys ? (
          <p className="text-sm text-text-muted py-2" data-testid="api-keys-no-permission">
            You don&apos;t have permission to manage this organization&apos;s API keys
            (<span className="font-mono text-xs">org.api_keys.manage</span>). Ask an Org Admin for a key or for access.
          </p>
        ) : (
        <>
        <div className="flex flex-col gap-3 mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              aria-label="Key label"
              value={newKeyLabel}
              onChange={(e) => setNewKeyLabel(e.target.value)}
              placeholder="Key label (e.g. CI scanner)..."
              maxLength={100}
              className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary placeholder-text-muted w-64"
            />
            <Button
              onClick={createKey}
              disabled={!newKeyLabel.trim() || newKeyScopes.length === 0 || creating}
              className="text-xs"
            >
              <Plus size={14} /> {creating ? 'Generating...' : 'Generate'}
            </Button>
          </div>
          <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
            <legend className="sr-only">Key scopes</legend>
            {KEY_SCOPES.map((s) => (
              <label key={s.value} className="flex items-center gap-2 text-xs text-text-secondary" title={s.hint}>
                <input
                  type="checkbox"
                  checked={newKeyScopes.includes(s.value)}
                  onChange={() => toggleScope(s.value)}
                />
                <span className="font-mono">{s.value}</span>
              </label>
            ))}
          </fieldset>
        </div>

        {keyActionError && <ErrorState compact message={keyActionError} />}

        {newKeyResult && (
          <div className="mb-4 p-3 bg-accent-dim border border-accent-border rounded-lg" role="status">
            <p className="text-xs text-accent font-semibold mb-1">
              New API key for &quot;{newKeyResult.label}&quot;. Copy it now: you won&apos;t see this again.
            </p>
            <div className="flex items-center gap-2">
              <p data-testid="new-api-key" className="font-mono text-sm text-text-primary break-all select-all flex-1">
                {newKeyResult.key}
              </p>
              <Button variant="secondary" size="sm" onClick={copyKey} aria-label="Copy API key">
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setNewKeyResult(null)}>Dismiss</Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-8"><Spinner className="w-6 h-6" /></div>
        ) : keysError ? (
          <ErrorState message={keysError} onRetry={loadKeys} />
        ) : keys.length === 0 ? (
          <p className="text-sm text-text-muted py-4">No API keys yet. Generate one above.</p>
        ) : (
          <div className="divide-y divide-border">
            {keys.map((k) => (
              <ApiKeyRow
                key={k.id}
                id={k.id}
                prefix={k.keyPrefix}
                label={k.label}
                scopes={k.scopes}
                lastUsedAt={k.lastUsedAt}
                createdAt={k.createdAt}
                expired={k.status === 'expired'}
                onRevoke={() => setPendingRevoke(k)}
              />
            ))}
          </div>
        )}
        </>
        )}
      </Card>

      <Modal open={!!pendingRevoke} onClose={() => setPendingRevoke(null)} title="Revoke API key?" width="max-w-md">
        <p className="text-sm text-text-secondary mb-4">
          Anything using <span className="font-mono">{pendingRevoke?.keyPrefix}</span> ({pendingRevoke?.label}) will
          stop working immediately. This cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPendingRevoke(null)}>Cancel</Button>
          <Button variant="danger" onClick={confirmRevoke} disabled={revoking}>
            {revoking ? 'Revoking...' : 'Revoke key'}
          </Button>
        </div>
      </Modal>

      {/* Diagnostics */}
      <Card>
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Diagnostics</h2>
        <p className="text-sm text-text-muted mb-4">
          Export a diagnostics report to share with support when troubleshooting issues.
        </p>
        <Button variant="secondary" onClick={exportDiagnostics} className="text-xs">
          <Download size={14} /> Export Error Log
        </Button>
      </Card>
    </div>
  );
}
