import { useState, useEffect } from 'react';
import { FlaskConical, Play, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';
import { formatDecimalUsd } from '../../lib/formatters';
import api from '../../api/client';

interface Simulation {
  id: string;
  signalTitle: string;
  signalJurisdiction: string;
  signalLikelihood: number;
  systemsAnalyzed: number;
  systemsImpacted: number;
  overallRiskLevel: string;
  estimatedRemediationCost: string | null;
  remediationRoadmap: Array<{ step: number; priority: string; estimatedDays: number; description: string }>;
  impactDetails: Array<{ systemId: string; systemName: string; impact: string; reason: string; remediationSteps: string[]; estimatedCost: string }>;
  status: string;
  completedAt: string | null;
  createdAt: string;
}

interface Signal {
  id: string;
  title: string;
  jurisdiction: string;
  stage: string;
  likelihoodPercent: number;
}

const riskColors: Record<string, string> = {
  critical: 'bg-danger/15 text-danger',
  high: 'bg-warning/15 text-warning',
  medium: 'bg-info/15 text-info',
  low: 'bg-accent/15 text-accent',
  none: 'bg-surface-hover text-text-muted',
};

const statusColors: Record<string, string> = {
  completed: 'bg-success/15 text-success',
  running: 'bg-warning/15 text-warning',
  pending: 'bg-info/15 text-info',
  failed: 'bg-danger/15 text-danger',
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

export default function Simulations() {
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(false);
  const [selectedSignal, setSelectedSignal] = useState('');
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signalsError, setSignalsError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  function fetchSimulations() {
    Promise.all([
      api.get('/simulations'),
      api.get('/radar').catch((err) => {
        setSignalsError(apiErrorMessage(err, 'Failed to load regulatory signals — signal picker unavailable'));
        return { data: { signals: [] } };
      }),
    ]).then(([simRes, sigRes]) => {
      setSimulations(simRes.data?.simulations ?? []);
      setTotalCount(simRes.data?.count ?? simRes.data?.simulations?.length ?? 0);
      setSignals(sigRes.data?.signals ?? []);
    }).catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load simulations')))
      .finally(() => setLoading(false));
  }

  function load() {
    setLoading(true);
    setLoadError(null);
    setSignalsError(null);
    fetchSimulations();
  }

  useEffect(() => {
    fetchSimulations();
  }, []);

  async function runSimulation() {
    if (!selectedSignal) return;
    setRunning(true);
    setRunError(null);
    try {
      await api.post('/simulations/run', { signalId: selectedSignal });
      setShowRun(false);
      setSelectedSignal('');
      load();
    } catch (err) {
      // Keep the form open so the selection isn't lost
      setRunError(apiErrorMessage(err, 'Failed to run simulation'));
    }
    setRunning(false);
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
            <FlaskConical size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Predictive Simulations</h1>
            <p className="text-sm text-text-muted">What happens to your AI systems if upcoming regulations pass?</p>
          </div>
        </div>
        <button
          onClick={() => setShowRun(!showRun)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-text font-semibold rounded-lg hover:opacity-90 transition"
        >
          <Play size={14} /> New Simulation
        </button>
      </div>

      {/* Run Form */}
      {showRun && (
        <div className="glass rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-text-primary mb-3">Simulate Regulatory Impact</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">Select Regulatory Signal</label>
              <select
                value={selectedSignal}
                onChange={(e) => setSelectedSignal(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
              >
                <option value="">-- Select a signal --</option>
                {signals.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({s.jurisdiction}, {s.likelihoodPercent}% likely)
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={runSimulation}
                disabled={running || !selectedSignal}
                className="px-5 py-2 bg-accent text-accent-text font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
              >
                {running ? 'Simulating...' : 'Run Simulation'}
              </button>
            </div>
          </div>
          {signalsError && <ErrorState compact message={signalsError} onRetry={load} />}
          {runError && <ErrorState compact message={runError} />}
          <p className="text-xs text-text-muted mt-3">
            Simulates the impact of the selected regulatory signal against your AI Bill of Materials.
          </p>
        </div>
      )}

      {/* Summary Stats */}
      {simulations.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Total Simulations</p>
            <p className="text-2xl font-semibold text-text-primary mt-1">{totalCount}</p>
          </div>
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Systems at Risk</p>
            <p className="text-2xl font-semibold text-warning mt-1">
              {new Set(simulations.flatMap((s) => s.impactDetails.filter((d) => d.impact !== 'none').map((d) => d.systemId))).size}
            </p>
          </div>
          <div className="glass rounded-xl p-5">
            <p className="text-xs text-text-muted">Critical Simulations</p>
            <p className="text-2xl font-semibold text-danger mt-1">
              {simulations.filter((s) => s.overallRiskLevel === 'critical').length}
            </p>
          </div>
        </div>
      )}

      {/* Simulation Results */}
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Simulation Results</h2>
        <div className="max-h-tile overflow-y-auto">
          {loadError ? (
            <ErrorState message={loadError} onRetry={load} />
          ) : simulations.length === 0 ? (
            <div className="text-center py-8">
              <AlertTriangle size={32} className="text-text-muted mx-auto mb-2" />
              <p className="text-sm text-text-muted">No simulations yet. Select a regulatory signal to simulate its impact.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {simulations.map((sim) => (
                <div key={sim.id} className="border border-border/50 rounded-lg p-4">
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setExpanded(expanded === sim.id ? null : sim.id)}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${riskColors[sim.overallRiskLevel]}`}>
                        {sim.overallRiskLevel}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-text-primary">{sim.signalTitle}</p>
                        <p className="text-xs text-text-muted">{sim.signalJurisdiction} — {sim.signalLikelihood}% likelihood</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${statusColors[sim.status]}`}>
                        {sim.status}
                      </span>
                      <span className="text-xs text-text-muted">
                        {sim.systemsImpacted}/{sim.systemsAnalyzed} systems impacted
                      </span>
                      <span className="text-xs text-text-muted">{timeAgo(sim.createdAt)}</span>
                      {expanded === sim.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>

                  {expanded === sim.id && (
                    <div className="mt-4 space-y-4">
                      {/* Impact Details */}
                      {sim.impactDetails.length > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold text-text-secondary mb-2">Impacted Systems</h3>
                          <div className="space-y-2">
                            {sim.impactDetails.map((d, i) => (
                              <div key={i} className="bg-surface rounded-lg p-3">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-text-primary">{d.systemName}</span>
                                  {d.estimatedCost && <span className="text-xs text-warning font-mono">{formatDecimalUsd(d.estimatedCost)}</span>}
                                </div>
                                <p className="text-xs text-text-secondary mb-2">
                                  <span className="font-medium capitalize">{d.impact} impact</span> — {d.reason}
                                </p>
                                {d.remediationSteps.length > 0 && (
                                  <ul className="text-xs text-text-muted space-y-0.5">
                                    {d.remediationSteps.map((step, j) => (
                                      <li key={j}>• {step}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Remediation Roadmap */}
                      {sim.remediationRoadmap.length > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold text-text-secondary mb-2">Remediation Roadmap</h3>
                          <div className="space-y-1">
                            {sim.remediationRoadmap.map((step, i) => (
                              <div key={i} className="flex items-center gap-3 text-xs">
                                <span className="w-6 h-6 rounded-full bg-accent-dim text-accent flex items-center justify-center font-semibold shrink-0">
                                  {step.step}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${step.priority === 'critical' || step.priority === 'high' ? 'bg-danger/15 text-danger' : step.priority === 'medium' ? 'bg-warning/15 text-warning' : 'bg-info/15 text-info'}`}>
                                  {step.priority}
                                </span>
                                <span className="text-text-secondary flex-1">{step.description}</span>
                                <span className="text-text-muted shrink-0">{step.estimatedDays}d</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {sim.estimatedRemediationCost && (
                        <p className="text-xs text-text-muted">
                          Estimated total remediation cost: <span className="text-warning font-semibold">{formatDecimalUsd(sim.estimatedRemediationCost)}</span>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
