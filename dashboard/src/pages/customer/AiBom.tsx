import { Fragment, useEffect, useState } from 'react';
import {
  ShieldCheck, Plus, Wand2, Download, FileJson,
  ChevronDown, ChevronUp, Pencil, Trash2, X,
  Bot, Brain, Cpu, Globe, Server,
} from 'lucide-react';
import api from '../../api/client';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { apiErrorMessage } from '../../lib/errors';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type RiskLevel = 'unacceptable' | 'high' | 'limited' | 'minimal' | 'unclassified';
type DeploymentType = 'cloud' | 'on-premise' | 'hybrid' | 'edge';
type SystemType = 'model' | 'agent' | 'pipeline' | 'integration' | 'other';

interface AiSystem {
  id: string;
  name: string;
  description: string;
  systemType: SystemType;
  provider: string;
  modelName: string;
  version: string;
  purpose: string;
  capabilities: string[];
  jurisdictions: string[];
  riskClassification: RiskLevel;
  euAiActCategory: string;
  deploymentType: DeploymentType;
  dataFlows: string[];
  regulatoryTags: string[];
  createdAt: string;
  updatedAt: string;
}

interface BomSummary {
  total: number;
  highRisk: number;
  jurisdictions: number;
  complianceScore: number;
}

interface BomData {
  systems: AiSystem[];
  summary: BomSummary;
}

const EMPTY_FORM: Omit<AiSystem, 'id' | 'createdAt' | 'updatedAt' | 'dataFlows' | 'regulatoryTags'> = {
  name: '',
  description: '',
  systemType: 'model',
  provider: '',
  modelName: '',
  version: '',
  purpose: '',
  capabilities: [],
  jurisdictions: [],
  riskClassification: 'unclassified',
  euAiActCategory: '',
  deploymentType: 'cloud',
};

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const RISK_BADGE: Record<RiskLevel, { variant: 'danger' | 'warning' | 'info' | 'accent' | 'default'; label: string }> = {
  unacceptable: { variant: 'danger', label: 'Unacceptable' },
  high: { variant: 'warning', label: 'High' },
  limited: { variant: 'info', label: 'Limited' },
  minimal: { variant: 'accent', label: 'Minimal' },
  unclassified: { variant: 'default', label: 'Unclassified' },
};

const SYSTEM_TYPE_ICONS: Record<SystemType, React.ReactNode> = {
  model: <Brain size={14} />,
  agent: <Bot size={14} />,
  pipeline: <Server size={14} />,
  integration: <Globe size={14} />,
  other: <Cpu size={14} />,
};

const JURISDICTIONS = [
  'EU', 'US', 'UK', 'Canada', 'Australia', 'Japan', 'South Korea',
  'Singapore', 'Brazil', 'India', 'China', 'Global',
];

const SYSTEM_TYPES: { value: SystemType; label: string }[] = [
  { value: 'model', label: 'Model' },
  { value: 'agent', label: 'Agent' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'integration', label: 'Integration' },
  { value: 'other', label: 'Other' },
];

const RISK_LEVELS: { value: RiskLevel; label: string }[] = [
  { value: 'unacceptable', label: 'Unacceptable' },
  { value: 'high', label: 'High' },
  { value: 'limited', label: 'Limited' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'unclassified', label: 'Unclassified' },
];

const DEPLOYMENT_TYPES: { value: DeploymentType; label: string }[] = [
  { value: 'cloud', label: 'Cloud' },
  { value: 'on-premise', label: 'On-Premise' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'edge', label: 'Edge' },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AiBom() {
  const [data, setData] = useState<BomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [capInput, setCapInput] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    api.get('/ai-bom')
      .then((r) => {
        setData(r.data);
        setFetchedAt(new Date().toISOString());
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load AI Bill of Materials')))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // Initial mount: loadError already starts null, so no synchronous reset is
    // needed here (the retry path clears it via load()).
    api.get('/ai-bom')
      .then((r) => {
        setData(r.data);
        setFetchedAt(new Date().toISOString());
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load AI Bill of Materials')))
      .finally(() => setLoading(false));
  }, []);

  /* ---- Form helpers ---- */

  function openAdd() {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(system: AiSystem) {
    setForm({
      name: system.name,
      description: system.description,
      systemType: system.systemType,
      provider: system.provider,
      modelName: system.modelName,
      version: system.version,
      purpose: system.purpose,
      capabilities: [...system.capabilities],
      jurisdictions: [...system.jurisdictions],
      riskClassification: system.riskClassification,
      euAiActCategory: system.euAiActCategory,
      deploymentType: system.deploymentType,
    });
    setEditingId(system.id);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setCapInput('');
    setFormError(null);
  }

  async function saveSystem() {
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await api.put(`/ai-bom/${editingId}`, form);
      } else {
        await api.post('/ai-bom', form);
      }
      closeForm();
      load();
    } catch (err) {
      // Keep the form open so the input isn't lost
      setFormError(apiErrorMessage(err, 'Failed to save AI system'));
    }
    setSaving(false);
  }

  async function deleteSystem(id: string) {
    if (!confirm('Delete this AI system from the bill of materials?')) return;
    setActionError(null);
    try {
      await api.delete(`/ai-bom/${id}`);
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to delete AI system'));
    }
  }

  async function generateFromScans() {
    setGenerating(true);
    setActionError(null);
    try {
      await api.post('/ai-bom/generate');
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to generate BOM from scans'));
    }
    setGenerating(false);
  }

  function exportJson() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-bom-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportPdf() {
    try {
      const response = await api.get('/ai-bom/export/pdf', { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-bom-${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to export PDF'));
    }
  }

  function addCapability() {
    const trimmed = capInput.trim();
    if (!trimmed || form.capabilities.includes(trimmed)) return;
    setForm((f) => ({ ...f, capabilities: [...f.capabilities, trimmed] }));
    setCapInput('');
  }

  function removeCapability(cap: string) {
    setForm((f) => ({ ...f, capabilities: f.capabilities.filter((c) => c !== cap) }));
  }

  function toggleJurisdiction(j: string) {
    setForm((f) => ({
      ...f,
      jurisdictions: f.jurisdictions.includes(j)
        ? f.jurisdictions.filter((x) => x !== j)
        : [...f.jurisdictions, j],
    }));
  }

  /* ---- Render helpers ---- */

  const inputCls =
    'w-full text-sm bg-surface border border-border rounded-lg px-3 py-2 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition';

  const summary = data?.summary ?? { total: 0, highRisk: 0, jurisdictions: 0, complianceScore: 0 };

  // Real data timestamp: most recent system update in the BOM (if any)
  const lastDataUpdate = data && data.systems.length > 0
    ? data.systems.reduce<string | null>((max, s) => {
        if (!s.updatedAt || Number.isNaN(new Date(s.updatedAt).getTime())) return max;
        return !max || new Date(s.updatedAt) > new Date(max) ? s.updatedAt : max;
      }, null)
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }

  return (
    <div className="p-6 animate-page">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <div className="p-2 rounded-lg bg-accent-dim text-accent">
          <ShieldCheck size={20} />
        </div>
        <h1 className="text-xl font-semibold text-text-primary">AI Bill of Materials</h1>
      </div>
      <p className="text-sm text-text-muted mb-1 ml-12">
        Inventory and risk classification of your AI systems (EU AI Act Article 11)
      </p>
      <DataFreshness fetchedAt={fetchedAt} dataTimestamp={lastDataUpdate} className="mb-6 ml-12" />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Total AI Systems</p>
          <p className="text-2xl font-bold text-text-primary mt-1">{summary.total}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">High Risk</p>
          <p className={`text-2xl font-bold mt-1 ${summary.highRisk > 0 ? 'text-danger' : 'text-text-primary'}`}>
            {summary.highRisk}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Jurisdictions</p>
          <p className="text-2xl font-bold text-text-primary mt-1">{summary.jurisdictions}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted uppercase tracking-wide">Compliance Score</p>
          <p className="text-2xl font-bold text-accent mt-1">{summary.complianceScore}%</p>
        </Card>
      </div>

      {/* Action Bar */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button onClick={openAdd} className="text-xs">
          <Plus size={14} /> Add System
        </Button>
        <Button variant="secondary" onClick={generateFromScans} disabled={generating} className="text-xs">
          <Wand2 size={14} /> {generating ? 'Generating...' : 'Generate from Scans'}
        </Button>
        <Button variant="secondary" onClick={exportJson} className="text-xs">
          <FileJson size={14} /> Export JSON
        </Button>
        <Button variant="secondary" onClick={exportPdf} className="text-xs">
          <Download size={14} /> Export PDF
        </Button>
      </div>

      {actionError && (
        <Card className="mb-6 border-danger/30">
          <ErrorState compact message={actionError} />
        </Card>
      )}

      {/* Add / Edit Form */}
      {showForm && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-text-secondary">
              {editingId ? 'Edit AI System' : 'Add AI System'}
            </h2>
            <button onClick={closeForm} className="text-text-muted hover:text-text-primary transition">
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Name */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className={inputCls}
                placeholder="e.g. Customer Support Chatbot"
              />
            </div>

            {/* System Type */}
            <div>
              <label className="block text-xs text-text-muted mb-1">System Type</label>
              <select
                value={form.systemType}
                onChange={(e) => setForm((f) => ({ ...f, systemType: e.target.value as SystemType }))}
                className={inputCls}
              >
                {SYSTEM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Provider */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Provider</label>
              <input
                value={form.provider}
                onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                className={inputCls}
                placeholder="e.g. OpenAI, Anthropic, Internal"
              />
            </div>

            {/* Model Name */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Model Name</label>
              <input
                value={form.modelName}
                onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
                className={inputCls}
                placeholder="e.g. gpt-4o, claude-3.5-sonnet"
              />
            </div>

            {/* Version */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Version</label>
              <input
                value={form.version}
                onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
                className={inputCls}
                placeholder="e.g. 1.0.0"
              />
            </div>

            {/* Deployment Type */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Deployment Type</label>
              <select
                value={form.deploymentType}
                onChange={(e) => setForm((f) => ({ ...f, deploymentType: e.target.value as DeploymentType }))}
                className={inputCls}
              >
                {DEPLOYMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Risk Classification */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Risk Classification</label>
              <select
                value={form.riskClassification}
                onChange={(e) => setForm((f) => ({ ...f, riskClassification: e.target.value as RiskLevel }))}
                className={inputCls}
              >
                {RISK_LEVELS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            {/* EU AI Act Category */}
            <div>
              <label className="block text-xs text-text-muted mb-1">EU AI Act Category</label>
              <input
                value={form.euAiActCategory}
                onChange={(e) => setForm((f) => ({ ...f, euAiActCategory: e.target.value }))}
                className={inputCls}
                placeholder="e.g. Annex III, Art. 6(2)"
              />
            </div>

            {/* Purpose (full width) */}
            <div className="md:col-span-2">
              <label className="block text-xs text-text-muted mb-1">Purpose</label>
              <input
                value={form.purpose}
                onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
                className={inputCls}
                placeholder="Describe the intended purpose of this AI system"
              />
            </div>

            {/* Description (full width) */}
            <div className="md:col-span-2">
              <label className="block text-xs text-text-muted mb-1">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className={`${inputCls} resize-none h-20`}
                placeholder="Detailed description of the AI system"
              />
            </div>

            {/* Capabilities (tag input, full width) */}
            <div className="md:col-span-2">
              <label className="block text-xs text-text-muted mb-1">Capabilities</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {form.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-accent-dim text-accent"
                  >
                    {cap}
                    <button
                      onClick={() => removeCapability(cap)}
                      className="hover:text-danger transition"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCapability();
                    }
                  }}
                  className={inputCls}
                  placeholder="Type a capability and press Enter"
                />
                <Button variant="secondary" onClick={addCapability} className="text-xs shrink-0">
                  Add
                </Button>
              </div>
            </div>

            {/* Jurisdictions (multi-select, full width) */}
            <div className="md:col-span-2">
              <label className="block text-xs text-text-muted mb-1">Jurisdictions</label>
              <div className="flex flex-wrap gap-2">
                {JURISDICTIONS.map((j) => (
                  <button
                    key={j}
                    type="button"
                    onClick={() => toggleJurisdiction(j)}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition ${
                      form.jurisdictions.includes(j)
                        ? 'bg-accent-dim text-accent border-accent'
                        : 'bg-surface text-text-muted border-border hover:border-text-muted'
                    }`}
                  >
                    {j}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {formError && <p className="text-sm text-danger mt-4" role="alert">{formError}</p>}

          {/* Save / Cancel */}
          <div className="flex items-center gap-2 mt-5">
            <Button onClick={saveSystem} disabled={saving || !form.name.trim()} className="text-xs">
              {saving ? 'Saving...' : editingId ? 'Update System' : 'Save System'}
            </Button>
            <Button variant="ghost" onClick={closeForm} className="text-xs">
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Systems Table */}
      {!data || data.systems.length === 0 ? (
        <EmptyState
          title="No AI systems registered"
          description="Add a system manually or generate from your scan results."
        />
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="max-h-tile overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Provider / Model</th>
                  <th className="px-4 py-3 font-medium">Risk Level</th>
                  <th className="px-4 py-3 font-medium">Jurisdictions</th>
                  <th className="px-4 py-3 font-medium">Deployment</th>
                  <th className="px-4 py-3 font-medium w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.systems.map((system) => {
                  const risk = RISK_BADGE[system.riskClassification] ?? RISK_BADGE.unclassified;
                  const expanded = expandedRow === system.id;
                  return (
                    <Fragment key={system.id}>
                      <tr
                        className="border-b border-border/50 hover:bg-surface-hover transition-colors cursor-pointer"
                        onClick={() => setExpandedRow(expanded ? null : system.id)}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 text-text-primary">
                            {SYSTEM_TYPE_ICONS[system.systemType] ?? SYSTEM_TYPE_ICONS.other}
                            <span className="font-medium">{system.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-text-secondary capitalize">{system.systemType}</td>
                        <td className="px-4 py-3 text-text-secondary">
                          {system.provider}{system.modelName ? ` / ${system.modelName}` : ''}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={risk.variant}>{risk.label}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {system.jurisdictions.slice(0, 3).map((j) => (
                              <span key={j} className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary">
                                {j}
                              </span>
                            ))}
                            {system.jurisdictions.length > 3 && (
                              <span className="text-xs text-text-muted">+{system.jurisdictions.length - 3}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-text-secondary capitalize">{system.deploymentType}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => openEdit(system)}
                              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition"
                              title="Edit"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => deleteSystem(system.id)}
                              className="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition"
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                            <button
                              onClick={() => setExpandedRow(expanded ? null : system.id)}
                              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition"
                            >
                              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded detail row */}
                      {expanded && (
                        <tr key={`${system.id}-detail`}>
                          <td colSpan={7} className="px-4 py-4 bg-surface-hover/50">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                              {/* Capabilities */}
                              <div>
                                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Capabilities</p>
                                {system.capabilities.length === 0 ? (
                                  <p className="text-xs text-text-muted">None listed</p>
                                ) : (
                                  <div className="flex flex-wrap gap-1.5">
                                    {system.capabilities.map((cap) => (
                                      <span
                                        key={cap}
                                        className="px-2 py-0.5 text-xs rounded-full bg-accent-dim text-accent"
                                      >
                                        {cap}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Data Flows */}
                              <div>
                                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Data Flows</p>
                                {(!system.dataFlows || system.dataFlows.length === 0) ? (
                                  <p className="text-xs text-text-muted">None documented</p>
                                ) : (
                                  <ul className="space-y-1">
                                    {system.dataFlows.map((flow, i) => (
                                      <li key={i} className="text-xs text-text-secondary">{flow}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>

                              {/* Regulatory Tags */}
                              <div>
                                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Regulatory Tags</p>
                                {(!system.regulatoryTags || system.regulatoryTags.length === 0) ? (
                                  <p className="text-xs text-text-muted">None assigned</p>
                                ) : (
                                  <div className="flex flex-wrap gap-1.5">
                                    {system.regulatoryTags.map((tag) => (
                                      <span
                                        key={tag}
                                        className="px-2 py-0.5 text-xs rounded-full bg-warning/15 text-warning"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Additional info row */}
                              <div className="md:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-4 pt-3 border-t border-border/50">
                                <div>
                                  <p className="text-xs text-text-muted">Purpose</p>
                                  <p className="text-xs text-text-primary mt-0.5">{system.purpose || 'Not specified'}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-text-muted">EU AI Act Category</p>
                                  <p className="text-xs text-text-primary mt-0.5">{system.euAiActCategory || 'Not classified'}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-text-muted">Version</p>
                                  <p className="text-xs text-text-primary mt-0.5">{system.version || 'N/A'}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-text-muted">Last Updated</p>
                                  <p className="text-xs text-text-primary mt-0.5">
                                    {system.updatedAt ? new Date(system.updatedAt).toLocaleDateString() : 'N/A'}
                                  </p>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
