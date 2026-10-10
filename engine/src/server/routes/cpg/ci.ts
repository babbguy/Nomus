import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { ciEvaluateRequestSchema, ciEvaluateResponseSchema, prClosedRequestSchema, prClosedResponseSchema } from '@nomus/scanner/corporate';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { cpgCiRuns } from '../../../db/schema-cpg.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { identityOf } from '../../../cpg/rbac/middleware.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { getCase } from '../../../cpg/cases/service.js';
import { evaluateCi } from '../../../cpg/ci/evaluate.js';
import { closeForPullRequest } from '../../../cpg/ci/pr-closed.js';
import { cpgVerify } from '../../../cpg/policies/signing.js';
import { ciRunListQuerySchema, ciRunListResponseSchema } from '../../../cpg/contracts.js';
import { cpgError } from '../../../cpg/errors.js';
import { actorFrom, cpgAuth, decodeKeyset, encodeKeyset, handle, parseBody, parseQuery, requireEnabled, requirePermission, uploadBodyLimit } from './helpers.js';

/**
 * The CI gate (design spec §11, E61 to E63). Evaluate and pr-closed act for a
 * pipeline: they take an org API key with the `evaluate` scope, never a user,
 * and need corporate policies enabled. The run list is for signed-in users
 * with `ci.read` on the repository.
 */
export const cpgCiRoutes = new Hono<AppEnv>();

const orgKeyOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (identityOf(c) !== 'org_key' || !c.get('apiKeyId') || !c.get('orgId')) {
    return cpgError(c, 403, 'forbidden', 'This endpoint takes an organization API key with the evaluate scope', { reason: 'org_key_required' });
  }
  await next();
});
const ciAuth = [requireSessionOrApiKey('evaluate'), rateLimit(), orgKeyOnly] as const;

const keyCaller = (c: Context<AppEnv>) => ({ orgId: c.get('orgId')!, apiKeyId: c.get('apiKeyId')! });

// E61 the server's verdict on a CI scan
cpgCiRoutes.post('/evaluate', ...ciAuth, uploadBodyLimit, handle(async (c) => {
  const body = await parseBody(c, ciEvaluateRequestSchema);
  const caller = keyCaller(c);
  const db = getDb();
  requireEnabled(db, caller.orgId);
  return c.json(ciEvaluateResponseSchema.parse(evaluateCi(db, caller, body, new URL(c.req.url).origin)));
}));

// E62 the pull request closed: close the branch's case as merged or pr_closed_unmerged
cpgCiRoutes.post('/pr-closed', ...ciAuth, handle(async (c) => {
  const body = await parseBody(c, prClosedRequestSchema);
  const caller = keyCaller(c);
  const db = getDb();
  requireEnabled(db, caller.orgId);
  return c.json(prClosedResponseSchema.parse(closeForPullRequest(db, caller.orgId, body, `api_key:${caller.apiKeyId}`)));
}));

// E63 recorded runs, newest first: by case or repository (ci.read there), or all of them (ci.read org-wide)
cpgCiRoutes.get('/runs', ...cpgAuth(null, { scope: 'read:policies' }), handle((c) => {
  const q = parseQuery(c, ciRunListQuerySchema);
  const actor = actorFrom(c);
  const db = getDb();
  const repo = q.caseId ? getCase(db, actor.orgId, q.caseId).repo : q.repo;
  requirePermission(actor, 'ci.read', repo);
  if (q.repo && q.repo !== repo) requirePermission(actor, 'ci.read', q.repo);
  if (!getOrgSettings(db, actor.orgId)?.enabled) return c.json(ciRunListResponseSchema.parse({ items: [], nextCursor: null }));

  const where: Array<SQL | undefined> = [eq(cpgCiRuns.orgId, actor.orgId)];
  if (q.caseId) where.push(eq(cpgCiRuns.caseId, q.caseId));
  if (q.repo) where.push(eq(cpgCiRuns.repo, q.repo));
  if (q.sha) where.push(eq(cpgCiRuns.headSha, q.sha));
  if (q.cursor) {
    const [at, id] = decodeKeyset(q.cursor);
    where.push(or(lt(cpgCiRuns.evaluatedAt, at), and(eq(cpgCiRuns.evaluatedAt, at), lt(cpgCiRuns.id, id))));
  }
  const rows = db.select().from(cpgCiRuns).where(and(...where)).orderBy(desc(cpgCiRuns.evaluatedAt), desc(cpgCiRuns.id)).limit(q.limit + 1).all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return c.json(ciRunListResponseSchema.parse({
    items: page.map((r) => ({
      id: r.id, repo: r.repo, branch: r.branch, prNumber: r.prNumber, headSha: r.headSha, eventName: r.eventName, bundleHash: r.bundleHash,
      scannedFileCount: r.scannedFileCount, verdict: r.verdict, caseId: r.caseId, findings: JSON.parse(r.findings) as unknown,
      counts: {
        blocking: r.blockingCount, pending: r.pendingCount, rejected: r.rejectedCount,
        approved: r.approvedCount, excepted: r.exceptedCount, advisory: r.advisoryCount,
      },
      evaluatedAt: r.evaluatedAt, signedPayload: r.signedPayload, signature: r.signature, signatureValid: cpgVerify(r.signedPayload, r.signature),
    })),
    nextCursor: rows.length > q.limit ? encodeKeyset(last.evaluatedAt, last.id) : null,
  }));
}));
