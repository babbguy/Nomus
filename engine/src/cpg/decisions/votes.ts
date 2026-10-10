import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgCaseRevisions, cpgJustifications, cpgVotes } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { boardsOfUser } from '../boards/service.js';
import { getCase, openCase, type CaseRow } from '../cases/service.js';
import { CpgError } from '../errors.js';
import { can, type CpgActor } from '../rbac/can.js';
import type { Outcome, Requirement } from '../quorum/evaluate.js';
import { settle, type SettleResult } from './finalize.js';
import { canOnPattern, coveredOpenCases, ruleOf } from './standing.js';
import { getProposal, proposalView, requiredOf, type ProposalRow, type VoteRow } from './status.js';

/**
 * Votes on proposals (design spec §4.3 step 3). A vote counts only from an
 * eligible voter, and the facts that made it eligible (boards, permissions)
 * are stored with it. Self-approval is refused here (403
 * self_approval_forbidden), whatever the configuration and whatever roles
 * the voter holds: on a standing exception, for every open case it covers.
 * trg_cpg_votes_no_self_approval refuses it again for the proposal's own case.
 */

/** Permissions a vote may need (§4.1 requiredPermission); held ones are snapshotted. */
const VOTE_PERMISSIONS = ['case.review', 'exception.approve'] as const;

/** The case opener, any justification author and any revision creator may never vote on the case. */
export function isSelfApproval(db: Db, c: CaseRow, userId: string): boolean {
  const actor = `user:${userId}`;
  if (c.openedBy === actor) return true;
  const justified = db.select({ id: cpgJustifications.id }).from(cpgJustifications)
    .where(and(eq(cpgJustifications.caseId, c.id), eq(cpgJustifications.authorUserId, userId))).limit(1).get();
  const revised = db.select({ id: cpgCaseRevisions.id }).from(cpgCaseRevisions)
    .where(and(eq(cpgCaseRevisions.caseId, c.id), eq(cpgCaseRevisions.createdBy, actor))).limit(1).get();
  return justified !== undefined || revised !== undefined;
}

interface Eligibility {
  boards: string[];
  permissions: string[];
}

/**
 * Throw unless `actor` may vote on proposal `p` needing `req`: `case.review`
 * on the case's repository, or for a standing exception `case.review` or
 * `exception.approve` on every repository its pattern can touch (403
 * forbidden); not self-approval, including the proposer of a standing
 * exception (403 self_approval_forbidden); and an active
 * member of a required board (403 not_eligible_voter). Returns the
 * eligibility facts to store.
 */
export function eligibleBallot(db: Db, actor: CpgActor, p: ProposalRow, req: Requirement): Eligibility {
  const origin = p.caseId === null ? null : getCase(db, p.orgId, p.caseId);
  const rule = p.pattern === null ? null : ruleOf(db, p.orgId, p.pattern);
  const holds = (permission: string) => (rule ? canOnPattern(actor, permission, rule.pattern) : can(actor, permission, { repo: origin!.repo }));
  if (!holds('case.review') && !(rule && holds('exception.approve'))) {
    throw new CpgError(403, 'forbidden', `Missing permission ${rule ? 'case.review or exception.approve' : 'case.review'}`, { permission: 'case.review' });
  }
  const cases = [...(origin ? [origin] : []), ...(rule ? coveredOpenCases(db, p.orgId, rule) : [])];
  // The proposer of a standing exception never votes on it (their proposal is not a vote, unlike a snippet or bulk one).
  if ((rule && p.proposerUserId === actor.userId) || cases.some((c) => isSelfApproval(db, c, actor.userId))) {
    throw new CpgError(403, 'self_approval_forbidden', rule && p.proposerUserId === actor.userId
      ? 'You proposed this standing exception, so you cannot vote on it'
      : 'You opened, justified or revised this case, so you cannot decide on it');
  }
  const boards = boardsOfUser(db, actor.orgId, actor.userId).map((b) => b.id).filter((id) => req.boardIds.includes(id)).sort();
  if (boards.length === 0) throw new CpgError(403, 'not_eligible_voter', 'Only a member of a required board can vote', { boardIds: req.boardIds });
  return { boards, permissions: VOTE_PERMISSIONS.filter(holds) };
}

/** Record an eligible vote and evaluate the proposal. Runs inside the caller's transaction. */
export function recordVote(db: Db, actor: CpgActor, p: ProposalRow, input: { vote: Outcome; comment: string }, now: string): { vote: VoteRow; result: SettleResult } {
  const ballot = eligibleBallot(db, actor, p, requiredOf(p));
  const vote: VoteRow = {
    id: randomUUID(), proposalId: p.id, orgId: p.orgId, voterUserId: actor.userId, vote: input.vote,
    boardsAtVote: JSON.stringify(ballot.boards), permissionsAtVote: JSON.stringify(ballot.permissions), comment: input.comment, createdAt: now,
  };
  db.insert(cpgVotes).values(vote).run();
  const userActor = `user:${actor.userId}`;
  appendAuditEvent(db, {
    orgId: p.orgId, actor: userActor, action: 'proposal.vote_cast', targetType: 'proposal', targetId: p.id,
    payload: { voteId: vote.id, vote: vote.vote, caseId: p.caseId, boards: ballot.boards },
  });
  return { vote, result: settle(db, p, userActor, now) };
}

/** E57: vote on a pending proposal. */
export function castProposalVote(db: Db, actor: CpgActor, proposalId: string, input: { vote: Outcome; comment: string }): { vote: VoteRow; proposal: ProposalRow } {
  return rawSqlite(db).transaction(() => {
    const p = getProposal(db, actor.orgId, proposalId);
    if (p.caseId !== null) openCase(db, actor.orgId, p.caseId);
    const now = new Date().toISOString();
    const { status } = proposalView(db, p, now);
    if (status !== 'pending') throw new CpgError(409, 'proposal_not_pending', `The proposal is ${status}`, { status });
    const prior = db.select({ id: cpgVotes.id }).from(cpgVotes).where(and(eq(cpgVotes.proposalId, p.id), eq(cpgVotes.voterUserId, actor.userId))).get();
    if (prior) throw new CpgError(409, 'already_voted', 'You have already voted on this proposal');
    return { vote: recordVote(db, actor, p, input, now).vote, proposal: p };
  }).immediate();
}
