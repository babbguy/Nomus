import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../../db/client.js';
import { sql, eq, desc, and } from 'drizzle-orm';
import { pipelineRuns, regulatorySources } from '../../db/schema.js';
import { getConnectedClients } from '../../sse/manager.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import type { AppEnv } from '../app.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { getPublicKey } from '../../core/signing.js';

export const healthRoutes = new Hono<AppEnv>();

// Read version from package.json once at module load time.
function getEngineVersion(): string {
  try {
    const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    // dist/server/routes -> dist/server -> dist -> engine root
    const pkgPath = resolve(dir, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const ENGINE_VERSION = getEngineVersion();

healthRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'nomus-engine',
    version: ENGINE_VERSION,
    notice: 'Nomus is a regulatory monitoring tool. It does not provide legal advice.',
    timestamp: new Date().toISOString(),
  });
});

healthRoutes.get('/ready', (c) => {
  // Ready = DB reachable AND signing keys initialized. Without signing keys
  // the rule promotion path will crash.
  let dbOk = false;
  let signingOk = false;
  try {
    const db = getDb();
    db.run(sql`SELECT 1`);
    dbOk = true;
  } catch { /* dbOk stays false */ }

  try {
    getPublicKey();
    signingOk = true;
  } catch { /* signingOk stays false */ }

  const ready = dbOk && signingOk;
  return c.json({
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database: dbOk ? 'ok' : 'error',
      signing: signingOk ? 'ok' : 'error',
    },
    version: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
  }, ready ? 200 : 503);
});

// ─── Public Status (no auth) ─────────────────────────────────

healthRoutes.get('/api/v1/status', (c) => {
  const start = performance.now();

  try {
    const db = getDb();
    db.run(sql`SELECT 1`);
    const dbLatency = Math.round(performance.now() - start);

    const connectedClients = getConnectedClients().length;

    // Last pipeline run (join source for name)
    const lastRun = db.select({
      status: pipelineRuns.status,
      completedAt: pipelineRuns.completedAt,
      sourceName: regulatorySources.name,
    }).from(pipelineRuns)
      .leftJoin(regulatorySources, eq(pipelineRuns.sourceId, regulatorySources.id))
      .orderBy(desc(pipelineRuns.completedAt)).limit(1).get();

    // Uptime: % of non-error runs in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const totalRuns = db.select({ count: sql<number>`count(*)` })
      .from(pipelineRuns).where(sql`${pipelineRuns.startedAt} >= ${thirtyDaysAgo}`).get();
    const errorRuns = db.select({ count: sql<number>`count(*)` })
      .from(pipelineRuns).where(and(
        sql`${pipelineRuns.startedAt} >= ${thirtyDaysAgo}`,
        eq(pipelineRuns.status, 'error'),
      )).get();
    const total = totalRuns?.count ?? 0;
    const errors = errorRuns?.count ?? 0;
    const uptime = total > 0 ? Math.round((1 - errors / total) * 1000) / 10 : 100;

    const overallStatus = errors > 0 && total > 0 && (errors / total) > 0.3 ? 'degraded' : 'operational';

    return c.json({
      status: overallStatus,
      services: {
        api: { status: 'ok', latencyMs: dbLatency },
        database: { status: 'ok' },
        sse: { status: 'ok', connectedClients },
      },
      recentPipeline: lastRun ? {
        status: lastRun.status,
        completedAt: lastRun.completedAt,
        sourceName: lastRun.sourceName,
      } : null,
      uptime,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return c.json({
      status: 'down',
      services: { api: { status: 'ok' }, database: { status: 'error' }, sse: { status: 'unknown' } },
      recentPipeline: null,
      uptime: 0,
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

// ─── Admin Status (deep diagnostics) ─────────────────────────

healthRoutes.get('/api/v1/admin/status', requireSessionOrApiKey('admin'), (c) => {
  const db = getDb();

  // Per-source health
  const sources = db.select({
    id: regulatorySources.id,
    name: regulatorySources.name,
    jurisdiction: regulatorySources.jurisdiction,
    lastScrapedAt: regulatorySources.lastScrapedAt,
    scrapeFrequencyHours: regulatorySources.scrapeFrequencyHours,
    isActive: regulatorySources.isActive,
  }).from(regulatorySources).all();

  const sourceHealth = sources.map((s) => {
    const lastRun = db.select({
      status: pipelineRuns.status,
      completedAt: pipelineRuns.completedAt,
      errorMessage: pipelineRuns.errorMessage,
      durationMs: pipelineRuns.durationMs,
    }).from(pipelineRuns)
      .where(eq(pipelineRuns.sourceId, s.id))
      .orderBy(desc(pipelineRuns.completedAt))
      .limit(1).get();

    return {
      ...s,
      lastRunStatus: lastRun?.status ?? 'never',
      lastRunAt: lastRun?.completedAt ?? null,
      lastError: lastRun?.status === 'error' ? lastRun.errorMessage : null,
      lastDurationMs: lastRun?.durationMs ?? null,
    };
  });

  // Recent errors
  const recentErrors = db.select({
    sourceId: pipelineRuns.sourceId,
    sourceName: regulatorySources.name,
    errorMessage: pipelineRuns.errorMessage,
    stepReached: pipelineRuns.stepReached,
    completedAt: pipelineRuns.completedAt,
  }).from(pipelineRuns)
    .leftJoin(regulatorySources, eq(pipelineRuns.sourceId, regulatorySources.id))
    .where(eq(pipelineRuns.status, 'error'))
    .orderBy(desc(pipelineRuns.completedAt))
    .limit(20).all();

  // Server stats
  const mem = process.memoryUsage();

  return c.json({
    sources: sourceHealth,
    recentErrors,
    sseClients: getConnectedClients(),
    server: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      nodeVersion: process.version,
    },
    timestamp: new Date().toISOString(),
  });
});
