import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { scoutFeeds, scoutItems, regulatorySignals } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { DEFAULT_SCOUT_FEEDS } from '../../scout/default-feeds.js';
import { runScoutCycle } from '../../scout/pipeline.js';
import { logger } from '../../logger.js';
import { safeJson } from '../utils.js';
import { safeParseInt } from '../utils.js';

const govApiConfigSchema = z.object({
  provider: z.enum(['congress_gov', 'federal_register', 'uk_parliament', 'eurlex']),
  queryTerms: z.array(z.string().min(1)).min(1).max(10),
  maxResults: z.number().int().min(1).max(50).optional(),
});

const createFeedSchema = z.object({
  name: z.string().min(2),
  url: z.string().url(),
  feedType: z.enum(['rss', 'atom', 'google_news', 'webpage', 'gov_api']),
  category: z.string().min(1).default('general'),
  jurisdiction: z.string().min(1).default('global'),
  checkIntervalHours: z.number().int().min(1).max(168).default(6),
  apiConfig: govApiConfigSchema.optional(),
}).refine(
  (data) => data.feedType !== 'gov_api' || data.apiConfig !== undefined,
  { message: 'apiConfig is required for gov_api feed type', path: ['apiConfig'] },
);

const updateFeedSchema = z.object({
  name: z.string().min(2).optional(),
  url: z.string().url().optional(),
  feedType: z.enum(['rss', 'atom', 'google_news', 'webpage', 'gov_api']).optional(),
  category: z.string().min(1).optional(),
  jurisdiction: z.string().min(1).optional(),
  checkIntervalHours: z.number().int().min(1).max(168).optional(),
  isActive: z.boolean().optional(),
  apiConfig: govApiConfigSchema.optional(),
});

export const scoutRoutes = new Hono<AppEnv>();

scoutRoutes.use('*', requireSessionOrApiKey('admin'));
scoutRoutes.use('*', rateLimit());

// ─── Feed Management ────────────────────────────────────────────

// List all feeds
scoutRoutes.get('/feeds', (c) => {
  const db = getDb();
  const feeds = db.select().from(scoutFeeds)
    .orderBy(desc(scoutFeeds.createdAt))
    .all();
  return c.json({ count: feeds.length, feeds });
});

// Create a feed
scoutRoutes.post('/feeds', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createFeedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const { apiConfig, ...rest } = parsed.data;
  const feed = {
    id: randomUUID(),
    ...rest,
    apiConfig: apiConfig ? JSON.stringify(apiConfig) : null,
    isActive: true,
    lastItemCount: 0,
    errorCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(scoutFeeds).values(feed).run();
  return c.json({ ...feed, apiConfig: apiConfig ?? null }, 201);
});

// Update a feed
scoutRoutes.patch('/feeds/:id', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateFeedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const db = getDb();
  const id = c.req.param('id');
  const { apiConfig, ...rest } = parsed.data;
  const updates: Record<string, unknown> = { ...rest, updatedAt: new Date().toISOString() };
  if (apiConfig !== undefined) {
    updates.apiConfig = JSON.stringify(apiConfig);
  }

  // Reset error count if re-enabling
  if (parsed.data.isActive === true) {
    updates.errorCount = 0;
    updates.lastError = null;
  }

  const result = db.update(scoutFeeds).set(updates).where(eq(scoutFeeds.id, id)).run();
  if (result.changes === 0) return c.json({ error: 'Feed not found' }, 404);
  return c.json({ message: 'Feed updated' });
});

// Delete a feed. The page's Delete button used to only deactivate it (the
// same as Disable), so the feed stayed listed. A feed whose items became
// radar signals is kept for their provenance: disable it instead.
scoutRoutes.delete('/feeds/:id', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const feed = db.select({ id: scoutFeeds.id }).from(scoutFeeds).where(eq(scoutFeeds.id, id)).get();
  if (!feed) return c.json({ error: 'Feed not found' }, 404);

  const promoted = db.select({ n: sql<number>`count(*)` }).from(scoutItems)
    .where(and(eq(scoutItems.feedId, id), inArray(scoutItems.status, ['accepted', 'auto_promoted'])))
    .get()?.n ?? 0;
  if (promoted > 0) {
    return c.json({
      error: `This feed produced ${promoted} radar signal(s); it is kept as their source. Disable it instead.`,
    }, 409);
  }

  db.transaction((tx) => {
    tx.delete(scoutItems).where(eq(scoutItems.feedId, id)).run();
    tx.delete(scoutFeeds).where(eq(scoutFeeds.id, id)).run();
  });
  return c.json({ message: 'Feed deleted' });
});

// Seed default feeds (idempotent)
scoutRoutes.post('/feeds/seed', (c) => {
  const db = getDb();
  const now = new Date().toISOString();
  let seeded = 0;

  for (const feed of DEFAULT_SCOUT_FEEDS) {
    // Skip if URL already exists
    const existing = db.select({ id: scoutFeeds.id })
      .from(scoutFeeds)
      .where(eq(scoutFeeds.url, feed.url))
      .get();
    if (existing) continue;

    db.insert(scoutFeeds).values({
      id: randomUUID(),
      name: feed.name,
      url: feed.url,
      feedType: feed.feedType,
      category: feed.category,
      jurisdiction: feed.jurisdiction,
      apiConfig: feed.apiConfig ? JSON.stringify(feed.apiConfig) : null,
      isActive: true,
      checkIntervalHours: 6,
      lastItemCount: 0,
      errorCount: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    seeded++;
  }

  return c.json({ message: `Seeded ${seeded} feeds (${DEFAULT_SCOUT_FEEDS.length - seeded} already existed)` });
});

// ─── Item Management ────────────────────────────────────────────

// List items (filterable)
scoutRoutes.get('/items', (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const feedId = c.req.query('feedId');
  const limit = Math.min(safeParseInt(c.req.query('limit'), 50), 200);
  const offset = safeParseInt(c.req.query('offset'), 0);

  // Filter in SQL, before the limit: filtering the newest `limit` rows of
  // every status afterwards showed 9 of 879 pending items in the review queue.
  const filters = [];
  if (status) filters.push(eq(scoutItems.status, status as typeof scoutItems.$inferSelect.status));
  if (feedId) filters.push(eq(scoutItems.feedId, feedId));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const items = db.select().from(scoutItems)
    .where(where)
    .orderBy(desc(scoutItems.discoveredAt))
    .limit(limit)
    .offset(offset)
    .all();
  const total = db.select({ n: sql<number>`count(*)` }).from(scoutItems).where(where).get()?.n ?? 0;

  // Parse extractedSignal JSON for convenience
  const enriched = items.map((item) => ({
    ...item,
    extractedSignal: (() => { if (!item.extractedSignal) return null; try { return JSON.parse(item.extractedSignal); } catch { return item.extractedSignal; } })(),
  }));

  return c.json({ count: enriched.length, total, items: enriched });
});

// Accept item — promote to Radar
scoutRoutes.post('/items/:id/accept', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const userId = c.get('orgId');

  const item = db.select().from(scoutItems).where(eq(scoutItems.id, id)).get();
  if (!item) return c.json({ error: 'Item not found' }, 404);
  if (item.status === 'accepted' || item.status === 'auto_promoted') {
    return c.json({ error: 'Item already promoted' }, 400);
  }

  // Allow overriding extracted signal fields
  const body = await c.req.json().catch(() => ({}));
  const signal = (() => { if (!item.extractedSignal) return null; try { return JSON.parse(item.extractedSignal); } catch { return null; } })();
  const title = body.title ?? signal?.title ?? item.title;
  const jurisdiction = body.jurisdiction ?? signal?.jurisdiction ?? 'global';
  const stage = body.stage ?? signal?.stage ?? 'signal';
  const likelihoodPercent = body.likelihoodPercent ?? signal?.likelihoodPercent ?? 50;
  const summary = body.summary ?? signal?.summary ?? item.rawSnippet ?? '';

  const now = new Date().toISOString();
  const signalId = randomUUID();

  db.insert(regulatorySignals).values({
    id: signalId,
    title,
    jurisdiction,
    stage,
    likelihoodPercent,
    summary,
    sourceUrl: item.url,
    detectedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();

  db.update(scoutItems).set({
    status: 'accepted',
    promotedSignalId: signalId,
    reviewedBy: userId,
    reviewedAt: now,
  }).where(eq(scoutItems.id, id)).run();

  return c.json({ message: 'Item promoted to Radar', signalId });
});

// Reject item
scoutRoutes.post('/items/:id/reject', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const userId = c.get('orgId');

  const result = db.update(scoutItems).set({
    status: 'rejected',
    reviewedBy: userId,
    reviewedAt: new Date().toISOString(),
  }).where(eq(scoutItems.id, id)).run();

  if (result.changes === 0) return c.json({ error: 'Item not found' }, 404);
  return c.json({ message: 'Item rejected' });
});

// Bulk review
scoutRoutes.post('/items/bulk-review', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = z.object({
    action: z.enum(['accept', 'reject']),
    itemIds: z.array(z.string()).min(1).max(100),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }
  const { action, itemIds } = parsed.data;

  const db = getDb();
  const userId = c.get('orgId');
  const now = new Date().toISOString();
  let processed = 0;

  for (const id of itemIds) {
    if (action === 'reject') {
      const result = db.update(scoutItems).set({
        status: 'rejected',
        reviewedBy: userId,
        reviewedAt: now,
      }).where(eq(scoutItems.id, id)).run();
      if (result.changes > 0) processed++;
    } else {
      // Accept: create signal from extracted data
      const item = db.select().from(scoutItems).where(eq(scoutItems.id, id)).get();
      if (!item || item.status === 'accepted' || item.status === 'auto_promoted') continue;

      const signal = (() => { if (!item.extractedSignal) return null; try { return JSON.parse(item.extractedSignal); } catch { return null; } })();
      const signalId = randomUUID();

      db.insert(regulatorySignals).values({
        id: signalId,
        title: signal?.title ?? item.title,
        jurisdiction: signal?.jurisdiction ?? 'global',
        stage: signal?.stage ?? 'signal',
        likelihoodPercent: signal?.likelihoodPercent ?? 50,
        summary: signal?.summary ?? item.rawSnippet ?? '',
        sourceUrl: item.url,
        detectedAt: now,
        createdAt: now,
        updatedAt: now,
      }).run();

      db.update(scoutItems).set({
        status: 'accepted',
        promotedSignalId: signalId,
        reviewedBy: userId,
        reviewedAt: now,
      }).where(eq(scoutItems.id, id)).run();
      processed++;
    }
  }

  return c.json({ message: `${action === 'accept' ? 'Accepted' : 'Rejected'} ${processed} items` });
});

// ─── Stats + Trigger ────────────────────────────────────────────

// Stats
scoutRoutes.get('/stats', (c) => {
  const db = getDb();

  const feedCount = db.select({ count: sql<number>`count(*)` })
    .from(scoutFeeds).where(eq(scoutFeeds.isActive, true)).get();

  const statusCounts = db.select({
    status: scoutItems.status,
    count: sql<number>`count(*)`,
  }).from(scoutItems).groupBy(scoutItems.status).all();

  const monthlyCost = db.select({
    total: sql<number>`coalesce(sum(llm_cost_cents), 0)`,
  }).from(scoutItems).where(
    sql`discovered_at >= datetime('now', '-30 days')`
  ).get();

  return c.json({
    activeFeeds: feedCount?.count ?? 0,
    itemsByStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s.count])),
    monthlyLlmCostCents: monthlyCost?.total ?? 0,
  });
});

// Manual trigger — runs synchronously so caller gets full results
scoutRoutes.post('/trigger', async (c) => {
  logger.info('Scout: Manual cycle triggered via API');
  try {
    const result = await runScoutCycle();
    logger.info(result, 'Scout: Manual cycle complete');
    return c.json({ message: 'Scout cycle complete', result });
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Scout: Manual cycle failed');
    return c.json({ error: 'Scout cycle failed', details: (err as Error).message }, 500);
  }
});
