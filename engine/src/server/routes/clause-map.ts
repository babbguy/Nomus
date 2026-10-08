/**
 * Clause Map API.
 *
 *   GET  /mappings              — dataset + learned accuracy state (+ org match counts)
 *   GET  /mappings/:id/history  — learning-event trajectory for one mapping
 *   GET  /matches               — org-scoped clause matches (filter: repo, status, framework)
 *   POST /matches/:id/feedback  — confirm/dismiss → Beta-posterior update
 */

import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { clauseMappings, clauseMatches } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { applyMatchFeedback, learningHistory } from '../../clausemap/learning.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';

const feedbackSchema = z.object({
  verdict: z.enum(['confirm', 'dismiss']),
  note: z.string().max(2000).optional(),
});

export const clauseMapRoutes = new Hono<AppEnv>();

clauseMapRoutes.use('*', requireSessionOrApiKey('evaluate'));
clauseMapRoutes.use('*', rateLimit());

// Full dataset with learned state + this org's match counts per mapping.
clauseMapRoutes.get('/mappings', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;

  const mappings = db
    .select()
    .from(clauseMappings)
    .where(eq(clauseMappings.isActive, true))
    .orderBy(clauseMappings.framework, clauseMappings.clauseCitation)
    .all();

  const orgCounts = db
    .select({
      mappingId: clauseMatches.mappingId,
      total: sql<number>`count(*)`,
      open: sql<number>`sum(case when status = 'open' then 1 else 0 end)`,
      confirmed: sql<number>`sum(case when status = 'confirmed' then 1 else 0 end)`,
      dismissed: sql<number>`sum(case when status = 'dismissed' then 1 else 0 end)`,
    })
    .from(clauseMatches)
    .where(eq(clauseMatches.orgId, orgId))
    .groupBy(clauseMatches.mappingId)
    .all();
  const countsById = new Map(orgCounts.map((r) => [r.mappingId, r]));

  return c.json({
    count: mappings.length,
    mappings: mappings.map((m) => ({
      id: m.id,
      mappingKey: m.mappingKey,
      datasetVersion: m.datasetVersion,
      heuristicLabel: m.heuristicLabel,
      heuristic: JSON.parse(m.heuristicJson),
      framework: m.framework,
      clauseCitation: m.clauseCitation,
      clauseTitle: m.clauseTitle,
      clauseUrl: m.clauseUrl,
      rationale: m.rationale,
      posterior: m.posterior,
      priorMean: m.priorAlpha / (m.priorAlpha + m.priorBeta),
      observations: m.confirmedWeight + m.dismissedWeight,
      firedCount: m.firedCount,
      evaluatedCount: m.evaluatedCount,
      orgMatches: countsById.get(m.id) ?? { total: 0, open: 0, confirmed: 0, dismissed: 0 },
      updatedAt: m.updatedAt,
    })),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Learning trajectory for one mapping.
clauseMapRoutes.get('/mappings/:id/history', (c) => {
  const db = getDb();
  const mapping = db
    .select({ id: clauseMappings.id })
    .from(clauseMappings)
    .where(eq(clauseMappings.id, c.req.param('id')))
    .get();
  if (!mapping) return c.json({ error: 'Mapping not found' }, 404);

  const events = learningHistory(db, mapping.id).map((e) => ({
    eventType: e.eventType,
    posteriorBefore: e.posteriorBefore,
    posteriorAfter: e.posteriorAfter,
    details: JSON.parse(e.detailsJson),
    createdAt: e.createdAt,
  }));
  return c.json({ count: events.length, events });
});

// Org-scoped clause matches, joined with their mapping/clause.
clauseMapRoutes.get('/matches', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const repo = c.req.query('repo');
  const status = c.req.query('status');
  const framework = c.req.query('framework');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);

  const conditions = [eq(clauseMatches.orgId, orgId)];
  if (repo) conditions.push(eq(clauseMatches.repo, repo));
  if (status && ['open', 'confirmed', 'dismissed'].includes(status)) {
    conditions.push(eq(clauseMatches.status, status as 'open' | 'confirmed' | 'dismissed'));
  }
  if (framework && ['EU_AI_ACT', 'HIPAA', 'GDPR'].includes(framework)) {
    conditions.push(eq(clauseMappings.framework, framework as 'EU_AI_ACT' | 'HIPAA' | 'GDPR'));
  }

  const rows = db
    .select({
      match: clauseMatches,
      mapping: clauseMappings,
    })
    .from(clauseMatches)
    .innerJoin(clauseMappings, eq(clauseMatches.mappingId, clauseMappings.id))
    .where(and(...conditions))
    .orderBy(desc(clauseMatches.matchedAt))
    .limit(limit)
    .all();

  return c.json({
    count: rows.length,
    matches: rows.map(({ match, mapping }) => ({
      id: match.id,
      repo: match.repo,
      commitSha: match.commitSha,
      filePath: match.filePath,
      lineNumber: match.lineNumber,
      evidence: JSON.parse(match.evidenceJson),
      confidence: match.confidence,
      livePosterior: mapping.posterior,
      status: match.status,
      matchedAt: match.matchedAt,
      resolvedAt: match.resolvedAt,
      mapping: {
        id: mapping.id,
        mappingKey: mapping.mappingKey,
        heuristicLabel: mapping.heuristicLabel,
        framework: mapping.framework,
        clauseCitation: mapping.clauseCitation,
        clauseTitle: mapping.clauseTitle,
        clauseUrl: mapping.clauseUrl,
        rationale: mapping.rationale,
      },
    })),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Confirm/dismiss a match → learning update (org-scoped to prevent IDOR).
clauseMapRoutes.post('/matches/:id/feedback', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const db = getDb();
  const orgId = c.get('orgId')!;
  const result = applyMatchFeedback(
    db,
    orgId,
    c.req.param('id'),
    parsed.data.verdict,
    parsed.data.note,
  );
  if (!result) return c.json({ error: 'Match not found' }, 404);
  return c.json(result);
});
