import { Hono } from 'hono';
import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { cpgAuditEvents } from '../../../db/schema-cpg.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { verifyAuditChain } from '../../../cpg/audit/log.js';
import { buildGovernanceExport } from '../../../cpg/audit/export.js';
import { auditListResponseSchema, auditQuerySchema } from '../../../cpg/contracts.js';
import { CpgError } from '../../../cpg/errors.js';
import { actorFrom, handle, parseQuery } from './helpers.js';

/**
 * E17 GET /api/v1/cpg/audit: the org's hash-chained audit log, newest first,
 * with `chainValid` from a full re-verification of the chain. E73 GET
 * /api/v1/cpg/audit/export: the same chain and the org's signed records in
 * one signed file.
 */
export const cpgAuditRoutes = new Hono<AppEnv>();

/** Opaque cursor: base64url of `seq:<n>` (the chain position of the last item returned). */
function encodeCursor(seq: number): string {
  return Buffer.from(`seq:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^seq:([1-9][0-9]{0,15})$/.exec(raw);
  if (!m) throw new CpgError(400, 'invalid_input', 'Invalid cursor');
  return Number(m[1]);
}

// E73 the signed governance audit export (registered before the list; the policy log export is E39)
cpgAuditRoutes.get('/export', requireSessionOrApiKey(), rateLimit(), requireCpgPermission('audit.export'), handle((c) => {
  const orgId = actorFrom(c).orgId;
  c.header('Content-Disposition', `attachment; filename="nomus-governance-audit-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(buildGovernanceExport(getDb(), orgId));
}));

cpgAuditRoutes.get('/', requireSessionOrApiKey(), rateLimit(), requireCpgPermission('audit.read'), handle((c) => {
  const q = parseQuery(c, auditQuerySchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;

  const where: SQL[] = [eq(cpgAuditEvents.orgId, orgId)];
  if (q.action) where.push(eq(cpgAuditEvents.action, q.action));
  if (q.since) where.push(gte(cpgAuditEvents.createdAt, new Date(q.since).toISOString()));
  if (q.until) where.push(lte(cpgAuditEvents.createdAt, new Date(q.until).toISOString()));
  if (q.cursor) where.push(lt(cpgAuditEvents.seq, decodeCursor(q.cursor)));

  const rows = db.select().from(cpgAuditEvents)
    .where(and(...where))
    .orderBy(desc(cpgAuditEvents.seq))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const nextCursor = rows.length > q.limit ? encodeCursor(page[page.length - 1].seq) : null;

  const body = auditListResponseSchema.parse({
    items: page.map((r) => ({
      id: r.id,
      seq: r.seq,
      actor: r.actor,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      prevHash: r.prevHash,
      hash: r.hash,
      createdAt: r.createdAt,
    })),
    nextCursor,
    chainValid: verifyAuditChain(db, orgId).valid,
  });
  return c.json(body);
}));
