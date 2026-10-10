import { Hono, type Context } from 'hono';
import { compileGlobList } from '@nomus/scanner/corporate';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import type { CpgActor } from '../../../cpg/rbac/can.js';
import type { PermissionKey } from '../../../cpg/rbac/catalog.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { getCase } from '../../../cpg/cases/service.js';
import { createProposal, createStandingProposal } from '../../../cpg/decisions/proposals.js';
import { getDecision, revokeDecision } from '../../../cpg/decisions/revoke.js';
import { canOnPattern, ruleOf, standingExceptions } from '../../../cpg/decisions/standing.js';
import { castProposalVote } from '../../../cpg/decisions/votes.js';
import { caseProposals, getProposal, proposalView, proposalViews, standingProposals, type ProposalRow } from '../../../cpg/decisions/status.js';
import { decisionOf, exceptionOf, proposalDetails, revocationOf, voteOf } from '../../../cpg/decisions/serialize.js';
import { userNames } from '../../../cpg/policies/service.js';
import {
  castVoteResponseSchema, exceptionListQuerySchema, exceptionListResponseSchema, proposalCreateRequestSchema, proposalListQuerySchema,
  proposalListResponseSchema, revocationResponseSchema, revokeRequestSchema, standingPatternSchema, voteRequestSchema, type StandingPattern,
} from '../../../cpg/contracts.js';
import { CpgError } from '../../../cpg/errors.js';
import { actorFrom, cpgAuth, handle, parseBody, parseQuery, pathParam, requireEnabled, requirePermission } from './helpers.js';

/**
 * Proposals, votes, decisions, standing exceptions and revocations (design
 * spec §4.3, §7, E54 to E60). Permissions are checked on the case's
 * repository, or on every repository a standing pattern can touch; an id of
 * another organization is 404 before any permission check. Proposing, voting
 * and revoking need a browser session (API keys never vote) and governance
 * enabled; each is one transaction that also appends to the audit chain.
 */
export const cpgProposalRoutes = new Hono<AppEnv>();

/** `userKey`: also accept the VS Code user-bound key, for reads. */
const auth = (userKey: boolean) => cpgAuth(null, { scope: 'read:policies', allowUserKey: userKey });

const now = () => new Date().toISOString();

/** 403 unless the actor holds `permission` on every repository the standing pattern can touch. */
function requireOnPattern(actor: CpgActor, permission: PermissionKey, pattern: StandingPattern): void {
  if (!canOnPattern(actor, permission, pattern)) throw new CpgError(403, 'forbidden', `Missing permission ${permission}`, { permission });
}

/** The proposal named by :id, with case.read checked on its case's repository (or its standing pattern). */
function readableProposal(c: Context<AppEnv>) {
  const actor = actorFrom(c);
  const db = getDb();
  const proposal = getProposal(db, actor.orgId, pathParam(c, 'id'));
  if (proposal.caseId !== null) requirePermission(actor, 'case.read', getCase(db, actor.orgId, proposal.caseId).repo);
  else requireOnPattern(actor, 'case.read', ruleOf(db, actor.orgId, proposal.pattern!).pattern);
  return { db, actor, proposal };
}

// E54 propose a snippet or bulk decision (the proposer's own vote is recorded with it) or a standing exception.
cpgProposalRoutes.post('/proposals', ...auth(false), handle(async (c) => {
  const body = await parseBody(c, proposalCreateRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  if (body.scope === 'standing') {
    if (body.caseId !== undefined) requirePermission(actor, 'case.read', getCase(db, actor.orgId, body.caseId).repo);
    requireOnPattern(actor, 'exception.propose', body.pattern);
  } else {
    requirePermission(actor, 'case.review', getCase(db, actor.orgId, body.caseId).repo);
  }
  requireEnabled(db, actor.orgId);
  const view = body.scope === 'standing' ? createStandingProposal(db, actor, body) : createProposal(db, actor, body);
  return c.json(proposalDetails(db, [view], actor)[0], 201);
}));

// E55 the proposals of a case, or the organization's standing exception proposals the caller may read; oldest first.
cpgProposalRoutes.get('/proposals', ...auth(false), handle((c) => {
  const q = parseQuery(c, proposalListQuerySchema);
  const actor = actorFrom(c);
  const db = getDb();
  let proposals: ProposalRow[];
  if (q.caseId !== undefined) {
    const kase = getCase(db, actor.orgId, q.caseId);
    requirePermission(actor, 'case.read', kase.repo);
    proposals = caseProposals(db, kase.id);
  } else {
    proposals = standingProposals(db, actor.orgId).filter((p) => canOnPattern(actor, 'case.read', standingPatternSchema.parse(JSON.parse(p.pattern!))));
  }
  const views = getOrgSettings(db, actor.orgId)?.enabled ? proposalViews(db, proposals, now()) : [];
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

// E58 the standing exceptions the caller may read, oldest first.
cpgProposalRoutes.get('/exceptions', ...auth(true), handle((c) => {
  const q = parseQuery(c, exceptionListQuerySchema);
  const actor = actorFrom(c);
  const db = getDb();
  const at = now();
  const items = (getOrgSettings(db, actor.orgId)?.enabled ? standingExceptions(db, actor.orgId) : [])
    .filter((x) => canOnPattern(actor, 'case.read', x.pattern) && (!q.policyKey || x.pattern.policyKey === q.policyKey)
      && (!q.repo || compileGlobList([...x.pattern.repos, ...x.teamRepos])(q.repo)))
    .map((x) => exceptionOf(x, at))
    .filter((x) => q.active === undefined || (x.status === 'active') === (q.active === 'true'));
  return c.json(exceptionListResponseSchema.parse({ items }));
}));

// E59 a decision with its signed payload (§13.2).
cpgProposalRoutes.get('/decisions/:id', ...auth(true), handle((c) => {
  const actor = actorFrom(c);
  const db = getDb();
  const decision = getDecision(db, actor.orgId, pathParam(c, 'id'));
  requirePermission(actor, 'case.read', decision.repo ?? undefined);
  return c.json(decisionOf(decision));
}));

// E60 revoke a decision or standing exception: immediate, final and signed.
cpgProposalRoutes.post('/decisions/:id/revoke', ...auth(false), handle(async (c) => {
  const body = await parseBody(c, revokeRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  const id = getDecision(db, actor.orgId, pathParam(c, 'id')).id; // 404 for another org's id, before anything else
  requireEnabled(db, actor.orgId);
  return c.json(revocationResponseSchema.parse(revocationOf(revokeDecision(db, actor, id, body.reason))), 201);
}));
