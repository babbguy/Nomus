import { useCallback, useEffect, useState } from 'react';
import {
  Shield, Database, FileText, ShieldCheck, Link2, ScrollText,
  Target, AlertTriangle, RefreshCw, Copy, Check, X, Info,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

import { formatDate, formatRelative } from '../lib/formatters';
import {
  fetchAccuracySnapshot,
  fetchAccuracyOutcomes,
  type AccuracySnapshot,
  type OutcomesResponse,
  type OutcomeEntry,
  type BillOutcomeKind,
} from '../api/transparency-accuracy';


interface LedgerEntry {
  documentName: string;
  jurisdiction: string;
  status: 'verified' | 'flagged' | 'rejected';
  rulesAccepted: number;
  verifiedAt: string;
}

interface LedgerData {
  totalDocuments: number;
  verified: number;
  jurisdictions: string[];
  totalRulesAccepted: number;
}

interface TransparencyData {
  sources: {
    total: number;
    jurisdictions: string[];
    bySource: Array<{ name: string; jurisdiction: string; lastScraped: string | null; provenanceGrade: string }>;
  };
  rules: {
    total: number;
    byJurisdiction: Array<{ jurisdiction: string; count: number }>;
  };
  quality: {
    /** null when no pipeline ran in the last 30 days */
    pipelineSuccessRate: number | null;
    pipelineRunsLast30Days: number;
    /** null when no shadow test has run */
    shadowTestPassRate: number | null;
    shadowTestsRun: number;
  };
  integrity: {
    currentStateHash?: { hash: string; ruleCount: number; computedAt: string };
    latestStateHash: { hash: string; ruleCount: number; computedAt: string } | null;
    latestChainAnchor: { txHash: string; blockNumber: number; anchoredAt: string } | null;
  };
}

function freshnessDot(lastScraped: string | null): string {
  if (!lastScraped) return 'bg-red-500';
  const diff = Date.now() - new Date(lastScraped).getTime();
  const hours48 = 48 * 60 * 60 * 1000;
  const days7 = 7 * 24 * 60 * 60 * 1000;
  if (diff < hours48) return 'bg-green-500';
  if (diff < days7) return 'bg-yellow-500';
  return 'bg-red-500';
}

const gradeColors: Record<string, string> = {
  A: 'text-success', B: 'text-success', C: 'text-accent',
  D: 'text-info', E: 'text-warning', F: 'text-danger', G: 'text-danger',
};

// ─── Prediction Accuracy (Scout Accuracy Ledger) ────────

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function isStale(generatedAt: string): boolean {
  return Date.now() - new Date(generatedAt).getTime() > STALE_MS;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed';
}

const outcomeBadgeStyles: Record<BillOutcomeKind, string> = {
  enacted: 'bg-[rgba(0,229,160,0.12)] text-[#00e5a0]',
  failed: 'bg-[rgba(239,68,68,0.12)] text-[#ef4444]',
  withdrawn: 'bg-[rgba(156,163,175,0.12)] text-[#9ca3af]',
};

const outcomeLabels: Record<BillOutcomeKind, string> = {
  enacted: 'Enacted',
  failed: 'Failed',
  withdrawn: 'Withdrawn',
};

interface CalibrationPoint {
  bucket: string;
  midpoint: number;
  /** Observed pass rate as a percent (0–100); null = empty bucket → rendered as a gap, never a zero. */
  observedPct: number | null;
  n: number;
}

function CalibrationTooltip({ active, payload }: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: CalibrationPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-[#0f1117] border border-[#2a2d3a] rounded-lg px-3 py-2 text-xs">
      <p className="text-[#f0f2f5] font-semibold mb-1">Predicted {p.bucket}%</p>
      <p className="text-[#9ca3af]">
        Observed pass rate:{' '}
        <span className="text-[#00e5a0] font-semibold">
          {p.observedPct !== null ? `${p.observedPct}%` : 'no data'}
        </span>
      </p>
      <p className="text-[#6b7280]">{p.n} outcome{p.n === 1 ? '' : 's'} in bucket</p>
    </div>
  );
}

function AccuracySection() {
  const [snapshot, setSnapshot] = useState<AccuracySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomesResponse | null>(null);
  const [outcomesError, setOutcomesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<{ id: string | number; ok: boolean } | null>(null);

  const fetchAccuracy = useCallback(() => {
    Promise.allSettled([fetchAccuracySnapshot(), fetchAccuracyOutcomes(15, 0)])
      .then(([snapRes, outRes]) => {
        if (snapRes.status === 'fulfilled') {
          setSnapshot(snapRes.value);
        } else {
          setSnapshot(null);
          setSnapshotError(errorMessage(snapRes.reason));
        }
        if (outRes.status === 'fulfilled') {
          setOutcomes(outRes.value);
        } else {
          setOutcomes(null);
          setOutcomesError(errorMessage(outRes.reason));
        }
        setLoading(false);
      });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setSnapshotError(null);
    setOutcomesError(null);
    fetchAccuracy();
  }, [fetchAccuracy]);

  useEffect(() => {
    fetchAccuracy();
  }, [fetchAccuracy]);

  function copySignature(entry: OutcomeEntry) {
    navigator.clipboard.writeText(entry.signature)
      .then(() => setCopied({ id: entry.id, ok: true }))
      .catch(() => setCopied({ id: entry.id, ok: false }));
    setTimeout(() => setCopied(null), 2000);
  }

  const chartData: CalibrationPoint[] = snapshot
    ? snapshot.calibration.map((b) => ({
        bucket: b.bucket,
        midpoint: b.predictedMidpoint,
        // Empty buckets (n=0) and buckets with no observed rate are gaps, not zeros.
        // `observed` is already a percentage 0-100 (same axis as predictedMidpoint).
        observedPct: b.n > 0 && b.observed !== null ? Math.round(b.observed * 10) / 10 : null,
        n: b.n,
      }))
    : [];

  const at70 = snapshot?.hitRates.at70 ?? null;

  return (
    <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-6">
      <h2 className="text-sm font-semibold text-[#9ca3af] mb-1 flex items-center gap-2">
        <Target size={14} /> Prediction Accuracy — Scout Track Record
      </h2>
      <p className="text-xs text-[#6b7280] mb-4">
        Every Scout passage prediction is scored against the bill's real outcome and recorded here.
        Nothing is deleted; the record accrues in public.
      </p>

      {/* State (a): loading */}
      {loading && (
        <div className="flex justify-center py-10">
          <div className="w-6 h-6 border-2 border-[#00e5a0] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* State (b): error — a load failure, visibly distinct from an empty track record */}
      {!loading && snapshotError && (
        <div className="flex flex-col items-center gap-2 py-8 px-4 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.4)] rounded-lg text-center">
          <AlertTriangle size={20} className="text-[#ef4444]" />
          <p className="text-sm font-semibold text-[#f0f2f5]">Couldn't load accuracy data</p>
          <p className="text-xs text-[#6b7280]">
            The accuracy endpoint returned an error ({snapshotError}). This is a load failure — it
            does not mean the track record is empty.
          </p>
          <button
            onClick={load}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#00e5a0] text-[#0a0b0f] hover:opacity-90 transition"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {/* State (c): data */}
      {!loading && !snapshotError && snapshot && (
        <>
          {/* Freshness */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="text-xs text-[#6b7280]">
              Last computed {formatRelative(snapshot.generatedAt)}
            </span>
            <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-[#0f1117] border border-[#2a2d3a] text-[#9ca3af]">
              methodology v{snapshot.methodologyVersion}
            </span>
            {isStale(snapshot.generatedAt) && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded bg-[rgba(245,158,11,0.15)] border border-[rgba(245,158,11,0.4)] text-[#f59e0b]">
                <AlertTriangle size={10} />
                Stale — computed {formatDate(snapshot.generatedAt)}; normally refreshed nightly
              </span>
            )}
          </div>

          {!snapshot.published ? (
            /* Honest collecting state — calibration withheld below minPublishN */
            <div className="mb-4 p-4 bg-[#0f1117] border border-[#2a2d3a] rounded-lg">
              <p className="text-sm text-[#f0f2f5] mb-1">
                Collecting outcomes — calibration publishes at N ≥ {snapshot.minPublishN}
              </p>
              <p className="text-xs text-[#6b7280] mb-3">
                {snapshot.sample.outcomes} of {snapshot.minPublishN} bill outcomes recorded
                ({snapshot.sample.enacted} enacted · {snapshot.sample.failed} failed).
                Calibration statistics are withheld until the sample is large enough to be meaningful.
              </p>
              <div className="h-2 rounded-full bg-[#161922] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#00e5a0] transition-all duration-500"
                  style={{ width: `${Math.min(100, (snapshot.sample.outcomes / snapshot.minPublishN) * 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <>
              {/* Headline stat tiles */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                  <p className="text-xs text-[#6b7280]">Brier Score</p>
                  <p className="text-lg font-semibold text-[#00e5a0]">
                    {snapshot.brierScore !== null ? snapshot.brierScore.toFixed(3) : '—'}
                  </p>
                  <p className="text-[10px] text-[#6b7280]">0 = perfect · 0.25 ≈ coin flip · lower is better</p>
                </div>
                <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                  <p className="text-xs text-[#6b7280]">Outcomes Recorded</p>
                  <p className="text-lg font-semibold">{snapshot.sample.outcomes}</p>
                  <p className="text-[10px] text-[#6b7280]">{snapshot.sample.withCalibrationScore} with a T-30 score</p>
                </div>
                <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                  <p className="text-xs text-[#6b7280]">Enacted / Failed</p>
                  <p className="text-lg font-semibold">
                    {snapshot.sample.enacted} <span className="text-[#6b7280] font-normal">/</span> {snapshot.sample.failed}
                  </p>
                  <p className="text-[10px] text-[#6b7280]">terminal bill outcomes</p>
                </div>
                <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                  <p className="text-xs text-[#6b7280]">Hit Rate ≥ 70</p>
                  <p className="text-lg font-semibold">
                    {at70 && at70.rate !== null ? `${Math.round(at70.rate * 100)}%` : '—'}
                  </p>
                  <p className="text-[10px] text-[#6b7280]">
                    {at70 && at70.predictedCount > 0
                      ? `${at70.enactedCount} of ${at70.predictedCount} bills scored ≥ 70 were enacted`
                      : 'no bills scored ≥ 70 yet'}
                  </p>
                </div>
              </div>

              {/* Calibration chart */}
              <div className="mb-4 p-3 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                <h3 className="text-xs font-semibold text-[#9ca3af] mb-1">
                  Calibration — predicted probability vs observed pass rate
                </h3>
                <p className="text-[10px] text-[#6b7280] mb-2">
                  Points on the dashed 45° line are perfectly calibrated. Empty buckets appear as
                  gaps, never as zeros.
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                    <XAxis
                      dataKey="midpoint"
                      type="number"
                      domain={[0, 100]}
                      ticks={[0, 20, 40, 60, 80, 100]}
                      tick={{ fontSize: 10 }}
                      stroke="#6b7280"
                    />
                    <YAxis
                      type="number"
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tick={{ fontSize: 10 }}
                      stroke="#6b7280"
                    />
                    <Tooltip content={<CalibrationTooltip />} cursor={{ stroke: '#2a2d3a' }} />
                    <ReferenceLine
                      segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]}
                      stroke="#6b7280"
                      strokeDasharray="4 4"
                    />
                    <Line
                      type="monotone"
                      dataKey="observedPct"
                      stroke="#00e5a0"
                      strokeWidth={2}
                      connectNulls={false}
                      isAnimationActive={false}
                      dot={{ r: 4, fill: '#00e5a0', stroke: '#0f1117', strokeWidth: 2 }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-[10px] text-[#6b7280] text-center mt-1">
                  x: predicted passage probability at T-30 (%) · y: observed pass rate (%) · hover for bucket size (n)
                </p>
              </div>

              {/* Per-jurisdiction table */}
              {snapshot.byJurisdiction.length > 0 && (
                <div className="mb-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[#6b7280] border-b border-[#2a2d3a]">
                        <th className="py-2 pr-3 font-medium">Jurisdiction</th>
                        <th className="py-2 pr-3 font-medium">Outcomes</th>
                        <th className="py-2 pr-3 font-medium">Enacted</th>
                        <th className="py-2 font-medium">Brier Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.byJurisdiction.map((j) => (
                        <tr key={j.jurisdiction} className="border-b border-[#2a2d3a] last:border-0">
                          <td className="py-2 pr-3 font-mono text-[#f0f2f5]">{j.jurisdiction}</td>
                          <td className="py-2 pr-3">{j.outcomes}</td>
                          <td className="py-2 pr-3 text-[#00e5a0]">{j.enacted}</td>
                          <td className="py-2">{j.brierScore !== null ? j.brierScore.toFixed(3) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* Methodology & limitations */}
          <details className="mb-4 p-3 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
            <summary className="text-xs font-semibold text-[#9ca3af] cursor-pointer flex items-center gap-1.5">
              <Info size={12} /> Methodology & limitations (v{snapshot.methodologyVersion})
            </summary>
            <ul className="mt-2 space-y-1.5 text-xs text-[#6b7280] list-disc pl-5">
              <li>
                The headline prediction for each bill is its <span className="text-[#9ca3af]">T-30 score</span> —
                the passage probability Scout computed 30 days before the outcome.
              </li>
              <li>
                Bills with no score on record 30 days before their outcome are excluded from the
                calibration buckets and the Brier score
                ({snapshot.sample.withCalibrationScore} of {snapshot.sample.outcomes} outcomes qualify).
              </li>
              <li>
                The political-climate component of the score is currently a fixed neutral input
                (50/100); it does not yet vary by jurisdiction or session.
              </li>
              <li>
                The Brier score measures probability accuracy: 0 is perfect; 0.25 is what you would
                get by always predicting 50%. Lower is better.
              </li>
              <li>
                Calibration statistics publish only once N ≥ {snapshot.minPublishN} outcomes exist,
                to avoid presenting statistically meaningless rates.
              </li>
              <li>
                Each outcome record is Ed25519-signed over its canonical JSON at the moment it is
                frozen, so the track record cannot be quietly rewritten.
              </li>
            </ul>
          </details>
        </>
      )}

      {/* Recent outcomes — rendered for both collecting and published states */}
      {!loading && outcomesError && (
        <div className="flex flex-col items-center gap-2 py-6 px-4 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.4)] rounded-lg text-center">
          <AlertTriangle size={16} className="text-[#ef4444]" />
          <p className="text-xs font-semibold text-[#f0f2f5]">Couldn't load the outcome list</p>
          <p className="text-xs text-[#6b7280]">
            The outcomes endpoint returned an error ({outcomesError}) — this is a load failure, not
            an empty record.
          </p>
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#00e5a0] text-[#0a0b0f] hover:opacity-90 transition"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {!loading && !outcomesError && outcomes && outcomes.total > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-[#9ca3af]">Recent Outcomes</h3>
            <span className="text-[10px] text-[#6b7280]">
              Showing {outcomes.entries.length} of {outcomes.total}
            </span>
          </div>
          <p className="text-[10px] text-[#6b7280] mb-2">
            Each record is Ed25519-signed when the outcome is frozen. Click a signature to copy it in full.
          </p>
          <div className="space-y-2">
            {outcomes.entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-[#2a2d3a] last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate" title={entry.title}>{entry.title}</p>
                  <p className="text-xs text-[#6b7280]">
                    {entry.jurisdiction} · final stage: {entry.finalStage}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 shrink-0">
                  <span
                    className="text-xs text-[#9ca3af]"
                    title="Passage probability Scout predicted 30 days before the outcome"
                  >
                    T-30: {entry.scoreT30 !== null ? `${entry.scoreT30}%` : 'no score'}
                  </span>
                  <span className={`px-2 py-0.5 text-[10px] font-semibold rounded ${outcomeBadgeStyles[entry.outcome]}`}>
                    {outcomeLabels[entry.outcome]}
                  </span>
                  <span className="text-xs text-[#6b7280]">{formatDate(entry.outcomeAt)}</span>
                  <button
                    onClick={() => copySignature(entry)}
                    title="Copy full Ed25519 signature"
                    className="flex items-center gap-1 font-mono text-[10px] text-[#6b7280] hover:text-[#00e5a0] transition"
                  >
                    {copied && copied.id === entry.id
                      ? (copied.ok
                          ? <Check size={10} className="text-[#00e5a0]" />
                          : <X size={10} className="text-[#ef4444]" />)
                      : <Copy size={10} />}
                    {entry.signature.slice(0, 12)}…
                    {copied && copied.id === entry.id && !copied.ok && (
                      <span className="text-[#ef4444]">copy failed</span>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !outcomesError && outcomes && outcomes.total === 0 && (
        <p className="text-xs text-[#6b7280]">
          No bill outcomes recorded yet — the ledger starts accruing as tracked bills reach a
          terminal stage.
        </p>
      )}
    </div>
  );
}

export default function PublicTransparency() {
  const [data, setData] = useState<TransparencyData | null>(null);
  const [ledgerData, setLedgerData] = useState<{ ledger: LedgerData; entries: LedgerEntry[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    function loadData() {
      Promise.all([
        fetch('/api/v1/transparency/stats').then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch('/api/v1/ledger').then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }).catch(() => null),
      ]).then(([transparencyData, ledger]) => {
        setData(transparencyData);
        if (ledger) setLedgerData(ledger);
        setLastUpdated(new Date());
      }).catch(() => {
        setData(null);
      }).finally(() => setLoading(false));
    }
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#00e5a0] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center text-[#9ca3af]">
        Unable to load transparency data.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-[#f0f2f5]" style={{ fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Logo */}
        <img src="/logo-stacked.svg" className="w-32 mx-auto mb-4" alt="Nomus" />

        {/* Header */}
        <h1 className="text-2xl font-semibold text-center mb-2">The Ledger</h1>
        <div className="flex items-center justify-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[rgba(0,229,160,0.15)] flex items-center justify-center">
            <Shield size={20} className="text-[#00e5a0]" />
          </div>
          <div>
            <p className="text-sm text-[#6b7280]">Nomus — Regulatory Monitoring Status</p>
          </div>
        </div>

        <p className="text-sm text-[#9ca3af] mb-8 border-l-2 border-[#2a2d3a] pl-4">
          The Ledger is Nomus's public record of every regulation we've processed and verified.
          This page shows operational health metrics and regulatory coverage.
          It does not constitute legal certification or advice.
        </p>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-4">
            <p className="text-xs text-[#6b7280] mb-1">Sources Monitored</p>
            <p className="text-2xl font-bold text-[#00e5a0]">{data.sources.total}</p>
          </div>
          <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-4">
            <p className="text-xs text-[#6b7280] mb-1">Policy Rules</p>
            <p className="text-2xl font-bold">{data.rules.total}</p>
          </div>
          <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-4">
            <p className="text-xs text-[#6b7280] mb-1">Pipeline Success (30 days)</p>
            <p className="text-2xl font-bold">
              {data.quality.pipelineSuccessRate === null ? '—' : `${data.quality.pipelineSuccessRate}%`}
            </p>
            <p className="text-[11px] text-[#6b7280] mt-1">{data.quality.pipelineRunsLast30Days} run{data.quality.pipelineRunsLast30Days === 1 ? '' : 's'}</p>
          </div>
          <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-4">
            <p className="text-xs text-[#6b7280] mb-1">Shadow Tests (latest run)</p>
            <p className="text-2xl font-bold">
              {data.quality.shadowTestPassRate === null ? '—' : `${data.quality.shadowTestPassRate}%`}
            </p>
            <p className="text-[11px] text-[#6b7280] mt-1">{data.quality.shadowTestsRun === 0 ? 'none run yet' : `${data.quality.shadowTestsRun} tests`}</p>
          </div>
        </div>

        {/* Sources */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <Database size={14} /> Monitored Sources
          </h2>
          <div className="space-y-2">
            {data.sources.bySource.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-[#2a2d3a] last:border-0">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${freshnessDot(s.lastScraped)}`} title={s.lastScraped ? `Last scraped: ${new Date(s.lastScraped).toLocaleString()}` : 'Never scraped'} />
                  <div>
                    <p className="text-sm">{s.name}</p>
                    <p className="text-xs text-[#6b7280]">{s.jurisdiction}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold ${gradeColors[s.provenanceGrade || 'G']}`}>
                    Grade {s.provenanceGrade || 'G'}
                  </span>
                  <span className="text-xs text-[#6b7280]">
                    {s.lastScraped ? `Scraped ${new Date(s.lastScraped).toLocaleDateString()}` : 'Not yet scraped'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Rules by Jurisdiction */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <FileText size={14} /> Rules by Jurisdiction
          </h2>
          {data.rules.byJurisdiction.length === 0 ? (
            <p className="text-sm text-[#6b7280]">No rules generated yet. Pipeline has not been run.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {data.rules.byJurisdiction.map((r, i) => (
                <div key={i} className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                  <p className="text-xs text-[#6b7280]">{r.jurisdiction}</p>
                  <p className="text-lg font-semibold">{r.count}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Integrity */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <ShieldCheck size={14} /> Cryptographic Integrity
          </h2>
          {data.integrity.currentStateHash && (
            <div className="mb-3">
              <p className="text-xs text-[#6b7280] mb-1">Current Corpus State Hash (SHA-256)</p>
              <p className="font-mono text-xs text-[#00e5a0] break-all">{data.integrity.currentStateHash.hash}</p>
              <p className="text-xs text-[#6b7280] mt-1">{data.integrity.currentStateHash.ruleCount} active rules</p>
            </div>
          )}
          {data.integrity.latestStateHash ? (
            <div className="mb-3">
              <p className="text-xs text-[#6b7280] mb-1">Last Stored Snapshot (SHA-256)</p>
              <p className="font-mono text-xs text-[#00e5a0] break-all">{data.integrity.latestStateHash.hash}</p>
              <p className="text-xs text-[#6b7280] mt-1">
                {data.integrity.latestStateHash.ruleCount} rules · Computed {new Date(data.integrity.latestStateHash.computedAt).toLocaleString()}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[#6b7280]">No state hash computed yet.</p>
          )}
          {data.integrity.latestChainAnchor && (
            <div className="mt-3 pt-3 border-t border-[#2a2d3a]">
              <p className="text-xs text-[#6b7280] mb-1 flex items-center gap-1"><Link2 size={10} /> On-Chain Anchor (Polygon)</p>
              <p className="font-mono text-xs text-[#00e5a0] break-all">{data.integrity.latestChainAnchor.txHash}</p>
              <p className="text-xs text-[#6b7280] mt-1">
                Block #{data.integrity.latestChainAnchor.blockNumber} · {new Date(data.integrity.latestChainAnchor.anchoredAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {/* The Ledger — Verified Regulations */}
        {ledgerData && ledgerData.ledger.totalDocuments > 0 && (
          <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-6">
            <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
              <ScrollText size={14} /> Verified Regulations
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                <p className="text-xs text-[#6b7280]">Documents Processed</p>
                <p className="text-lg font-semibold">{ledgerData.ledger.totalDocuments}</p>
              </div>
              <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                <p className="text-xs text-[#6b7280]">Verified</p>
                <p className="text-lg font-semibold text-[#00e5a0]">{ledgerData.ledger.verified}</p>
              </div>
              <div className="px-3 py-2 bg-[#0f1117] rounded-lg border border-[#2a2d3a]">
                <p className="text-xs text-[#6b7280]">Rules Accepted</p>
                <p className="text-lg font-semibold">{ledgerData.ledger.totalRulesAccepted}</p>
              </div>
            </div>

            {ledgerData.entries.length > 0 && (
              <div className="space-y-2">
                {ledgerData.entries.map((entry, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-[#2a2d3a] last:border-0">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        entry.status === 'verified' ? 'bg-green-500' :
                        entry.status === 'flagged' ? 'bg-yellow-500' : 'bg-red-500'
                      }`} />
                      <div>
                        <p className="text-sm">{entry.documentName}</p>
                        <p className="text-xs text-[#6b7280]">{entry.jurisdiction}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-[#6b7280]">
                        {entry.rulesAccepted} rules
                      </span>
                      <span className="text-xs text-[#6b7280]">
                        {new Date(entry.verifiedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Scout Accuracy Ledger */}
        <AccuracySection />

        {lastUpdated && (
          <p className="text-xs text-[#6b7280] text-center mt-8">
            Last updated: {lastUpdated.toLocaleString()}
          </p>
        )}
        <p className="text-xs text-[#6b7280] text-center mt-2">
          Nomus is a regulatory monitoring tool. It does not provide legal advice.
        </p>
        <p className="text-xs text-[#6b7280] text-center mt-1">
          Trust through transparency.
        </p>
      </div>
    </div>
  );
}
