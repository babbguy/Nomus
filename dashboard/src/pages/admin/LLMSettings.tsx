import { useState, useEffect, useCallback } from 'react';
import { Cpu, RefreshCw, Check, X, Eye, EyeOff } from 'lucide-react';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface LLMConfig {
  classifier: { provider: string; model: string };
  translator: { provider: string; model: string };
  fallback: { provider: string };
  apiKeys: { anthropic: string; google: string; openai: string };
  providers: string[];
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google AI',
  openai: 'OpenAI',
  none: 'None',
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
};

export default function LLMSettings() {
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/llm');
      setConfig(data);
    } catch (err) {
      setMessage(apiErrorMessage(err, 'Failed to load settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  async function saveConfig() {
    if (!config) return;
    setSaving(true);
    setMessage('');
    try {
      await api.put('/settings/llm', {
        classifier: config.classifier,
        translator: config.translator,
        fallback: config.fallback,
      });

      // Save API keys if any were entered
      const keysToSave: Record<string, string> = {};
      for (const [k, v] of Object.entries(apiKeys)) {
        if (v) keysToSave[k] = v;
      }
      if (Object.keys(keysToSave).length > 0) {
        await api.put('/settings/llm/api-keys', keysToSave);
        setApiKeys({});
      }

      setMessage('Settings saved');
      loadConfig();
    } catch (err) {
      setMessage(apiErrorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  async function testProvider(provider: string) {
    if (!config) return;
    setTesting(provider);
    setTestResult((prev) => ({ ...prev, [provider]: undefined! }));
    try {
      const model = provider === config.classifier.provider
        ? config.classifier.model
        : provider === config.translator.provider
          ? config.translator.model
          : DEFAULT_MODELS[provider] ?? 'gpt-4o-mini';
      const { data } = await api.post('/settings/llm/test', { provider, model });
      setTestResult((prev) => ({
        ...prev,
        [provider]: { ok: data.ok, message: data.ok ? `OK (${data.tokensIn + data.tokensOut} tokens)` : data.error },
      }));
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setTestResult((prev) => ({
        ...prev,
        [provider]: { ok: false, message: axiosErr?.response?.data?.error ?? 'Connection failed' },
      }));
    } finally {
      setTesting(null);
    }
  }

  if (loading) {
    return <div className="p-6 text-text-muted">Loading...</div>;
  }

  if (!config) {
    return <div className="p-6 text-danger">Failed to load LLM settings</div>;
  }

  return (
    <div className="p-6 animate-page">
      <div className="flex items-center gap-3 mb-6">
        <Cpu size={24} className="text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-text-primary">LLM Providers</h1>
          <p className="text-sm text-text-muted">Configure AI providers for the pipeline</p>
        </div>
      </div>

      {/* Fallback */}
      <div className="glass rounded-xl p-5 mb-6 space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Fallback Provider</h2>
        <p className="text-xs text-text-muted">If the primary provider fails (rate limit, outage), automatically retry with this provider</p>
        <select
          value={config.fallback.provider}
          onChange={(e) => setConfig({ ...config, fallback: { provider: e.target.value } })}
          className="w-full max-w-xs px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
        >
          <option value="none">None (no fallback)</option>
          {config.providers.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
      </div>

      {/* Provider Roles */}
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        {/* Classifier */}
        <div className="glass rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">Classifier</h2>
          <p className="text-xs text-text-muted">Used for change detection, extraction, scoring, and validation (cheap, frequent)</p>
          <div>
            <label className="block text-xs text-text-muted mb-1">Provider</label>
            <select
              value={config.classifier.provider}
              onChange={(e) => setConfig({ ...config, classifier: { ...config.classifier, provider: e.target.value } })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            >
              {config.providers.map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Model</label>
            <input
              type="text"
              value={config.classifier.model}
              onChange={(e) => setConfig({ ...config, classifier: { ...config.classifier, model: e.target.value } })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        {/* Translator */}
        <div className="glass rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">Translator</h2>
          <p className="text-xs text-text-muted">Used for legal text to policy rule translation (expensive, rare)</p>
          <div>
            <label className="block text-xs text-text-muted mb-1">Provider</label>
            <select
              value={config.translator.provider}
              onChange={(e) => setConfig({ ...config, translator: { ...config.translator, provider: e.target.value } })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            >
              {config.providers.map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Model</label>
            <input
              type="text"
              value={config.translator.model}
              onChange={(e) => setConfig({ ...config, translator: { ...config.translator, model: e.target.value } })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
            />
          </div>
        </div>
      </div>

      {/* API Keys */}
      <div className="glass rounded-xl p-5 mb-6 space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">API Keys</h2>
        <p className="text-xs text-text-muted">Keys are stored encrypted. Leave blank to keep existing key.</p>

        {config.providers.map((p) => (
          <div key={p} className="flex items-center gap-3">
            <label className="w-24 text-sm text-text-secondary shrink-0">{PROVIDER_LABELS[p]}</label>
            <div className="flex-1 relative">
              <input
                type={showKeys[p] ? 'text' : 'password'}
                value={apiKeys[p] ?? ''}
                onChange={(e) => setApiKeys({ ...apiKeys, [p]: e.target.value })}
                placeholder={config.apiKeys[p as keyof typeof config.apiKeys] || 'Not configured'}
                className="w-full px-3 py-2 pr-10 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShowKeys({ ...showKeys, [p]: !showKeys[p] })}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                {showKeys[p] ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <button
              onClick={() => testProvider(p)}
              disabled={testing === p}
              className="px-3 py-2 text-xs font-medium bg-surface-raised border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition disabled:opacity-50 shrink-0"
            >
              {testing === p ? <RefreshCw size={14} className="animate-spin" /> : 'Test'}
            </button>
            {testResult[p] && (
              <span className={`text-xs shrink-0 ${testResult[p].ok ? 'text-success' : 'text-danger'}`}>
                {testResult[p].ok ? <Check size={14} /> : <X size={14} />}
              </span>
            )}
          </div>
        ))}

        {Object.entries(testResult).map(([p, r]) => (
          r && !r.ok ? (
            <p key={p} className="text-xs text-danger mt-1">{PROVIDER_LABELS[p]}: {r.message}</p>
          ) : null
        ))}
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={saveConfig}
          disabled={saving}
          className="px-5 py-2.5 bg-accent text-accent-text font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {message && (
          <span className={`text-sm ${message.includes('Failed') ? 'text-danger' : 'text-success'}`}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
