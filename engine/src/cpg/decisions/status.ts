import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cpgCases, cpgDecisions, cpgProposalEvents, cpgProposals, cpgVotes } from '../../db/schema-cpg.js';
import { notFound } from '../errors.js';
import { proposalStatus, requirementSchema, type ProposalStatus, type Requirement } from '../quorum/evaluate.js';

/**
 * Proposal reads (design spec §5.5). Every table behind a proposal is
 * append-only, so its status is derived: finalized (decisions exist), vetoed
 * (a reject vote on an approve proposal), invalidated, void (the case is
 * closed), lapsed, otherwise pending.
 */

type Db = BetterSQLite3Database<any>;
export type ProposalRow = typeof cpgProposals.$inferSelect;
export type VoteRow = typeof cpgVotes.$inferSelect;

export interface ProposalView {
  proposal: ProposalRow;
  votes: VoteRow[];
  decisionIds: string[];
  invalidation: { reason: string; at: string } | null;
  status: ProposalStatus;
}

export const requiredOf = (p: ProposalRow): Requirement => requirementSchema.parse(JSON.parse(p.required));
export const fingerprintsOf = (p: ProposalRow): string[] => JSON.parse(p.fingerprints) as string[];

export function getProposal(db: Db, orgId: string, proposalId: string): ProposalRow {
  const p = db.select().from(cpgProposals).where(and(eq(cpgProposals.id, proposalId), eq(cpgProposals.orgId, orgId))).get();
  // Cross-org ids are 404, never 403 (§9.1).
  if (!p) throw notFound('Proposal');
  return p;
}

export function caseProposals(db: Db, caseId: string): ProposalRow[] {
  return db.select().from(cpgProposals).where(eq(cpgProposals.caseId, caseId)).orderBy(asc(cpgProposals.createdAt), asc(sql`rowid`)).all();
}

/** The derived view of each proposal, in the given order. */
export function proposalViews(db: Db, proposals: readonly ProposalRow[], now: string): ProposalView[] {
  const ids = proposals.map((p) => p.id);
  if (ids.length === 0) return [];
  const group = <T extends { proposalId: string }>(rows: T[]) => {
    const by = new Map<string, T[]>();
    for (const r of rows) by.set(r.proposalId, [...(by.get(r.proposalId) ?? []), r]);
    return by;
  };
  const votes = group(db.select().from(cpgVotes).where(inArray(cpgVotes.proposalId, ids)).orderBy(asc(cpgVotes.createdAt), asc(sql`rowid`)).all());
  const decisions = group(db.select({ id: cpgDecisions.id, proposalId: cpgDecisions.proposalId }).from(cpgDecisions)
    .where(inArray(cpgDecisions.proposalId, ids)).orderBy(asc(sql`rowid`)).all());
  const events = new Map(db.select().from(cpgProposalEvents).where(inArray(cpgProposalEvents.proposalId, ids)).all().map((e) => [e.proposalId, e]));
  const caseIds = [...new Set(proposals.map((p) => p.caseId).filter((id): id is string => id !== null))];
  const closed = new Set(caseIds.length === 0 ? [] : db.select({ id: cpgCases.id }).from(cpgCases)
    .where(and(inArray(cpgCases.id, caseIds), isNotNull(cpgCases.closedAt))).all().map((c) => c.id));
  return proposals.map((proposal) => {
    const pv = votes.get(proposal.id) ?? [];
    const decisionIds = (decisions.get(proposal.id) ?? []).map((d) => d.id);
    const event = events.get(proposal.id);
    const invalidation = event ? { reason: (JSON.parse(event.details) as { reason: string }).reason, at: event.createdAt } : null;
    const status = proposalStatus({
      finalized: decisionIds.length > 0,
      vetoed: proposal.outcome === 'approve' && pv.some((v) => v.vote === 'reject'),
      invalidated: invalidation !== null,
      caseClosed: proposal.caseId !== null && closed.has(proposal.caseId),
      lapsesAt: proposal.lapsesAt,
    }, now);
    return { proposal, votes: pv, decisionIds, invalidation, status };
  });
}

export const proposalView = (db: Db, p: ProposalRow, now: string): ProposalView => proposalViews(db, [p], now)[0];

/** Fingerprints of a case that a pending proposal covers (§7.4 step 4 `pending`). */
export function pendingFingerprints(db: Db, caseId: string, now: string): Set<string> {
  return new Set(proposalViews(db, caseProposals(db, caseId), now).filter((v) => v.status === 'pending').flatMap((v) => fingerprintsOf(v.proposal)));
}
