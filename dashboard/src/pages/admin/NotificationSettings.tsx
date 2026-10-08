import { useState, useEffect, useCallback } from 'react';
import { Bell, Mail, MessageSquare, Smartphone, Plus, X, RefreshCw, Check, Key } from 'lucide-react';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface NotificationConfig {
  email: { enabled: string; recipients: string[]; resendKeyConfigured: boolean; resendKeyMasked: string };
  push: { enabled: string; topics: string[]; ntfyUrl: string };
  slack: { configured: boolean };
  events: {
    pipeline_success: string;
    pipeline_error: string;
    scout_review: string;
    scout_signal: string;
  };
}

const EVENT_LABELS: Record<string, { label: string; desc: string }> = {
  pipeline_success: { label: 'Pipeline completed', desc: 'When a regulatory source scan finishes with new or updated rules' },
  pipeline_error: { label: 'Pipeline error', desc: 'When a scan fails — critical alert' },
  scout_review: { label: 'Scout review needed', desc: 'When Scout finds items needing manual review' },
  scout_signal: { label: 'Scout signal detected', desc: 'When Scout auto-promotes a new regulatory signal' },
};

const CHANNEL_OPTIONS = [
  { value: 'email+sms', label: 'Email + Push' },
  { value: 'email', label: 'Email only' },
  { value: 'sms', label: 'Push only' },
  { value: 'none', label: 'Off' },
];

export default function NotificationSettings() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [ntfyUrl, setNtfyUrl] = useState('');
  const [slackWebhook, setSlackWebhook] = useState('');
  const [resendApiKey, setResendApiKey] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/notifications');
      setConfig(data);
      setNtfyUrl(data.push?.ntfyUrl || 'https://ntfy.sh');
    } catch (err) {
      setMessage(apiErrorMessage(err, 'Failed to load settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  async function save() {
    if (!config) return;
    setSaving(true);
    setMessage('');
    try {
      await api.put('/settings/notifications', {
        email: {
          enabled: config.email.enabled,
          recipients: config.email.recipients,
          ...(resendApiKey ? { resendApiKey } : {}),
        },
        push: {
          enabled: config.push.enabled,
          topics: config.push.topics,
          ...(ntfyUrl ? { ntfyUrl } : {}),
        },
        ...(slackWebhook ? { slack: { webhook_url: slackWebhook } } : {}),
        events: config.events,
      });
      setSlackWebhook('');
      setResendApiKey('');
      setMessage('Settings saved');
      loadConfig();
    } catch (err) {
      setMessage(apiErrorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  async function testChannel(channel: 'email' | 'push' | 'slack') {
    setTesting(channel);
    try {
      const { data } = await api.post('/settings/notifications/test', { channel });
      setMessage(data.ok ? `Test ${channel} sent` : `Test failed: ${data.error}`);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setMessage(axiosErr?.response?.data?.error ?? `Test ${channel} failed`);
    } finally {
      setTesting(null);
    }
  }

  function addEmail() {
    if (!config || !newEmail || !newEmail.includes('@')) return;
    if (config.email.recipients.includes(newEmail)) return;
    setConfig({ ...config, email: { ...config.email, recipients: [...config.email.recipients, newEmail] } });
    setNewEmail('');
  }

  function removeEmail(email: string) {
    if (!config) return;
    setConfig({ ...config, email: { ...config.email, recipients: config.email.recipients.filter((e) => e !== email) } });
  }

  function addTopic() {
    if (!config || !newTopic) return;
    if (config.push.topics.includes(newTopic)) return;
    setConfig({ ...config, push: { ...config.push, topics: [...config.push.topics, newTopic] } });
    setNewTopic('');
  }

  function removeTopic(topic: string) {
    if (!config) return;
    setConfig({ ...config, push: { ...config.push, topics: config.push.topics.filter((t) => t !== topic) } });
  }

  if (loading) return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>;
  if (!config) return <div className="p-6 text-danger">Failed to load notification settings</div>;

  return (
    <div className="p-6 animate-page">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim text-accent">
          <Bell size={20} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Notifications</h1>
          <p className="text-sm text-text-muted">Configure email, push, and Slack alerts for pipeline and Scout events</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Event Configuration */}
        <div className="glass rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">Event Channels</h2>
          <p className="text-xs text-text-muted">Choose how to be notified for each event type</p>
          {Object.entries(EVENT_LABELS).map(([key, { label, desc }]) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{label}</p>
                <p className="text-xs text-text-muted">{desc}</p>
              </div>
              <select
                value={config.events[key as keyof typeof config.events]}
                onChange={(e) => setConfig({ ...config, events: { ...config.events, [key]: e.target.value } })}
                className="w-36 px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
              >
                {CHANNEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          ))}
          <p className="text-[10px] text-text-muted">Slack notifications are sent for all events when configured.</p>
        </div>

        {/* Email */}
        <div className="glass rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail size={16} className="text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Email</h2>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.email.enabled === 'true'}
                onChange={(e) => setConfig({ ...config, email: { ...config.email, enabled: e.target.checked ? 'true' : 'false' } })}
                className="rounded"
              />
              <span className="text-text-secondary">Enabled</span>
            </label>
          </div>

          <div className="space-y-1">
            {config.email.recipients.map((email) => (
              <div key={email} className="flex items-center justify-between px-3 py-1.5 bg-surface rounded text-sm">
                <span className="text-text-primary">{email}</span>
                <button onClick={() => removeEmail(email)} className="text-text-muted hover:text-danger"><X size={14} /></button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmail()}
              placeholder="alerts@example.com"
              className="flex-1 px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            />
            <button onClick={addEmail} className="p-1.5 text-text-muted hover:text-accent"><Plus size={16} /></button>
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
              <Key size={12} />
              Resend API Key
              {config.email.resendKeyConfigured && (
                <span className="text-[10px] px-1.5 py-0.5 bg-success/15 text-success rounded">Configured</span>
              )}
            </label>
            <input
              type="password"
              value={resendApiKey}
              onChange={(e) => setResendApiKey(e.target.value)}
              placeholder={config.email.resendKeyConfigured ? `${config.email.resendKeyMasked} — leave blank to keep` : 're_xxxxxxxxxxxx'}
              className="w-full px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
            />
            <p className="text-[10px] text-text-muted mt-1">Get your API key from resend.com/api-keys. Required for welcome emails and password resets.</p>
          </div>

          <button
            onClick={() => testChannel('email')}
            disabled={testing === 'email'}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            {testing === 'email' ? <RefreshCw size={12} className="inline animate-spin mr-1" /> : <Check size={12} className="inline mr-1" />}
            Send test email
          </button>
        </div>

        {/* Push + Slack column */}
        <div className="space-y-4">
          {/* ntfy Push */}
          <div className="glass rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Smartphone size={16} className="text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">Push (ntfy)</h2>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={config.push.enabled === 'true'}
                  onChange={(e) => setConfig({ ...config, push: { ...config.push, enabled: e.target.checked ? 'true' : 'false' } })}
                  className="rounded"
                />
                <span className="text-text-secondary">Enabled</span>
              </label>
            </div>

            <div className="space-y-1">
              {config.push.topics.map((topic) => (
                <div key={topic} className="flex items-center justify-between px-3 py-1.5 bg-surface rounded text-sm">
                  <span className="text-text-primary font-mono">{topic}</span>
                  <button onClick={() => removeTopic(topic)} className="text-text-muted hover:text-danger"><X size={14} /></button>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTopic()}
                placeholder="nomus-alerts"
                className="flex-1 px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
              />
              <button onClick={addTopic} className="p-1.5 text-text-muted hover:text-accent"><Plus size={16} /></button>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1">ntfy Server URL</label>
              <input
                type="text"
                value={ntfyUrl}
                onChange={(e) => setNtfyUrl(e.target.value)}
                placeholder="https://ntfy.sh"
                className="w-full px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
              />
            </div>

            <p className="text-[10px] text-text-muted">Free push notifications. Install the ntfy app on your phone to receive alerts.</p>

            <button
              onClick={() => testChannel('push')}
              disabled={testing === 'push'}
              className="text-xs text-accent hover:underline disabled:opacity-50"
            >
              {testing === 'push' ? <RefreshCw size={12} className="inline animate-spin mr-1" /> : <Check size={12} className="inline mr-1" />}
              Send test push
            </button>
          </div>

          {/* Slack */}
          <div className="glass rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <MessageSquare size={16} className="text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Slack</h2>
              {config.slack.configured && (
                <span className="text-[10px] px-1.5 py-0.5 bg-success/15 text-success rounded">Connected</span>
              )}
            </div>

            <input
              type="password"
              value={slackWebhook}
              onChange={(e) => setSlackWebhook(e.target.value)}
              placeholder={config.slack.configured ? 'Webhook configured — leave blank to keep' : 'https://hooks.slack.com/services/...'}
              className="w-full px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
            />

            <p className="text-[10px] text-text-muted">
              Slack webhooks are free. Create one at your-workspace.slack.com/apps → Incoming Webhooks.
              All events are sent to Slack when configured.
            </p>

            <button
              onClick={() => testChannel('slack')}
              disabled={testing === 'slack' || !config.slack.configured}
              className="text-xs text-accent hover:underline disabled:opacity-50"
            >
              {testing === 'slack' ? <RefreshCw size={12} className="inline animate-spin mr-1" /> : <Check size={12} className="inline mr-1" />}
              Send test message
            </button>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 justify-start">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2.5 bg-accent text-accent-text font-semibold rounded-lg hover:bg-accent-hover hover:shadow-lg hover:shadow-accent/20 active:scale-[0.98] transition disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {message && (
          <span className={`text-sm ${message.includes('Failed') || message.includes('failed') ? 'text-danger' : 'text-success'}`}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
