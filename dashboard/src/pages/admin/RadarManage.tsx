import { useEffect, useState } from 'react';
import { Radar as RadarIcon, Plus, Trash2, Pencil, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import { getSignals, createSignal, updateSignal, deleteSignal, type RegulatorySignal } from '../../api/radar';
import { JURISDICTIONS } from '@nomus/shared';
import { formatDate } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';

const STAGES = ['signal', 'draft', 'committee', 'adopted', 'active'] as const;

export default function RadarManage() {
  const [signals, setSignals] = useState<RegulatorySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ title: '', jurisdiction: 'EU', stage: 'signal' as string, likelihoodPercent: 50, summary: '', sourceUrl: '', expectedEffectiveDate: '' });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  function fetchSignals() {
    getSignals()
      .then((r) => {
        setSignals(r.signals);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load signals.'));
      })
      .finally(() => {
        setLoading(false);
      });
  }

  function load() {
    setLoading(true);
    setError(null);
    fetchSignals();
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await createSignal({
        title: form.title,
        jurisdiction: form.jurisdiction,
        stage: form.stage,
        likelihoodPercent: form.likelihoodPercent,
        summary: form.summary,
        sourceUrl: form.sourceUrl || undefined,
        expectedEffectiveDate: form.expectedEffectiveDate || undefined,
      });
      setShowCreate(false);
      setForm({ title: '', jurisdiction: 'EU', stage: 'signal', likelihoodPercent: 50, summary: '', sourceUrl: '', expectedEffectiveDate: '' });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to create signal.'));
    }
    setCreating(false);
  }

  function openEdit(signal: RegulatorySignal) {
    setEditingId(signal.id);
    setForm({
      title: signal.title,
      jurisdiction: signal.jurisdiction,
      stage: signal.stage,
      likelihoodPercent: signal.likelihoodPercent,
      summary: signal.summary,
      sourceUrl: (signal as unknown as Record<string, unknown>).sourceUrl as string ?? '',
      expectedEffectiveDate: signal.expectedEffectiveDate ?? '',
    });
    setShowCreate(true);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    try {
      await updateSignal(editingId, {
        title: form.title,
        jurisdiction: form.jurisdiction,
        stage: form.stage as RegulatorySignal['stage'],
        likelihoodPercent: form.likelihoodPercent,
        summary: form.summary,
        sourceUrl: form.sourceUrl || undefined,
        expectedEffectiveDate: form.expectedEffectiveDate || undefined,
      });
      setShowCreate(false);
      setEditingId(null);
      setForm({ title: '', jurisdiction: 'EU', stage: 'signal', likelihoodPercent: 50, summary: '', sourceUrl: '', expectedEffectiveDate: '' });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to update signal.'));
    }
  }

  async function advanceStage(signal: RegulatorySignal) {
    const idx = STAGES.indexOf(signal.stage);
    if (idx < STAGES.length - 1) {
      try {
        await updateSignal(signal.id, { stage: STAGES[idx + 1] });
        load();
      } catch (err) {
        setError(apiErrorMessage(err, 'Failed to advance stage.'));
      }
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteSignal(id);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to delete signal.'));
    }
  }

  if (error && !loading && signals.length === 0) {
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
      {error && (
        <div className="mb-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-sm text-danger flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-xs underline ml-3">Dismiss</button>
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-dim">
            <RadarIcon size={20} className="text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary">Manage Regulatory Radar</h1>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus size={14} /> Add Signal
        </Button>
      </div>

      {showCreate && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">{editingId ? 'Edit Signal' : 'New Signal'}</h3>
            <button onClick={() => { setShowCreate(false); setEditingId(null); }} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
          </div>
          <form onSubmit={editingId ? handleUpdate : handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Title *</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="EU AI Act Amendment Proposal" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Jurisdiction</label>
                <select value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                  {Object.entries(JURISDICTIONS).map(([code, name]) => (
                    <option key={code} value={code}>{code} — {name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Summary *</label>
              <textarea value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} required rows={2}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary resize-none" placeholder="Description of the regulatory signal..." />
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Stage</label>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                  {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Likelihood %</label>
                <input type="number" min={0} max={100} value={form.likelihoodPercent}
                  onChange={(e) => setForm({ ...form, likelihoodPercent: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Source URL</label>
                <input value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="https://..." />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Expected Date</label>
                <input type="date" value={form.expectedEffectiveDate} onChange={(e) => setForm({ ...form, expectedEffectiveDate: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
              </div>
            </div>
            <Button type="submit" disabled={creating}>{creating ? 'Saving...' : editingId ? 'Update Signal' : 'Create Signal'}</Button>
          </form>
        </Card>
      )}

      {signals.length === 0 ? (
        <EmptyState title="No signals yet" description="Add regulatory signals to track upcoming regulations." />
      ) : (
        <div className="space-y-2">
          {signals.map((signal) => (
            <Card key={signal.id}>
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">{signal.title}</p>
                  <p className="text-xs text-text-secondary mt-0.5">{signal.summary}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <JurisdictionTag code={signal.jurisdiction} />
                    <Badge variant="accent">{signal.stage}</Badge>
                    <span className="text-xs text-text-muted">{signal.likelihoodPercent}% likely</span>
                    {signal.expectedEffectiveDate && (
                      <span className="text-xs text-text-muted">~{formatDate(signal.expectedEffectiveDate)}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => openEdit(signal)} className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition" title="Edit">
                    <Pencil size={14} />
                  </button>
                  {signal.stage !== 'active' && (
                    <Button variant="ghost" onClick={() => advanceStage(signal)} className="text-xs">
                      Advance →
                    </Button>
                  )}
                  <button onClick={() => handleDelete(signal.id)} className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition" title="Delete">
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
