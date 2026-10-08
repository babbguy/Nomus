import { useEffect, useState } from 'react';
import { Search, Plus, Trash2, X, Download, RefreshCw, Key, ExternalLink, CheckCircle, AlertTriangle } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import {
  getFeeds, createFeed, updateFeed, deleteFeed, seedFeeds, triggerCycle,
  getScoutApiKeys, updateScoutApiKeys,
  type ScoutFeed, type ScoutCycleResult, type ScoutApiKeyInfo,
} from '../../api/scout';
import { JURISDICTIONS } from '@nomus/shared';
import { formatDateTime } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

const FEED_TYPES = ['rss', 'atom', 'google_news', 'webpage', 'gov_api'] as const;
const FEED_TYPE_LABELS: Record<string, string> = {
  rss: 'RSS',
  atom: 'Atom',
  google_news: 'Google News',
  webpage: 'Webpage',
  gov_api: 'Gov API',
};

const GOV_API_PROVIDERS = [
  { id: 'congress_gov', name: 'Congress.gov', jurisdiction: 'US-FED' },
  { id: 'federal_register', name: 'Federal Register', jurisdiction: 'US-FED' },
  { id: 'uk_parliament', name: 'UK Parliament', jurisdiction: 'UK' },
  { id: 'eurlex', name: 'EUR-Lex', jurisdiction: 'EU' },
] as const;

export default function ScoutFeeds() {
  const [feeds, setFeeds] = useState<ScoutFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', feedType: 'rss' as string, category: 'general', jurisdiction: 'global', checkIntervalHours: 6 });
  const [govApiForm, setGovApiForm] = useState({ provider: 'congress_gov', queryTerms: 'artificial intelligence', maxResults: 20 });
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [cycleResult, setCycleResult] = useState<ScoutCycleResult | null>(null);
  const [apiKeyInfo, setApiKeyInfo] = useState<ScoutApiKeyInfo | null>(null);
  const [congressGovKey, setCongressGovKey] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function fetchFeeds() {
    getFeeds()
      .then((r) => {
        setFeeds(r.feeds);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load feeds.'));
      })
      .finally(() => {
        setLoading(false);
      });
  }

  function load() {
    setLoading(true);
    setError(null);
    fetchFeeds();
  }

  useEffect(() => {
    fetchFeeds();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const payload: Parameters<typeof createFeed>[0] = { ...form };

      if (form.feedType === 'gov_api') {
        const terms = govApiForm.queryTerms.split(',').map((t) => t.trim()).filter(Boolean);
        if (terms.length === 0) {
          setError('At least one search term is required for Gov API feeds.');
          setCreating(false);
          return;
        }
        payload.apiConfig = {
          provider: govApiForm.provider,
          queryTerms: terms,
          maxResults: govApiForm.maxResults,
        };
      }

      await createFeed(payload);
      setShowCreate(false);
      setForm({ name: '', url: '', feedType: 'rss', category: 'general', jurisdiction: 'global', checkIntervalHours: 6 });
      setGovApiForm({ provider: 'congress_gov', queryTerms: 'artificial intelligence', maxResults: 20 });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to create feed.'));
    }
    setCreating(false);
  }

  async function handleToggle(feed: ScoutFeed) {
    try {
      await updateFeed(feed.id, { isActive: !feed.isActive });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to update feed.'));
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this feed and the items it found that were not promoted to the radar?')) return;
    try {
      await deleteFeed(id);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to delete feed.'));
    }
  }

  async function handleSeed() {
    setSeeding(true);
    try {
      const r = await seedFeeds();
      setSuccess(r.message);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to seed feeds.'));
    }
    setSeeding(false);
  }

  async function handleTrigger() {
    setTriggering(true);
    setCycleResult(null);
    setError(null);
    try {
      const r = await triggerCycle();
      setCycleResult(r.result);
      load(); // Refresh feeds to show updated lastCheckedAt
    } catch (err) {
      setError(apiErrorMessage(err, 'Scout cycle failed. Check server logs for details.'));
    }
    setTriggering(false);
  }

  async function loadApiKeys() {
    try {
      const info = await getScoutApiKeys();
      setApiKeyInfo(info);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load API key settings.'));
    }
  }

  async function handleSaveApiKeys(e: React.FormEvent) {
    e.preventDefault();
    setSavingKeys(true);
    try {
      await updateScoutApiKeys({ congressGov: congressGovKey });
      setCongressGovKey('');
      setSuccess('Congress.gov API key saved.');
      loadApiKeys();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to save API key.'));
    }
    setSavingKeys(false);
  }

  // Auto-dismiss success after 5s
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  // Auto-dismiss cycle result after 15s
  useEffect(() => {
    if (!cycleResult) return;
    const t = setTimeout(() => setCycleResult(null), 15000);
    return () => clearTimeout(t);
  }, [cycleResult]);

  if (error && !loading && feeds.length === 0) {
    return (
      <div className="flex flex-col items-center py-20 gap-3">
        <p className="text-sm text-danger">{error}</p>
        <button onClick={load} className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition">Retry</button>
      </div>
    );
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div>
      {/* Alerts */}
      {error && (
        <div className="mb-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-sm text-danger flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-xs underline ml-3">Dismiss</button>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-success/10 border border-success/30 rounded-lg text-sm text-success flex items-center justify-between">
          <div className="flex items-center gap-2"><CheckCircle size={14} /><span>{success}</span></div>
          <button onClick={() => setSuccess(null)} className="text-xs underline ml-3">Dismiss</button>
        </div>
      )}

      {/* Scout Running Banner */}
      {triggering && (
        <div className="mb-4 p-4 bg-accent/10 border border-accent/30 rounded-lg flex items-center gap-3">
          <Spinner className="w-4 h-4" />
          <div>
            <p className="text-sm font-medium text-accent">Scout is running...</p>
            <p className="text-xs text-text-muted mt-0.5">Fetching feeds, filtering, classifying, and extracting signals. This may take a minute.</p>
          </div>
        </div>
      )}

      {/* Cycle Result Summary */}
      {cycleResult && !triggering && (
        <div className="mb-4 p-4 bg-success/5 border border-success/20 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={16} className="text-success" />
            <p className="text-sm font-medium text-success">Scout cycle complete</p>
            <span className="text-xs text-text-muted ml-auto">{(cycleResult.durationMs / 1000).toFixed(1)}s</span>
          </div>
          <div className="grid grid-cols-4 gap-4 mt-2">
            <div>
              <p className="text-xl font-bold text-text-primary">{cycleResult.feedsProcessed}</p>
              <p className="text-xs text-text-muted">Feeds processed</p>
            </div>
            <div>
              <p className="text-xl font-bold text-text-primary">{cycleResult.itemsNew}</p>
              <p className="text-xs text-text-muted">New items found</p>
            </div>
            <div>
              <p className="text-xl font-bold text-text-primary">{cycleResult.itemsExtracted}</p>
              <p className="text-xs text-text-muted">Signals extracted</p>
            </div>
            <div>
              <p className="text-xl font-bold text-accent">{cycleResult.itemsAutoPromoted}</p>
              <p className="text-xs text-text-muted">Auto-promoted</p>
            </div>
          </div>
          {cycleResult.itemsNew === 0 && (
            <p className="text-xs text-text-muted mt-2">No new items discovered. All feed items were already in the database.</p>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-dim">
            <Search size={20} className="text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary">Scout Feeds</h1>
          <Badge variant="accent">{feeds.filter((f) => f.isActive).length} active</Badge>
          {feeds.some((f) => f.feedType === 'gov_api') && (
            <Badge variant="success">{feeds.filter((f) => f.feedType === 'gov_api' && f.isActive).length} gov APIs</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={handleTrigger} disabled={triggering}>
            <RefreshCw size={14} className={triggering ? 'animate-spin' : ''} /> {triggering ? 'Running...' : 'Run Scout'}
          </Button>
          <Button variant="ghost" onClick={() => { setShowApiKeys(!showApiKeys); if (!showApiKeys) loadApiKeys(); }}>
            <Key size={14} /> API Keys
          </Button>
          <Button variant="ghost" onClick={handleSeed} disabled={seeding}>
            <Download size={14} /> {seeding ? 'Seeding...' : 'Seed Defaults'}
          </Button>
          <Button onClick={() => setShowCreate(!showCreate)}>
            <Plus size={14} /> Add Feed
          </Button>
        </div>
      </div>

      {/* API Keys Panel */}
      {showApiKeys && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Government API Keys</h3>
            <button onClick={() => setShowApiKeys(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
          </div>
          {apiKeyInfo ? (
            <div className="space-y-3">
              {apiKeyInfo.providers.map((p) => (
                <div key={p.id} className="flex items-center gap-3 p-3 bg-surface-dim rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-text-primary">{p.name}</p>
                      {p.required ? (
                        apiKeyInfo.configured[p.id as keyof typeof apiKeyInfo.configured] ? (
                          <Badge variant="success">Configured</Badge>
                        ) : (
                          <Badge variant="warning">Key Required</Badge>
                        )
                      ) : (
                        <Badge variant="accent">No Key Needed</Badge>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">{p.description}</p>
                    {p.required && apiKeyInfo.congressGov && (
                      <p className="text-xs text-text-muted mt-1 font-mono">{apiKeyInfo.congressGov}</p>
                    )}
                  </div>
                  {p.signupUrl && (
                    <a href={p.signupUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-accent hover:underline shrink-0">
                      Get Key <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              ))}
              <form onSubmit={handleSaveApiKeys} className="flex items-end gap-3 pt-2">
                <div className="flex-1">
                  <label className="block text-xs text-text-muted mb-1">Congress.gov API Key</label>
                  <input
                    type="password"
                    value={congressGovKey}
                    onChange={(e) => setCongressGovKey(e.target.value)}
                    placeholder="Enter your API key..."
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary"
                  />
                </div>
                <Button type="submit" disabled={savingKeys || !congressGovKey}>
                  {savingKeys ? 'Saving...' : 'Save Key'}
                </Button>
              </form>
            </div>
          ) : (
            <div className="flex justify-center py-4"><Spinner className="w-4 h-4" /></div>
          )}
        </Card>
      )}

      {/* Create Feed Form */}
      {showCreate && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">New Feed</h3>
            <button onClick={() => setShowCreate(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
          </div>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="Federal Register — AI" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">URL *</label>
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required type="url"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="https://..." />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Type</label>
                <select value={form.feedType} onChange={(e) => setForm({ ...form, feedType: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                  {FEED_TYPES.map((t) => <option key={t} value={t}>{FEED_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Jurisdiction</label>
                <select value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                  <option value="global">Global</option>
                  {Object.entries(JURISDICTIONS).map(([code, name]) => (
                    <option key={code} value={code}>{code} — {name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Category</label>
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="general" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Check Interval (hrs)</label>
                <input type="number" min={1} max={168} value={form.checkIntervalHours}
                  onChange={(e) => setForm({ ...form, checkIntervalHours: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
              </div>
            </div>

            {/* Gov API-specific fields */}
            {form.feedType === 'gov_api' && (
              <div className="p-3 bg-accent/5 border border-accent/20 rounded-lg space-y-3">
                <p className="text-xs font-medium text-accent">Government API Configuration</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Provider</label>
                    <select value={govApiForm.provider}
                      onChange={(e) => {
                        const p = GOV_API_PROVIDERS.find((gp) => gp.id === e.target.value);
                        setGovApiForm({ ...govApiForm, provider: e.target.value });
                        if (p) setForm({ ...form, jurisdiction: p.jurisdiction });
                      }}
                      className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                      {GOV_API_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Search Terms (comma-separated)</label>
                    <input value={govApiForm.queryTerms}
                      onChange={(e) => setGovApiForm({ ...govApiForm, queryTerms: e.target.value })}
                      className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary"
                      placeholder="artificial intelligence, algorithmic accountability" />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Max Results</label>
                    <input type="number" min={1} max={50} value={govApiForm.maxResults}
                      onChange={(e) => setGovApiForm({ ...govApiForm, maxResults: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
                  </div>
                </div>
                {govApiForm.provider === 'congress_gov' && (
                  <div className="flex items-center gap-2 text-xs text-warning">
                    <AlertTriangle size={12} />
                    <span>Congress.gov requires an API key. Configure it in the API Keys panel above.</span>
                  </div>
                )}
              </div>
            )}

            <Button type="submit" disabled={creating}>{creating ? 'Adding...' : 'Add Feed'}</Button>
          </form>
        </Card>
      )}

      {/* Feed List */}
      {feeds.length === 0 ? (
        <EmptyState title="No scout feeds" description="Seed default feeds or add custom RSS/news feeds to start discovering regulatory signals." />
      ) : (
        <div className="space-y-2">
          {feeds.map((feed) => (
            <Card key={feed.id} className={!feed.isActive ? 'opacity-50' : ''}>
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-text-primary">{feed.name}</p>
                    <Badge variant={feed.isActive ? 'success' : 'danger'}>{feed.isActive ? 'Active' : 'Disabled'}</Badge>
                    <Badge variant={feed.feedType === 'gov_api' ? 'accent' : 'default'}>
                      {FEED_TYPE_LABELS[feed.feedType] ?? feed.feedType}
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5 truncate">{feed.url}</p>
                  <div className="flex items-center gap-3 mt-2">
                    <JurisdictionTag code={feed.jurisdiction} />
                    <span className="text-xs text-text-muted">{feed.lastItemCount} items last check</span>
                    {feed.lastCheckedAt && (
                      <span className="text-xs text-text-muted">Checked {formatDateTime(feed.lastCheckedAt)}</span>
                    )}
                    {feed.errorCount > 0 && (
                      <span className="text-xs text-danger">{feed.errorCount} errors</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="ghost" onClick={() => handleToggle(feed)} className="text-xs">
                    {feed.isActive ? 'Disable' : 'Enable'}
                  </Button>
                  <button onClick={() => handleDelete(feed.id)} className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
