import { useEffect, useState } from 'react';
import { ShieldCheck, FileText, ClipboardCheck, AlertTriangle, Globe, Radio } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { JURISDICTIONS } from '@nomus/shared';
import Card from '../../components/ui/Card';
import Spinner from '../../components/ui/Spinner';
import ScoreGauge from '../../components/charts/ScoreGauge';
import AttestationRow from '../../components/domain/AttestationRow';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface ImpactEntry {
  jurisdiction: string;
  industry: string;
  ruleCount: number;
  maxSeverity: string;
}

interface RadarSignal {
  id: string;
  title: string;
  jurisdiction: string;
  stage: string;
  likelihood: string;
}

function jurisdictionLabel(code: string): string {
  return (JURISDICTIONS as Record<string, string>)[code] ?? code;
}

const severityRank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

const severityColors: Record<string, string> = {
  critical: 'bg-danger/15 text-danger',
  high: 'bg-warning/15 text-warning',
  medium: 'bg-accent/15 text-accent',
  low: 'bg-success/15 text-success',
};

interface CustomerStats {
  policyCount: number;
  attestationCount: number;
  recentAttestations: Array<{
    id: string;
    result: string;
    jurisdiction: string;
    actionContext: Record<string, string>;
    evaluatedAt: string;
  }>;
  /** Share of the recent attestations whose obligations are clear (-1: none yet). */
  clearRate: number;
  /** The organization's compliance score, as on the Compliance Posture page (null if unavailable). */
  complianceScore: number | null;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-lg bg-accent-dim text-accent">{icon}</div>
        <p className="text-sm text-text-muted">{label}</p>
      </div>
      <p className="text-4xl font-bold text-text-primary text-center">{value}</p>
    </Card>
  );
}

export default function CustomerDashboard() {
  const [stats, setStats] = useState<CustomerStats | null>(null);
  const [impactMap, setImpactMap] = useState<ImpactEntry[]>([]);
  const [hasIndustry, setHasIndustry] = useState<boolean | null>(null);
  const [signals, setSignals] = useState<RadarSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [signalsError, setSignalsError] = useState<string | null>(null);
  const [orgFailed, setOrgFailed] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    async function load() {
      try {
        const [policyHash, attestations, orgRes, scoreRes] = await Promise.all([
          // The active-rule count; GET /policies returns at most one page of rules.
          api.get('/policies/hash'),
          api.get('/attestations', { params: { limit: 10 } }),
          api.get('/org').catch(() => {
            setOrgFailed(true);
            return { data: {} as { industry?: string | null } };
          }),
          // Same score as the Compliance Posture page, so the two never disagree.
          api.get('/compliance/score').catch(() => ({ data: null as { overallScore?: number } | null })),
        ]);

        const atts: CustomerStats['recentAttestations'] = Array.isArray(attestations.data?.attestations)
          ? attestations.data.attestations
          : [];
        const compliant = atts.filter((a: { result: string }) => a.result === 'compliant').length;
        const rate = atts.length > 0 ? Math.round((compliant / atts.length) * 100) : -1; // -1 = not yet assessed
        const score = scoreRes.data?.overallScore;

        setStats({
          policyCount: policyHash.data?.ruleCount ?? 0,
          attestationCount: attestations.data?.total ?? attestations.data?.count ?? atts.length,
          recentAttestations: atts,
          clearRate: rate,
          complianceScore: typeof score === 'number' ? Math.round(score) : null,
        });

        const orgIndustry = orgRes.data?.industry;
        setHasIndustry(!!orgIndustry);
        setFetchedAt(new Date().toISOString());

        // Load impact map
        try {
          setImpactError(null);
          const impactRes = await api.get('/policies/impact-map');
          // The API returns { matrix: [...], industries, jurisdictions }
          const matrix = impactRes.data?.matrix;
          let entries: ImpactEntry[] = Array.isArray(matrix) ? matrix : [];
          if (orgIndustry) {
            entries = entries.filter((e) => e.industry === orgIndustry || e.industry === 'all');
          }
          // One card per jurisdiction: combine industries, keep the worst severity
          const byJurisdiction = new Map<string, ImpactEntry>();
          for (const e of entries) {
            const existing = byJurisdiction.get(e.jurisdiction);
            if (!existing) {
              byJurisdiction.set(e.jurisdiction, { ...e });
              continue;
            }
            existing.ruleCount += e.ruleCount;
            if ((severityRank[e.maxSeverity] ?? 0) > (severityRank[existing.maxSeverity] ?? 0)) {
              existing.maxSeverity = e.maxSeverity;
            }
          }
          setImpactMap([...byJurisdiction.values()].sort((a, b) => b.ruleCount - a.ruleCount));
        } catch (err) {
          setImpactError(apiErrorMessage(err, 'Failed to load regulation impact data'));
        }

        // Load recent radar signals
        try {
          setSignalsError(null);
          const radarRes = await api.get('/radar', { params: { limit: 5 } });
          const raw = radarRes.data?.signals ?? radarRes.data?.items ?? radarRes.data;
          setSignals(Array.isArray(raw) ? raw.slice(0, 5) : []);
        } catch (err) {
          setSignalsError(apiErrorMessage(err, 'Failed to load regulatory signals'));
        }
      } catch (err) {
        setError(apiErrorMessage(err, 'Failed to load dashboard data. Please try again.'));
      }
    }
    load();
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <p className="text-sm text-danger">{error}</p>
        <button
          onClick={() => { setError(null); window.location.reload(); }}
          className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!stats) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <h1 className="text-xl font-semibold text-text-primary">Compliance Dashboard</h1>
        <DataFreshness
          fetchedAt={fetchedAt}
          dataTimestamp={stats.recentAttestations.reduce<string | null>((max, a) => {
            if (!a.evaluatedAt || Number.isNaN(new Date(a.evaluatedAt).getTime())) return max;
            return !max || new Date(a.evaluatedAt) > new Date(max) ? a.evaluatedAt : max;
          }, null)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-8">
        <Card className="lg:col-span-1 flex justify-center py-6" glow>
          <ScoreGauge score={stats.complianceScore ?? 0} />
          {stats.complianceScore === null && (
            <p className="text-xs text-text-muted mt-2 text-center">Score unavailable</p>
          )}
        </Card>
        <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard icon={<FileText size={18} />} label="Active Policies" value={stats.policyCount} />
          <StatCard icon={<ClipboardCheck size={18} />} label="Attestations" value={stats.attestationCount} />
          <StatCard
            icon={stats.clearRate >= 80 ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}
            label={`Obligations clear (last ${stats.recentAttestations.length})`}
            value={stats.clearRate < 0 ? 'N/A' : `${stats.clearRate}%`}
          />
        </div>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-text-secondary mb-3">Recent Attestations</h2>
        {stats.recentAttestations.length === 0 ? (
          <EmptyState title="No attestations yet" description="Run your first compliance evaluation to see results here." />
        ) : (
          <div className="divide-y divide-border">
            {stats.recentAttestations.map((a) => (
              <AttestationRow key={a.id} {...a} />
            ))}
          </div>
        )}
      </Card>

      {/* Regulation Impact */}
      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-text-secondary mb-3 flex items-center gap-2">
          <Globe size={14} /> Regulation Impact
        </h2>
        {impactError ? (
          <ErrorState compact message={impactError} />
        ) : hasIndustry === false && !orgFailed ? (
          <p className="text-sm text-text-muted">Set your industry in Settings to see regulations that impact your business.</p>
        ) : impactMap.length === 0 ? (
          <p className="text-sm text-text-muted">No regulation impact data yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {impactMap.map((entry, i) => (
              <button
                key={i}
                onClick={() => navigate(`/policies?jurisdiction=${entry.jurisdiction}`)}
                className="text-left border border-border rounded-lg p-3 hover:bg-surface-hover transition"
              >
                <p className="text-sm font-medium text-text-primary">{jurisdictionLabel(entry.jurisdiction)}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-text-muted">{entry.ruleCount} rules</span>
                  {entry.maxSeverity && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${severityColors[entry.maxSeverity] || 'bg-surface-hover text-text-muted'}`}>
                      {entry.maxSeverity}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Recent Regulatory Signals */}
      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-text-secondary mb-3 flex items-center gap-2">
          <Radio size={14} /> Recent Regulatory Signals
        </h2>
        {signalsError ? (
          <ErrorState compact message={signalsError} />
        ) : signals.length === 0 ? (
          <p className="text-sm text-text-muted">No recent signals detected.</p>
        ) : (
          <div className="divide-y divide-border">
            {signals.map((s) => (
              <div key={s.id} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary truncate">{s.title}</p>
                  <p className="text-xs text-text-muted">{s.jurisdiction}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-accent/15 text-accent font-medium">{s.stage}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-surface-hover text-text-secondary font-medium">{s.likelihood}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
