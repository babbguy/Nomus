import { useEffect, useState, useMemo } from 'react';
import { Activity, Database, Users, Wifi } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface ImpactEntry {
  jurisdiction: string;
  industry: string;
  ruleCount: number;
  maxSeverity: string;
}

function heatColor(count: number): string {
  if (count === 0) return 'bg-surface-hover text-text-muted';
  if (count <= 5) return 'bg-success/15 text-success';
  if (count <= 15) return 'bg-warning/15 text-warning';
  return 'bg-danger/15 text-danger';
}

interface Stats {
  rules: number;
  sources: number;
  tenants: number;
  connectedClients: number;
  lastPipelineRun: { status: string; completedAt: string } | null;
  latestStateHash: { hash: string; ruleCount: number; computedAt: string } | null;
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${accent ? 'bg-accent-dim text-accent' : 'bg-surface-hover text-text-secondary'}`}>
          {icon}
        </div>
        <span className="text-sm text-text-secondary">{label}</span>
      </div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [impactMap, setImpactMap] = useState<ImpactEntry[]>([]);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);

  function fetchDashboard() {
    api.get('/dashboard/stats')
      .then((r) => setStats(r.data))
      .catch((err) => setStatsError(apiErrorMessage(err, 'Failed to load platform stats')));
    api.get('/policies/impact-map')
      .then((r) => setImpactMap(r.data?.matrix || []))
      .catch((err) => setImpactError(apiErrorMessage(err, 'Failed to load regulation impact map')));
  }

  function load() {
    setStatsError(null);
    setImpactError(null);
    fetchDashboard();
  }

  useEffect(() => {
    fetchDashboard();
  }, []);

  const { industries, jurisdictions, matrix } = useMemo(() => {
    const indSet = new Set<string>();
    const jurSet = new Set<string>();
    for (const e of impactMap) {
      indSet.add(e.industry);
      jurSet.add(e.jurisdiction);
    }
    const industries = Array.from(indSet).sort();
    const jurisdictions = Array.from(jurSet).sort();
    const matrix: Record<string, Record<string, number>> = {};
    for (const ind of industries) {
      matrix[ind] = {};
      for (const jur of jurisdictions) matrix[ind][jur] = 0;
    }
    for (const e of impactMap) {
      matrix[e.industry][e.jurisdiction] = e.ruleCount;
    }
    return { industries, jurisdictions, matrix };
  }, [impactMap]);

  if (statsError) {
    return <ErrorState message={statsError} onRetry={load} />;
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-text-primary mb-6">Platform Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={<Activity size={18} />} label="Policy Rules" value={stats.rules} accent />
        <StatCard icon={<Database size={18} />} label="Sources" value={stats.sources} />
        <StatCard icon={<Users size={18} />} label="Tenants" value={stats.tenants} />
        <StatCard icon={<Wifi size={18} />} label="Connected Clients" value={stats.connectedClients} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold text-text-secondary mb-3">Last Pipeline Run</h2>
          {stats.lastPipelineRun ? (
            <div>
              <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${
                stats.lastPipelineRun.status === 'completed' ? 'bg-success/15 text-success' :
                stats.lastPipelineRun.status === 'no_change' ? 'bg-info/15 text-info' :
                'bg-danger/15 text-danger'
              }`}>
                {stats.lastPipelineRun.status}
              </span>
              <p className="text-text-muted text-sm mt-1">
                {new Date(stats.lastPipelineRun.completedAt).toLocaleString()}
              </p>
            </div>
          ) : (
            <p className="text-text-muted text-sm">No pipeline runs yet</p>
          )}
        </div>

        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold text-text-secondary mb-3">Integrity Status</h2>
          {stats.latestStateHash ? (
            <div>
              <p className="font-mono text-xs text-accent break-all">{stats.latestStateHash.hash}</p>
              <p className="text-text-muted text-sm mt-1">
                {stats.latestStateHash.ruleCount} rules verified
              </p>
            </div>
          ) : (
            <p className="text-text-muted text-sm">No state hash computed yet</p>
          )}
        </div>
      </div>

      {/* Regulation Impact Heat Map */}
      <div className="glass rounded-xl p-5 mt-6">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Regulation Impact Overview</h2>
        {impactError ? (
          <ErrorState compact message={impactError} onRetry={load} />
        ) : industries.length === 0 ? (
          <p className="text-sm text-text-muted">No policy rules yet. Run the pipeline to populate the impact map.</p>
        ) : (
          <div className="max-h-tile overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-medium text-text-muted sticky left-0 bg-surface">Industry</th>
                  {jurisdictions.map((j) => (
                    <th key={j} className="text-center py-2 px-2 font-medium text-text-muted min-w-[60px]">{j}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {industries.map((ind) => (
                  <tr key={ind} className="border-b border-border/50">
                    <td className="py-2 px-2 text-text-primary font-medium sticky left-0 bg-surface whitespace-nowrap">{ind}</td>
                    {jurisdictions.map((jur) => {
                      const count = matrix[ind][jur];
                      return (
                        <td key={jur} className="py-1 px-1 text-center">
                          <span className={`inline-block w-full py-1 rounded text-xs font-medium ${heatColor(count)}`}>
                            {count || '-'}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
