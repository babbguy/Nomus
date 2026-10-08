import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar as RadarIcon, TrendingUp, TrendingDown, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';

import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { formatDate, formatRelative } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';
import {
  getBills,
  getRadarStats,
  getTopMovers,
  type TrackedBill,
  type RadarStats,
  type BillMover,
} from '../../api/radar-v2';

// ─── Stage Configuration ────────────────────────────────────────

const STAGES = [
  'rumor', 'introduced', 'committee', 'floor_vote',
  'passed_one_chamber', 'conference', 'enrolled', 'signed', 'enacted', 'dead',
] as const;

const stageLabels: Record<string, string> = {
  rumor: 'Rumor',
  introduced: 'Introduced',
  committee: 'Committee',
  floor_vote: 'Floor Vote',
  passed_one_chamber: 'Passed Chamber',
  conference: 'Conference',
  enrolled: 'Enrolled',
  signed: 'Signed',
  enacted: 'Enacted',
  dead: 'Dead',
};

function stageBadgeVariant(stage: string): 'default' | 'info' | 'warning' | 'success' | 'danger' | 'accent' {
  switch (stage) {
    case 'enacted':
    case 'signed': return 'success';
    case 'floor_vote':
    case 'conference': return 'warning';
    case 'dead': return 'danger';
    case 'introduced':
    case 'committee': return 'info';
    default: return 'default';
  }
}

// ─── Score Badge ────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-text-muted">--</span>;
  const variant = score >= 70 ? 'success' : score >= 40 ? 'warning' : 'danger';
  return <Badge variant={variant}>{score}%</Badge>;
}

// ─── Top Movers Widget (SD5) ────────────────────────────────────

function TopMoversWidget({ movers }: { movers: BillMover[] }) {
  const navigate = useNavigate();

  if (movers.length === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
        <TrendingUp size={16} className="text-accent" />
        Top Movers (7d)
      </h3>
      <div className="space-y-2">
        {movers.slice(0, 5).map((m) => (
          <button
            key={m.id}
            onClick={() => navigate(`/radar/v2/bills/${m.id}`)}
            className="w-full flex items-center justify-between gap-2 p-2 rounded-lg hover:bg-surface-hover transition text-left"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text-primary truncate">{m.title}</p>
              <p className="text-xs text-text-muted">{m.jurisdiction}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {m.change > 0 ? (
                <TrendingUp size={14} className="text-success" />
              ) : m.change < 0 ? (
                <TrendingDown size={14} className="text-danger" />
              ) : null}
              <span className={`text-sm font-medium ${m.change > 0 ? 'text-success' : m.change < 0 ? 'text-danger' : 'text-text-muted'}`}>
                {m.change > 0 ? '+' : ''}{m.change}
              </span>
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ─── Alerts Feed (SD6) ──────────────────────────────────────────

function AlertsFeed({ bills }: { bills: TrackedBill[] }) {
  // Show recent activity from all bills — stage changes and actions
  const recentBills = bills
    .filter((b) => b.lastActionDate)
    .sort((a, b) => (b.lastActionDate ?? '').localeCompare(a.lastActionDate ?? ''))
    .slice(0, 8);

  if (recentBills.length === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-3">Recent Activity</h3>
      <div className="space-y-2">
        {recentBills.map((b) => (
          <div key={b.id} className="flex items-center gap-2 text-xs">
            <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            <span className="text-text-secondary truncate flex-1">{b.title}</span>
            <Badge variant={stageBadgeVariant(b.currentStage)}>{stageLabels[b.currentStage] ?? b.currentStage}</Badge>
            {b.lastActionDate && <span className="text-text-muted shrink-0">{formatRelative(b.lastActionDate)}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Stats Bar ──────────────────────────────────────────────────

function StatsBar({ stats }: { stats: RadarStats }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <Card className="p-3 text-center">
        <p className="text-2xl font-bold text-text-primary">{stats.totalBills}</p>
        <p className="text-xs text-text-muted">Tracked Bills</p>
      </Card>
      <Card className="p-3 text-center">
        <p className="text-2xl font-bold text-text-primary">{Object.keys(stats.byJurisdiction).length}</p>
        <p className="text-xs text-text-muted">Jurisdictions</p>
      </Card>
      <Card className="p-3 text-center">
        <p className="text-2xl font-bold text-text-primary">{stats.avgScore}%</p>
        <p className="text-xs text-text-muted">Avg Passage Score</p>
      </Card>
      <Card className="p-3 text-center">
        <p className="text-2xl font-bold text-text-primary">{stats.byStage['enacted'] ?? 0}</p>
        <p className="text-xs text-text-muted">Enacted</p>
      </Card>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────

export default function RadarV2() {
  const navigate = useNavigate();
  const [bills, setBills] = useState<TrackedBill[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<RadarStats | null>(null);
  const [movers, setMovers] = useState<BillMover[]>([]);
  const [widgetsError, setWidgetsError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // Filters
  const [jurisdiction, setJurisdiction] = useState('');
  const [stage, setStage] = useState('');
  const [minScore, setMinScore] = useState(0);

  const loadBills = useCallback(() => {
    const params: Record<string, string | number> = { page, limit };
    if (jurisdiction) params.jurisdiction = jurisdiction;
    if (stage) params.stage = stage;
    if (minScore > 0) params.minScore = minScore;
    return getBills(params as Parameters<typeof getBills>[0])
      .then((r) => {
        setBills(r.bills);
        setTotal(r.total);
        setFetchedAt(new Date().toISOString());
        setError(null);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load tracked bills.'));
      })
      .finally(() => setLoading(false));
  }, [page, limit, jurisdiction, stage, minScore]);

  useEffect(() => { loadBills(); }, [loadBills]);

  const fetchWidgets = useCallback(() => {
    Promise.all([
      getRadarStats().then(setStats),
      getTopMovers({ days: 7, limit: 10 }).then((r) => setMovers(r.movers)),
    ]).catch((err) => setWidgetsError(apiErrorMessage(err, 'Failed to load radar stats and top movers')));
  }, []);

  const loadWidgets = useCallback(() => {
    setWidgetsError(null);
    fetchWidgets();
  }, [fetchWidgets]);

  useEffect(() => { fetchWidgets(); }, [fetchWidgets]);

  // Real data timestamp: most recent bill update in the current result set
  const lastBillUpdate = bills.reduce<string | null>((max, b) => {
    if (!b.updatedAt || Number.isNaN(new Date(b.updatedAt).getTime())) return max;
    return !max || new Date(b.updatedAt) > new Date(max) ? b.updatedAt : max;
  }, null);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (error) {
    return (
      <div className="flex flex-col items-center py-20 gap-3">
        <p className="text-sm text-danger">{error}</p>
        <button onClick={() => { setLoading(true); loadBills(); }} className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition">Retry</button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <RadarIcon size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Legislative Radar</h1>
          <p className="text-sm text-text-secondary">Track AI bills through the legislative lifecycle</p>
          <DataFreshness fetchedAt={fetchedAt} dataTimestamp={lastBillUpdate} className="mt-1" />
        </div>
      </div>

      {/* Stats */}
      {stats && <StatsBar stats={stats} />}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Main Table Area */}
        <div className="lg:col-span-3">
          {/* Filters */}
          <Card className="p-3 mb-4">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={jurisdiction}
                onChange={(e) => { setJurisdiction(e.target.value); setPage(1); }}
                className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
              >
                <option value="">All Jurisdictions</option>
                <option value="US-FED">US Federal</option>
                <option value="EU">EU</option>
                <option value="UK">UK</option>
                <option value="CA">Canada</option>
                {/* US states are dynamically available but we list common ones */}
                <option value="US-CA">California</option>
                <option value="US-NY">New York</option>
                <option value="US-TX">Texas</option>
                <option value="US-IL">Illinois</option>
                <option value="US-CO">Colorado</option>
              </select>
              <select
                value={stage}
                onChange={(e) => { setStage(e.target.value); setPage(1); }}
                className="text-sm bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary"
              >
                <option value="">All Stages</option>
                {STAGES.map((s) => (
                  <option key={s} value={s}>{stageLabels[s]}</option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted">Min Score:</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) => { setMinScore(Number(e.target.value)); setPage(1); }}
                  className="w-24 accent-accent"
                />
                <span className="text-xs text-text-secondary w-8">{minScore}%</span>
              </div>
            </div>
          </Card>

          {/* Bill Table */}
          {loading ? (
            <div className="flex justify-center py-20"><Spinner /></div>
          ) : bills.length === 0 ? (
            <EmptyState title="No bills found" description="Adjust your filters or wait for the Scout pipeline to discover bills." />
          ) : (
            <>
              <Card className="p-0 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="px-4 py-3 font-medium">Title</th>
                      <th className="px-4 py-3 font-medium">Jurisdiction</th>
                      <th className="px-4 py-3 font-medium">Stage</th>
                      <th className="px-4 py-3 font-medium">Score</th>
                      <th className="px-4 py-3 font-medium">Last Action</th>
                      <th className="px-4 py-3 font-medium w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {bills.map((bill) => (
                      <tr
                        key={bill.id}
                        onClick={() => navigate(`/radar/v2/bills/${bill.id}`)}
                        className="hover:bg-surface-hover transition cursor-pointer"
                      >
                        <td className="px-4 py-3">
                          <p className="text-text-primary font-medium truncate max-w-[300px]">{bill.title}</p>
                          {bill.externalId && <p className="text-xs text-text-muted">{bill.externalId}</p>}
                        </td>
                        <td className="px-4 py-3"><JurisdictionTag code={bill.jurisdiction} /></td>
                        <td className="px-4 py-3">
                          <Badge variant={stageBadgeVariant(bill.currentStage)}>
                            {stageLabels[bill.currentStage] ?? bill.currentStage}
                          </Badge>
                        </td>
                        <td className="px-4 py-3"><ScoreBadge score={bill.passageScore} /></td>
                        <td className="px-4 py-3 text-text-muted text-xs">
                          {bill.lastActionDate ? formatDate(bill.lastActionDate) : '--'}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          <ArrowRight size={14} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-xs text-text-muted">
                    Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="p-1.5 rounded-lg border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-30 transition"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="text-sm text-text-secondary">
                      {page} / {totalPages}
                    </span>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="p-1.5 rounded-lg border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-30 transition"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Sidebar Widgets */}
        <div className="space-y-4">
          {widgetsError && (
            <Card>
              <ErrorState compact message={widgetsError} onRetry={loadWidgets} />
            </Card>
          )}
          <TopMoversWidget movers={movers} />
          <AlertsFeed bills={bills} />
        </div>
      </div>
    </div>
  );
}
