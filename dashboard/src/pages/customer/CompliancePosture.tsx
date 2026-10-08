import { useState, useEffect } from 'react';
import { Shield, RefreshCw, TrendingUp, TrendingDown, Minus, Printer } from 'lucide-react';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

/** A score factor as served by GET /api/v1/compliance/score. */
interface ScoreFactor {
  category: string;
  description: string;
  /** Points added (positive) or deducted (negative); 0 for informational factors. */
  impact: number;
}

interface Score {
  overallScore: number;
  scoresByJurisdiction: Record<string, number>;
  scoresByCategory: Record<string, number>;
  factorsPositive: ScoreFactor[];
  factorsNegative: ScoreFactor[];
  rulesActive: number;
  rulesApplicable: number;
  openFindings: number;
  aiBomSystemCount: number;
  highRiskSystems: number;
  benchmarkScore: number | null;
  lastBenchmarkAt: string | null;
  computedAt: string;
}

interface HistoryEntry {
  overallScore: number;
  computedAt: string;
  triggerEvent: string;
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 60) return 'text-accent';
  if (score >= 40) return 'text-warning';
  return 'text-danger';
}

function getScoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 40) return 'Needs Work';
  return 'Critical';
}

function getScoreBg(score: number): string {
  if (score >= 80) return 'bg-success/15';
  if (score >= 60) return 'bg-accent/15';
  if (score >= 40) return 'bg-warning/15';
  return 'bg-danger/15';
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function CompliancePosture() {
  const [score, setScore] = useState<Score | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  function exportReport() {
    if (!score) return;
    const jurisdictionRows = Object.entries(score.scoresByJurisdiction)
      .sort(([, a], [, b]) => a - b)
      .map(([j, s]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${j}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;color:${s >= 80 ? '#22c55e' : s >= 60 ? '#3b82f6' : s >= 40 ? '#f59e0b' : '#ef4444'}">${s.toFixed(0)}</td></tr>`)
      .join('');
    const categoryRows = Object.entries(score.scoresByCategory)
      .sort(([, a], [, b]) => a - b)
      .map(([c, s]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${c.replace(/_/g, ' ')}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;color:${s >= 80 ? '#22c55e' : s >= 60 ? '#3b82f6' : s >= 40 ? '#f59e0b' : '#ef4444'}">${s.toFixed(0)}</td></tr>`)
      .join('');
    const html = `<!DOCTYPE html><html><head><title>Nomus Compliance Report</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:800px;margin:40px auto;color:#1a1a1a}h1{font-size:24px}h2{font-size:16px;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:8px}.score{font-size:64px;font-weight:700;text-align:center;margin:20px 0}.label{text-align:center;font-size:18px;font-weight:600}.stats{display:flex;gap:24px;margin:20px 0}.stat{flex:1;background:#f8f9fa;padding:16px;border-radius:8px}.stat-val{font-size:24px;font-weight:700}.stat-lbl{font-size:12px;color:#666;margin-top:4px}table{width:100%;border-collapse:collapse}th{text-align:left;padding:8px 12px;background:#f8f9fa;font-size:12px;text-transform:uppercase;color:#666}.footer{margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999}@media print{body{margin:20px}}</style></head><body>
<h1>Nomus Compliance Report</h1>
<p style="color:#666">Generated ${new Date().toLocaleDateString()} | ${new Date().toLocaleTimeString()}</p>
<div class="score" style="color:${score.overallScore >= 80 ? '#22c55e' : score.overallScore >= 60 ? '#3b82f6' : score.overallScore >= 40 ? '#f59e0b' : '#ef4444'}">${score.overallScore.toFixed(0)}</div>
<div class="label" style="color:${score.overallScore >= 80 ? '#22c55e' : score.overallScore >= 60 ? '#3b82f6' : score.overallScore >= 40 ? '#f59e0b' : '#ef4444'}">${getScoreLabel(score.overallScore)}</div>
<div class="stats">
<div class="stat"><div class="stat-val">${score.rulesApplicable}</div><div class="stat-lbl">Applicable Rules</div></div>
<div class="stat"><div class="stat-val">${score.openFindings}</div><div class="stat-lbl">Open Findings</div></div>
<div class="stat"><div class="stat-val">${score.aiBomSystemCount}</div><div class="stat-lbl">AI Systems</div></div>
<div class="stat"><div class="stat-val">${score.highRiskSystems}</div><div class="stat-lbl">High Risk</div></div>
</div>
<h2>Score by Jurisdiction</h2>
<table><thead><tr><th>Jurisdiction</th><th>Score</th></tr></thead><tbody>${jurisdictionRows || '<tr><td colspan="2" style="padding:12px;color:#999">No jurisdiction data</td></tr>'}</tbody></table>
<h2>Score by Category</h2>
<table><thead><tr><th>Category</th><th>Score</th></tr></thead><tbody>${categoryRows || '<tr><td colspan="2" style="padding:12px;color:#999">No category data</td></tr>'}</tbody></table>
<div class="footer">
<p>Nomus — Regulatory Applicability Engine</p>
<p>This report is generated from automated analysis and does not constitute legal advice. Consult qualified legal counsel for compliance decisions.</p>
</div></body></html>`;
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 300);
    }
  }

  function fetchPosture() {
    Promise.all([
      api.get('/compliance/score'),
      api.get('/compliance/history'),
    ]).then(([scoreRes, historyRes]) => {
      setScore(scoreRes.data);
      setHistory(historyRes.data?.history ?? []);
      setFetchedAt(new Date().toISOString());
    }).catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load compliance posture')))
      .finally(() => setLoading(false));
  }

  function load() {
    setLoading(true);
    setLoadError(null);
    fetchPosture();
  }

  useEffect(() => {
    fetchPosture();
  }, []);

  async function recalculate() {
    setRecalculating(true);
    setActionError(null);
    try {
      const { data } = await api.post('/compliance/recalculate');
      setScore(data);
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to recalculate compliance score'));
    }
    setRecalculating(false);
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
            <Shield size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Compliance Posture</h1>
            <p className="text-sm text-text-muted">Real-time compliance score across all jurisdictions</p>
            <DataFreshness fetchedAt={fetchedAt} dataTimestamp={score?.computedAt ?? null} className="mt-1" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportReport}
            disabled={!score}
            className="flex items-center gap-2 px-4 py-2 bg-surface-raised border border-border rounded-lg text-text-secondary hover:text-text-primary transition disabled:opacity-50"
          >
            <Printer size={14} />
            Export Report
          </button>
          <button
            onClick={recalculate}
            disabled={recalculating}
            className="flex items-center gap-2 px-4 py-2 bg-surface-raised border border-border rounded-lg text-text-secondary hover:text-text-primary transition disabled:opacity-50"
          >
            <RefreshCw size={14} className={recalculating ? 'animate-spin' : ''} />
            {recalculating ? 'Recalculating...' : 'Recalculate'}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="mb-4">
          <ErrorState compact message={actionError} />
        </div>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : score ? (
        <>
          {/* Main Score */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className={`glass rounded-xl p-6 flex flex-col items-center justify-center ${getScoreBg(score.overallScore)}`}>
              <p className={`text-5xl font-bold ${getScoreColor(score.overallScore)}`}>
                {score.overallScore.toFixed(0)}
              </p>
              <p className={`text-sm font-semibold mt-1 ${getScoreColor(score.overallScore)}`}>
                {getScoreLabel(score.overallScore)}
              </p>
              <p className="text-xs text-text-muted mt-2">Updated {timeAgo(score.computedAt)}</p>
            </div>

            {/* Quick Stats */}
            <div className="glass rounded-xl p-5 space-y-3">
              <h2 className="text-sm font-semibold text-text-secondary">Coverage</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Active Rules</span>
                  <span className="text-text-primary font-medium">{score.rulesActive}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Applicable Rules</span>
                  <span className="text-text-primary font-medium">{score.rulesApplicable}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Open Findings</span>
                  <span className={score.openFindings > 0 ? 'text-warning font-medium' : 'text-text-primary font-medium'}>
                    {score.openFindings}
                  </span>
                </div>
              </div>
            </div>

            <div className="glass rounded-xl p-5 space-y-3">
              <h2 className="text-sm font-semibold text-text-secondary">AI Systems</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Total AI Systems</span>
                  <span className="text-text-primary font-medium">{score.aiBomSystemCount}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">High Risk</span>
                  <span className={score.highRiskSystems > 0 ? 'text-danger font-medium' : 'text-text-primary font-medium'}>
                    {score.highRiskSystems}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Benchmark Score</span>
                  <span className="text-text-primary font-medium">
                    {score.benchmarkScore != null ? `${score.benchmarkScore.toFixed(0)}%` : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Factors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold text-success mb-3 flex items-center gap-1.5">
                <TrendingUp size={14} /> Positive Factors
              </h2>
              {score.factorsPositive.length === 0 ? (
                <p className="text-sm text-text-muted">No positive factors yet.</p>
              ) : (
                <div className="space-y-2">
                  {score.factorsPositive.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">{f.description}</span>
                      <span className="text-success font-medium">{f.impact > 0 ? `+${f.impact}` : 'info'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold text-danger mb-3 flex items-center gap-1.5">
                <TrendingDown size={14} /> Negative Factors
              </h2>
              {score.factorsNegative.length === 0 ? (
                <p className="text-sm text-text-muted">No negative factors — great job!</p>
              ) : (
                <div className="space-y-2">
                  {score.factorsNegative.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">{f.description}</span>
                      <span className="text-danger font-medium">{f.impact}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scores by Jurisdiction */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold text-text-secondary mb-3">Score by Jurisdiction</h2>
              <div className="space-y-2">
                {Object.entries(score.scoresByJurisdiction)
                  .sort(([, a], [, b]) => a - b)
                  .map(([j, s]) => (
                    <div key={j} className="flex items-center gap-3">
                      <span className="text-sm text-text-secondary w-20">{j}</span>
                      <div className="flex-1 h-2 bg-surface rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${s >= 80 ? 'bg-success' : s >= 60 ? 'bg-accent' : s >= 40 ? 'bg-warning' : 'bg-danger'}`}
                          style={{ width: `${Math.min(100, s)}%` }}
                        />
                      </div>
                      <span className={`text-sm font-medium w-10 text-right ${getScoreColor(s)}`}>{s.toFixed(0)}</span>
                    </div>
                  ))}
                {Object.keys(score.scoresByJurisdiction).length === 0 && (
                  <p className="text-sm text-text-muted">No jurisdiction-specific scores yet.</p>
                )}
              </div>
            </div>
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold text-text-secondary mb-3">Score by Category</h2>
              <div className="space-y-2">
                {Object.entries(score.scoresByCategory)
                  .sort(([, a], [, b]) => a - b)
                  .map(([c, s]) => (
                    <div key={c} className="flex items-center gap-3">
                      <span className="text-sm text-text-secondary w-28 truncate">{c.replace(/_/g, ' ')}</span>
                      <div className="flex-1 h-2 bg-surface rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${s >= 80 ? 'bg-success' : s >= 60 ? 'bg-accent' : s >= 40 ? 'bg-warning' : 'bg-danger'}`}
                          style={{ width: `${Math.min(100, s)}%` }}
                        />
                      </div>
                      <span className={`text-sm font-medium w-10 text-right ${getScoreColor(s)}`}>{s.toFixed(0)}</span>
                    </div>
                  ))}
                {Object.keys(score.scoresByCategory).length === 0 && (
                  <p className="text-sm text-text-muted">No category-specific scores yet.</p>
                )}
              </div>
            </div>
          </div>

          {/* History */}
          <div className="glass rounded-xl p-5">
            <h2 className="text-sm font-semibold text-text-secondary mb-3">Score History</h2>
            <div className="max-h-tile overflow-y-auto">
              {history.length === 0 ? (
                <p className="text-sm text-text-muted">No history yet. Recalculate to create your first entry.</p>
              ) : (
                <div className="space-y-1">
                  {history.map((h, i) => {
                    const prev = history[i + 1];
                    const delta = prev ? h.overallScore - prev.overallScore : 0;
                    return (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-semibold ${getScoreColor(h.overallScore)}`}>
                            {h.overallScore.toFixed(0)}
                          </span>
                          {delta !== 0 && (
                            <span className={`flex items-center text-xs ${delta > 0 ? 'text-success' : 'text-danger'}`}>
                              {delta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                            </span>
                          )}
                          {delta === 0 && prev && <Minus size={12} className="text-text-muted" />}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-text-muted px-2 py-0.5 bg-surface-hover rounded">
                            {h.triggerEvent.replace(/_/g, ' ')}
                          </span>
                          <span className="text-xs text-text-muted">{timeAgo(h.computedAt)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="glass rounded-xl p-8 text-center">
          <Shield size={48} className="text-text-muted mx-auto mb-4" />
          <p className="text-text-secondary mb-4">No compliance score computed yet.</p>
          <button
            onClick={recalculate}
            className="px-5 py-2 bg-accent text-accent-text font-semibold rounded-lg hover:opacity-90 transition"
          >
            Calculate Now
          </button>
        </div>
      )}
    </div>
  );
}
