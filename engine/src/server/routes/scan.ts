import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { scanFindings } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { correlateScan, type CorrelatableFinding } from '../../clausemap/correlator.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';

const findingSchema = z.object({
  repo: z.string().optional(),
  prNumber: z.number().int().optional(),
  commitSha: z.string().optional(),
  file: z.string().min(1),
  line: z.number().int(),
  ruleKey: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  effect: z.string().optional(),
  sdk: z.string().optional(),
  capability: z.string().optional(),
  summary: z.string().optional(),
  suggestion: z.string().optional(),
  detectorSource: z.string().optional(),
  legalReference: z.string().optional(),
});

const uploadFindingsSchema = z.object({
  findings: z.array(findingSchema).min(1),
  repo: z.string().optional(),
  prNumber: z.number().int().optional(),
  commitSha: z.string().optional(),
});

const updateFindingSchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']),
});

export const scanRoutes = new Hono<AppEnv>();

scanRoutes.use('*', requireSessionOrApiKey('evaluate'));
scanRoutes.use('*', rateLimit());

// Upload scan findings
scanRoutes.post('/findings', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = uploadFindingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const orgId = c.get('orgId')!;
  const db = getDb();

  let created = 0;
  const correlatable: CorrelatableFinding[] = [];
  for (const f of parsed.data.findings) {
    const findingId = randomUUID();
    db.insert(scanFindings).values({
      id: findingId,
      orgId,
      repo: f.repo || parsed.data.repo || 'unknown',
      prNumber: f.prNumber ?? parsed.data.prNumber ?? null,
      commitSha: f.commitSha || parsed.data.commitSha || 'unknown',
      filePath: f.file,
      lineNumber: f.line,
      ruleId: null,
      ruleKey: f.ruleKey,
      severity: f.severity,
      effect: f.effect || 'flag',
      capabilityDetected: f.sdk || f.capability || 'unknown',
      humanSummary: f.summary || '',
      suggestion: f.suggestion ?? null,
      detectorSource: f.detectorSource ?? null,
      legalReference: f.legalReference ?? null,
      status: 'open',
      scannedAt: new Date().toISOString(),
    }).run();
    created++;
    correlatable.push({
      id: findingId,
      filePath: f.file,
      lineNumber: f.line,
      capability: f.capability || f.sdk || 'unknown',
      detectorSource: f.detectorSource ?? null,
      severity: f.severity,
    });
  }

  // Correlate this scan's findings against the clause map.
  // Correlation failure must never fail the upload (zero silent failures:
  // the error is logged in the response, findings are already persisted).
  let clauseCorrelation: { created: number; suppressed: number; evaluated: number } | null = null;
  let clauseCorrelationError: string | null = null;
  try {
    clauseCorrelation = correlateScan(
      db,
      orgId,
      parsed.data.repo || parsed.data.findings[0]?.repo || 'unknown',
      parsed.data.commitSha || parsed.data.findings[0]?.commitSha || 'unknown',
      correlatable,
    );
  } catch (err) {
    clauseCorrelationError = err instanceof Error ? err.message : 'correlation failed';
  }

  return c.json({ created, clauseCorrelation, clauseCorrelationError }, 201);
});

// Query findings
scanRoutes.get('/findings', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const repo = c.req.query('repo');
  const severity = c.req.query('severity');
  const status = c.req.query('status') || 'open';
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);

  const conditions = [eq(scanFindings.orgId, orgId)];
  if (repo) conditions.push(eq(scanFindings.repo, repo));
  if (severity) conditions.push(eq(scanFindings.severity, severity as 'critical' | 'high' | 'medium' | 'low'));
  if (status) conditions.push(eq(scanFindings.status, status as 'open' | 'resolved' | 'dismissed'));

  const findings = db.select().from(scanFindings)
    .where(and(...conditions))
    .orderBy(desc(scanFindings.scannedAt))
    .limit(limit)
    .all();

  const countResult = db.select({ count: sql<number>`count(*)` }).from(scanFindings)
    .where(and(...conditions))
    .get();

  return c.json({
    count: countResult?.count ?? findings.length,
    findings,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// List repos with scan history
scanRoutes.get('/repos', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;

  const repos = db.select({
    repo: scanFindings.repo,
    totalFindings: sql<number>`count(*)`,
    openFindings: sql<number>`sum(case when status = 'open' then 1 else 0 end)`,
    lastScanned: sql<string>`max(scanned_at)`,
  })
    .from(scanFindings)
    .where(eq(scanFindings.orgId, orgId))
    .groupBy(scanFindings.repo)
    .all();

  return c.json({ count: repos.length, repos });
});

// Dismiss a finding (org-scoped to prevent IDOR)
scanRoutes.patch('/findings/:id', async (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateFindingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  const status = parsed.data.status;

  const result = db.update(scanFindings)
    .set({ status })
    .where(and(eq(scanFindings.id, c.req.param('id')), eq(scanFindings.orgId, orgId)))
    .run();

  if (result.changes === 0) return c.json({ error: 'Finding not found' }, 404);
  return c.json({ message: 'Finding updated' });
});
