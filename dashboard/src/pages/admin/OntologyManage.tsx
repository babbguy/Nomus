import { useEffect, useState } from 'react';
import { BookOpen, Plus, Check, X, Upload } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface OntologyTerm {
  id: string;
  term: string;
  type: string;
  jurisdiction: string;
  sourceArticle: string;
  description: string;
  isActive: boolean;
  createdAt: string;
}

const typeColors: Record<string, 'danger' | 'warning' | 'info' | 'success' | 'accent' | 'default'> = {
  obligation: 'danger',
  definition: 'info',
  risk_level: 'warning',
  technical_requirement: 'accent',
  penalty: 'danger',
  applicability: 'success',
};

export default function OntologyManage() {
  const [terms, setTerms] = useState<OntologyTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [stats, setStats] = useState<{ total: number; active: number; pendingReview: number } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTerm, setNewTerm] = useState({ term: '', type: 'definition', jurisdiction: '', source_article: '', description: '' });
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);

  const [error, setError] = useState<string | null>(null);

  function fetchOntology() {
    Promise.all([
      api.get('/admin/ontology', { params: { inactive: 'true' } }),
      api.get('/admin/ontology/stats'),
    ]).then(([termsRes, statsRes]) => {
      setTerms(termsRes.data.terms);
      setStats(statsRes.data);
    }).catch((err) => {
      setError(apiErrorMessage(err, 'Failed to load ontology data.'));
    }).finally(() => {
      setLoading(false);
    });
  }

  function load() {
    setLoading(true);
    setError(null);
    fetchOntology();
  }

  useEffect(() => {
    fetchOntology();
  }, []);

  async function toggleActive(id: string, isActive: boolean) {
    try {
      await api.patch(`/admin/ontology/${id}`, { isActive });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to update term.'));
    }
  }

  async function deleteTerm(id: string) {
    try {
      await api.delete(`/admin/ontology/${id}`);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to delete term.'));
    }
  }

  async function handleAddTerm(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/admin/ontology', newTerm);
      setShowAdd(false);
      setNewTerm({ term: '', type: 'definition', jurisdiction: '', source_article: '', description: '' });
      load();
    } catch (err) {
      // Keep the form open so the input isn't lost
      setError(apiErrorMessage(err, 'Failed to add term.'));
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      setError('Import failed: the selected file is not valid JSON.');
      e.target.value = '';
      return;
    }
    try {
      const { data: result } = await api.post('/admin/ontology/import', data);
      setImportResult(result);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to import ontology terms.'));
    }
    e.target.value = '';
  }

  const filtered = filter
    ? terms.filter((t) => t.type === filter)
    : terms;

  const pendingTerms = filtered.filter((t) => !t.isActive);
  const activeTerms = filtered.filter((t) => t.isActive);

  if (error && !loading && terms.length === 0) {
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
            <BookOpen size={20} className="text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Ontology Management</h1>
            <p className="text-sm text-text-secondary">Curated regulatory vocabulary — constrains LLM extraction</p>
          </div>
        </div>
        {stats && (
          <div className="flex gap-2">
            <Badge variant="accent">{stats.active} active</Badge>
            {stats.pendingReview > 0 && <Badge variant="warning">{stats.pendingReview} pending review</Badge>}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mb-4">
        <Button variant="primary" onClick={() => setShowAdd(true)} className="text-xs"><Plus size={14} /> Add Term</Button>
        <label className="cursor-pointer">
          <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-primary hover:bg-surface-hover transition">
            <Upload size={14} /> Import JSON
          </span>
        </label>
      </div>

      {/* Add Term Form */}
      {showAdd && (
        <Card className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Add Term</h3>
            <button onClick={() => setShowAdd(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
          </div>
          <form onSubmit={handleAddTerm} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input value={newTerm.term} onChange={(e) => setNewTerm({ ...newTerm, term: e.target.value })} required placeholder="Term name"
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:border-accent" />
            <select value={newTerm.type} onChange={(e) => setNewTerm({ ...newTerm, type: e.target.value })}
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
              {['obligation', 'definition', 'risk_level', 'technical_requirement', 'penalty', 'applicability'].map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <input value={newTerm.jurisdiction} onChange={(e) => setNewTerm({ ...newTerm, jurisdiction: e.target.value })} required placeholder="Jurisdiction (EU, US-FED, NIST...)"
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:border-accent" />
            <input value={newTerm.source_article} onChange={(e) => setNewTerm({ ...newTerm, source_article: e.target.value })} required placeholder="Source article (Art. 5, Sec. 4...)"
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:border-accent" />
            <textarea value={newTerm.description} onChange={(e) => setNewTerm({ ...newTerm, description: e.target.value })} required placeholder="Description"
              className="md:col-span-2 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:border-accent min-h-[60px]" />
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button variant="primary" type="submit">Add</Button>
            </div>
          </form>
        </Card>
      )}

      {importResult && (
        <div className="mb-4 p-3 bg-accent-dim border border-accent-border rounded-lg text-sm text-accent">
          Imported {importResult.imported} terms ({importResult.skipped} skipped)
          <button onClick={() => setImportResult(null)} className="ml-3 text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        <button onClick={() => setFilter('')} className={`px-3 py-1 text-xs rounded-lg border transition ${!filter ? 'bg-accent-dim text-accent border-accent-border' : 'bg-surface text-text-muted border-border'}`}>All</button>
        {['obligation', 'definition', 'risk_level', 'technical_requirement', 'penalty', 'applicability'].map((t) => (
          <button key={t} onClick={() => setFilter(t)} className={`px-3 py-1 text-xs rounded-lg border transition capitalize ${filter === t ? 'bg-accent-dim text-accent border-accent-border' : 'bg-surface text-text-muted border-border'}`}>
            {t.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {/* Pending Review */}
      {pendingTerms.length > 0 && (
        <Card className="mb-4 border-warning/30">
          <h3 className="text-sm font-semibold text-warning mb-3">Pending Review ({pendingTerms.length})</h3>
          <p className="text-xs text-text-muted mb-3">These terms were detected by the pipeline but aren't in the ontology. Approve or reject them.</p>
          <div className="space-y-2">
            {pendingTerms.map((t) => (
              <div key={t.id} className="flex items-center justify-between py-2 px-3 bg-surface rounded-lg">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{t.term}</span>
                    <Badge variant={typeColors[t.type] ?? 'default'}>{t.type.replace(/_/g, ' ')}</Badge>
                    <span className="text-xs text-text-muted">{t.jurisdiction}</span>
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5">{t.description}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => toggleActive(t.id, true)} className="p-1.5 rounded text-success hover:bg-success/10 transition" title="Approve"><Check size={14} /></button>
                  <button onClick={() => deleteTerm(t.id)} className="p-1.5 rounded text-danger hover:bg-danger/10 transition" title="Reject"><X size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Active Terms */}
      {activeTerms.length === 0 ? (
        <EmptyState title="No ontology terms yet" description="Import your ontology-seed.json via the API or add terms manually." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Term</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activeTerms.slice(0, 100).map((t) => (
                <tr key={t.id} className="hover:bg-surface-hover transition">
                  <td className="px-4 py-3 text-text-primary font-medium">{t.term}</td>
                  <td className="px-4 py-3"><Badge variant={typeColors[t.type] ?? 'default'}>{t.type.replace(/_/g, ' ')}</Badge></td>
                  <td className="px-4 py-3 text-text-secondary font-mono text-xs">{t.jurisdiction}</td>
                  <td className="px-4 py-3 text-text-muted text-xs">{t.sourceArticle}</td>
                  <td className="px-4 py-3 text-text-secondary text-xs max-w-xs truncate">{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
