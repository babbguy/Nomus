import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { regulatorySources } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import {
  checkSourceHealth,
  checkAllSourceHealth,
  getSourceHealthSummary,
} from '../../hunter/source-health-checker.js';

export const sourceHealthRoutes = new Hono<AppEnv>();

sourceHealthRoutes.use('*', requireSessionOrApiKey('admin'));

// GET / — returns health status for all sources
sourceHealthRoutes.get('/', (c) => {
  const db = getDb();
  const sources = db.select().from(regulatorySources).all();

  const summary = getSourceHealthSummary();

  const sourceList = sources.map((s) => ({
    id: s.id,
    name: s.name,
    jurisdiction: s.jurisdiction,
    url: s.url,
    isActive: s.isActive,
    connectivityStatus: s.connectivityStatus ?? 'unknown',
    connectivityCheckedAt: s.connectivityCheckedAt,
    connectivityError: s.connectivityError,
    consecutiveFailures: s.consecutiveFailures ?? 0,
    lastSuccessfulScrapeAt: s.lastSuccessfulScrapeAt,
    lastScrapedAt: s.lastScrapedAt,
  }));

  return c.json({ summary, sources: sourceList });
});

// POST /check — trigger health check for all active sources
sourceHealthRoutes.post('/check', async (c) => {
  const results = await checkAllSourceHealth();
  const summary = getSourceHealthSummary();

  return c.json({
    checked: results.length,
    summary,
    results: results.map((r) => ({
      sourceId: r.sourceId,
      name: r.name,
      status: r.result.status,
      latencyMs: r.result.latencyMs,
      error: r.result.error,
    })),
  });
});

// POST /check/:sourceId — check a single source
sourceHealthRoutes.post('/check/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId');
  const db = getDb();

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  const result = await checkSourceHealth(sourceId);

  return c.json({
    sourceId,
    name: source.name,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
  });
});
