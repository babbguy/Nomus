/**
 * Forge API Routes
 *
 * Admin routes for controlling The Forge bulk ingestion pipeline.
 * Public and admin routes for The Ledger.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { logger } from '../../logger.js';
import { safeJson } from '../utils.js';
import {
  startForge,
  stopForge,
  getStatus,
  getForgeState,
  populateQueue,
} from '../../forge/orchestrator.js';
import {
  harvestAll,
  buildSourceListFromDb,
  getMissingSources,
} from '../../forge/harvester.js';
import { getJobs, getJob, getUnrepairableJobs, getJobCounts } from '../../forge/queue.js';
import {
  getPublicLedger,
  getDetailedLedger,
  getLedgerEntry,
  getLedgerStats,
  setPublishingEnabled,
} from '../../forge/ledger.js';
import type { HarvestManifest, HarvestSource, ForgeJobStatus, LedgerStatus } from '../../forge/types.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { isSsrfSafe } from '../utils/ssrf.js';

// ─── Admin Routes (require platform_admin role) ──────────────

export const forgeAdminRoutes = new Hono<AppEnv>();

forgeAdminRoutes.use('*', requireSessionOrApiKey('admin'));
forgeAdminRoutes.use('*', rateLimit());

/** Start the Forge pipeline */
forgeAdminRoutes.post('/start', async (c) => {
  const state = getForgeState();
  if (state === 'processing') {
    return c.json({ error: 'Forge is already running', state }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const concurrency = body.concurrency ?? undefined;

  // Run in background — don't block the HTTP response
  startForge({ concurrency }).catch((err) => {
    logger.error({ error: (err as Error).message }, 'Forge background task failed');
  });

  return c.json({
    message: 'Forge started',
    state: 'processing',
    concurrency: concurrency ?? 3,
  });
});

/** Stop the Forge pipeline gracefully */
forgeAdminRoutes.post('/stop', (c) => {
  stopForge();
  return c.json({ message: 'Stop requested — finishing current jobs', state: 'stopping' });
});

/** Get Forge status */
forgeAdminRoutes.get('/status', (c) => {
  return c.json(getStatus());
});

const harvestSourceSchema = z.object({
  name: z.string().min(1).max(200),
  jurisdiction: z.string().min(1).max(50),
  url: z.string().url().max(2048),
  parserType: z.enum(['html', 'pdf']).optional(),
}).passthrough(); // allow extra fields the harvester may use

const harvestBodySchema = z.object({
  sources: z.array(harvestSourceSchema).min(1).max(500).optional(),
});

/** Run the Harvester (fetch documents from known URLs) */
forgeAdminRoutes.post('/harvest', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = harvestBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  let sources: HarvestSource[];
  if (parsed.data.sources && parsed.data.sources.length > 0) {
    // Validate every URL is SSRF-safe before passing to the harvester.
    for (const s of parsed.data.sources) {
      const check = isSsrfSafe(s.url);
      if (!check.ok) {
        return c.json({ error: `URL rejected: ${s.url} (${check.reason})` }, 400);
      }
    }
    sources = parsed.data.sources as HarvestSource[];
  } else {
    // Build from existing regulatory sources in DB
    sources = await buildSourceListFromDb();
  }

  if (sources.length === 0) {
    return c.json({ error: 'No sources to harvest' }, 400);
  }

  // Run harvest
  const manifest = await harvestAll(sources);

  return c.json({
    harvestedAt: manifest.harvestedAt,
    total: manifest.totalSources,
    fetched: manifest.fetched,
    failed: manifest.failed,
    skipped: manifest.skipped,
    missing: getMissingSources(manifest),
    results: manifest.results.map((r) => ({
      name: r.source.name,
      jurisdiction: r.source.jurisdiction,
      status: r.status,
      strategy: r.strategy,
      pageCount: r.pageCount,
      wordCount: r.wordCount,
      error: r.error,
      durationMs: r.durationMs,
    })),
  });
});

/** Get documents the Harvester couldn't fetch */
forgeAdminRoutes.get('/harvest/missing', (c) => {
  // Read the last harvest manifest from the queue stats
  // Since we don't persist the manifest, return unrepairable + error jobs instead
  const errorJobs = getUnrepairableJobs();
  return c.json({
    count: errorJobs.length,
    documents: errorJobs.map((j) => ({
      id: j.id,
      name: j.sourceName,
      jurisdiction: j.jurisdiction,
      error: j.errorMessage,
      category: j.errorCategory,
      attempts: j.attempt,
    })),
  });
});

/** List all forge jobs with optional filters */
forgeAdminRoutes.get('/jobs', (c) => {
  const status = c.req.query('status') as ForgeJobStatus | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const result = getJobs({ status, limit, offset });
  return c.json({
    jobs: result.jobs,
    total: result.total,
    counts: getJobCounts(),
  });
});

/** Get a single forge job by ID */
forgeAdminRoutes.get('/jobs/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json(job);
});

/** Get unrepairable jobs */
forgeAdminRoutes.get('/unrepairable', (c) => {
  const jobs = getUnrepairableJobs();
  return c.json({
    count: jobs.length,
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.sourceName,
      jurisdiction: j.jurisdiction,
      error: j.errorMessage,
      category: j.errorCategory,
      attempts: j.attempt,
      queuedAt: j.queuedAt,
      completedAt: j.completedAt,
    })),
  });
});

/** Re-populate the queue from the regulations directory */
forgeAdminRoutes.post('/scan', (c) => {
  const enqueued = populateQueue();
  return c.json({
    message: `Scanned regulations directory`,
    enqueued,
    counts: getJobCounts(),
  });
});

/** Get Ledger stats (admin view — includes publishing toggle) */
forgeAdminRoutes.get('/ledger/stats', (c) => {
  return c.json(getLedgerStats());
});

/** Toggle Ledger publishing */
forgeAdminRoutes.post('/ledger/publish', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const { enabled } = body as { enabled: unknown };
  if (typeof enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400);
  }
  setPublishingEnabled(enabled);
  return c.json({ message: `Ledger publishing ${enabled ? 'enabled' : 'disabled'}` });
});

/** Get detailed Ledger entries (admin view) */
forgeAdminRoutes.get('/ledger', (c) => {
  const jurisdiction = c.req.query('jurisdiction');
  const status = c.req.query('status') as LedgerStatus | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const result = getDetailedLedger({ jurisdiction, status, limit, offset });
  return c.json({ entries: result.entries, total: result.total });
});

// ─── Public Ledger Routes (no auth required) ─────────────────

export const ledgerPublicRoutes = new Hono();

/** Public Ledger — limited fields, only published entries */
ledgerPublicRoutes.get('/', (c) => {
  const jurisdiction = c.req.query('jurisdiction');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const result = getPublicLedger({ jurisdiction, limit, offset });
  const stats = getLedgerStats();

  return c.json({
    ledger: {
      totalDocuments: stats.totalDocuments,
      verified: stats.verified,
      jurisdictions: stats.jurisdictions,
      totalRulesAccepted: stats.totalRulesAccepted,
    },
    entries: result.entries,
    total: result.total,
  });
});

/** Public Ledger entry detail */
ledgerPublicRoutes.get('/:id', (c) => {
  const entry = getLedgerEntry(c.req.param('id'));
  if (!entry) return c.json({ error: 'Entry not found' }, 404);

  // Public view — limited fields
  return c.json({
    documentName: entry.documentName,
    jurisdiction: entry.jurisdiction,
    status: entry.status,
    rulesAccepted: entry.rulesAccepted,
    verifiedAt: entry.verifiedAt,
  });
});
