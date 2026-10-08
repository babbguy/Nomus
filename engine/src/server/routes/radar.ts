import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { regulatorySignals } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';

const createSignalSchema = z.object({
  title: z.string().min(3),
  jurisdiction: z.string().min(2),
  stage: z.enum(['signal', 'draft', 'committee', 'adopted', 'active']).default('signal'),
  likelihoodPercent: z.number().min(0).max(100).default(50),
  summary: z.string().min(10),
  sourceUrl: z.string().url().optional(),
  expectedEffectiveDate: z.string().optional(),
});

// jurisdiction is editable (it was silently dropped); sourceUrl and
// expectedEffectiveDate accept null to clear them.
const updateSignalSchema = z.object({
  title: z.string().min(3).optional(),
  jurisdiction: z.string().min(2).optional(),
  stage: z.enum(['signal', 'draft', 'committee', 'adopted', 'active']).optional(),
  likelihoodPercent: z.number().min(0).max(100).optional(),
  summary: z.string().min(10).optional(),
  sourceUrl: z.string().url().nullable().optional(),
  expectedEffectiveDate: z.string().nullable().optional(),
});

export const radarRoutes = new Hono<AppEnv>();

radarRoutes.use('*', requireSessionOrApiKey('read:policies'));
radarRoutes.use('*', rateLimit());

// List signals
radarRoutes.get('/', (c) => {
  const db = getDb();
  const jurisdiction = c.req.query('jurisdiction');
  const stage = c.req.query('stage');

  let signals = db.select().from(regulatorySignals)
    .orderBy(desc(regulatorySignals.detectedAt))
    .all();

  if (jurisdiction) signals = signals.filter((s) => s.jurisdiction === jurisdiction);
  if (stage) signals = signals.filter((s) => s.stage === stage);

  return c.json({ count: signals.length, signals, _disclaimer: LEGAL_DISCLAIMER });
});

// Create signal (admin only)
radarRoutes.post('/', async (c) => {
  const scopes = c.get('scopes') || [];
  if (!scopes.includes('admin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createSignalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const signal = {
    id: randomUUID(),
    sourceId: null,
    title: parsed.data.title,
    jurisdiction: parsed.data.jurisdiction,
    stage: parsed.data.stage,
    likelihoodPercent: parsed.data.likelihoodPercent,
    summary: parsed.data.summary,
    sourceUrl: parsed.data.sourceUrl ?? null,
    detectedAt: now,
    expectedEffectiveDate: parsed.data.expectedEffectiveDate ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(regulatorySignals).values(signal).run();
  return c.json(signal, 201);
});

// Update signal (admin only)
radarRoutes.patch('/:id', async (c) => {
  const scopes = c.get('scopes') || [];
  if (!scopes.includes('admin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateSignalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const db = getDb();
  const id = c.req.param('id');

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.title) updates.title = parsed.data.title;
  if (parsed.data.jurisdiction) updates.jurisdiction = parsed.data.jurisdiction;
  if (parsed.data.stage) updates.stage = parsed.data.stage;
  if (parsed.data.likelihoodPercent !== undefined) updates.likelihoodPercent = parsed.data.likelihoodPercent;
  if (parsed.data.summary) updates.summary = parsed.data.summary;
  if (parsed.data.sourceUrl !== undefined) updates.sourceUrl = parsed.data.sourceUrl;
  if (parsed.data.expectedEffectiveDate !== undefined) updates.expectedEffectiveDate = parsed.data.expectedEffectiveDate;

  const result = db.update(regulatorySignals)
    .set(updates)
    .where(eq(regulatorySignals.id, id))
    .run();

  if (result.changes === 0) return c.json({ error: 'Signal not found' }, 404);
  return c.json({ message: 'Signal updated' });
});

// Delete signal (admin only)
radarRoutes.delete('/:id', (c) => {
  const scopes = c.get('scopes') || [];
  if (!scopes.includes('admin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const db = getDb();
  const result = db.delete(regulatorySignals)
    .where(eq(regulatorySignals.id, c.req.param('id')))
    .run();

  if (result.changes === 0) return c.json({ error: 'Signal not found' }, 404);
  return c.json({ message: 'Signal deleted' });
});
