import { Hono, type Context } from 'hono';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  caseByBranchResponseSchema, findingsStatusRequestSchema, findingsStatusResponseSchema, justificationInputSchema, parseFingerprint, requestReviewRequestSchema, requestReviewResponseSchema,
} from '@nomus/scanner/corporate';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { cpgCaseFindings, cpgCaseRevisions, cpgCases } from '../../../db/schema-cpg.js';
import { CPG_REVIEWER_CONTEXT_PROMPT_VERSION } from '../../../llm/prompts/cpg-reviewer-context.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { identityOf, requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { can, type CpgActor } from '../../../cpg/rbac/can.js';
import type { PermissionKey } from '../../../cpg/rbac/catalog.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { appendAuditEvent } from '../../../cpg/audit/log.js';
import { addCaseEvent, findOrCreateCase, addRevision, getCase, type CaseRow } from '../../../cpg/cases/service.js';
import { addJustification } from '../../../cpg/cases/justifications.js';
import { addComment, requestChanges, resubmit, type CommentRow } from '../../../cpg/cases/comments.js';
import { closeCase } from '../../../cpg/cases/close.js';
import { notifyCase } from '../../../cpg/notify/outbox.js';
import { reviewerContext } from '../../../cpg/cases/context.js';
import {
  caseDetail, caseStatus, caseSummaries, commentOf, findingsStatus, justificationOf, reviewerContextOf, revisionDetail,
} from '../../../cpg/cases/serialize.js';
import { userNames } from '../../../cpg/policies/service.js';
import {
  caseByBranchQuerySchema, caseListQuerySchema, caseListResponseSchema, closeCaseRequestSchema, commentRequestSchema, commentResponseSchema,
  emptyRequestSchema, justificationResponseSchema, requestChangesRequestSchema,
} from '../../../cpg/contracts.js';
import { CpgError, notFound } from '../../../cpg/errors.js';
import { actorFrom, handle, parseBody, parseQuery, pathParam, requireEnabled, requirePermission, uploadBodyLimit } from './helpers.js';

/**
 * Review cases (design spec §5, E40 to E53). Permissions are checked against
 * the case's repository, so team- and repo-scoped grants work; an id of
 * another organization is 404 before any permission is checked. Writes need
 * a user (an org key gets 403 user_identity_required) and an organization
 * with corporate policies enabled. Every write is one transaction that also
 * appends to the case events and the audit chain.
 */
export const cpgCaseRoutes = new Hono<AppEnv>();

type Db = BetterSQLite3Database<any>;

/** `userKey`: also accept the VS Code user-bound key (the "UK" of the endpoint table). */
const auth = (userKey: boolean) => [requireSessionOrApiKey('read:policies'), rateLimit(), requireCpgPermission(null, { allowUserKey: userKey })] as const;
/** Reads the CI action also makes: an org key with read:policies is accepted ("K[read:policies]"). */
const readAuth = [requireSessionOrApiKey('read:policies'), rateLimit(), requireCpgPermission(null, { allowUserKey: true, allowOrgKey: true })] as const;

/** The case named by :id, with `permission` checked on its repository. */
function caseFor(c: Context<AppEnv>, permission: PermissionKey): { db: Db; actor: CpgActor; kase: CaseRow } {
  const actor = actorFrom(c);
  const db = getDb();
  const kase = getCase(db, actor.orgId, pathParam(c, 'id'));
  requirePermission(actor, permission, kase.repo);
  return { db, actor, kase };
}

/** The org of a read that an org key may make; a user needs `case.read` on the repository. */
function readerOrg(c: Context<AppEnv>, repo: string): string {
  if (identityOf(c) === 'org_key') {
    const orgId = c.get('orgId');
    if (!orgId) throw new CpgError(401, 'unauthenticated', 'Authentication required');
    return orgId;
  }
  const actor = actorFrom(c);
  requirePermission(actor, 'case.read', repo);
  return actor.orgId;
}

const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;
const statusOf = (c: Context<AppEnv>, db: Db, kase: CaseRow) => caseStatus(db, getCase(db, kase.orgId, kase.id), origin(c));

// E40 request review: find or create the branch's case, add a revision, record the justifications.
cpgCaseRoutes.post('/cases/request-review', ...auth(true), uploadBodyLimit, handle(async (c) => {
  const body = await parseBody(c, requestReviewRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  requirePermission(actor, 'case.create', body.repo);
  requireEnabled(db, actor.orgId);
  const mismatched = body.findings.filter((f) => {
    const p = parseFingerprint(f.fingerprint);
    return p?.policyKey !== f.policyKey || p.policyVersion !== f.policyVersion;
  });
  if (mismatched.length > 0) throw new CpgError(422, 'fingerprint_mismatch', 'A fingerprint does not name its policy key and version', { fingerprints: mismatched.map((f) => f.fingerprint) });
  if (body.justifications.length === 0) throw new CpgError(422, 'justification_required', 'A review request justifies at least one finding');

  const userActor = `user:${actor.userId}`;
  const result = rawSqlite(db).transaction(() => {
    const { case: kase, created } = findOrCreateCase(db, { orgId: actor.orgId, repo: body.repo, branch: body.branch }, userActor);
    const source = identityOf(c) === 'user_key' ? 'vscode' : 'dashboard';
    const { revision, revisionCreated } = addRevision(db, actor.orgId, kase.id, { source, headSha: body.headSha, bundleHash: body.bundleHash, findings: body.findings }, userActor);
    const added = body.justifications.filter((j) => addJustification(db, { orgId: actor.orgId, caseId: kase.id, userId: actor.userId, ...j }).added).length;
    addCaseEvent(db, kase, 'submitted', userActor, { via: 'request_review', revision: revision.revision }, new Date().toISOString());
    // A re-request with no code change notifies nobody again.
    if (revisionCreated) notifyCase(db, getCase(db, actor.orgId, kase.id), 'case.review_requested');
    appendAuditEvent(db, {
      orgId: actor.orgId, actor: userActor, action: 'case.review_requested', targetType: 'case', targetId: kase.id,
      payload: { created, revision: revision.revision, revisionCreated, findings: body.findings.length, justificationsAdded: added },
    });
    return { kase, created, revisionCreated };
  }).immediate();
  return c.json(requestReviewResponseSchema.parse({
    created: result.created, revisionCreated: result.revisionCreated, case: statusOf(c, db, result.kase),
  }), result.created ? 201 : 200);
}));

// E41 list, newest first, filtered to the repositories the caller may read.
cpgCaseRoutes.get('/cases', ...auth(true), handle((c) => {
  const q = parseQuery(c, caseListQuerySchema);
  const actor = actorFrom(c);
  const db = getDb();
  if (!actor.grants.some((g) => g.permission === 'case.read')) throw new CpgError(403, 'forbidden', 'Missing permission case.read', { permission: 'case.read' });
  if (!getOrgSettings(db, actor.orgId)?.enabled) return c.json(caseListResponseSchema.parse({ items: [], nextCursor: null }));
  const where: Array<SQL | undefined> = [eq(cpgCases.orgId, actor.orgId)];
  if (q.state) where.push(eq(cpgCases.state, q.state));
  if (q.repo) where.push(eq(cpgCases.repo, q.repo));
  if (q.boardId) {
    // A lane of the board: a finding of the latest revision whose policy version the board owns (§5.6).
    where.push(sql`exists (select 1 from ${cpgCaseFindings} f
      join ${cpgCaseRevisions} r on r.id = f.revision_id
      join cpg_policy_versions v on v.id = f.policy_version_id, json_each(v.owning_board_ids) b
      where f.case_id = ${cpgCases.id} and r.revision = ${cpgCases.latestRevision} and b.value = ${q.boardId})`);
  }
  if (q.mine === 'true') where.push(eq(cpgCases.openedBy, `user:${actor.userId}`));
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id) throw new CpgError(400, 'invalid_input', 'Invalid cursor', [{ path: ['cursor'], message: 'not a cursor of this list' }]);
    where.push(or(lt(cpgCases.openedAt, at), and(eq(cpgCases.openedAt, at), lt(cpgCases.id, id))));
  }
  const rows = db.select().from(cpgCases).where(and(...where)).orderBy(desc(cpgCases.openedAt), desc(cpgCases.id)).limit(q.limit + 1).all();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return c.json(caseListResponseSchema.parse({
    items: caseSummaries(db, actor.orgId, page.filter((r) => can(actor, 'case.read', { repo: r.repo }))),
    nextCursor: rows.length > q.limit ? Buffer.from(`${last.openedAt}|${last.id}`).toString('base64url') : null,
  }));
}));

// E42 the open case of a branch (the extension's status poll).
cpgCaseRoutes.get('/cases/by-branch', ...readAuth, handle((c) => {
  const q = parseQuery(c, caseByBranchQuerySchema);
  const orgId = readerOrg(c, q.repo);
  const db = getDb();
  const kase = getOrgSettings(db, orgId)?.enabled
    ? db.select().from(cpgCases).where(and(eq(cpgCases.orgId, orgId), eq(cpgCases.repo, q.repo), eq(cpgCases.branch, q.branch), isNull(cpgCases.closedAt))).get()
    : undefined;
  return c.json(caseByBranchResponseSchema.parse({ case: kase ? caseStatus(db, kase, origin(c)) : null }));
}));

// E53 the resolution of the fingerprints a scan found on a branch (the extension's request-review step and the action).
cpgCaseRoutes.post('/findings/status', ...readAuth, handle(async (c) => {
  const body = await parseBody(c, findingsStatusRequestSchema);
  const orgId = readerOrg(c, body.repo);
  const db = getDb();
  const evaluatedAt = new Date().toISOString();
  const items = getOrgSettings(db, orgId)?.enabled ? findingsStatus(db, orgId, body, body.fingerprints, evaluatedAt) : [];
  return c.json(findingsStatusResponseSchema.parse({ items, evaluatedAt }));
}));

// E43
cpgCaseRoutes.get('/cases/:id', ...auth(true), handle((c) => {
  const { db, actor, kase } = caseFor(c, 'case.read');
  return c.json(caseDetail(db, kase, origin(c), actor));
}));

// E44
cpgCaseRoutes.get('/cases/:id/revisions/:revision', ...auth(true), handle((c) => {
  const { db, kase } = caseFor(c, 'case.read');
  const revision = Number(pathParam(c, 'revision'));
  if (!Number.isInteger(revision) || revision < 1) throw notFound('Revision');
  return c.json(revisionDetail(db, kase, revision));
}));

// E45
cpgCaseRoutes.post('/cases/:id/justifications', ...auth(true), handle(async (c) => {
  const body = await parseBody(c, justificationInputSchema);
  const { db, actor, kase } = caseFor(c, 'case.create');
  requireEnabled(db, actor.orgId);
  const { justification: j } = addJustification(db, { orgId: actor.orgId, caseId: kase.id, userId: actor.userId, ...body });
  return c.json(justificationResponseSchema.parse(justificationOf(j, userNames(db, [j.authorUserId]))), 201);
}));

const commentResponse = (db: Db, m: CommentRow) => commentResponseSchema.parse(commentOf(m, userNames(db, [m.authorUserId])));

// E46 comment or reply (a reply with resolves: true marks a change request resolved)
cpgCaseRoutes.post('/cases/:id/comments', ...auth(true), handle(async (c) => {
  const body = await parseBody(c, commentRequestSchema);
  const { db, actor, kase } = caseFor(c, 'case.comment');
  requireEnabled(db, actor.orgId);
  return c.json(commentResponse(db, addComment(db, { orgId: actor.orgId, caseId: kase.id, userId: actor.userId, ...body })), 201);
}));

// E47 request changes for a lane (a member of the lane's board)
cpgCaseRoutes.post('/cases/:id/request-changes', ...auth(false), handle(async (c) => {
  const body = await parseBody(c, requestChangesRequestSchema);
  const { db, actor, kase } = caseFor(c, 'case.review');
  requireEnabled(db, actor.orgId);
  return c.json(commentResponse(db, requestChanges(db, { orgId: actor.orgId, caseId: kase.id, userId: actor.userId, ...body })), 201);
}));

// E48 resubmit once every change request is resolved
cpgCaseRoutes.post('/cases/:id/resubmit', ...auth(true), handle(async (c) => {
  await parseBody(c, emptyRequestSchema);
  const { db, actor, kase } = caseFor(c, 'case.create');
  requireEnabled(db, actor.orgId);
  resubmit(db, { orgId: actor.orgId, caseId: kase.id, userId: actor.userId });
  return c.json(statusOf(c, db, kase));
}));

// E49 withdraw (the opener, or case.close) and E50 close (case.close)
for (const [path, reason, userKey] of [['withdraw', 'withdrawn', true], ['close', 'closed_by_reviewer', false]] as const) {
  cpgCaseRoutes.post(`/cases/:id/${path}`, ...auth(userKey), handle(async (c) => {
    const body = await parseBody(c, closeCaseRequestSchema);
    const actor = actorFrom(c);
    const db = getDb();
    const kase = getCase(db, actor.orgId, pathParam(c, 'id'));
    if (!(reason === 'withdrawn' && kase.openedBy === `user:${actor.userId}`)) requirePermission(actor, 'case.close', kase.repo);
    requireEnabled(db, actor.orgId);
    closeCase(db, { orgId: actor.orgId, caseId: kase.id, reason, note: body.reason, actor: `user:${actor.userId}` });
    return c.json(statusOf(c, db, kase));
  }));
}

// E51 reviewer context (generated on first request when enabled) and E52 retry after a failure
for (const retry of [false, true]) {
  const route = '/cases/:id/findings/:findingId/context' + (retry ? '/retry' : '');
  const handler = handle(async (c) => {
    if (retry) await parseBody(c, emptyRequestSchema);
    const { db, actor, kase } = caseFor(c, 'case.read');
    const findingId = pathParam(c, 'findingId');
    const finding = db.select().from(cpgCaseFindings).where(and(eq(cpgCaseFindings.id, findingId), eq(cpgCaseFindings.caseId, kase.id))).get();
    if (!finding) throw notFound('Finding');
    const row = await reviewerContext(db, finding, { retry, actor: `user:${actor.userId}`, caseClosed: kase.closedAt !== null });
    return c.json(reviewerContextOf(findingId, row, CPG_REVIEWER_CONTEXT_PROMPT_VERSION));
  });
  if (retry) cpgCaseRoutes.post(route, ...auth(false), handler);
  else cpgCaseRoutes.get(route, ...auth(false), handler);
}
