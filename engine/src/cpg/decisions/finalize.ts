import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { canonicalJson, sha256Hex } from '@nomus/scanner/corporate';
import { cpgDecisions, cpgProposalEvents, cpgVotes } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { listBoards } from '../boards/service.js';
import { addCaseEvent, refreshCaseState, type CaseRow } from '../cases/service.js';
import { CpgError } from '../errors.js';
import { boardIdsOf, getHead, getVersion } from '../policies/service.js';
import { cpgSign } from '../policies/signing.js';
import { expiryInRange, requirementFor, tally, type Requirement, type Tally } from '../quorum/evaluate.js';
import { currentQuorum, type QuorumVersion } from '../quorum/store.js';
import { fingerprintsOf, type ProposalRow } from './status.js';

/**
 * Finalization (design spec §4.3 steps 4 to 6, §4.4, §13.2). After every
 * vote the proposal is evaluated against the quorum config in force NOW:
 * quorum reached writes one signed decision per finding, recording that
 * config's version and hash; a requirement that no longer holds (scope
 * disallowed, no active board, expiry beyond the new maximum, a superseded
 * policy version) invalidates the proposal instead.
 */

type Db = BetterSQLite3Database<any>;
export const DECISION_KIND = 'nomus.cpg-decision.v1';

/** The §13.2 payload, signed as canonical JSON. */
export interface DecisionPayload {
  kind: typeof DECISION_KIND;
  id: string;
  orgId: string;
  proposalId: string;
  caseId: string | null;
  scope: ProposalRow['scope'];
  outcome: ProposalRow['outcome'];
  repo: string | null;
  fingerprint: string | null;
  pattern: unknown;
  policyKey: string;
  policyVersion: number;
  policyActivationSignatureSha256: string;
  expiresAt: string | null;
  approverUserIds: string[];
  quorumConfigVersion: number;
  quorumConfigHash: string;
  finalizedAt: string;
}

/** The requirement under the config in force now. */
export function currentRequirement(db: Db, p: ProposalRow, quorum: QuorumVersion = currentQuorum(db, p.orgId)): Requirement {
  const activeBoards = new Set(listBoards(db, p.orgId).filter((b) => !b.archivedAt).map((b) => b.id));
  const owningBoardIds = boardIdsOf(getVersion(db, p.orgId, p.policyVersionId));
  return requirementFor(quorum.config, { scope: p.scope, tier: p.tier, policyId: p.policyId, owningBoardIds }, activeBoards);
}

export type SettleResult = Tally['state'] | 'invalidated';

/** Evaluate a pending proposal after a vote, inside the vote's transaction. */
export function settle(db: Db, p: ProposalRow, c: CaseRow, actor: string, now: string): SettleResult {
  const quorum = currentQuorum(db, p.orgId);
  let req: Requirement;
  try {
    req = currentRequirement(db, p, quorum);
  } catch (err) {
    if (err instanceof CpgError) return invalidate(db, p, err.code, quorum, actor, now);
    throw err;
  }
  const ballots = db.select().from(cpgVotes).where(eq(cpgVotes.proposalId, p.id)).orderBy(asc(sql`rowid`)).all()
    .map((v) => ({ voterUserId: v.voterUserId, vote: v.vote, boards: JSON.parse(v.boardsAtVote) as string[], permissions: JSON.parse(v.permissionsAtVote) as string[] }));
  const result = tally(p.outcome, req, ballots);
  if (result.state === 'vetoed') {
    appendAuditEvent(db, { orgId: p.orgId, actor, action: 'proposal.vetoed', targetType: 'proposal', targetId: p.id, payload: { caseId: p.caseId } });
    return 'vetoed';
  }
  if (result.state === 'pending') return 'pending';
  if (p.outcome === 'approve' && !expiryInRange(p.requestedExpiresAt!, now, req.maxExpiryDays)) {
    return invalidate(db, p, 'expiry_out_of_range', quorum, actor, now);
  }
  const head = getHead(db, p.policyId);
  if (head.activeVersionId !== p.policyVersionId || !head.activationSignature) {
    return invalidate(db, p, 'policy_version_not_active', quorum, actor, now);
  }
  writeDecisions(db, p, c, result.deciders, quorum, sha256Hex(head.activationSignature), actor, now);
  return 'reached';
}

function invalidate(db: Db, p: ProposalRow, reason: string, quorum: QuorumVersion, actor: string, now: string): 'invalidated' {
  const details = { reason, quorumConfigVersion: quorum.version };
  db.insert(cpgProposalEvents).values({ id: randomUUID(), proposalId: p.id, orgId: p.orgId, event: 'invalidated', actor, details: canonicalJson(details), createdAt: now }).run();
  appendAuditEvent(db, { orgId: p.orgId, actor, action: 'proposal.invalidated', targetType: 'proposal', targetId: p.id, payload: details });
  return 'invalidated';
}

function writeDecisions(db: Db, p: ProposalRow, c: CaseRow, deciders: string[], quorum: QuorumVersion, activationSha: string, actor: string, finalizedAt: string): void {
  const decisionIds = fingerprintsOf(p).map((fingerprint) => {
    const payload: DecisionPayload = {
      kind: DECISION_KIND, id: randomUUID(), orgId: p.orgId, proposalId: p.id, caseId: c.id, scope: p.scope, outcome: p.outcome,
      repo: c.repo, fingerprint, pattern: null, policyKey: p.policyKey, policyVersion: p.policyVersion,
      policyActivationSignatureSha256: activationSha, expiresAt: p.requestedExpiresAt, approverUserIds: deciders,
      quorumConfigVersion: quorum.version, quorumConfigHash: quorum.configHash, finalizedAt,
    };
    const signedPayload = canonicalJson(payload);
    db.insert(cpgDecisions).values({
      id: payload.id, orgId: p.orgId, proposalId: p.id, caseId: c.id, scope: p.scope, outcome: p.outcome, repo: c.repo, fingerprint,
      batchId: p.scope === 'bulk' ? p.id : null, policyId: p.policyId, policyVersionId: p.policyVersionId, policyKey: p.policyKey,
      policyVersion: p.policyVersion, expiresAt: p.requestedExpiresAt, approverUserIds: JSON.stringify(deciders),
      quorumConfigVersion: quorum.version, quorumConfigHash: quorum.configHash, finalizedAt, signedPayload, signature: cpgSign(signedPayload),
    }).run();
    // A bulk decision is still recorded per finding in the audit trail (brief §3).
    appendAuditEvent(db, {
      orgId: p.orgId, actor, action: 'decision.recorded', targetType: 'decision', targetId: payload.id,
      payload: { proposalId: p.id, caseId: c.id, scope: p.scope, outcome: p.outcome, fingerprint, expiresAt: p.requestedExpiresAt, quorumConfigVersion: quorum.version },
    });
    return payload.id;
  });
  addCaseEvent(db, c, 'decision_recorded', actor, { proposalId: p.id, outcome: p.outcome, decisionIds }, finalizedAt);
  refreshCaseState(db, c, actor, finalizedAt);
}
