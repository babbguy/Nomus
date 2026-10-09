import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { canonicalJson, sha256Hex } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgCaseEvents, cpgCaseRevisions, cpgCases, cpgDecisions } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { cpgSign } from '../policies/signing.js';
import { addCaseEvent, getCase, openCase, type CaseRow } from './service.js';
import { assertTransition } from './state.js';

/**
 * Closing a case (design spec §5.7, §13.3). In one transaction: the `closed`
 * event is appended, the closure record is built from the stored rows and
 * signed, and the case row is frozen (its trigger refuses any later update,
 * and the child tables refuse new rows).
 *
 * The record is rebuilt from immutable rows only, so closurePayload() on the
 * closed case reproduces exactly the text that was signed.
 */

type Db = BetterSQLite3Database<any>;
export type CloseReason = NonNullable<CaseRow['closeReason']>;
export const CASE_CLOSURE_KIND = 'nomus.cpg-case-closure.v1';

export function closurePayload(db: Db, c: CaseRow) {
  const revisions = db.select({ revision: cpgCaseRevisions.revision, findingsDigest: cpgCaseRevisions.findingsDigest, headSha: cpgCaseRevisions.headSha })
    .from(cpgCaseRevisions).where(eq(cpgCaseRevisions.caseId, c.id)).orderBy(asc(cpgCaseRevisions.revision)).all();
  const events = db.select({
    id: cpgCaseEvents.id, seq: cpgCaseEvents.seq, event: cpgCaseEvents.event, actor: cpgCaseEvents.actor,
    details: cpgCaseEvents.details, createdAt: cpgCaseEvents.createdAt,
  }).from(cpgCaseEvents).where(eq(cpgCaseEvents.caseId, c.id)).orderBy(asc(cpgCaseEvents.seq)).all();
  const decisionIds = db.select({ id: cpgDecisions.id }).from(cpgDecisions).where(eq(cpgDecisions.caseId, c.id))
    .orderBy(asc(cpgDecisions.finalizedAt), asc(cpgDecisions.id)).all().map((d) => d.id);
  return {
    kind: CASE_CLOSURE_KIND, caseId: c.id, orgId: c.orgId, repo: c.repo, branch: c.branch, prNumber: c.prNumber,
    closeReason: c.closeReason, closedAt: c.closedAt, openedAt: c.openedAt, revisions,
    // A closed case accepts no new decision (trigger), so these ids are as fixed as the rows above.
    // Standing exceptions are linked in a later phase, and CI runs (Phase 6) have no table yet.
    decisionIds, standingExceptionDecisionIds: [] as string[], ciRunIds: [] as string[],
    eventsDigest: sha256Hex(canonicalJson(events)),
  };
}

export function closureSignedText(db: Db, c: CaseRow): string {
  return canonicalJson(closurePayload(db, c));
}

export function closeCase(db: Db, input: { orgId: string; caseId: string; reason: CloseReason; note: string; actor: string }): CaseRow {
  return rawSqlite(db).transaction(() => {
    const c = openCase(db, input.orgId, input.caseId);
    assertTransition(c.state, 'closed');
    const now = new Date().toISOString();
    addCaseEvent(db, c, 'closed', input.actor, { reason: input.reason, from: c.state, note: input.note }, now);
    const closed: CaseRow = { ...c, state: 'closed', closeReason: input.reason, closedAt: now, closedBy: input.actor, updatedAt: now };
    closed.closureSignature = cpgSign(closureSignedText(db, closed));
    db.update(cpgCases).set({
      state: 'closed', closeReason: input.reason, closedAt: now, closedBy: input.actor, closureSignature: closed.closureSignature, updatedAt: now,
    }).where(eq(cpgCases.id, c.id)).run();
    appendAuditEvent(db, {
      orgId: c.orgId, actor: input.actor, action: 'case.closed', targetType: 'case', targetId: c.id,
      payload: { reason: input.reason, from: c.state, note: input.note },
    });
    return getCase(db, input.orgId, input.caseId);
  }).immediate();
}
