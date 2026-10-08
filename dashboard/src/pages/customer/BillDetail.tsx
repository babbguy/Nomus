import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Calendar, Clock } from 'lucide-react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';

import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import { formatDate, formatRelative } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';
import {
  getBill,
  getBillTimeline,
  getBillScores,
  getBillNews,
  type TrackedBill,
  type BillStageHistoryEntry,
  type BillScoreHistoryEntry,
  type BillNewsArticle,
} from '../../api/radar-v2';
import { BILL_STAGES, ENACTED_BILL_STAGES, ENDED_BILL_STAGES, billStageLabel } from '@nomus/shared';

// ─── Stage Definitions (for timeline) ───────────────────────────

// The timeline follows the engine's lifecycle stages, excluding the
// terminal and veto branches, which are shown as a badge instead.
const TIMELINE_STAGES = BILL_STAGES
  .filter((st) => st.phase !== 'terminal' && st.id !== 'vetoed' && st.id !== 'veto_override')
  .map((st) => st.id as string);

// ─── SD3: Stage Timeline Visualization ──────────────────────────

function StageTimeline({ currentStage, stages }: { currentStage: string; stages: BillStageHistoryEntry[] }) {
  const completedStages = new Set(stages.map((s) => s.stage));
  const currentIdx = TIMELINE_STAGES.indexOf(currentStage);
  const isDead = ENDED_BILL_STAGES.includes(currentStage);

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-4">Legislative Timeline</h3>
      <div className="flex items-center gap-0 overflow-x-auto pb-2">
        {TIMELINE_STAGES.map((stage, i) => {
          const isCompleted = completedStages.has(stage) || (currentIdx >= 0 && i < currentIdx);
          const isCurrent = stage === currentStage;

          return (
            <div key={stage} className="flex items-center">
              {/* Connector line (before dot, except first) */}
              {i > 0 && (
                <div className={`w-6 md:w-10 h-0.5 ${isCompleted || isCurrent ? 'bg-accent' : 'bg-border'}`} />
              )}
              {/* Dot + label */}
              <div className="relative group flex flex-col items-center">
                <div
                  className={`w-3 h-3 rounded-full border-2 transition ${
                    isCurrent
                      ? 'bg-accent border-accent ring-2 ring-accent/30'
                      : isCompleted
                        ? 'bg-accent border-accent'
                        : 'bg-transparent border-border'
                  } ${isDead && isCurrent ? 'bg-danger border-danger ring-danger/30' : ''}`}
                />
                {/* Hover label */}
                <span className={`absolute top-5 text-[10px] whitespace-nowrap transition ${
                  isCurrent ? 'text-accent font-semibold opacity-100' : 'text-text-muted opacity-0 group-hover:opacity-100'
                } ${isDead && isCurrent ? 'text-danger' : ''}`}>
                  {billStageLabel(stage)}
                </span>
                {/* Stage date if available */}
                {stages.find((s) => s.stage === stage) && (
                  <span className="absolute top-8 text-[9px] text-text-muted opacity-0 group-hover:opacity-100 whitespace-nowrap">
                    {formatDate(stages.find((s) => s.stage === stage)!.enteredAt)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {isDead && (
        <div className="mt-3">
          <Badge variant="danger">{billStageLabel(currentStage)}</Badge>
        </div>
      )}
    </Card>
  );
}

// ─── SD7: Score Breakdown ───────────────────────────────────────

interface ScoreComponent {
  label: string;
  value: number | null;
  key: string;
}

function ScoreBreakdown({ bill }: { bill: TrackedBill }) {
  const components: ScoreComponent[] = [
    { label: 'Momentum', value: bill.passageMomentum, key: 'momentum' },
    { label: 'Base Rate', value: bill.passageBaseRate, key: 'baseRate' },
    { label: 'Sponsor Strength', value: bill.passageSponsorStrength, key: 'sponsor' },
    { label: 'Sentiment', value: bill.passageSentiment, key: 'sentiment' },
    { label: 'Political', value: bill.passagePolitical, key: 'political' },
    { label: 'Opposition', value: bill.passageOpposition, key: 'opposition' },
  ];

  function barColor(v: number | null): string {
    if (v === null) return 'bg-surface-hover';
    if (v >= 70) return 'bg-success';
    if (v >= 40) return 'bg-warning';
    return 'bg-danger';
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">Score Breakdown</h3>
        <span className="text-2xl font-bold text-text-primary">
          {bill.passageScore !== null ? `${bill.passageScore}%` : '--'}
        </span>
      </div>
      <div className="space-y-3">
        {components.map((comp) => {
          // Components are stored on a 0-100 scale (scout/passage-score.ts).
          const pct = comp.value !== null ? Math.max(0, Math.min(100, Math.round(comp.value))) : 0;
          return (
            <div key={comp.key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-text-secondary">{comp.label}</span>
                <span className="text-xs font-medium text-text-primary">
                  {comp.value !== null ? `${pct}%` : '--'}
                </span>
              </div>
              <div className="h-2 rounded-full bg-surface-hover overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${barColor(pct)}`}
                  style={{ width: `${comp.value !== null ? pct : 0}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── SD4: Score Trend Chart ─────────────────────────────────────

function ScoreTrendChart({ scores }: { scores: BillScoreHistoryEntry[] }) {
  if (scores.length === 0) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-2">Score Trend</h3>
        <p className="text-xs text-text-muted py-8 text-center">No score history available yet.</p>
      </Card>
    );
  }

  const chartData = scores.map((s) => ({
    date: new Date(s.computedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    score: s.score,
  }));

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-3">Score Trend (90d)</h3>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-accent, #6366f1)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--color-accent, #6366f1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--color-text-muted, #888)" />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="var(--color-text-muted, #888)" />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface, #1a1a2e)',
              border: '1px solid var(--color-border, #333)',
              borderRadius: '8px',
              fontSize: '12px',
            }}
          />
          <Area
            type="monotone"
            dataKey="score"
            stroke="var(--color-accent, #6366f1)"
            fill="url(#scoreGrad)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ─── SD8: News Panel ────────────────────────────────────────────

function sentimentVariant(s: string | null): 'success' | 'danger' | 'default' | 'warning' {
  switch (s) {
    case 'supportive': return 'success';
    case 'opposed': return 'danger';
    case 'mixed': return 'warning';
    default: return 'default';
  }
}

function NewsPanel({ articles }: { articles: BillNewsArticle[] }) {
  if (articles.length === 0) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-2">Related News</h3>
        <p className="text-xs text-text-muted py-4 text-center">No news articles found.</p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-3">Related News</h3>
      <div className="space-y-3">
        {articles.map((a) => (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start justify-between gap-2 p-2 rounded-lg hover:bg-surface-hover transition"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text-primary leading-snug">{a.title}</p>
              <div className="flex items-center gap-2 mt-1">
                {a.sourceName && <span className="text-xs text-text-muted">{a.sourceName}</span>}
                {a.publishedAt && <span className="text-xs text-text-muted">{formatRelative(a.publishedAt)}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {a.sentiment && (
                <Badge variant={sentimentVariant(a.sentiment)}>
                  {a.sentiment}
                </Badge>
              )}
              <ExternalLink size={12} className="text-text-muted" />
            </div>
          </a>
        ))}
      </div>
    </Card>
  );
}

// ─── SD6: Recent Stage Transitions (Alerts) ─────────────────────

function StageAlerts({ stages }: { stages: BillStageHistoryEntry[] }) {
  if (stages.length === 0) return null;

  const recent = [...stages].reverse().slice(0, 5);

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-3">Stage Transitions</h3>
      <div className="space-y-2">
        {recent.map((s) => (
          <div key={s.id} className="flex items-center gap-2 text-xs">
            <div className="w-1.5 h-1.5 rounded-full bg-info shrink-0" />
            <Badge variant="info">{billStageLabel(s.stage)}</Badge>
            <span className="text-text-muted">{formatDate(s.enteredAt)}</span>
            {s.source && <span className="text-text-muted truncate">via {s.source}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Main Bill Detail Page (SD2) ────────────────────────────────

export default function BillDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [bill, setBill] = useState<TrackedBill | null>(null);
  const [stages, setStages] = useState<BillStageHistoryEntry[]>([]);
  const [scores, setScores] = useState<BillScoreHistoryEntry[]>([]);
  const [articles, setArticles] = useState<BillNewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    Promise.all([
      getBill(id),
      getBillTimeline(id),
      getBillScores(id, 90),
      getBillNews(id),
    ])
      .then(([billRes, timelineRes, scoresRes, newsRes]) => {
        if (cancelled) return;
        setBill(billRes.bill);
        setStages(timelineRes.stages);
        setScores(scoresRes.scores);
        setArticles(newsRes.articles);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(apiErrorMessage(err, 'Failed to load bill details.'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  if (error || !bill) {
    return (
      <div className="flex flex-col items-center py-20 gap-3">
        <p className="text-sm text-danger">{error ?? 'Bill not found.'}</p>
        <button
          onClick={() => navigate('/radar/v2')}
          className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition"
        >
          Back to Radar
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Back Link */}
      <button
        onClick={() => navigate('/radar/v2')}
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4 transition"
      >
        <ArrowLeft size={16} />
        Back to Legislative Radar
      </button>

      {/* Bill Header */}
      <Card className="p-5 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-text-primary mb-2">{bill.title}</h1>
            {bill.summary && (
              <p className="text-sm text-text-secondary mb-3">{bill.summary}</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <JurisdictionTag code={bill.jurisdiction} />
              {bill.session && (
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <Calendar size={12} /> {bill.session}
                </span>
              )}
              {bill.introducedDate && (
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <Clock size={12} /> Introduced {formatDate(bill.introducedDate)}
                </span>
              )}
              {bill.externalId && (
                <span className="text-xs font-mono text-text-muted">{bill.externalId}</span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            {bill.passageScore !== null && (
              <div className="text-3xl font-bold text-text-primary">{bill.passageScore}%</div>
            )}
            <Badge variant={
              ENACTED_BILL_STAGES.includes(bill.currentStage) ? 'success'
              : ENDED_BILL_STAGES.includes(bill.currentStage) || bill.currentStage === 'vetoed' ? 'danger'
              : 'info'
            }>
              {billStageLabel(bill.currentStage)}
            </Badge>
            {bill.sourceUrl && (
              <a
                href={bill.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-accent hover:opacity-80 transition"
              >
                Source <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      </Card>

      {/* Stage Timeline (SD3) */}
      <div className="mb-6">
        <StageTimeline currentStage={bill.currentStage} stages={stages} />
      </div>

      {/* Two-column layout for breakdown + trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <ScoreBreakdown bill={bill} />
        <ScoreTrendChart scores={scores} />
      </div>

      {/* Bottom row: alerts + news */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <StageAlerts stages={stages} />
        <NewsPanel articles={articles} />
      </div>
    </div>
  );
}
