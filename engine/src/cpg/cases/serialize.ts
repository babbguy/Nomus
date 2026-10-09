import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { caseStatusSchema, parseFingerprint, type CaseStatus, type FindingResolution } from '@nomus/scanner/corporate';
import { cpgCaseEvents, cpgCaseFindings, cpgCaseRevisions, cpgCases, cpgPolicies, cpgPolicyHeads, cpgPolicyVersions, cpgSnippets } from '../../db/schema-cpg.js';
import { listBoards } from '../boards/service.js';
import { can, type CpgActor } from '../rbac/can.js';
import { cpgVerify } from '../policies/signing.js';
import {
  caseDetailResponseSchema, revisionDetailResponseSchema, reviewerContextResponseSchema,
  type CaseSummaryResponse, type CommentResponse, type JustificationResponse, type ReviewerContextResponse,
} from '../contracts.js';
import { coverFindings, settled, type Cover } from '../decisions/resolve.js';
import { pendingFingerprints } from '../decisions/status.js';
import { CpgError, notFound } from '../errors.js';
import { boardIdsOf, userNames } from '../policies/service.js';
import { closurePayload, closureSignedText } from './close.js';
import { listComments, type CommentRow } from './comments.js';
import { latestAttempt, type ReviewerContextRow } from './context.js';
import { currentJustifications, type JustificationRow } from './justifications.js';
import { caseLanes } from './lanes.js';
import { caseCover, isBlocking, latestFindings, openChangeRequests, type CaseFindingRow, type CaseRow, type RevisionRow } from './service.js';

/** Response builders for the review-case routes; each output is parsed with its contract. */

type Db = BetterSQLite3Database<any>;
type PolicyHead = typeof cpgPolicyHeads.$inferSelect;

export const caseUrl = (origin: string, caseId: string) => `${origin}/governance/cases/${caseId}`;

const boardNames = (db: Db, orgId: string) => new Map(listBoards(db, orgId).map((b) => [b.id, b.name]));
const userIdOf = (actor: string | null) => (actor?.startsWith('user:') ? actor.slice('user:'.length) : null);
const actorRef = (actor: string, names: Map<string, string>) => ({ actor, name: names.get(userIdOf(actor) ?? '') ?? null });
const actorNames = (db: Db, actors: Array<string | null>) => userNames(db, actors.map(userIdOf).filter((id): id is string => id !== null));

function lanesOf(db: Db, c: CaseRow, boardName: Map<string, string>): CaseStatus['lanes'] {
  return caseLanes(db, c.orgId, c.id).map((l) => ({ boardId: l.boardId, boardName: boardName.get(l.boardId) ?? '', state: l.state, blocking: l.blocking, decided: l.decided }));
}

/** List rows (E41): the case, who opened it and its lanes. */
export function caseSummaries(db: Db, orgId: string, rows: CaseRow[]): CaseSummaryResponse[] {
  const boardName = boardNames(db, orgId);
  const names = actorNames(db, rows.map((c) => c.openedBy));
  return rows.map((c) => ({
    id: c.id, ref: c.ref, repo: c.repo, branch: c.branch, prNumber: c.prNumber, state: c.state, closeReason: c.closeReason,
    latestRevision: c.latestRevision, openedAt: c.openedAt, updatedAt: c.updatedAt, closedAt: c.closedAt,
    openedBy: actorRef(c.openedBy, names), lanes: lanesOf(db, c, boardName),
  }));
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

interface ResolutionFacts {
  fingerprint: string;
  tier: CaseFindingRow['tier'];
  /** The policy version is enforced (past its grace period). */
  enforced: boolean;
  /** The finding's policy version is the policy's active version. */
  current: boolean;
  head: Pick<PolicyHead, 'state' | 'enforceFrom'>;
}

/** What else decides a finding's resolution: its §7.4 cover, a pending proposal, a change request. */
interface ResolutionContext {
  cover: ReadonlyMap<string, Cover>;
  pending: ReadonlySet<string>;
  changeRequested: ReadonlySet<string>;
  now: string;
}

/**
 * One finding's resolution (§7.4). A finding raised against a version that
 * is no longer active is `expired`: it blocks (rescan) unless the policy is
 * retired. A non-blocking finding is `advisory` or `grace`. Otherwise its
 * cover decides (rejected, approved, excepted); an undecided finding is
 * `pending` when a proposal covers it, else `expired` (its approval lapsed),
 * `changes_requested` or `needs_review`.
 */
function resolutionOf(f: ResolutionFacts, ctx: ResolutionContext): FindingResolution {
  const base = { fingerprint: f.fingerprint, tier: f.tier, enforceFrom: f.head.enforceFrom, decisionId: null, exceptionDecisionId: null, expiresAt: null };
  if (!f.current) return { ...base, status: 'expired', blocking: f.head.state === 'active' };
  if (!isBlocking(f)) return { ...base, status: f.tier === 'advisory' ? 'advisory' : 'grace', blocking: false };
  const cover = ctx.cover.get(f.fingerprint) ?? { status: null };
  const decided = {
    decisionId: cover.decision?.id ?? null, exceptionDecisionId: cover.exception?.id ?? null,
    expiresAt: (cover.exception ?? cover.decision)?.expiresAt ?? null,
  };
  if (settled(cover)) return { ...base, ...decided, status: cover.status!, blocking: cover.status === 'rejected' };
  const status = ctx.pending.has(f.fingerprint) ? 'pending' : cover.status === 'expired' ? 'expired' : ctx.changeRequested.has(f.fingerprint) ? 'changes_requested' : 'needs_review';
  return { ...base, ...decided, status, blocking: true };
}

/** The change requests of a case that no reply has resolved yet. */
function unresolvedRequests(db: Db, caseId: string): CommentRow[] {
  const unresolved = new Set([...openChangeRequests(db, caseId)].filter(([, s]) => !s.resolved).map(([id]) => id));
  return listComments(db, caseId).filter((m) => unresolved.has(m.id));
}

const requestedFingerprints = (requests: CommentRow[]) => new Set(requests.flatMap((m) => JSON.parse(m.fingerprints) as string[]));

/** The resolution of each latest-revision finding of case `c`, by fingerprint. */
function resolutions(db: Db, c: CaseRow, findings: CaseFindingRow[], changeRequested: Set<string>): FindingResolution[] {
  const now = new Date().toISOString();
  const ctx: ResolutionContext = { cover: caseCover(db, c, findings, now), pending: pendingFingerprints(db, c.id, now), changeRequested, now };
  const policyIds = [...new Set(findings.map((f) => f.policyId))];
  const heads = new Map(policyIds.length === 0 ? [] : db.select().from(cpgPolicyHeads).where(inArray(cpgPolicyHeads.policyId, policyIds)).all().map((h) => [h.policyId, h]));
  const byFingerprint = new Map(findings.map((f) => [f.fingerprint, f]));
  return [...byFingerprint.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)).map((f) => {
    const head = heads.get(f.policyId)!;
    return resolutionOf({ ...f, current: head.activeVersionId === f.policyVersionId, head }, ctx);
  });
}

/**
 * E53: the resolution of fingerprints a scanner found on a branch, before or
 * after review was requested. Each must name a version of one of the org's
 * policies (422 unknown_policy otherwise). Change requests, and the file
 * locations a standing exception is matched against, come from the branch's
 * open case: a fingerprint it does not hold is never excepted.
 */
export function findingsStatus(db: Db, orgId: string, branch: { repo: string; branch: string }, fingerprints: readonly string[], now: string): FindingResolution[] {
  const parsed = [...new Set(fingerprints)].map((fingerprint) => ({ fingerprint, ...parseFingerprint(fingerprint)! }));
  const keys = [...new Set(parsed.map((p) => p.policyKey))];
  const versions = new Map(db.select({
    policyKey: cpgPolicies.policyKey, version: cpgPolicyVersions.version, id: cpgPolicyVersions.id, tier: cpgPolicyVersions.tier,
    state: cpgPolicyHeads.state, activeVersionId: cpgPolicyHeads.activeVersionId, enforceFrom: cpgPolicyHeads.enforceFrom,
  }).from(cpgPolicyVersions)
    .innerJoin(cpgPolicies, eq(cpgPolicies.id, cpgPolicyVersions.policyId))
    .innerJoin(cpgPolicyHeads, eq(cpgPolicyHeads.policyId, cpgPolicyVersions.policyId))
    .where(and(eq(cpgPolicyVersions.orgId, orgId), inArray(cpgPolicies.policyKey, keys))).all()
    .map((v) => [`${v.policyKey}:${v.version}`, v]));
  const unknown = parsed.filter((p) => !versions.has(`${p.policyKey}:${p.policyVersion}`)).map((p) => p.fingerprint);
  if (unknown.length > 0) throw new CpgError(422, 'unknown_policy', 'A fingerprint names a policy version this organization does not have', { fingerprints: unknown });
  const kase = db.select().from(cpgCases)
    .where(and(eq(cpgCases.orgId, orgId), eq(cpgCases.repo, branch.repo), eq(cpgCases.branch, branch.branch), isNull(cpgCases.closedAt))).get();
  const ctx: ResolutionContext = {
    cover: coverFindings(db, orgId, parsed.map((p) => p.fingerprint), (kase ? latestFindings(db, kase.id) : []).map((f) => ({ ...f, ...branch })), branch.repo, now),
    pending: kase ? pendingFingerprints(db, kase.id, now) : new Set(),
    changeRequested: kase ? requestedFingerprints(unresolvedRequests(db, kase.id)) : new Set(),
    now,
  };
  return parsed.map((p) => {
    const v = versions.get(`${p.policyKey}:${p.policyVersion}`)!;
    return resolutionOf({
      fingerprint: p.fingerprint, tier: v.tier, current: v.state === 'active' && v.activeVersionId === v.id,
      enforced: v.enforceFrom !== null && v.enforceFrom <= now, head: v,
    }, ctx);
  });
}

/** The CaseStatus contract (§9.3), shared with the extension and the action. */
export function caseStatus(db: Db, c: CaseRow, origin: string): CaseStatus {
  const boardName = boardNames(db, c.orgId);
  const requests = unresolvedRequests(db, c.id);
  const names = userNames(db, requests.map((m) => m.authorUserId));
  return caseStatusSchema.parse({
    id: c.id, ref: c.ref, repo: c.repo, branch: c.branch, prNumber: c.prNumber, state: c.state, closeReason: c.closeReason,
    latestRevision: c.latestRevision, url: caseUrl(origin, c.id),
    lanes: lanesOf(db, c, boardName),
    openChangeRequests: requests.map((m) => ({
      commentId: m.id, boardName: boardName.get(m.boardId!) ?? '', authorName: names.get(m.authorUserId) ?? '', body: m.body,
      fingerprints: JSON.parse(m.fingerprints) as string[], createdAt: m.createdAt,
    })),
    resolutions: resolutions(db, c, latestFindings(db, c.id), requestedFingerprints(requests)),
    updatedAt: c.updatedAt,
  });
}

const revisionOf = (r: RevisionRow) => ({
  revision: r.revision, source: r.source, headSha: r.headSha, findingsDigest: r.findingsDigest,
  addedCount: r.addedCount, carriedCount: r.carriedCount, resolvedCount: r.resolvedCount, createdAt: r.createdAt,
});

/** The signed closure record of a closed case, verified against the rows it was built from. */
function closureOf(db: Db, c: CaseRow, names: Map<string, string>) {
  if (!c.closedAt || !c.closedBy || !c.closeReason || !c.closureSignature) return null;
  const event = db.select({ details: cpgCaseEvents.details }).from(cpgCaseEvents)
    .where(and(eq(cpgCaseEvents.caseId, c.id), eq(cpgCaseEvents.event, 'closed'))).get();
  const note = event ? (JSON.parse(event.details) as { note?: unknown }).note : undefined;
  return {
    reason: c.closeReason, note: typeof note === 'string' ? note : null, closedAt: c.closedAt, closedBy: actorRef(c.closedBy, names),
    record: closurePayload(db, c), signature: c.closureSignature, signatureValid: cpgVerify(closureSignedText(db, c), c.closureSignature),
  };
}

/** E43: the case, its people and history, and what `actor` may do on it. */
export function caseDetail(db: Db, c: CaseRow, origin: string, actor: CpgActor) {
  const revisions = db.select().from(cpgCaseRevisions).where(eq(cpgCaseRevisions.caseId, c.id)).orderBy(asc(cpgCaseRevisions.revision)).all();
  const justifications = [...currentJustifications(db, c.id).values()];
  const comments = listComments(db, c.id);
  const names = userNames(db, [...justifications, ...comments].map((r) => r.authorUserId));
  for (const [id, name] of actorNames(db, [c.openedBy, c.closedBy])) names.set(id, name);
  const repo = { repo: c.repo };
  const close = can(actor, 'case.close', repo);
  return caseDetailResponseSchema.parse({
    case: caseStatus(db, c, origin),
    openedAt: c.openedAt,
    openedBy: actorRef(c.openedBy, names),
    closure: closureOf(db, c, names),
    viewer: {
      comment: can(actor, 'case.comment', repo), review: can(actor, 'case.review', repo),
      close, withdraw: close || c.openedBy === `user:${actor.userId}`,
    },
    revisions: revisions.map(revisionOf),
    justifications: justifications.map((j) => justificationOf(j, names)),
    comments: comments.map((m) => commentOf(m, names)),
  });
}

/** One revision with its findings, snippet text and current justifications (E44). */
export function revisionDetail(db: Db, c: CaseRow, revision: number) {
  const r = db.select().from(cpgCaseRevisions).where(and(eq(cpgCaseRevisions.caseId, c.id), eq(cpgCaseRevisions.revision, revision))).get();
  if (!r) throw notFound('Revision');
  const rows = db.select({ f: cpgCaseFindings, snippet: cpgSnippets.normalizedText, policyTitle: cpgPolicyVersions.title, owningBoardIds: cpgPolicyVersions.owningBoardIds }).from(cpgCaseFindings)
    .innerJoin(cpgSnippets, and(eq(cpgSnippets.orgId, cpgCaseFindings.orgId), eq(cpgSnippets.snippetHash, cpgCaseFindings.snippetHash)))
    .innerJoin(cpgPolicyVersions, eq(cpgPolicyVersions.id, cpgCaseFindings.policyVersionId))
    .where(eq(cpgCaseFindings.revisionId, r.id)).orderBy(asc(cpgCaseFindings.filePath), asc(cpgCaseFindings.startLine), asc(cpgCaseFindings.fingerprint)).all();
  const justifications = currentJustifications(db, c.id);
  const names = userNames(db, [...justifications.values()].map((j) => j.authorUserId));
  return revisionDetailResponseSchema.parse({
    revision: revisionOf(r),
    findings: rows.map(({ f, snippet, policyTitle, owningBoardIds }) => {
      const j = justifications.get(f.fingerprint);
      return {
        id: f.id, fingerprint: f.fingerprint, policyId: f.policyId, policyKey: f.policyKey, policyTitle, policyVersion: f.policyVersion,
        tier: f.tier, blocking: isBlocking(f), owningBoardIds: boardIdsOf({ owningBoardIds }),
        statusAtRevision: f.statusAtRevision, filePath: f.filePath, startLine: f.startLine, endLine: f.endLine, language: f.language,
        snippet, justification: j ? justificationOf(j, names) : null, contextStatus: latestAttempt(db, f)?.status ?? 'none',
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
