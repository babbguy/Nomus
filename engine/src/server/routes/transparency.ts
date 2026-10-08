import { Hono } from 'hono';
import { eq, sql, desc } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  regulatorySources, policyRules, pipelineRuns,
  shadowTestResults, stateHashes, chainAnchors,
} from '../../db/schema.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { computeCurrentStateHash } from '../../core/state-hasher.js';
import { checkSlaBreaches, getSourceHealthStatus } from '../../hunter/source-health.js';
import { getRuleAccuracyScores } from '../../feedback/refiner.js';

export const transparencyRoutes = new Hono();

// Fully public — no auth required
transparencyRoutes.get('/stats', (c) => {
  const db = getDb();

  // Source stats
  const sources = db.select({
    id: regulatorySources.id,
    name: regulatorySources.name,
    jurisdiction: regulatorySources.jurisdiction,
    lastScrapedAt: regulatorySources.lastScrapedAt,
    provenanceGrade: regulatorySources.provenanceGrade,
    isActive: regulatorySources.isActive,
  }).from(regulatorySources).all()
    .filter((s) => s.isActive);

  // Rule counts by jurisdiction
  const rules = db.select({
    jurisdiction: policyRules.jurisdiction,
    count: sql<number>`count(*)`,
  }).from(policyRules)
    .where(eq(policyRules.isActive, true))
    .groupBy(policyRules.jurisdiction)
    .all();

  const totalRules = rules.reduce((sum, r) => sum + r.count, 0);

  // Pipeline success rate (last 30 days)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentRuns = db.select({
    status: pipelineRuns.status,
    count: sql<number>`count(*)`,
  }).from(pipelineRuns)
    .where(sql`started_at >= ${since}`)
    .groupBy(pipelineRuns.status)
    .all();

  const totalRuns = recentRuns.reduce((sum, r) => sum + r.count, 0);
  const successRuns = recentRuns
    .filter((r) => r.status !== 'error')
    .reduce((sum, r) => sum + r.count, 0);
  // null when nothing ran: "100%" success with zero runs (and "0%" shadow
  // tests before any test ran) presented absent data as a measurement.
  const pipelineSuccessRate = totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : null;

  // Shadow test pass rate of the latest run (every test of that run, not the
  // newest 10 result rows).
  const latestRunAt = db.select({ runAt: shadowTestResults.runAt }).from(shadowTestResults)
    .orderBy(desc(shadowTestResults.runAt))
    .limit(1)
    .get()?.runAt;
  const latestTests = latestRunAt
    ? db.select().from(shadowTestResults).where(eq(shadowTestResults.runAt, latestRunAt)).all()
    : [];

  const testsPassed = latestTests.filter((t) => t.passed).length;
  const shadowTestRate = latestTests.length > 0
    ? Math.round((testsPassed / latestTests.length) * 100)
    : null;

  // Latest state hash (exclude signing key entries)
  const latestHash = db.select().from(stateHashes).all()
    .filter((h) => !h.hash.startsWith('SIGNING_KEY:'))
    .sort((a, b) => b.computedAt.localeCompare(a.computedAt))[0];

  // Latest chain anchor
  const latestAnchor = db.select().from(chainAnchors)
    .orderBy(desc(chainAnchors.anchoredAt))
    .limit(1)
    .get();

  return c.json({
    nomus: {
      description: 'Nomus is an automated AI regulatory monitoring tool.',
      notice: 'This data reflects automated monitoring status. It does not constitute legal certification.',
    },
    sources: {
      total: sources.length,
      jurisdictions: [...new Set(sources.map((s) => s.jurisdiction))],
      bySource: sources.map((s) => ({
        name: s.name,
        jurisdiction: s.jurisdiction,
        lastScraped: s.lastScrapedAt,
        provenanceGrade: s.provenanceGrade,
      })),
    },
    rules: {
      total: totalRules,
      byJurisdiction: rules,
    },
    quality: {
      pipelineSuccessRate,
      pipelineRunsLast30Days: totalRuns,
      shadowTestPassRate: shadowTestRate,
      shadowTestsRun: latestTests.length,
    },
    integrity: {
      // The corpus as served now (the stored hash is a periodic snapshot).
      currentStateHash: { ...computeCurrentStateHash(), computedAt: new Date().toISOString() },
      latestStateHash: latestHash ? {
        hash: latestHash.hash,
        ruleCount: latestHash.ruleCount,
        computedAt: latestHash.computedAt,
      } : null,
      latestChainAnchor: latestAnchor ? {
        txHash: latestAnchor.txHash,
        blockNumber: latestAnchor.blockNumber,
        anchoredAt: latestAnchor.anchoredAt,
      } : null,
    },
    sla: (() => {
      const sla = checkSlaBreaches();
      const health = getSourceHealthStatus();
      return {
        breached: sla.breached,
        total: sla.total,
        sources: health.map((s) => ({
          name: s.name,
          jurisdiction: s.jurisdiction,
          slaBreached: s.slaBreached,
          lastScrapedAt: s.lastScrapedAt,
          provenanceGrade: s.provenanceGrade,
        })),
      };
    })(),
    accuracy: (() => {
      const scores = getRuleAccuracyScores();
      const avgAccuracy = scores.length > 0
        ? Math.round(scores.reduce((sum, s) => sum + s.accuracyScore, 0) / scores.length * 100) / 100
        : null;
      return {
        averageAccuracy: avgAccuracy,
        rulesWithFeedback: scores.length,
        rulesNeedingReview: scores.filter((s) => s.needsReview).length,
      };
    })(),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});
