import { useState, useEffect } from 'react';
import { BarChart3, Play, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface BenchmarkRun {
  id: string;
  modelName: string;
  provider: string;
  status: string;
  benchmarkSuite: string;
  benchmarksTotal: number;
  benchmarksPassed: number;
  benchmarksFailed: number;
  overallScore: number | null;
  resultsByPrinciple: Record<string, { score: number; benchmarks_run: number; passed: number; failed: number }>;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  durationMs: number | null;
  triggeredBy: string;
  createdAt: string;
  completedAt: string | null;
}

interface BenchmarkDef {
  id: string;
  name: string;
  principle: string;
  description: string;
  euAiActArticle: string | null;
}

interface PrincipleAverage {
  principle: string;
  avgScore: number;
}

/** GET /api/v1/benchmarks/summary */
interface Summary {
  modelsTested: number;
  averageScore: number | null;
  totalRuns: number;
  bestPrinciple: PrincipleAverage | null;
  worstPrinciple: PrincipleAverage | null;
}

const statusColors: Record<string, string> = {
  completed: 'bg-success/15 text-success',
  running: 'bg-warning/15 text-warning',
  pending: 'bg-info/15 text-info',
  failed: 'bg-danger/15 text-danger',
};

const principleColors: Record<string, string> = {
  fairness: 'text-accent',
  transparency: 'text-info',
  robustness: 'text-warning',
  privacy: 'text-danger',
  accountability: 'text-success',
  human_oversight: 'text-text-primary',
  accuracy: 'text-accent',
  societal_impact: 'text-warning',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Benchmarks() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [definitions, setDefinitions] = useState<BenchmarkDef[]>([]);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [showNewRun, setShowNewRun] = useState(false);
  const [newRun, setNewRun] = useState({ modelName: '', provider: 'openai' });
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  function fetchBenchmarks() {
    Promise.all([
      api.get('/benchmarks/summary').catch((err) => {
        setSummaryError(apiErrorMessage(err, 'Failed to load benchmark summary'));
        return { data: null };
      }),
      api.get('/benchmarks/definitions'),
      api.get('/benchmarks/runs'),
    ]).then(([summaryRes, defsRes, runsRes]) => {
      if (summaryRes.data) setSummary(summaryRes.data);
      setDefinitions(defsRes.data?.definitions ?? []);
      setRuns(runsRes.data?.runs ?? []);
    }).catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load benchmarks')))
      .finally(() => setLoading(false));
  }

  function load() {
    setLoading(true);
    setLoadError(null);
    setSummaryError(null);
    fetchBenchmarks();
  }

  useEffect(() => {
    fetchBenchmarks();
  }, []);

  async function startBenchmark() {
    if (!newRun.modelName) return;
    setStarting(true);
    setStartError(null);
    try {
      await api.post('/benchmarks/run', newRun);
      setShowNewRun(false);
      setNewRun({ modelName: '', provider: 'openai' });
      load();
    } catch (err) {
      // Keep the form open so the input isn't lost
      setStartError(apiErrorMessage(err, 'Failed to start benchmark run'));
    }
    setStarting(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 animate-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-dim text-accent">
            <BarChart3 size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">COMPL-AI Benchmarks</h1>
            <p className="text-sm text-text-muted">EU AI Act compliance benchmarking — runs on your infrastructure</p>
          </div>
        </div>
        <button
          onClick={() => setShowNewRun(!showNewRun)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-text font-semibold rounded-lg hover:opacity-90 transition"
        >
          <Play size={14} /> Run Benchmark
        </button>
      </div>

      {/* New Run Form */}
      {showNewRun && (
        <div className="glass rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-text-primary mb-3">New Benchmark Run</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">Model Name</label>
              <input
                type="text"
                value={newRun.modelName}
                onChange={(e) => setNewRun({ ...newRun, modelName: e.target.value })}
                placeholder="e.g. gpt-4, claude-3.5-sonnet"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm font-mono focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Provider</label>
              <select
                value={newRun.provider}
                onChange={(e) => setNewRun({ ...newRun, provider: e.target.value })}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google AI</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={startBenchmark}
                disabled={starting || !newRun.modelName}
                className="px-5 py-2 bg-accent text-accent-text font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
              >
                {starting ? 'Starting...' : 'Start'}
              </button>
            </div>
          </div>
          {startError && <ErrorState compact message={startError} />}
          <p className="text-xs text-text-muted mt-3">
            Nomus records the run; it never calls a model. Run the benchmarks with your own evaluation harness, then upload the
            scores to the run with <code className="font-mono">PATCH /api/v1/benchmarks/runs/&lt;run id&gt;/results</code> (an API key with
            the read:policies scope). The run stays pending until results arrive.
          </p>
        </div>
      )}

      {loadError && <ErrorState message={loadError} onRetry={load} />}
      {!loadError && summaryError && <ErrorState compact message={summaryError} onRetry={load} />}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Models Tested</p>
            <p className="text-2xl font-semibold text-text-primary mt-1">{summary.modelsTested}</p>
          </div>
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Average Score</p>
            <p className="text-2xl font-semibold text-text-primary mt-1">
              {summary.averageScore != null ? `${summary.averageScore.toFixed(1)}%` : '—'}
            </p>
          </div>
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Strongest Principle</p>
            <p className={`text-lg font-semibold mt-1 ${principleColors[summary.bestPrinciple?.principle ?? ''] ?? 'text-text-primary'}`}>
              {summary.bestPrinciple
                ? `${summary.bestPrinciple.principle.replace(/_/g, ' ')} (${summary.bestPrinciple.avgScore.toFixed(0)}%)`
                : '—'}
            </p>
          </div>
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Weakest Principle</p>
            <p className={`text-lg font-semibold mt-1 ${principleColors[summary.worstPrinciple?.principle ?? ''] ?? 'text-danger'}`}>
              {summary.worstPrinciple
                ? `${summary.worstPrinciple.principle.replace(/_/g, ' ')} (${summary.worstPrinciple.avgScore.toFixed(0)}%)`
                : '—'}
            </p>
          </div>
        </div>
      )}

      {/* Benchmark Runs */}
      <div className="glass rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-secondary">Benchmark Runs</h2>
          <button onClick={load} className="text-text-muted hover:text-text-primary transition"><RefreshCw size={14} /></button>
        </div>
        <div className="max-h-tile overflow-y-auto">
          {runs.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center">No benchmark runs yet. Start your first benchmark above.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div key={run.id} className="border border-border/50 rounded-lg p-3">
                  <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-text-primary">{run.modelName}</span>
                      <span className="text-xs text-text-muted">{run.provider}</span>
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${statusColors[run.status] ?? ''}`}>
                        {run.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {run.overallScore != null && (
                        <span className="text-sm font-semibold text-accent">{run.overallScore.toFixed(1)}%</span>
                      )}
                      <span className="text-xs text-text-muted">{timeAgo(run.createdAt)}</span>
                      {expandedRun === run.id ? <ChevronUp size={14} className="text-text-muted" /> : <ChevronDown size={14} className="text-text-muted" />}
                    </div>
                  </div>
                  {expandedRun === run.id && run.status !== 'completed' && (
                    <p className="mt-3 text-xs text-text-muted">
                      Awaiting results. Upload them with{' '}
                      <code className="font-mono text-text-secondary">PATCH /api/v1/benchmarks/runs/{run.id}/results</code>
                    </p>
                  )}
                  {expandedRun === run.id && run.resultsByPrinciple && (
                    <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                      {Object.entries(run.resultsByPrinciple).map(([principle, data]) => (
                        <div key={principle} className="bg-surface rounded-lg p-2">
                          <p className={`text-xs font-medium ${principleColors[principle] ?? 'text-text-secondary'}`}>
                            {principle.replace(/_/g, ' ')}
                          </p>
                          <p className="text-lg font-semibold text-text-primary">{data.score?.toFixed(0)}%</p>
                          <p className="text-[10px] text-text-muted">{data.passed}/{data.benchmarks_run} passed</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Benchmark Definitions */}
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">
          Benchmark Suite ({definitions.length} benchmarks)
        </h2>
        <div className="max-h-tile overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-muted text-xs border-b border-border">
                <th className="text-left py-2 font-medium">Benchmark</th>
                <th className="text-left py-2 font-medium">Principle</th>
                <th className="text-left py-2 font-medium">EU AI Act</th>
              </tr>
            </thead>
            <tbody>
              {definitions.map((d) => (
                <tr key={d.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2">
                    <p className="text-text-primary">{d.name}</p>
                    <p className="text-xs text-text-muted">{d.description.slice(0, 80)}...</p>
                  </td>
                  <td className="py-2">
                    <span className={`text-xs font-medium ${principleColors[d.principle] ?? 'text-text-secondary'}`}>
                      {d.principle.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-text-muted">{d.euAiActArticle ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
