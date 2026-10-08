import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { regulatorySources, policyRules, stagedContent, scanFindings, organizations } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { runPipeline } from '../../hunter/pipeline.js';
import { runShadowTests } from '../../audit/shadow-tester.js';
import { verifyIntegrity } from '../../audit/integrity.js';
import { computeAndStoreStateHash } from '../../core/state-hasher.js';
import { getRecentPipelineRuns } from '../../audit/logger.js';
import { logger } from '../../logger.js';
import { broadcastEvent } from '../../sse/manager.js';
import { randomUUID } from 'node:crypto';
import { initSigningKeys } from '../../core/signing.js';
import { getSourceHealthStatus, checkSlaBreaches } from '../../hunter/source-health.js';
import { runFullAudit, auditSource, saveAuditReport, getAuditResult } from '../../hunter/data-auditor.js';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireSessionOrApiKey('admin'));
adminRoutes.use('*', rateLimit());

// Manually trigger scrape for one source — returns immediately, pipeline runs in background
adminRoutes.post('/scrape/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId');
  const db = getDb();

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) return c.json({ error: 'Source not found' }, 404);

  // Fire pipeline in background — progress reported via SSE, not HTTP response
  runPipeline(sourceId).catch((err) => {
    logger.error({ sourceId, error: (err as Error).message }, 'Background pipeline failed');
  });

  return c.json({
    status: 'processing',
    sourceId,
    sourceName: source.name,
    message: `Pipeline started for ${source.name}. Progress will appear in real-time.`,
  });
});

// Process-wide guard — only one full scrape-all cycle may run at a time.
// Without this, repeatedly clicking "Run All" overlaps fetches and confuses
// pipeline mutexes downstream.
let _scrapeAllInFlight = false;

// Trigger full scrape cycle — only AUTO ingestion mode sources
// Runs sequentially in background — progress reported via SSE
adminRoutes.post('/scrape-all', (c) => {
  if (_scrapeAllInFlight) {
    return c.json({
      status: 'busy',
      message: 'Another scrape-all cycle is already running. Wait for it to finish.',
    }, 409);
  }

  const db = getDb();
  const sources = db.select().from(regulatorySources)
    .where(and(
      eq(regulatorySources.isActive, true),
      eq(regulatorySources.ingestionMode, 'auto'),
    ))
    .all();

  if (sources.length === 0) {
    return c.json({ status: 'skipped', sourcesQueued: 0, message: 'No active auto-scrape sources found.' });
  }

  _scrapeAllInFlight = true;

  // Fire pipelines sequentially in background — each source has a 30-min safety timeout
  // so one hung source can't block the entire batch.
  // Tracks results and broadcasts a summary when done.
  const PER_SOURCE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max per source

  (async () => {
    const results: Array<{ name: string; id: string; status: string; error?: string; rulesCreated?: number; rulesUpdated?: number }> = [];

    for (let idx = 0; idx < sources.length; idx++) {
      const source = sources[idx];

      // Broadcast which source is being processed
      broadcastEvent({
        id: randomUUID(),
        type: 'pipeline.progress',
        data: {
          step: 1,
          stepName: `Scrape All: ${idx + 1}/${sources.length}`,
          sourceName: source.name,
          sourceId: source.id,
          scrapeAllProgress: { current: idx + 1, total: sources.length },
        },
        jurisdiction: source.jurisdiction ?? '*',
      });

      try {
        const result = await Promise.race([
          runPipeline(source.id),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Exceeded ${PER_SOURCE_TIMEOUT_MS / 60000}min timeout`)), PER_SOURCE_TIMEOUT_MS)
          ),
        ]);
        const r = result;
        results.push({
          name: source.name, id: source.id, status: r.status,
          rulesCreated: r.rulesCreated, rulesUpdated: r.rulesUpdated,
          error: r.error,
        });
        logger.info({ sourceId: source.id, name: source.name, status: r.status },
          `Scrape-all [${idx + 1}/${sources.length}]: ${source.name} — ${r.status}`);
      } catch (err) {
        const errorMsg = (err as Error).message;
        results.push({ name: source.name, id: source.id, status: 'error', error: errorMsg });
        logger.error({ sourceId: source.id, name: source.name, error: errorMsg },
          `Scrape-all [${idx + 1}/${sources.length}]: ${source.name} — FAILED`);
      }
    }

    // Broadcast scrape-all completion summary
    const succeeded = results.filter((r) => r.status === 'completed');
    const failed = results.filter((r) => r.status === 'error');
    const noChange = results.filter((r) => r.status === 'no_change' || r.status === 'typo_only');

    broadcastEvent({
      id: randomUUID(),
      type: 'pipeline.progress',
      data: {
        step: 5,
        done: true,
        stepName: 'Scrape All complete',
        scrapeAllSummary: {
          total: sources.length,
          succeeded: succeeded.length,
          failed: failed.length,
          noChange: noChange.length,
          totalRulesCreated: succeeded.reduce((s, r) => s + (r.rulesCreated ?? 0), 0),
          totalRulesUpdated: succeeded.reduce((s, r) => s + (r.rulesUpdated ?? 0), 0),
          failures: failed.map((f) => ({ name: f.name, error: f.error })),
        },
      },
      jurisdiction: '*',
    });

    logger.info({
      total: sources.length,
      succeeded: succeeded.length,
      failed: failed.length,
      noChange: noChange.length,
    }, 'Scrape-all cycle complete');
  })().catch((err) => {
    logger.error({ error: (err as Error).message }, 'Background scrape-all cycle failed');
  }).finally(() => {
    _scrapeAllInFlight = false;
  });

  return c.json({
    status: 'processing',
    sourcesQueued: sources.length,
    sourceNames: sources.map((s) => s.name),
    message: `Pipeline started for ${sources.length} auto-scrape sources. Progress will appear in real-time via SSE.`,
  });
});

// Get pipeline history
adminRoutes.get('/pipeline-runs', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const runs = getRecentPipelineRuns(limit);
  return c.json({ count: runs.length, runs });
});

// Trigger shadow tests
adminRoutes.post('/shadow-test', (c) => {
  const results = runShadowTests();
  return c.json(results);
});

// Verify integrity
adminRoutes.post('/verify-integrity', (c) => {
  const results = verifyIntegrity();
  return c.json(results);
});

// Compute state hash
adminRoutes.post('/state-hash', (c) => {
  const result = computeAndStoreStateHash();
  return c.json(result);
});

// Approve a pending rule (when NOMUS_REQUIRE_RULE_APPROVAL=true)
adminRoutes.post('/rules/:id/approve', (c) => {
  const db = getDb();
  const result = db.update(policyRules)
    .set({ isActive: true, updatedAt: new Date().toISOString() })
    .where(eq(policyRules.id, c.req.param('id')))
    .run();
  if (result.changes === 0) return c.json({ error: 'Rule not found' }, 404);
  return c.json({ message: 'Rule approved and activated' });
});

// Reject a pending rule
adminRoutes.post('/rules/:id/reject', (c) => {
  const db = getDb();
  const result = db.delete(policyRules)
    .where(eq(policyRules.id, c.req.param('id')))
    .run();
  if (result.changes === 0) return c.json({ error: 'Rule not found' }, 404);
  return c.json({ message: 'Rule rejected and deleted' });
});

// Source health status
adminRoutes.get('/source-health', (c) => {
  const health = getSourceHealthStatus();
  const sla = checkSlaBreaches();
  return c.json({ sources: health, sla });
});

// Trigger full data quality audit — runs in background
adminRoutes.post('/audit', async (c) => {
  const deepAudit = c.req.query('deepAudit') === 'true';

  // Fire in background — don't block the HTTP response
  runFullAudit({ deepAudit }).catch((err) => {
    logger.error({ error: (err as Error).message }, 'Background data audit failed');
  });

  return c.json({
    status: 'processing',
    message: `Data quality audit started${deepAudit ? ' (with LLM re-audit)' : ''}. Results will appear on source tiles.`,
  });
});

// Trigger audit for a single source
adminRoutes.post('/audit/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId');
  const deepAudit = c.req.query('deepAudit') === 'true';

  const report = await auditSource(sourceId, { deepAudit });
  saveAuditReport(report);

  return c.json(report);
});

// Get latest audit result for a source
adminRoutes.get('/audit/:sourceId', (c) => {
  const sourceId = c.req.param('sourceId');
  const result = getAuditResult(sourceId);
  if (!result) return c.json({ error: 'No audit results for this source' }, 404);
  return c.json(result);
});

// Rotate signing keys (generates new keypair)
adminRoutes.post('/rotate-keys', (c) => {
  // Note: this would invalidate all existing signatures
  // In production, implement key versioning with kid
  const result = initSigningKeys();
  return c.json({ message: 'Signing keys rotated', publicKey: result.publicKey });
});

// ─── Scan findings across organizations ───────────────────────
// The admin Scans page used the org-scoped /scan endpoints, so a platform
// admin saw only the admin organization's (usually zero) findings under the
// title "Scan Administration", and its "Critical" card counted only the 20
// most recent findings.
adminRoutes.get('/scans/summary', (c) => {
  const db = getDb();
  const repos = db.select({
    orgId: scanFindings.orgId,
    orgName: organizations.name,
    repo: scanFindings.repo,
    totalFindings: sql<number>`count(*)`,
    openFindings: sql<number>`sum(case when ${scanFindings.status} = 'open' then 1 else 0 end)`,
    criticalOpen: sql<number>`sum(case when ${scanFindings.status} = 'open' and ${scanFindings.severity} = 'critical' then 1 else 0 end)`,
    lastScanned: sql<string>`max(${scanFindings.scannedAt})`,
  })
    .from(scanFindings)
    .leftJoin(organizations, eq(scanFindings.orgId, organizations.id))
    .groupBy(scanFindings.orgId, scanFindings.repo)
    .orderBy(desc(sql`max(${scanFindings.scannedAt})`))
    .all();

  const recentFindings = db.select({
    id: scanFindings.id,
    orgName: organizations.name,
    repo: scanFindings.repo,
    filePath: scanFindings.filePath,
    lineNumber: scanFindings.lineNumber,
    ruleKey: scanFindings.ruleKey,
    severity: scanFindings.severity,
    scannedAt: scanFindings.scannedAt,
  })
    .from(scanFindings)
    .leftJoin(organizations, eq(scanFindings.orgId, organizations.id))
    .where(eq(scanFindings.status, 'open'))
    .orderBy(desc(scanFindings.scannedAt))
    .limit(20)
    .all();

  return c.json({
    totals: {
      organizations: new Set(repos.map((r) => r.orgId)).size,
      repos: repos.length,
      totalFindings: repos.reduce((s, r) => s + r.totalFindings, 0),
      openFindings: repos.reduce((s, r) => s + (r.openFindings ?? 0), 0),
      criticalOpen: repos.reduce((s, r) => s + (r.criticalOpen ?? 0), 0),
    },
    repos,
    recentFindings,
  });
});

// ─── Staged Content Management ─────────────────────────────────

// List all staged content with status
adminRoutes.get('/staged', (c) => {
  const db = getDb();
  const status = c.req.query('status'); // optional filter
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);

  let query = db.select({
    id: stagedContent.id,
    sourceId: stagedContent.sourceId,
    contentHash: stagedContent.contentHash,
    fetchedAt: stagedContent.fetchedAt,
    wordCount: stagedContent.wordCount,
    source: stagedContent.source,
    // Verification (Step 3)
    verificationPassed: stagedContent.verificationPassed,
    verificationIssues: stagedContent.verificationIssues,
    verificationStats: stagedContent.verificationStats,
    llmSpotCheckUsed: stagedContent.llmSpotCheckUsed,
    // Quality scoring
    qualityGrade: stagedContent.qualityGrade,
    qualityStructure: stagedContent.qualityStructure,
    qualityText: stagedContent.qualityText,
    qualityIssues: stagedContent.qualityIssues,
    qualityDiagnostic: stagedContent.qualityDiagnostic,
    pipelineStep: stagedContent.pipelineStep,
    pipelineStatus: stagedContent.pipelineStatus,
    pipelineError: stagedContent.pipelineError,
    retryCount: stagedContent.retryCount,
    extractedCount: stagedContent.extractedCount,
    scoredCount: stagedContent.scoredCount,
    rejectedCount: stagedContent.rejectedCount,
    llmProvider: stagedContent.llmProvider,
    llmModel: stagedContent.llmModel,
    llmTokensIn: stagedContent.llmTokensIn,
    llmTokensOut: stagedContent.llmTokensOut,
    llmCostCents: stagedContent.llmCostCents,
    healingAttempted: stagedContent.healingAttempted,
    healingStrategy: stagedContent.healingStrategy,
    healingLog: stagedContent.healingLog,
    createdAt: stagedContent.createdAt,
    updatedAt: stagedContent.updatedAt,
    // Join source name
    sourceName: regulatorySources.name,
    sourceJurisdiction: regulatorySources.jurisdiction,
  })
    .from(stagedContent)
    .leftJoin(regulatorySources, eq(stagedContent.sourceId, regulatorySources.id))
    .orderBy(desc(stagedContent.updatedAt))
    .limit(limit)
    .$dynamic();

  let rows;
  if (status) {
    rows = query
      .where(eq(stagedContent.pipelineStatus, status as typeof stagedContent.$inferSelect['pipelineStatus']))
      .all();
  } else {
    rows = query.all();
  }

  return c.json({ count: rows.length, staged: rows });
});

// Approve a needs_review item — triggers extraction pipeline
adminRoutes.post('/staged/:id/approve', async (c) => {
  const db = getDb();
  const id = c.req.param('id');

  const entry = db.select().from(stagedContent)
    .where(eq(stagedContent.id, id))
    .get();

  if (!entry) return c.json({ error: 'Staged entry not found' }, 404);

  if (entry.pipelineStatus !== 'needs_review') {
    return c.json({
      error: `Cannot approve entry with status '${entry.pipelineStatus}'. Only 'needs_review' entries can be approved.`,
    }, 400);
  }

  // Move to 'cleaned' status so the pipeline resumes at verification (Step 3)
  db.update(stagedContent)
    .set({
      pipelineStatus: 'cleaned',
      pipelineStep: 2,
      qualityDiagnostic: `${entry.qualityDiagnostic ?? ''} [ADMIN APPROVED]`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(stagedContent.id, id))
    .run();

  // Fire the pipeline in background — it will find the 'cleaned' staged entry and resume from verify
  runPipeline(entry.sourceId).catch((err) => {
    logger.error({ sourceId: entry.sourceId, stagedId: id, error: (err as Error).message },
      'Background pipeline failed after admin approval');
  });

  return c.json({
    status: 'processing',
    stagedId: id,
    message: 'Staged content approved. Pipeline will resume from verification. Progress via SSE.',
  });
});

// Manually reject a staged item
adminRoutes.post('/staged/:id/reject', async (c) => {
  const db = getDb();
  const id = c.req.param('id');

  const entry = db.select().from(stagedContent)
    .where(eq(stagedContent.id, id))
    .get();

  if (!entry) return c.json({ error: 'Staged entry not found' }, 404);

  if (['promoted', 'rejected'].includes(entry.pipelineStatus)) {
    return c.json({
      error: `Cannot reject entry with status '${entry.pipelineStatus}'. Already in terminal state.`,
    }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const reason = (body as Record<string, unknown>).reason as string || 'Manually rejected by admin';

  db.update(stagedContent)
    .set({
      pipelineStatus: 'rejected',
      pipelineError: reason,
      qualityDiagnostic: `${entry.qualityDiagnostic ?? ''} [ADMIN REJECTED: ${reason}]`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(stagedContent.id, id))
    .run();

  logger.info({ stagedId: id, sourceId: entry.sourceId, reason }, 'Staged content manually rejected by admin');

  return c.json({
    status: 'rejected',
    stagedId: id,
    message: `Staged content rejected: ${reason}`,
  });
});

// Retry a failed item — resets retryCount, re-enters pipeline
adminRoutes.post('/staged/:id/retry', async (c) => {
  const db = getDb();
  const id = c.req.param('id');

  const entry = db.select().from(stagedContent)
    .where(eq(stagedContent.id, id))
    .get();

  if (!entry) return c.json({ error: 'Staged entry not found' }, 404);

  if (!['needs_intervention', 'rejected', 'needs_review'].includes(entry.pipelineStatus)) {
    return c.json({
      error: `Cannot retry entry with status '${entry.pipelineStatus}'. Only failed/rejected/review entries can be retried.`,
    }, 400);
  }

  // Reset to 'pending' with retryCount reset
  db.update(stagedContent)
    .set({
      pipelineStatus: 'pending',
      pipelineStep: 1,
      pipelineError: null,
      retryCount: 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(stagedContent.id, id))
    .run();

  // Fire the pipeline in background
  runPipeline(entry.sourceId).catch((err) => {
    logger.error({ sourceId: entry.sourceId, stagedId: id, error: (err as Error).message },
      'Background pipeline failed after admin retry');
  });

  return c.json({
    status: 'processing',
    stagedId: id,
    message: 'Staged content reset for retry. Pipeline will resume from cleaning. Progress via SSE.',
  });
});
