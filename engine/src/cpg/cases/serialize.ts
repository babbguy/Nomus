import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { caseStatusSchema, type CaseStatus, type FindingResolution } from '@nomus/scanner/corporate';
import { cpgCaseFindings, cpgCaseRevisions, cpgPolicyHeads, cpgSnippets } from '../../db/schema-cpg.js';
import { listBoards } from '../boards/service.js';
import {
  caseDetailResponseSchema, revisionDetailResponseSchema, reviewerContextResponseSchema,
  type CaseSummaryResponse, type CommentResponse, type JustificationResponse, type ReviewerContextResponse,
} from '../contracts.js';
import { notFound } from '../errors.js';
import { userNames } from '../policies/service.js';
import { listComments, type CommentRow } from './comments.js';
import type { ReviewerContextRow } from './context.js';
import { currentJustifications, type JustificationRow } from './justifications.js';
import { caseLanes } from './lanes.js';
import { isBlocking, latestFindings, openChangeRequests, type CaseFindingRow, type CaseRow, type RevisionRow } from './service.js';

/** Response builders for the review-case routes; each output is parsed with its contract. */

type Db = BetterSQLite3Database<any>;

export const caseUrl = (origin: string, caseId: string) => `${origin}/governance/cases/${caseId}`;

export function caseSummary(c: CaseRow): CaseSummaryResponse {
  return {
    id: c.id, ref: c.ref, repo: c.repo, branch: c.branch, prNumber: c.prNumber, state: c.state, closeReason: c.closeReason,
    latestRevision: c.latestRevision, openedAt: c.openedAt, updatedAt: c.updatedAt, closedAt: c.closedAt,
  };
}

export function justificationOf(j: JustificationRow, names: Map<string, string>): JustificationResponse {
  return { id: j.id, fingerprint: j.fingerprint, authorUserId: j.authorUserId, authorName: names.get(j.authorUserId) ?? '', body: j.body, createdAt: j.createdAt };
}

export function commentOf(m: CommentRow, names: Map<string, string>): CommentResponse {
  return {
    id: m.id, threadId: m.threadId, parentId: m.parentId, kind: m.kind, boardId: m.boardId, fingerprints: JSON.parse(m.fingerprints) as string[],
    authorUserId: m.authorUserId, authorName: names.get(m.authorUserId) ?? '', body: m.body, createdAt: m.createdAt,
  };
}

/**
 * The resolution of each latest-revision finding. Decisions arrive in Phase
 * 5, so a blocking finding is `changes_requested` (named by an unresolved
 * change request) or `needs_review`. A finding raised against a version that
 * is no longer active is `expired`: it blocks (rescan) unless the policy is retired.
 */
function resolutions(db: Db, findings: CaseFindingRow[], changeRequested: Set<string>): FindingResolution[] {
  const policyIds = [...new Set(findings.map((f) => f.policyId))];
  const heads = new Map(policyIds.length === 0 ? [] : db.select().from(cpgPolicyHeads).where(inArray(cpgPolicyHeads.policyId, policyIds)).all().map((h) => [h.policyId, h]));
  const byFingerprint = new Map(findings.map((f) => [f.fingerprint, f]));
  return [...byFingerprint.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)).map((f) => {
    const head = heads.get(f.policyId)!;
    const current = head.activeVersionId === f.policyVersionId;
    const blocking = current ? isBlocking(f) : head.state === 'active';
    const status = !current ? 'expired' : f.tier === 'advisory' ? 'advisory' : !f.enforced ? 'grace'
      : changeRequested.has(f.fingerprint) ? 'changes_requested' : 'needs_review';
    return {
      fingerprint: f.fingerprint, status, blocking, tier: f.tier, enforceFrom: head.enforceFrom,
      decisionId: null, exceptionDecisionId: null, expiresAt: null,
    };
  });
}

/** The CaseStatus contract (§9.3), shared with the extension and the action. */
export function caseStatus(db: Db, c: CaseRow, origin: string): CaseStatus {
  const boardName = new Map(listBoards(db, c.orgId).map((b) => [b.id, b.name]));
  const unresolved = new Set([...openChangeRequests(db, c.id)].filter(([, s]) => !s.resolved).map(([id]) => id));
  const requests = listComments(db, c.id).filter((m) => unresolved.has(m.id));
  const names = userNames(db, requests.map((m) => m.authorUserId));
  return caseStatusSchema.parse({
    id: c.id, ref: c.ref, repo: c.repo, branch: c.branch, prNumber: c.prNumber, state: c.state, closeReason: c.closeReason,
    latestRevision: c.latestRevision, url: caseUrl(origin, c.id),
    lanes: caseLanes(db, c.orgId, c.id).map((l) => ({ boardId: l.boardId, boardName: boardName.get(l.boardId) ?? '', state: l.state, blocking: l.blocking, decided: l.decided })),
    openChangeRequests: requests.map((m) => ({
      commentId: m.id, boardName: boardName.get(m.boardId!) ?? '', authorName: names.get(m.authorUserId) ?? '', body: m.body,
      fingerprints: JSON.parse(m.fingerprints) as string[], createdAt: m.createdAt,
    })),
    resolutions: resolutions(db, latestFindings(db, c.id), new Set(requests.flatMap((m) => JSON.parse(m.fingerprints) as string[]))),
    updatedAt: c.updatedAt,
  });
}

const revisionOf = (r: RevisionRow) => ({
  revision: r.revision, source: r.source, headSha: r.headSha, findingsDigest: r.findingsDigest,
  addedCount: r.addedCount, carriedCount: r.carriedCount, resolvedCount: r.resolvedCount, createdAt: r.createdAt,
});

export function caseDetail(db: Db, c: CaseRow, origin: string) {
  const revisions = db.select().from(cpgCaseRevisions).where(eq(cpgCaseRevisions.caseId, c.id)).orderBy(asc(cpgCaseRevisions.revision)).all();
  const justifications = [...currentJustifications(db, c.id).values()];
  const comments = listComments(db, c.id);
  const names = userNames(db, [...justifications, ...comments].map((r) => r.authorUserId));
  return caseDetailResponseSchema.parse({
    case: caseStatus(db, c, origin),
    revisions: revisions.map(revisionOf),
    justifications: justifications.map((j) => justificationOf(j, names)),
    comments: comments.map((m) => commentOf(m, names)),
  });
}

/** One revision with its findings, snippet text and current justifications (E44). */
export function revisionDetail(db: Db, c: CaseRow, revision: number) {
  const r = db.select().from(cpgCaseRevisions).where(and(eq(cpgCaseRevisions.caseId, c.id), eq(cpgCaseRevisions.revision, revision))).get();
  if (!r) throw notFound('Revision');
  const rows = db.select({ f: cpgCaseFindings, snippet: cpgSnippets.normalizedText }).from(cpgCaseFindings)
    .innerJoin(cpgSnippets, and(eq(cpgSnippets.orgId, cpgCaseFindings.orgId), eq(cpgSnippets.snippetHash, cpgCaseFindings.snippetHash)))
    .where(eq(cpgCaseFindings.revisionId, r.id)).orderBy(asc(cpgCaseFindings.filePath), asc(cpgCaseFindings.startLine), asc(cpgCaseFindings.fingerprint)).all();
  const justifications = currentJustifications(db, c.id);
  const names = userNames(db, [...justifications.values()].map((j) => j.authorUserId));
  return revisionDetailResponseSchema.parse({
    revision: revisionOf(r),
    findings: rows.map(({ f, snippet }) => {
      const j = justifications.get(f.fingerprint);
      return {
        id: f.id, fingerprint: f.fingerprint, policyKey: f.policyKey, policyVersion: f.policyVersion, tier: f.tier, blocking: isBlocking(f),
        statusAtRevision: f.statusAtRevision, filePath: f.filePath, startLine: f.startLine, endLine: f.endLine, language: f.language,
        snippet, justification: j ? justificationOf(j, names) : null,
      };
    }),
  });
}

export function reviewerContextOf(findingId: string, row: ReviewerContextRow | null, promptVersion: number): ReviewerContextResponse {
  return reviewerContextResponseSchema.parse(row === null
    ? { findingId, status: 'disabled', label: null, whatItDoes: null, whyFlagged: null, provider: null, model: null, promptVersion, attempt: null, error: null, createdAt: null }
    : {
      findingId, status: row.status, label: row.status === 'generated' ? `Generated by ${row.provider} ${row.model}` : null,
      whatItDoes: row.whatItDoes, whyFlagged: row.whyFlagged, provider: row.provider, model: row.model,
      promptVersion: row.promptVersion, attempt: row.attempt, error: row.error, createdAt: row.createdAt,
    });
}
