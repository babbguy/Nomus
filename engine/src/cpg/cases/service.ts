import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { canonicalJson, MAX_SNIPPET_LINES, normalizeSnippet, parseFingerprint, sha256Hex } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import {
  cpgCaseEvents, cpgCaseFindings, cpgCaseRevisions, cpgCases, cpgJustifications, cpgPolicies, cpgPolicyHeads, cpgPolicyVersions,
  cpgSnippets,
} from '../../db/schema-cpg.js';
import { coverFindings, settled, type Cover } from '../decisions/resolve.js';
import { CpgError, notFound } from '../errors.js';
import { assertTransition, deriveCaseState, type CaseFacts } from './state.js';

/**
 * Review cases (design spec §5.1, §5.4): one open case per (org, repo,
 * branch), and revisions that snapshot the branch's corporate findings.
 *
 * Writers run in BEGIN IMMEDIATE transactions, so concurrent callers are
 * serialized before they read: two simultaneous find-or-create calls see one
 * case, and two revisions of one case never race for the same number. When
 * called inside an outer transaction they become savepoints of it.
 *
 * Request validation (the §9.3 contracts) belongs to the routes; this layer
 * enforces what only the server can know: the snippet hashes to its
 * fingerprint, and the policy version exists in the org and is active.
 */

export type CaseRow = typeof cpgCases.$inferSelect;
export type RevisionRow = typeof cpgCaseRevisions.$inferSelect;
export type CaseFindingRow = typeof cpgCaseFindings.$inferSelect;
type CaseEvent = (typeof cpgCaseEvents.$inferSelect)['event'];

export interface CaseKey {
  orgId: string;
  /** canonicalRepo() output. */
  repo: string;
  /** Without refs/heads/. */
  branch: string;
}

export interface RevisionFinding {
  fingerprint: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  /** Required unless the org already stores the snippet (a CI re-run). */
  snippet?: string;
}

export interface RevisionInput {
  source: RevisionRow['source'];
  headSha: string | null;
  bundleHash: string;
  findings: readonly RevisionFinding[];
}

export interface RevisionResult {
  /** The new revision, or the latest one when nothing changed. */
  revision: RevisionRow;
  revisionCreated: boolean;
}

export function getCase(db: Db, orgId: string, caseId: string): CaseRow {
  const c = db.select().from(cpgCases).where(and(eq(cpgCases.id, caseId), eq(cpgCases.orgId, orgId))).get();
  // Cross-org ids are 404, never 403 (§9.1).
  if (!c) throw notFound('Case');
  return c;
}

/** The open case of (org, repo, branch), if any (§5.1: at most one). */
export function findOpenCase(db: Db, key: CaseKey): CaseRow | undefined {
  return db.select().from(cpgCases)
    .where(and(eq(cpgCases.orgId, key.orgId), eq(cpgCases.repo, key.repo), eq(cpgCases.branch, key.branch), isNull(cpgCases.closedAt))).get();
}

/** A case that still accepts writes (§5.7: 409 case_closed otherwise). */
export function openCase(db: Db, orgId: string, caseId: string): CaseRow {
  const c = getCase(db, orgId, caseId);
  if (c.closedAt) throw new CpgError(409, 'case_closed', 'The case is closed');
  return c;
}

/** Every fingerprint must be a finding of the case's latest revision (422 unknown_fingerprint). */
export function assertLatestFingerprints(db: Db, caseId: string, fingerprints: readonly string[]): void {
  const known = new Set(latestFindings(db, caseId).map((f) => f.fingerprint));
  const unknown = fingerprints.filter((fp) => !known.has(fp));
  if (unknown.length > 0) throw new CpgError(422, 'unknown_fingerprint', 'Not a finding of the latest revision', { fingerprints: unknown });
}

/** §5.4: sha256 of the sorted fingerprints joined with newlines. */
export function findingsDigest(fingerprints: readonly string[]): string {
  return sha256Hex([...fingerprints].sort().join('\n'));
}

/** Blocking (§5.2): tier review-required or prohibited, and enforced at revision time. */
export function isBlocking(f: Pick<CaseFindingRow, 'tier' | 'enforced'>): boolean {
  return f.tier !== 'advisory' && f.enforced;
}

export function latestRevision(db: Db, caseId: string): RevisionRow | undefined {
  return db.select().from(cpgCaseRevisions).where(eq(cpgCaseRevisions.caseId, caseId))
    .orderBy(desc(cpgCaseRevisions.revision)).limit(1).get();
}

export function latestFindings(db: Db, caseId: string): CaseFindingRow[] {
  const latest = latestRevision(db, caseId);
  if (!latest) return [];
  return db.select().from(cpgCaseFindings).where(eq(cpgCaseFindings.revisionId, latest.id)).all();
}

/**
 * The open case for (org, repo, branch), created when there is none (§5.1).
 * A new case after a closed one records the closed case as `previousCaseId`.
 */
export function findOrCreateCase(db: Db, key: CaseKey, actor: string): { case: CaseRow; created: boolean } {
  const sameBranch = and(eq(cpgCases.orgId, key.orgId), eq(cpgCases.repo, key.repo), eq(cpgCases.branch, key.branch));
  return rawSqlite(db).transaction(() => {
    const open = findOpenCase(db, key);
    if (open) return { case: open, created: false };

    const previous = db.select({ id: cpgCases.id }).from(cpgCases).where(and(sameBranch, isNotNull(cpgCases.closedAt)))
      .orderBy(desc(cpgCases.closedAt)).limit(1).get();
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: CaseRow = {
      id, orgId: key.orgId, ref: `CPG-${id.slice(0, 8).toUpperCase()}`, repo: key.repo, branch: key.branch, prNumber: null,
      state: 'open', closeReason: null, latestRevision: 0, openedBy: actor, openedAt: now,
      closedAt: null, closedBy: null, closureSignature: null, updatedAt: now,
    };
    db.insert(cpgCases).values(row).run();
    addCaseEvent(db, row, 'opened', actor, previous ? { previousCaseId: previous.id } : {}, now);
    return { case: row, created: true };
  }).immediate();
}

/**
 * Snapshot the branch's findings as a new revision (§5.4). Idempotent: when
 * the findings digest equals the latest revision's, nothing is written and
 * the latest revision is returned. The case state is then re-derived.
 */
export function addRevision(db: Db, orgId: string, caseId: string, input: RevisionInput, actor: string): RevisionResult {
  return rawSqlite(db).transaction((): RevisionResult => {
    const c = openCase(db, orgId, caseId);
    const now = new Date().toISOString();
    const findings = resolveFindings(db, orgId, input.findings, now);

    const digest = findingsDigest(findings.map((f) => f.fingerprint));
    const latest = latestRevision(db, caseId);
    if (latest?.findingsDigest === digest) return { revision: latest, revisionCreated: false };

    const previous = new Set(latest ? latestFindings(db, caseId).map((f) => f.fingerprint) : []);
    const current = new Set(findings.map((f) => f.fingerprint));
    const addedCount = [...current].filter((fp) => !previous.has(fp)).length;
    const revision: RevisionRow = {
      id: randomUUID(), caseId, orgId, revision: c.latestRevision + 1, source: input.source, headSha: input.headSha,
      bundleHash: input.bundleHash, findingsDigest: digest,
      addedCount, carriedCount: current.size - addedCount, resolvedCount: [...previous].filter((fp) => !current.has(fp)).length,
      createdBy: actor, createdAt: now,
    };
    db.insert(cpgCaseRevisions).values(revision).run();
    for (const f of findings) {
      db.insert(cpgCaseFindings).values({
        ...f, id: randomUUID(), revisionId: revision.id, caseId, orgId,
        statusAtRevision: previous.has(f.fingerprint) ? 'carried' : 'new', createdAt: now,
      }).run();
    }
    db.update(cpgCases).set({ latestRevision: revision.revision, updatedAt: now }).where(eq(cpgCases.id, caseId)).run();
    addCaseEvent(db, c, 'revision_added', actor, {
      revisionId: revision.id, revision: revision.revision,
      added: revision.addedCount, carried: revision.carriedCount, resolved: revision.resolvedCount,
    }, now);
    refreshCaseState(db, c, actor, now);
    return { revision, revisionCreated: true };
  }).immediate();
}

// ─── Internals ─────────────────────────────────────────────────────────

type ResolvedFinding = Omit<CaseFindingRow, 'id' | 'revisionId' | 'caseId' | 'orgId' | 'statusAtRevision' | 'createdAt'>;

/** Verify and store each snippet, and bind each finding to its active policy version. */
function resolveFindings(db: Db, orgId: string, findings: readonly RevisionFinding[], now: string): ResolvedFinding[] {
  const locations = new Set<string>();
  const versions = new Map<string, ReturnType<typeof activeVersion>>();
  return findings.map((f) => {
    const location = JSON.stringify([f.fingerprint, f.filePath, f.startLine]);
    if (locations.has(location)) {
      throw new CpgError(422, 'duplicate_finding', 'A finding is listed twice at the same location', { fingerprint: f.fingerprint, filePath: f.filePath, startLine: f.startLine });
    }
    locations.add(location);
    const parsed = parseFingerprint(f.fingerprint);
    if (!parsed) throw new CpgError(422, 'invalid_fingerprint', 'Malformed fingerprint', { fingerprint: f.fingerprint });
    storeSnippet(db, orgId, parsed.snippetHash, f, now);
    const versionKey = `${parsed.policyKey}:${parsed.policyVersion}`;
    const version = versions.get(versionKey) ?? activeVersion(db, orgId, parsed.policyKey, parsed.policyVersion);
    versions.set(versionKey, version);
    return {
      fingerprint: f.fingerprint, snippetHash: parsed.snippetHash,
      policyId: version.policyId, policyVersionId: version.id, policyKey: parsed.policyKey, policyVersion: parsed.policyVersion,
      tier: version.tier, enforced: version.enforceFrom <= now,
      filePath: f.filePath, startLine: f.startLine, endLine: f.endLine, language: f.language,
    };
  });
}

/** §2.3 T22: the server re-hashes every snippet; the stored text is exactly the bytes that were hashed. */
function storeSnippet(db: Db, orgId: string, hash: string, f: RevisionFinding, now: string): void {
  if (f.snippet === undefined) {
    const stored = db.select({ hash: cpgSnippets.snippetHash }).from(cpgSnippets)
      .where(and(eq(cpgSnippets.orgId, orgId), eq(cpgSnippets.snippetHash, hash))).get();
    if (!stored) throw new CpgError(422, 'snippet_required', 'The snippet of this finding is not stored yet; send it', { fingerprint: f.fingerprint });
    return;
  }
  const normalizedText = normalizeSnippet(f.snippet);
  if (sha256Hex(normalizedText) !== hash) {
    throw new CpgError(422, 'snippet_hash_mismatch', 'The snippet does not hash to its fingerprint', { fingerprint: f.fingerprint });
  }
  const lineCount = normalizedText.split('\n').length;
  if (lineCount > MAX_SNIPPET_LINES) {
    throw new CpgError(422, 'snippet_too_long', `A snippet has at most ${MAX_SNIPPET_LINES} lines`, { fingerprint: f.fingerprint });
  }
  db.insert(cpgSnippets).values({ orgId, snippetHash: hash, normalizedText, lineCount, createdAt: now }).onConflictDoNothing().run();
}

/** The org's version `version` of policy `policyKey`, which must be the policy's active version. */
export function activeVersion(db: Db, orgId: string, policyKey: string, version: number) {
  const row = db.select({
    id: cpgPolicyVersions.id, policyId: cpgPolicyVersions.policyId, tier: cpgPolicyVersions.tier,
    state: cpgPolicyHeads.state, activeVersionId: cpgPolicyHeads.activeVersionId, enforceFrom: cpgPolicyHeads.enforceFrom,
  }).from(cpgPolicyVersions)
    .innerJoin(cpgPolicies, eq(cpgPolicies.id, cpgPolicyVersions.policyId))
    .innerJoin(cpgPolicyHeads, eq(cpgPolicyHeads.policyId, cpgPolicyVersions.policyId))
    .where(and(eq(cpgPolicyVersions.orgId, orgId), eq(cpgPolicies.policyKey, policyKey), eq(cpgPolicyVersions.version, version)))
    .get();
  if (!row) throw new CpgError(422, 'unknown_policy_version', `Policy ${policyKey} has no version ${version}`, { policyKey, version });
  // Fail closed: a finding against a superseded or retired version is stale, never silently non-blocking.
  if (row.state !== 'active' || row.activeVersionId !== row.id || !row.enforceFrom) {
    throw new CpgError(422, 'policy_version_not_active', `Version ${version} of ${policyKey} is not the active version; rescan`, { policyKey, version });
  }
  return { id: row.id, policyId: row.policyId, tier: row.tier, enforceFrom: row.enforceFrom };
}

export function addCaseEvent(db: Db, c: Pick<CaseRow, 'id' | 'orgId'>, event: CaseEvent, actor: string, details: Record<string, unknown>, createdAt: string): void {
  const { seq } = db.select({ seq: sql<number>`coalesce(max(${cpgCaseEvents.seq}), 0) + 1` })
    .from(cpgCaseEvents).where(eq(cpgCaseEvents.caseId, c.id)).get()!;
  db.insert(cpgCaseEvents).values({ id: randomUUID(), caseId: c.id, orgId: c.orgId, seq, event, actor, details: canonicalJson(details), createdAt }).run();
}

/**
 * The case's change requests that no later revision or resubmit cleared
 * (§5.3 row 5), each with whether a reply marked it resolved. Derived from
 * the append-only case events, so resolving one is never a mutation.
 */
export function openChangeRequests(db: Db, caseId: string): Map<string, { resolved: boolean }> {
  const open = new Map<string, { resolved: boolean }>();
  const events = db.select({ event: cpgCaseEvents.event, details: cpgCaseEvents.details }).from(cpgCaseEvents)
    .where(eq(cpgCaseEvents.caseId, caseId)).orderBy(asc(cpgCaseEvents.seq)).all();
  for (const { event, details } of events) {
    const d = JSON.parse(details) as { commentId?: string; threadId?: string; resolves?: boolean; via?: string };
    if (event === 'changes_requested') open.set(d.commentId!, { resolved: false });
    else if (event === 'comment_added' && d.resolves === true && open.has(d.threadId!)) open.set(d.threadId!, { resolved: true });
    else if (event === 'revision_added' || (event === 'submitted' && d.via === 'resubmit')) open.clear();
  }
  return open;
}

/** The §7.4 cover of each fingerprint of the case's latest revision, located by its findings there. */
export function caseCover(db: Db, c: Pick<CaseRow, 'orgId' | 'repo' | 'branch'>, findings: readonly CaseFindingRow[], now: string): Map<string, Cover> {
  const located = findings.map((f) => ({ ...f, repo: c.repo, branch: c.branch }));
  return coverFindings(db, c.orgId, findings.map((f) => f.fingerprint), located, c.repo, now);
}

/** The blocking fingerprints of the latest revision that no current decision or standing exception settles (§5.2). */
export function undecidedBlocking(db: Db, c: Pick<CaseRow, 'id' | 'orgId' | 'repo' | 'branch'>, now: string): Set<string> {
  const blocking = latestFindings(db, c.id).filter(isBlocking);
  const cover = caseCover(db, c, blocking, now);
  return new Set(blocking.map((f) => f.fingerprint).filter((fp) => !settled(cover.get(fp))));
}

/** The facts of §5.2 over the latest revision. */
function caseFacts(db: Db, c: CaseRow, now: string): CaseFacts {
  const undecided = undecidedBlocking(db, c, now);
  const justified = new Set(db.selectDistinct({ fingerprint: cpgJustifications.fingerprint }).from(cpgJustifications)
    .where(eq(cpgJustifications.caseId, c.id)).all().map((r) => r.fingerprint));
  return {
    blockingUndecided: undecided.size,
    unjustified: [...undecided].filter((fp) => !justified.has(fp)).length,
    openChangeRequests: openChangeRequests(db, c.id).size,
  };
}

/**
 * Attach the case to its pull request (§5.4): `pr_attached` the first time,
 * `pr_changed {from, to}` when the number differs. The CI evaluate route and
 * the GitHub App call it; a closed case refuses it.
 */
export function attachPullRequest(db: Db, orgId: string, caseId: string, prNumber: number, actor: string): CaseRow {
  return rawSqlite(db).transaction((): CaseRow => {
    const c = openCase(db, orgId, caseId);
    if (c.prNumber === prNumber) return c;
    const now = new Date().toISOString();
    db.update(cpgCases).set({ prNumber, updatedAt: now }).where(eq(cpgCases.id, caseId)).run();
    addCaseEvent(db, c, c.prNumber === null ? 'pr_attached' : 'pr_changed', actor,
      c.prNumber === null ? { prNumber } : { from: c.prNumber, to: prNumber }, now);
    return getCase(db, orgId, caseId);
  }).immediate();
}

/** Re-derive the projected state (§5.2) and record the move, refusing any §5.3 forbids. True when the state moved. */
export function refreshCaseState(db: Db, c: CaseRow, actor: string, now: string): boolean {
  const to = deriveCaseState(caseFacts(db, c, now));
  if (to === c.state) return false;
  assertTransition(c.state, to);
  db.update(cpgCases).set({ state: to, updatedAt: now }).where(eq(cpgCases.id, c.id)).run();
  addCaseEvent(db, c, 'state_changed', actor, { from: c.state, to }, now);
  return true;
}

/**
 * Re-derive every open case a decision change can affect: those of `orgId`
 * (every org when null) whose latest revision has a finding of
 * `policyVersionId` (any when omitted). Returns how many moved.
 */
export function refreshOpenCases(db: Db, orgId: string | null, actor: string, now: string, policyVersionId?: string): number {
  const rows = db.selectDistinct({ kase: cpgCases }).from(cpgCases)
    .innerJoin(cpgCaseRevisions, and(eq(cpgCaseRevisions.caseId, cpgCases.id), eq(cpgCaseRevisions.revision, cpgCases.latestRevision)))
    .innerJoin(cpgCaseFindings, eq(cpgCaseFindings.revisionId, cpgCaseRevisions.id))
    .where(and(isNull(cpgCases.closedAt), orgId ? eq(cpgCases.orgId, orgId) : undefined,
      policyVersionId ? eq(cpgCaseFindings.policyVersionId, policyVersionId) : undefined)).all();
  return rows.filter(({ kase }) => refreshCaseState(db, kase, actor, now)).length;
}
