import { Hono } from 'hono';
import { eq, sql, desc } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import {
  policyRules, regulatorySources, pipelineRuns,
  organizations, usageRecords, policyFeedback,
} from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { getLatestStateHash } from '../../core/state-hasher.js';
import { getConnectedClients } from '../../sse/manager.js';
import { getLatestShadowTests } from '../../audit/logger.js';
import { getFeedbackSummary } from '../../feedback/analyzer.js';
import { safeParseInt } from '../utils.js';

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.use('*', requireSessionOrApiKey('admin'));

// Overview stats
dashboardRoutes.get('/stats', (c) => {
  const db = getDb();

  const ruleCount = db.select({ count: sql<number>`count(*)` })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .get()?.count ?? 0;

  const sourceCount = db.select({ count: sql<number>`count(*)` })
    .from(regulatorySources)
    .where(eq(regulatorySources.isActive, true))
    .get()?.count ?? 0;

  const tenantCount = db.select({ count: sql<number>`count(*)` })
    .from(organizations)
    .where(eq(organizations.isActive, true))
    .get()?.count ?? 0;

  const lastRun = db.select()
    .from(pipelineRuns)
    .orderBy(desc(pipelineRuns.completedAt))
    .limit(1)
    .get();

  const stateHash = getLatestStateHash();

  return c.json({
    rules: ruleCount,
    sources: sourceCount,
    tenants: tenantCount,
    connectedClients: getConnectedClients().length,
    lastPipelineRun: lastRun ? {
      status: lastRun.status,
      completedAt: lastRun.completedAt,
    } : null,
    latestStateHash: stateHash,
  });
});

// Pipeline run history (for charts)
dashboardRoutes.get('/pipeline-history', (c) => {
  const db = getDb();
  const limit = safeParseInt(c.req.query('limit'), 100);

  const runs = db.select().from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(limit)
    .all();

  return c.json({ count: runs.length, runs });
});

// LLM cost breakdown
dashboardRoutes.get('/cost-breakdown', (c) => {
  const db = getDb();
  const since = c.req.query('since') || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const runs = db.select({
    provider: pipelineRuns.llmProvider,
    model: pipelineRuns.llmModel,
    totalCostCents: sql<number>`SUM(llm_cost_cents)`,
    totalTokensIn: sql<number>`SUM(llm_tokens_in)`,
    totalTokensOut: sql<number>`SUM(llm_tokens_out)`,
    runCount: sql<number>`COUNT(*)`,
  })
    .from(pipelineRuns)
    .where(sql`started_at >= ${since} AND llm_provider IS NOT NULL`)
    .groupBy(pipelineRuns.llmProvider, pipelineRuns.llmModel)
    .all();

  const totalCentsCombined = runs.reduce((sum, r) => sum + (r.totalCostCents ?? 0), 0);

  return c.json({
    since,
    totalCostCents: totalCentsCombined,
    totalCostDollars: (totalCentsCombined / 100).toFixed(2),
    breakdown: runs,
  });
});

// Connected SSE clients
dashboardRoutes.get('/connected-clients', (c) => {
  const clients = getConnectedClients();
  return c.json({ count: clients.length, clients });
});

// Integrity check results
dashboardRoutes.get('/integrity', (c) => {
  const stateHash = getLatestStateHash();
  const shadowTests = getLatestShadowTests(10);

  return c.json({
    stateHash,
    shadowTests,
  });
});

// Tenant usage across all orgs
dashboardRoutes.get('/tenant-usage', (c) => {
  const db = getDb();
  const since = c.req.query('since') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const usage = db.select({
    orgId: usageRecords.orgId,
    totalRequests: sql<number>`COUNT(*)`,
    avgResponseMs: sql<number>`AVG(response_ms)`,
    errorCount: sql<number>`SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)`,
  })
    .from(usageRecords)
    .where(sql`recorded_at >= ${since}`)
    .groupBy(usageRecords.orgId)
    .all();

  return c.json({ since, usage });
});

// SLA status
dashboardRoutes.get('/sla-status', (c) => {
  const db = getDb();
  const sources = db.select().from(regulatorySources)
    .where(eq(regulatorySources.isActive, true))
    .all();

  const now = Date.now();
  const status = sources.map((s) => {
    const lastScraped = s.lastScrapedAt ? new Date(s.lastScrapedAt).getTime() : 0;
    const ageHours = lastScraped ? (now - lastScraped) / (1000 * 60 * 60) : Infinity;
    const breaching = ageHours > (s.slaMaxAgeHours ?? 48);

    return {
      id: s.id,
      name: s.name,
      jurisdiction: s.jurisdiction,
      provenanceGrade: s.provenanceGrade ?? 'G',
      slaMaxAgeHours: s.slaMaxAgeHours ?? 48,
      lastScrapedAt: s.lastScrapedAt,
      ageHours: Math.round(ageHours),
      breaching,
    };
  });

  const breachCount = status.filter((s) => s.breaching).length;

  return c.json({ total: status.length, breaching: breachCount, sources: status });
});

// Feedback summary
dashboardRoutes.get('/feedback-summary', (c) => {
  const summary = getFeedbackSummary();
  return c.json({
    totalRulesWithFeedback: summary.length,
    summary,
  });
});
