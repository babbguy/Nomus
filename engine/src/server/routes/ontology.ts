import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { ontologyTerms } from '../../db/schema.js';
import { importOntologyTerms, replaceOntologyTerms, getActiveOntologyTerms } from '../../db/ontology.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { safeJson, safeParseInt } from '../utils.js';

const ontologyTypeEnum = z.enum(['obligation', 'definition', 'risk_level', 'technical_requirement', 'penalty', 'applicability']);

const createTermSchema = z.object({
  term: z.string().min(1),
  type: ontologyTypeEnum,
  jurisdiction: z.string().default('universal'),
  source_article: z.string().optional(),
  sourceArticle: z.string().optional(),
  description: z.string().min(1),
});

const updateTermSchema = z.object({
  isActive: z.boolean().optional(),
  term: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  type: ontologyTypeEnum.optional(),
});

export const ontologyRoutes = new Hono<AppEnv>();

ontologyRoutes.use('*', requireSessionOrApiKey('admin'));

// List ontology terms
ontologyRoutes.get('/', (c) => {
  const type = c.req.query('type');
  const jurisdiction = c.req.query('jurisdiction');
  const includeInactive = c.req.query('inactive') === 'true';
  const limit = Math.min(Math.max(safeParseInt(c.req.query('limit'), 500), 1), 2000);
  const offset = Math.max(safeParseInt(c.req.query('offset'), 0), 0);

  // Filters run in SQL before the limit (they ran on the first 500 rows).
  const filters = [];
  if (!includeInactive) filters.push(eq(ontologyTerms.isActive, true));
  if (type) filters.push(eq(ontologyTerms.type, type as typeof ontologyTerms.$inferSelect.type));
  if (jurisdiction) filters.push(or(eq(ontologyTerms.jurisdiction, jurisdiction), eq(ontologyTerms.jurisdiction, 'universal'))!);
  const where = filters.length > 0 ? and(...filters) : undefined;

  const db = getDb();
  const terms = db.select().from(ontologyTerms).where(where).orderBy(ontologyTerms.term).limit(limit).offset(offset).all();
  const total = db.select({ n: sql<number>`count(*)` }).from(ontologyTerms).where(where).get()?.n ?? terms.length;

  return c.json({ count: terms.length, total, terms });
});

// Bulk import from JSON (additive — skips duplicates)
ontologyRoutes.post('/import', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected a JSON array of ontology terms' }, 400);
  }
  const result = importOntologyTerms(body);
  return c.json(result);
});

// Replace all terms with new import (wipes existing, then imports)
ontologyRoutes.post('/replace', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected a JSON array of ontology terms' }, 400);
  }
  const result = replaceOntologyTerms(body);
  return c.json(result);
});

// Create single term
ontologyRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createTermSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const db = getDb();
  const now = new Date().toISOString();

  const term = {
    id: randomUUID(),
    term: parsed.data.term,
    type: parsed.data.type,
    jurisdiction: parsed.data.jurisdiction,
    sourceArticle: parsed.data.source_article || parsed.data.sourceArticle || '',
    description: parsed.data.description,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(ontologyTerms).values(term).run();
  return c.json(term, 201);
});

// Toggle active/inactive (approve or reject flagged terms)
ontologyRoutes.patch('/:id', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateTermSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const db = getDb();

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;
  if (parsed.data.term) updates.term = parsed.data.term;
  if (parsed.data.description) updates.description = parsed.data.description;
  if (parsed.data.type) updates.type = parsed.data.type;

  const result = db.update(ontologyTerms)
    .set(updates)
    .where(eq(ontologyTerms.id, c.req.param('id')))
    .run();

  if (result.changes === 0) return c.json({ error: 'Term not found' }, 404);
  return c.json({ message: 'Term updated' });
});

// Delete term
ontologyRoutes.delete('/:id', (c) => {
  const db = getDb();
  const result = db.delete(ontologyTerms)
    .where(eq(ontologyTerms.id, c.req.param('id')))
    .run();

  if (result.changes === 0) return c.json({ error: 'Term not found' }, 404);
  return c.json({ message: 'Term deleted' });
});

// Stats
ontologyRoutes.get('/stats', (c) => {
  const db = getDb();
  const total = db.select({ count: sql<number>`count(*)` }).from(ontologyTerms).get()?.count ?? 0;
  const active = db.select({ count: sql<number>`count(*)` }).from(ontologyTerms).where(eq(ontologyTerms.isActive, true)).get()?.count ?? 0;
  const pending = total - active;

  return c.json({ total, active, pendingReview: pending });
});
