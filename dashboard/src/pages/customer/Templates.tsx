import { useState, useEffect } from 'react';
import {
  MessageSquare, Sparkles, TrendingUp, Eye, DollarSign,
  Shield, Globe, BookOpen, ChevronRight, Search, Loader2,
} from 'lucide-react';
import api from '../../api/client';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';

interface Template {
  id: string;
  name: string;
  description: string;
  useCase: string;
  jurisdictions: string[];
  icon: string;
  ruleCount: number;
}

interface TemplateDetail extends Template {
  severityCounts: Record<string, number>;
  rules: Array<{
    id: string;
    ruleKey: string;
    jurisdiction: string;
    severity: string;
    effect: string;
    humanSummary: string | null;
  }>;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  MessageSquare: <MessageSquare size={24} />,
  Sparkles: <Sparkles size={24} />,
  TrendingUp: <TrendingUp size={24} />,
  Eye: <Eye size={24} />,
  DollarSign: <DollarSign size={24} />,
  Shield: <Shield size={24} />,
  Globe: <Globe size={24} />,
  BookOpen: <BookOpen size={24} />,
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/15 text-danger',
  high: 'bg-warning/15 text-warning',
  medium: 'bg-accent/15 text-accent',
  low: 'bg-text-muted/15 text-text-muted',
};

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  function fetchTemplates() {
    api.get('/templates').then((r) => {
      setTemplates(r.data.templates);
    }).catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load templates')))
      .finally(() => setLoading(false));
  }

  function load() {
    setLoading(true);
    setLoadError(null);
    fetchTemplates();
  }

  useEffect(() => {
    fetchTemplates();
  }, []);

  async function selectTemplate(id: string) {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const r = await api.get(`/templates/${id}`);
      setSelected(r.data);
    } catch (err) {
      setDetailError(apiErrorMessage(err, 'Failed to load template details'));
    }
    setDetailLoading(false);
  }

  const filtered = templates.filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()),
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-accent" size={24} />
      </div>
    );
  }

  if (loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Compliance Templates</h1>
        <p className="text-sm text-text-muted mt-1">
          Pre-built rule sets for common AI use cases. Select a template to see which regulatory obligations apply.
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates..."
          className="w-full pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((t) => (
          <button
            key={t.id}
            onClick={() => selectTemplate(t.id)}
            className={`text-left p-5 rounded-xl border transition-all hover:border-accent/50 hover:shadow-md ${
              selected?.id === t.id ? 'border-accent bg-accent/5' : 'border-border bg-surface'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="w-10 h-10 rounded-lg bg-accent-dim flex items-center justify-center text-accent shrink-0">
                {ICON_MAP[t.icon] ?? <Shield size={24} />}
              </div>
              <ChevronRight size={16} className="text-text-muted mt-1" />
            </div>
            <h3 className="text-sm font-semibold text-text-primary mt-3">{t.name}</h3>
            <p className="text-xs text-text-muted mt-1.5 line-clamp-2">{t.description}</p>
            <div className="flex items-center gap-3 mt-3">
              <span className="text-xs font-medium text-accent">{t.ruleCount} rules</span>
              <span className="text-xs text-text-muted">{t.jurisdictions.join(', ')}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Detail panel */}
      {detailError && !detailLoading && <ErrorState compact message={detailError} />}

      {detailLoading && (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="animate-spin text-accent" size={20} />
        </div>
      )}

      {selected && !detailLoading && (
        <div className="glass rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">{selected.name}</h2>
              <p className="text-sm text-text-muted mt-1">{selected.description}</p>
            </div>
            <button onClick={() => setSelected(null)} className="text-xs text-text-muted hover:text-text-primary transition">
              Close
            </button>
          </div>

          {/* Severity breakdown */}
          <div className="flex gap-3">
            {Object.entries(selected.severityCounts).map(([sev, count]) => (
              <span key={sev} className={`px-2.5 py-1 rounded-full text-xs font-medium ${SEVERITY_COLORS[sev] ?? ''}`}>
                {count} {sev}
              </span>
            ))}
          </div>

          {/* Rules table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-text-muted text-xs">
                  <th className="text-left py-2 pr-4">Rule</th>
                  <th className="text-left py-2 pr-4">Jurisdiction</th>
                  <th className="text-left py-2 pr-4">Severity</th>
                  <th className="text-left py-2 pr-4">Effect</th>
                  <th className="text-left py-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {selected.rules.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-surface-hover/50">
                    <td className="py-2 pr-4 font-mono text-xs text-accent">{r.ruleKey}</td>
                    <td className="py-2 pr-4 text-xs">{r.jurisdiction}</td>
                    <td className="py-2 pr-4">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${SEVERITY_COLORS[r.severity] ?? ''}`}>
                        {r.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-text-muted">{r.effect}</td>
                    <td className="py-2 text-xs text-text-secondary max-w-md truncate">{r.humanSummary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected.rules.length >= 100 && (
            <p className="text-xs text-text-muted">Showing first 100 rules. Use the API for the full list.</p>
          )}
        </div>
      )}
    </div>
  );
}
