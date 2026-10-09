import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { cpgDecisions } from '../../../db/schema-cpg.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { getCase } from '../../../cpg/cases/service.js';
import { createProposal } from '../../../cpg/decisions/proposals.js';
import { castProposalVote } from '../../../cpg/decisions/votes.js';
import { caseProposals, getProposal, proposalView, proposalViews } from '../../../cpg/decisions/status.js';
import { decisionOf, proposalDetails, voteOf } from '../../../cpg/decisions/serialize.js';
import { userNames } from '../../../cpg/policies/service.js';
import {
  castVoteResponseSchema, proposalCreateRequestSchema, proposalListQuerySchema, proposalListResponseSchema, voteRequestSchema,
} from '../../../cpg/contracts.js';
import { notFound } from '../../../cpg/errors.js';
import { actorFrom, handle, parseBody, parseQuery, pathParam, requireEnabled, requirePermission } from './helpers.js';

/**
 * Snippet and bulk proposals, votes and decisions (design spec §4.3, E54 to
 * E57 and E59). Permissions are checked on the case's repository; an id of
 * another organization is 404 before any permission check. Proposing and
 * voting need a browser session (API keys never vote) and governance enabled;
 * each is one transaction that also appends to the case events and the audit
 * chain.
 */
export const cpgProposalRoutes = new Hono<AppEnv>();

/** `userKey`: also accept the VS Code user-bound key, for reads. */
const auth = (userKey: boolean) => [requireSessionOrApiKey('read:policies'), rateLimit(), requireCpgPermission(null, { allowUserKey: userKey })] as const;

const now = () => new Date().toISOString();

/** The proposal named by :id, with case.read checked on its case's repository. */
function readableProposal(c: Context<AppEnv>) {
  const actor = actorFrom(c);
  const db = getDb();
  const proposal = getProposal(db, actor.orgId, pathParam(c, 'id'));
  requirePermission(actor, 'case.read', getCase(db, actor.orgId, proposal.caseId!).repo);
  return { db, actor, proposal };
}

// E54 propose a snippet or bulk decision; the proposer's own vote is recorded with it.
cpgProposalRoutes.post('/proposals', ...auth(false), handle(async (c) => {
  const body = await parseBody(c, proposalCreateRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  requirePermission(actor, 'case.review', getCase(db, actor.orgId, body.caseId).repo);
  requireEnabled(db, actor.orgId);
  return c.json(proposalDetails(db, [createProposal(db, actor, body)], actor)[0], 201);
}));

// E55 the proposals of a case, oldest first.
cpgProposalRoutes.get('/proposals', ...auth(false), handle((c) => {
  const q = parseQuery(c, proposalListQuerySchema);
  const actor = actorFrom(c);
  const db = getDb();
  const kase = getCase(db, actor.orgId, q.caseId);
  requirePermission(actor, 'case.read', kase.repo);
  const views = getOrgSettings(db, actor.orgId)?.enabled ? proposalViews(db, caseProposals(db, kase.id), now()) : [];
  const items = views.filter((v) => (!q.scope || v.proposal.scope === q.scope) && (!q.status || v.status === q.status));
  return c.json(proposalListResponseSchema.parse({ items: proposalDetails(db, items, actor) }));
}));

// E56
cpgProposalRoutes.get('/proposals/:id', ...auth(false), handle((c) => {
  const { db, actor, proposal } = readableProposal(c);
  return c.json(proposalDetails(db, [proposalView(db, proposal, now())], actor)[0]);
}));

// E57 vote; the vote that completes the quorum finalizes the proposal.
cpgProposalRoutes.post('/proposals/:id/votes', ...auth(false), handle(async (c) => {
  const body = await parseBody(c, voteRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  const id = getProposal(db, actor.orgId, pathParam(c, 'id')).id; // 404 for another org's id, before anything else
  requireEnabled(db, actor.orgId);
  const { vote, proposal } = castProposalVote(db, actor, id, { vote: body.vote, comment: body.comment ?? '' });
  const view = proposalView(db, proposal, now());
  return c.json(castVoteResponseSchema.parse({
    vote: voteOf(vote, userNames(db, [vote.voterUserId])), proposalStatus: view.status, decisionIds: view.decisionIds,
  }), 201);
}));

// E59 a decision with its signed payload (§13.2).
cpgProposalRoutes.get('/decisions/:id', ...auth(true), handle((c) => {
  const actor = actorFrom(c);
  const db = getDb();
  const decision = db.select().from(cpgDecisions).where(and(eq(cpgDecisions.id, pathParam(c, 'id')), eq(cpgDecisions.orgId, actor.orgId))).get();
  if (!decision) throw notFound('Decision');
  requirePermission(actor, 'case.read', decision.repo ?? undefined);
  return c.json(decisionOf(decision));
}));
