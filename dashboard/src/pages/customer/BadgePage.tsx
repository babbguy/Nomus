import { useEffect, useState } from 'react';
import { Award, Copy, Check } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import { useAuthStore } from '../../stores/authStore';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface BadgeConfig {
  id: string;
  style: string;
  jurisdictions: string[];
  showScore: boolean;
  showJurisdictions: boolean;
  customLabel: string | null;
  isPublic: boolean;
  embedCode: string;
}

export default function BadgePage() {
  const { org } = useAuthStore();
  const [config, setConfig] = useState<BadgeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function load() {
    if (!org) return;
    setLoading(true);
    setLoadError(null);
    api.get(`/badge/${org.slug}/config`).then((r) => {
      setConfig(r.data);
      setLoading(false);
    }).catch((err) => {
      setLoadError(apiErrorMessage(err, 'Failed to load badge configuration'));
      setLoading(false);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function togglePublic() {
    if (!org || !config) return;
    setSaving(true);
    setActionError(null);
    const newPublic = !config.isPublic;
    try {
      await api.patch(`/badge/${org.slug}/config`, { isPublic: newPublic });
      setConfig({ ...config, isPublic: newPublic });
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to update badge visibility'));
    }
    setSaving(false);
  }

  async function updateStyle(style: string) {
    if (!org || !config) return;
    setActionError(null);
    try {
      await api.patch(`/badge/${org.slug}/config`, { style });
      setConfig({ ...config, style });
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to update badge style'));
    }
  }

  function copyEmbed() {
    if (!config) return;
    navigator.clipboard.writeText(config.embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (loadError) return <ErrorState message={loadError} onRetry={load} />;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <Award size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Compliance Badge</h1>
          <p className="text-sm text-text-secondary">Embed a live compliance status badge on your website</p>
        </div>
      </div>

      {actionError && (
        <Card className="mb-4 border-danger/30">
          <ErrorState compact message={actionError} />
        </Card>
      )}

      {/* Preview */}
      <Card className="mb-6" glow>
        <h2 className="text-sm font-semibold text-text-secondary mb-4">Badge Preview</h2>
        <div className="flex justify-center py-6 bg-white/5 rounded-lg">
          {config?.isPublic && org ? (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface border border-border text-sm">
              <img src="/logo-icon.svg" alt="Nomus" className="w-4 h-4" />
              <span className="text-text-primary font-medium">Nomus Verified</span>
            </div>
          ) : (
            <p className="text-sm text-text-muted">Enable your badge to see the preview</p>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Settings */}
        <Card>
          <h2 className="text-sm font-semibold text-text-secondary mb-4">Settings</h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-text-primary font-medium">Public Badge</p>
                <p className="text-xs text-text-muted">Allow anyone to see your compliance status</p>
              </div>
              <button
                onClick={togglePublic}
                disabled={saving}
                className={`relative w-11 h-6 rounded-full transition ${
                  config?.isPublic ? 'bg-accent' : 'bg-surface-hover border border-border'
                }`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  config?.isPublic ? 'translate-x-5.5' : 'translate-x-0.5'
                }`} />
              </button>
            </div>

            <div>
              <p className="text-sm text-text-primary font-medium mb-2">Badge Style</p>
              <div className="flex gap-2">
                {['flat', 'rounded', 'pill'].map((style) => (
                  <button
                    key={style}
                    onClick={() => updateStyle(style)}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition capitalize ${
                      config?.style === style
                        ? 'bg-accent-dim text-accent border-accent-border'
                        : 'bg-surface text-text-muted border-border hover:border-border-bright'
                    }`}
                  >
                    {style}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Embed Code */}
        <Card>
          <h2 className="text-sm font-semibold text-text-secondary mb-4">Embed Code</h2>
          {config?.isPublic ? (
            <>
              <div className="bg-surface rounded-lg p-3 mb-3">
                <code className="text-xs text-accent font-mono break-all">
                  {config.embedCode}
                </code>
              </div>
              <Button variant="secondary" onClick={copyEmbed} className="text-xs">
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy Embed Code'}
              </Button>
              <p className="text-xs text-text-muted mt-3">
                Paste this script tag into your website's HTML. The badge auto-updates every 5 minutes.
              </p>
            </>
          ) : (
            <p className="text-sm text-text-muted py-4">
              Enable your public badge to get the embed code.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
