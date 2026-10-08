import { Hono } from 'hono';
import { eq, desc, sql, and, gte, lte, asc } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import {
  trackedBills,
  billStageHistory,
  billScoreHistory,
  billNews,
} from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { safeParseInt } from '../utils.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';

// ─── Routes ────────────────────────────────────────────────────

export const radarV2Routes = new Hono<AppEnv>();

radarV2Routes.use('*', requireSessionOrApiKey('read:policies'));
radarV2Routes.use('*', rateLimit());

// SA1: List tracked bills with filtering + pagination
radarV2Routes.get('/bills', (c) => {
  const db = getDb();
  const jurisdiction = c.req.query('jurisdiction');
  const stage = c.req.query('stage');
  const minScore = safeParseInt(c.req.query('minScore'), 0);
  const maxScore = safeParseInt(c.req.query('maxScore'), 100);
  const page = Math.max(1, safeParseInt(c.req.query('page'), 1));
  const limit = Math.min(100, Math.max(1, safeParseInt(c.req.query('limit'), 20)));
  const offset = (page - 1) * limit;

  // Build WHERE conditions
  const conditions = [
    gte(trackedBills.passageScore, minScore),
    lte(trackedBills.passageScore, maxScore),
  ];
  if (jurisdiction) conditions.push(eq(trackedBills.jurisdiction, jurisdiction));
  if (stage) conditions.push(eq(trackedBills.currentStage, stage));

  const where = and(...conditions);

  const totalRow = db.select({ count: sql<number>`count(*)` })
    .from(trackedBills)
    .where(where)
    .get();

  const bills = db.select()
    .from(trackedBills)
    .where(where)
    .orderBy(desc(trackedBills.passageScore), desc(trackedBills.updatedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return c.json({
    bills,
    total: totalRow?.count ?? 0,
    page,
    limit,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// SA2: Bill detail
radarV2Routes.get('/bills/:id', (c) => {
  const db = getDb();
  const id = c.req.param('id');

  const bill = db.select().from(trackedBills).where(eq(trackedBills.id, id)).get();
  if (!bill) return c.json({ error: 'Bill not found' }, 404);

  return c.json({ bill, _disclaimer: LEGAL_DISCLAIMER });
});

// SA3: Bill stage timeline
radarV2Routes.get('/bills/:id/timeline', (c) => {
  const db = getDb();
  const id = c.req.param('id');

  // Verify bill exists
  const bill = db.select({ id: trackedBills.id }).from(trackedBills).where(eq(trackedBills.id, id)).get();
  if (!bill) return c.json({ error: 'Bill not found' }, 404);

  const stages = db.select()
    .from(billStageHistory)
    .where(eq(billStageHistory.billId, id))
    .orderBy(asc(billStageHistory.enteredAt))
    .all();

  return c.json({ stages });
});

// SA4: Score trend
radarV2Routes.get('/bills/:id/scores', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const days = safeParseInt(c.req.query('days'), 90);

  // Verify bill exists
  const bill = db.select({ id: trackedBills.id }).from(trackedBills).where(eq(trackedBills.id, id)).get();
  if (!bill) return c.json({ error: 'Bill not found' }, 404);

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const scores = db.select()
    .from(billScoreHistory)
    .where(and(
      eq(billScoreHistory.billId, id),
      gte(billScoreHistory.computedAt, cutoff),
    ))
    .orderBy(asc(billScoreHistory.computedAt))
    .all();

  return c.json({ scores });
});

// SA5: Related news articles
radarV2Routes.get('/bills/:id/news', (c) => {
  const db = getDb();
  const id = c.req.param('id');

  // Verify bill exists
  const bill = db.select({ id: trackedBills.id }).from(trackedBills).where(eq(trackedBills.id, id)).get();
  if (!bill) return c.json({ error: 'Bill not found' }, 404);

  const articles = db.select()
    .from(billNews)
    .where(eq(billNews.billId, id))
    .orderBy(desc(billNews.publishedAt))
    .all();

  return c.json({ articles });
});

// SA6: Global aggregation stats
radarV2Routes.get('/stats', (c) => {
  const db = getDb();

  const totalRow = db.select({ count: sql<number>`count(*)` })
    .from(trackedBills)
    .get();

  const jurisdictionRows = db.select({
    jurisdiction: trackedBills.jurisdiction,
    count: sql<number>`count(*)`,
  }).from(trackedBills).groupBy(trackedBills.jurisdiction).all();

  const stageRows = db.select({
    stage: trackedBills.currentStage,
    count: sql<number>`count(*)`,
  }).from(trackedBills).groupBy(trackedBills.currentStage).all();

  const avgRow = db.select({
    avg: sql<number>`coalesce(avg(passage_score), 0)`,
  }).from(trackedBills).get();

  return c.json({
    totalBills: totalRow?.count ?? 0,
    byJurisdiction: Object.fromEntries(jurisdictionRows.map((r) => [r.jurisdiction, r.count])),
    byStage: Object.fromEntries(stageRows.map((r) => [r.stage, r.count])),
    avgScore: Math.round((avgRow?.avg ?? 0) * 100) / 100,
  });
});

// SA7: Top movers — bills with biggest score changes
radarV2Routes.get('/movers', (c) => {
  const db = getDb();
  const days = safeParseInt(c.req.query('days'), 7);
  const limit = Math.min(50, Math.max(1, safeParseInt(c.req.query('limit'), 10)));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // For each bill, find the oldest score within the window and compare to current score
  const movers = db.all<{
    id: string;
    title: string;
    jurisdiction: string;
    currentStage: string;
    passageScore: number | null;
    oldScore: number | null;
  }>(sql`
    SELECT
      b.id,
      b.title,
      b.jurisdiction,
      b.current_stage AS currentStage,
      b.passage_score AS passageScore,
      (
        SELECT h.score
        FROM bill_score_history h
        WHERE h.bill_id = b.id AND h.computed_at >= ${cutoff}
        ORDER BY h.computed_at ASC
        LIMIT 1
      ) AS oldScore
    FROM tracked_bills b
    WHERE b.passage_score IS NOT NULL
    ORDER BY abs(coalesce(b.passage_score, 0) - coalesce(
      (SELECT h2.score FROM bill_score_history h2 WHERE h2.bill_id = b.id AND h2.computed_at >= ${cutoff} ORDER BY h2.computed_at ASC LIMIT 1),
      b.passage_score
    )) DESC
    LIMIT ${limit}
  `);

  const result = movers.map((m) => ({
    id: m.id,
    title: m.title,
    jurisdiction: m.jurisdiction,
    currentStage: m.currentStage,
    currentScore: m.passageScore ?? 0,
    previousScore: m.oldScore ?? m.passageScore ?? 0,
    change: (m.passageScore ?? 0) - (m.oldScore ?? m.passageScore ?? 0),
  }));

  return c.json({ movers: result, days });
});
