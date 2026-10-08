import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { benchmarkRuns, benchmarkDefinitions } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';

const startBenchmarkSchema = z.object({
  modelName: z.string().min(1),
  provider: z.string().min(1),
  aiBomSystemId: z.string().optional(),
  benchmarkSuite: z.string().optional(),
});

const uploadResultsSchema = z.object({
  overallScore: z.number(),
  resultsByPrinciple: z.record(z.unknown()).optional(),
  rawResults: z.array(z.unknown()).optional(),
  benchmarksPassed: z.number().int().optional(),
  benchmarksFailed: z.number().int().optional(),
  actualCostCents: z.number().optional(),
  durationMs: z.number().int().optional(),
});

export const benchmarkRoutes = new Hono<AppEnv>();

benchmarkRoutes.use('*', requireSessionOrApiKey('read:policies'));
benchmarkRoutes.use('*', rateLimit());

// List all COMPL-AI benchmark definitions
benchmarkRoutes.get('/definitions', (c) => {
  const db = getDb();

  const definitions = db.select().from(benchmarkDefinitions)
    .where(eq(benchmarkDefinitions.isActive, true))
    .all();

  return c.json({
    count: definitions.length,
    definitions,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Start a benchmark run
benchmarkRoutes.post('/run', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = startBenchmarkSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const orgId = c.get('orgId')!;
  const db = getDb();

  const { modelName, provider, aiBomSystemId, benchmarkSuite } = parsed.data;

  const now = new Date().toISOString();
  const id = randomUUID();

  // Count total benchmarks in the suite
  const totalBenchmarks = db.select({ count: sql<number>`count(*)` })
    .from(benchmarkDefinitions)
    .where(eq(benchmarkDefinitions.isActive, true))
    .get()?.count ?? 0;

  db.insert(benchmarkRuns).values({
    id,
    orgId,
    aiBomSystemId: aiBomSystemId ?? null,
    modelName,
    provider,
    status: 'pending',
    benchmarkSuite: benchmarkSuite || 'compl-ai-v1',
    benchmarksTotal: totalBenchmarks,
    benchmarksPassed: 0,
    benchmarksFailed: 0,
    overallScore: null,
    resultsByPrinciple: '{}',
    rawResults: '[]',
    estimatedCostCents: null,
    actualCostCents: null,
    durationMs: null,
    errorMessage: null,
    triggeredBy: 'manual',
    startedAt: null,
    completedAt: null,
    createdAt: now,
  }).run();

  return c.json({ id, status: 'pending', benchmarksTotal: totalBenchmarks }, 201);
});

// List benchmark runs for the org
benchmarkRoutes.get('/runs', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const status = c.req.query('status');
  const modelName = c.req.query('modelName');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);

  let runs = db.select().from(benchmarkRuns)
    .where(eq(benchmarkRuns.orgId, orgId))
    .orderBy(desc(benchmarkRuns.createdAt))
    .all();

  if (status) runs = runs.filter((r) => r.status === status);
  if (modelName) runs = runs.filter((r) => r.modelName === modelName);

  return c.json({
    count: runs.length,
    runs: runs.slice(0, limit),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Get single benchmark run with full results
benchmarkRoutes.get('/runs/:id', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const id = c.req.param('id');

  const run = db.select().from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.id, id), eq(benchmarkRuns.orgId, orgId)))
    .get();

  if (!run) return c.json({ error: 'Benchmark run not found' }, 404);

  let resultsByPrinciple: unknown;
  let rawResults: unknown;
  try { resultsByPrinciple = JSON.parse(run.resultsByPrinciple); } catch { resultsByPrinciple = {}; }
  try { rawResults = JSON.parse(run.rawResults); } catch { rawResults = []; }

  return c.json({
    ...run,
    resultsByPrinciple,
    rawResults,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Upload benchmark results produced by an external runner
benchmarkRoutes.patch('/runs/:id/results', async (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const id = c.req.param('id');
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = uploadResultsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const run = db.select().from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.id, id), eq(benchmarkRuns.orgId, orgId)))
    .get();

  if (!run) return c.json({ error: 'Benchmark run not found' }, 404);

  if (run.status === 'completed') {
    return c.json({ error: 'Benchmark run already completed' }, 409);
  }

  const {
    overallScore,
    resultsByPrinciple,
    rawResults,
    benchmarksPassed,
    benchmarksFailed,
    actualCostCents,
    durationMs,
  } = parsed.data;

  const now = new Date().toISOString();

  db.update(benchmarkRuns).set({
    status: 'completed',
    overallScore,
    resultsByPrinciple: JSON.stringify(resultsByPrinciple || {}),
    rawResults: JSON.stringify(rawResults || []),
    benchmarksPassed: benchmarksPassed ?? 0,
    benchmarksFailed: benchmarksFailed ?? 0,
    actualCostCents: actualCostCents ?? null,
    durationMs: durationMs ?? null,
    completedAt: now,
  }).where(eq(benchmarkRuns.id, id)).run();

  return c.json({ message: 'Benchmark results uploaded', status: 'completed' });
});

// Dashboard summary
benchmarkRoutes.get('/summary', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;

  // Models tested (distinct model names with completed runs)
  const modelsTested = db.select({
    modelName: benchmarkRuns.modelName,
    provider: benchmarkRuns.provider,
  })
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.orgId, orgId), eq(benchmarkRuns.status, 'completed')))
    .groupBy(benchmarkRuns.modelName, benchmarkRuns.provider)
    .all();

  // Average score across completed runs
  const avgResult = db.select({
    avgScore: sql<number>`avg(overall_score)`,
  })
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.orgId, orgId), eq(benchmarkRuns.status, 'completed')))
    .get();

  // Recent completed runs for principle analysis
  const recentRuns = db.select().from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.orgId, orgId), eq(benchmarkRuns.status, 'completed')))
    .orderBy(desc(benchmarkRuns.completedAt))
    .limit(10)
    .all();

  // Aggregate principle scores across recent runs
  const principleScores: Record<string, { total: number; count: number }> = {};
  for (const run of recentRuns) {
    let principles: Record<string, { score: number }>;
    try { principles = JSON.parse(run.resultsByPrinciple); } catch { continue; }
    for (const [principle, data] of Object.entries(principles)) {
      if (!principleScores[principle]) {
        principleScores[principle] = { total: 0, count: 0 };
      }
      principleScores[principle].total += data.score;
      principleScores[principle].count += 1;
    }
  }

  const principleAverages = Object.entries(principleScores).map(([principle, data]) => ({
    principle,
    avgScore: Math.round((data.total / data.count) * 100) / 100,
  })).sort((a, b) => a.avgScore - b.avgScore);

  const worstPrinciple = principleAverages[0] ?? null;
  const bestPrinciple = principleAverages[principleAverages.length - 1] ?? null;

  // Total runs
  const totalRuns = db.select({ count: sql<number>`count(*)` })
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.orgId, orgId))
    .get()?.count ?? 0;

  return c.json({
    modelsTested: modelsTested.length,
    models: modelsTested,
    averageScore: avgResult?.avgScore ? Math.round(avgResult.avgScore * 100) / 100 : null,
    totalRuns,
    recentRunCount: recentRuns.length,
    bestPrinciple,
    worstPrinciple,
    principleAverages,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});
