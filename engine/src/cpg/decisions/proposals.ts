import { randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { canonicalJson } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgProposals } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { activeVersion, addCaseEvent, assertLatestFingerprints, latestFindings, openCase, type CaseRow } from '../cases/service.js';
import type { StandingPattern } from '../contracts.js';
import { CpgError } from '../errors.js';
import { getHead } from '../policies/service.js';
import type { CpgActor } from '../rbac/can.js';
import { assertExpiry, lapsesAt, type Outcome } from '../quorum/evaluate.js';
import { currentQuorum, type QuorumVersion } from '../quorum/store.js';
import { currentRequirement } from './finalize.js';
import { assertPattern } from './standing.js';
import { caseProposals, fingerprintsOf, proposalView, proposalViews, type ProposalRow, type ProposalView } from './status.js';
import { recordVote } from './votes.js';

/**
 * Proposals (design spec §3, §4.3, §7). A snippet or bulk proposal decides
 * findings of the case's latest revision: one for `snippet`, 2 to 500 of the
 * same policy version for `bulk`. Its proposer must be an eligible voter, and
 * the proposer's vote is recorded with it, so a requirement of one approval
 * (or any rejection) is finalized at once. A standing exception covers future
 * findings matching a pattern; its proposer holds `exception.propose` and does
 * not vote, so every vote comes from an eligible approver.
 */

type Db = BetterSQLite3Database<any>;

export interface ProposalInput {
  caseId: string;
  scope: 'snippet' | 'bulk';
  outcome: Outcome;
  fingerprints: readonly string[];
  /** Required for an approval, absent for a rejection. */
  expiresAt?: string;
  rationale: string;
}

export interface StandingInput {
  /** The case the exception was proposed from, if any. */
  caseId?: string;
  pattern: StandingPattern;
  expiresAt: string;
  rationale: string;
}

type Draft = Omit<ProposalRow, 'id' | 'orgId' | 'required' | 'quorumConfigVersionAtCreation' | 'proposerUserId' | 'createdAt' | 'lapsesAt'>;

/** Compute the requirement, check the expiry against it, and insert the proposal with its case and audit events. */
function insertProposal(db: Db, actor: CpgActor, c: CaseRow | null, fields: Draft, quorum: QuorumVersion, now: string): ProposalRow {
  const draft: ProposalRow = {
    ...fields, id: randomUUID(), orgId: actor.orgId, required: '', quorumConfigVersionAtCreation: quorum.version,
    proposerUserId: actor.userId, createdAt: now, lapsesAt: lapsesAt(now, quorum.config.proposalLapseDays),
  };
  const required = currentRequirement(db, draft, quorum);
  if (draft.requestedExpiresAt !== null) assertExpiry(draft.requestedExpiresAt, now, required.maxExpiryDays);
  const proposal: ProposalRow = { ...draft, required: canonicalJson(required) };
  db.insert(cpgProposals).values(proposal).run();
  const userActor = `user:${actor.userId}`;
  const details = { proposalId: proposal.id, scope: proposal.scope, outcome: proposal.outcome, fingerprints: fingerprintsOf(proposal), quorumConfigVersion: quorum.version };
  if (c) addCaseEvent(db, c, 'proposal_created', userActor, details, now);
  appendAuditEvent(db, { orgId: actor.orgId, actor: userActor, action: 'proposal.created', targetType: 'proposal', targetId: proposal.id, payload: details });
  return proposal;
}

const isoOrNull = (iso: string | undefined) => (iso === undefined ? null : new Date(iso).toISOString());

export function createProposal(db: Db, actor: CpgActor, input: ProposalInput): ProposalView {
  return rawSqlite(db).transaction(() => {
    const c = openCase(db, actor.orgId, input.caseId);
    const fingerprints = [...new Set(input.fingerprints)].sort();
    assertLatestFingerprints(db, c.id, fingerprints);
    // §4.3 step 2: a bulk proposal is homogeneous, one policy version.
    const findings = latestFindings(db, c.id).filter((f) => fingerprints.includes(f.fingerprint));
    if (new Set(findings.map((f) => f.policyVersionId)).size > 1) {
      throw new CpgError(422, 'bulk_mixed_policies', 'A bulk proposal decides findings of one policy version; split it by policy');
    }
    const finding = findings[0];
    if (getHead(db, finding.policyId).activeVersionId !== finding.policyVersionId) {
      throw new CpgError(422, 'policy_version_not_active', 'The findings belong to a policy version that is no longer active; rescan');
    }
    const now = new Date().toISOString();
    const overlapping = proposalViews(db, caseProposals(db, c.id), now)
      .find((v) => v.status === 'pending' && fingerprintsOf(v.proposal).some((fp) => fingerprints.includes(fp)));
    if (overlapping) throw new CpgError(409, 'proposal_pending', 'A pending proposal already covers one of these findings', { proposalId: overlapping.proposal.id });

    const proposal = insertProposal(db, actor, c, {
      caseId: c.id, scope: input.scope, outcome: input.outcome,
      policyId: finding.policyId, policyVersionId: finding.policyVersionId, policyKey: finding.policyKey, policyVersion: finding.policyVersion,
      tier: finding.tier, fingerprints: JSON.stringify(fingerprints), pattern: null,
      requestedExpiresAt: isoOrNull(input.expiresAt), rationale: input.rationale,
    }, currentQuorum(db, actor.orgId), now);
    // The proposer's own vote: eligibility (including the self-approval ban) is checked there, and a refusal rolls all of this back.
    recordVote(db, actor, proposal, { vote: proposal.outcome, comment: '' }, now);
    return proposalView(db, proposal, now);
  }).immediate();
}

export function createStandingProposal(db: Db, actor: CpgActor, input: StandingInput): ProposalView {
  return rawSqlite(db).transaction(() => {
    const c = input.caseId === undefined ? null : openCase(db, actor.orgId, input.caseId);
    const quorum = currentQuorum(db, actor.orgId);
    const p = input.pattern;
    assertPattern(db, actor.orgId, p, quorum.config.standingExceptions.allowOrgWideRepoPatterns);
    const version = activeVersion(db, actor.orgId, p.policyKey, p.policyVersion);
    const now = new Date().toISOString();
    const proposal = insertProposal(db, actor, c, {
      caseId: c?.id ?? null, scope: 'standing', outcome: 'approve',
      policyId: version.policyId, policyVersionId: version.id, policyKey: p.policyKey, policyVersion: p.policyVersion,
      tier: version.tier, fingerprints: '[]', pattern: canonicalJson(p),
      requestedExpiresAt: isoOrNull(input.expiresAt), rationale: input.rationale,
    }, quorum, now);
    return proposalView(db, proposal, now);
  }).immediate();
}
