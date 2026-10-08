import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getPolicies, getIndustries, type Policy, type IndustrySummary } from '../../api/policies';
import PolicyCard from '../../components/domain/PolicyCard';
import Badge from '../../components/ui/Badge';
import { SkeletonTable } from '../../components/ui/Skeleton';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { apiErrorMessage } from '../../lib/errors';
import { JURISDICTIONS, CATEGORY_LABELS } from '@nomus/shared';

const INDUSTRY_LABELS: Record<string, string> = {
  all: 'All Industries', finance: 'Finance', healthcare: 'Healthcare',
  education: 'Education', employment: 'Employment', law_enforcement: 'Law Enforcement',
  critical_infrastructure: 'Critical Infrastructure', defense: 'Defense',
  telecom: 'Telecom', insurance: 'Insurance', transportation: 'Transportation',
  energy: 'Energy', agriculture: 'Agriculture', retail: 'Retail', media: 'Media',
  legal: 'Legal', government: 'Government', real_estate: 'Real Estate',
  pharma: 'Pharma', manufacturing: 'Manufacturing', cybersecurity: 'Cybersecurity',
  social_media: 'Social Media',
};

export default function Policies() {
  const [searchParams] = useSearchParams();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [industries, setIndustries] = useState<IndustrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jurisdiction, setJurisdiction] = useState(searchParams.get('jurisdiction') ?? '');
  const [category, setCategory] = useState(searchParams.get('category') ?? '');
  const [industry, setIndustry] = useState(searchParams.get('industry') ?? '');
  const [industriesError, setIndustriesError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  function loadIndustries() {
    setIndustriesError(null);
    getIndustries()
      .then((r) => setIndustries(r.industries))
      .catch((err) => setIndustriesError(apiErrorMessage(err, 'Failed to load industry filters')));
  }

  useEffect(() => {
    loadIndustries();
  }, []);

  function loadPolicies() {
    setError(null);
    setLoading(true);
    const params: Record<string, string> = {};
    if (jurisdiction) params.jurisdiction = jurisdiction;
    if (category) params.category = category;
    if (industry) params.industry = industry;
    getPolicies(params)
      .then((r) => {
        setPolicies(r.policies);
        setFetchedAt(new Date().toISOString());
        setLoading(false);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load policies.'));
        setLoading(false);
      });
  }

  useEffect(() => {
    loadPolicies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jurisdiction, category, industry]);

  // Real data timestamp: most recent policy rule update in the current result set
  const lastPolicyUpdate = policies.reduce<string | null>((max, p) => {
    if (!p.updatedAt || Number.isNaN(new Date(p.updatedAt).getTime())) return max;
    return !max || new Date(p.updatedAt) > new Date(max) ? p.updatedAt : max;
  }, null);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Policy Rules</h1>
          <DataFreshness fetchedAt={fetchedAt} dataTimestamp={lastPolicyUpdate} className="mt-1" />
        </div>
        <Badge variant="accent">{policies.length} rules</Badge>
      </div>

      {industriesError && <ErrorState compact message={industriesError} onRetry={loadIndustries} />}

      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <select
          value={jurisdiction}
          onChange={(e) => setJurisdiction(e.target.value)}
          className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
        >
          <option value="">All Jurisdictions</option>
          {Object.entries(JURISDICTIONS).map(([code, name]) => (
            <option key={code} value={code}>{code} — {name}</option>
          ))}
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
        >
          <option value="">All Categories</option>
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
        >
          <option value="">All Industries</option>
          {industries.filter((i) => i.name !== 'all').map((ind) => (
            <option key={ind.name} value={ind.name}>
              {INDUSTRY_LABELS[ind.name] ?? ind.name} ({ind.ruleCount})
            </option>
          ))}
        </select>
      </div>

      {/* Industry chips (quick filter) */}
      {industries.length > 1 && !industry && (
        <div className="flex gap-1.5 mb-4 flex-wrap">
          {industries.filter((i) => i.name !== 'all' && i.ruleCount > 0).slice(0, 12).map((ind) => (
            <button
              key={ind.name}
              onClick={() => setIndustry(ind.name)}
              className="px-2.5 py-1 text-xs rounded-full bg-surface border border-border text-text-secondary hover:bg-accent-dim hover:text-accent hover:border-accent-border transition"
            >
              {INDUSTRY_LABELS[ind.name] ?? ind.name}
              <span className="ml-1 text-text-muted">{ind.ruleCount}</span>
            </button>
          ))}
        </div>
      )}

      {/* Active industry filter indicator */}
      {industry && (
        <div className="flex items-center gap-2 mb-4">
          <Badge variant="accent">{INDUSTRY_LABELS[industry] ?? industry}</Badge>
          <button onClick={() => setIndustry('')} className="text-xs text-text-muted hover:text-text-primary">Clear</button>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={loadPolicies} />
      ) : loading ? (
        <SkeletonTable rows={8} />
      ) : policies.length === 0 ? (
        <EmptyState title="No policies found" description="Adjust filters or trigger a pipeline scrape to generate policies." />
      ) : (
        <div className="space-y-3">
          {policies.map((p) => (
            <PolicyCard
              key={p.id}
              ruleKey={p.ruleKey}
              jurisdiction={p.jurisdiction}
              category={p.category}
              effect={p.effect}
              severity={p.severity}
              humanSummary={p.humanSummary}
              legalReference={p.legalReference}
              version={p.version}
              industries={p.industries}
            />
          ))}
        </div>
      )}
    </div>
  );
}
