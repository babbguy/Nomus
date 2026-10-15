import type { Db } from '../../db/client.js';
import {
  decisionResponseSchema, proposalDetailResponseSchema, standingExceptionSchema,
  type DecisionResponse, type ProposalDetailResponse, type ProposalVoteResponse, type RevocationResponse, type StandingException,
} from '../contracts.js';
import { CpgError } from '../errors.js';
import { userNames } from '../policies/service.js';
import { cpgVerify } from '../policies/signing.js';
import type { CpgActor } from '../rbac/can.js';
import type { DecisionRow } from './resolve.js';
import type { RevocationRow } from './revoke.js';
import type { StandingException as Exception } from './standing.js';
import { fingerprintsOf, requiredOf, type ProposalView, type VoteRow } from './status.js';
import { eligibleBallot } from './votes.js';

/** Response builders for the proposal and decision routes; each output is parsed with its contract. */

export function voteOf(v: VoteRow, names: Map<string, string>): ProposalVoteResponse {
  return {
    id: v.id, voterUserId: v.voterUserId, voterName: names.get(v.voterUserId) ?? '', vote: v.vote,
    boards: JSON.parse(v.boardsAtVote) as string[], permissions: JSON.parse(v.permissionsAtVote) as string[], comment: v.comment, createdAt: v.createdAt,
  };
}

/** Whether `actor` may vote on the proposal now; the reason is the code a vote would be refused with. */
function viewerOf(db: Db, view: ProposalView, actor: CpgActor): ProposalDetailResponse['viewer'] {
  const refuse = (reason: string) => ({ canVote: false, reason });
  if (view.status !== 'pending') return refuse('proposal_not_pending');
  if (view.votes.some((v) => v.voterUserId === actor.userId)) return refuse('already_voted');
  try {
    eligibleBallot(db, actor, view.proposal, requiredOf(view.proposal));
    return { canVote: true, reason: null };
  } catch (err) {
    if (err instanceof CpgError) return refuse(err.code);
    throw err;
  }
}

export function proposalDetails(db: Db, views: ProposalView[], actor: CpgActor): ProposalDetailResponse[] {
  const names = userNames(db, views.flatMap((v) => [v.proposal.proposerUserId, ...v.votes.map((b) => b.voterUserId), ...v.revocations.map((r) => r.revokedByUserId)]));
  return views.map((view) => {
    const p = view.proposal;
    return proposalDetailResponseSchema.parse({
      id: p.id, caseId: p.caseId, scope: p.scope, outcome: p.outcome, status: view.status,
      policyId: p.policyId, policyKey: p.policyKey, policyVersion: p.policyVersion, tier: p.tier,
      fingerprints: fingerprintsOf(p), pattern: p.pattern === null ? null : JSON.parse(p.pattern), requestedExpiresAt: p.requestedExpiresAt, rationale: p.rationale,
      required: requiredOf(p), quorumConfigVersionAtCreation: p.quorumConfigVersionAtCreation,
      proposer: { userId: p.proposerUserId, name: names.get(p.proposerUserId) ?? '' },
      createdAt: p.createdAt, lapsesAt: p.lapsesAt,
      votes: view.votes.map((v) => voteOf(v, names)), decisionIds: view.decisionIds, invalidation: view.invalidation,
      revocations: view.revocations.map((r) => ({ decisionId: r.decisionId, revokedByName: names.get(r.revokedByUserId) ?? '', reason: r.reason, revokedAt: r.revokedAt })),
      viewer: viewerOf(db, view, actor),
    });
  });
}

export function decisionOf(d: DecisionRow): DecisionResponse {
  return decisionResponseSchema.parse({
    id: d.id, proposalId: d.proposalId, caseId: d.caseId, scope: d.scope, outcome: d.outcome, repo: d.repo, fingerprint: d.fingerprint,
    batchId: d.batchId, policyId: d.policyId, policyKey: d.policyKey, policyVersion: d.policyVersion, expiresAt: d.expiresAt,
    approverUserIds: JSON.parse(d.approverUserIds) as string[], quorumConfigVersion: d.quorumConfigVersion, quorumConfigHash: d.quorumConfigHash,
    finalizedAt: d.finalizedAt, signedPayload: d.signedPayload, signature: d.signature, signatureValid: cpgVerify(d.signedPayload, d.signature),
  });
}

export function revocationOf(r: RevocationRow): RevocationResponse {
  return { id: r.id, decisionId: r.decisionId, revokedByUserId: r.revokedByUserId, reason: r.reason, revokedAt: r.revokedAt, signedPayload: r.signedPayload, signature: r.signature };
}

export function exceptionOf(x: Exception, now: string): StandingException {
  const d = x.decision;
  const revoked = x.revocation !== null && x.revocation.revokedAt <= now;
  return standingExceptionSchema.parse({
    id: d.id, proposalId: d.proposalId, caseId: d.caseId, policyId: d.policyId, policyKey: d.policyKey, policyVersion: d.policyVersion,
    pattern: x.pattern, expiresAt: d.expiresAt, finalizedAt: d.finalizedAt, approverUserIds: JSON.parse(d.approverUserIds) as string[],
    status: revoked ? 'revoked' : d.expiresAt! <= now ? 'expired' : x.activeVersion !== d.policyVersion ? 'lapsed' : 'active', revocation: x.revocation && revocationOf(x.revocation),
  });
}
