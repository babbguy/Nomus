import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { organizations } from '../../db/schema.js';
import { cpgBoards, cpgPolicies, cpgPolicyVersions } from '../../db/schema-cpg.js';
import { env } from '../../config/env.js';
import { caseUrl } from '../cases/serialize.js';
import { caseCover, isBlocking, latestFindings, type CaseRow } from '../cases/service.js';
import { boardIdsOf } from '../policies/service.js';

/**
 * The only input to every notification renderer (design spec §12.3, §12.6).
 *
 * Constraint 2: source code never leaves the server. This module is the one
 * producer of notification content, and it reads only identifiers, names,
 * states and counts. It never reads snippets, justifications, comments,
 * reviewer context, policy text or rules, and file paths only to count them.
 * The strict schema is parsed before anything is stored or rendered, so an
 * unknown key cannot reach an email, a Jira issue or a webhook.
 */

type Db = BetterSQLite3Database<any>;

export const CPG_EVENTS = [
  'case.review_requested', 'case.changes_requested', 'case.replied', 'decision.recorded', 'case.closed',
  'exception.expiring', 'exception.expired', 'integration.test',
] as const;
export type CpgEvent = (typeof CPG_EVENTS)[number];

const count = z.number().int().min(0);

export const caseNotificationSummarySchema = z.object({
  event: z.enum(CPG_EVENTS),
  deliveryId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  org: z.object({ id: z.string().uuid(), slug: z.string().max(100), name: z.string().max(200) }).strict(),
  case: z.object({
    id: z.string().uuid(),
    ref: z.string().regex(/^CPG-[0-9A-F]{8}$/),
    // The same bounds as the cpg_cases CHECK constraints.
    repo: z.string().min(3).max(200),
    branch: z.string().min(1).max(255),
    prNumber: z.number().int().positive().nullable(),
    state: z.enum(['open', 'in_review', 'changes_requested', 'decided', 'closed']),
    revision: count,
    url: z.string().url(),
  }).strict().nullable(),
  board: z.object({ id: z.string().uuid(), name: z.string().max(100) }).strict().nullable(),
  counts: z.object({
    blocking: count, advisory: count, approved: count, rejected: count, excepted: count,
    byTier: z.object({ 'review-required': count, prohibited: count }).strict(),
    files: count,
  }).strict().nullable(),
  policies: z.array(z.object({
    key: z.string().max(100), version: z.number().int().positive(), title: z.string().max(120),
    tier: z.enum(['advisory', 'review-required', 'prohibited']),
  }).strict()).max(50),
  decision: z.object({
    id: z.string().uuid(), scope: z.enum(['snippet', 'bulk', 'standing']), outcome: z.enum(['approve', 'reject']),
    expiresAt: z.string().datetime().nullable(), findingCount: count,
  }).strict().nullable(),
  link: z.string().url(),
}).strict();
export type CaseNotificationSummary = z.infer<typeof caseNotificationSummarySchema>;

export interface SummaryInput {
  event: CpgEvent;
  orgId: string;
  case: CaseRow | null;
  boardId: string | null;
  /** Policy versions to list when there is no case (an expiring exception). */
  policyVersionIds?: readonly string[];
  decision?: CaseNotificationSummary['decision'];
  occurredAt: string;
}

const origin = () => env().NOMUS_CORS_ORIGIN.replace(/\/+$/, '');

/** The summary without its delivery id; each delivery adds its own and parses the result. */
export function buildSummary(db: Db, input: SummaryInput): Omit<CaseNotificationSummary, 'deliveryId'> {
  const org = db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
    .from(organizations).where(eq(organizations.id, input.orgId)).get();
  if (!org) throw new Error(`Notification summary: organization ${input.orgId} not found`);
  const board = input.boardId === null ? null
    : db.select({ id: cpgBoards.id, name: cpgBoards.name }).from(cpgBoards).where(eq(cpgBoards.id, input.boardId)).get() ?? null;
  const c = input.case;
  const lane = c ? laneFindings(db, c, input.boardId) : [];
  const versionIds = c ? [...new Set(lane.map((f) => f.policyVersionId))] : [...(input.policyVersionIds ?? [])];
  return {
    event: input.event,
    occurredAt: input.occurredAt,
    org,
    case: c && {
      id: c.id, ref: c.ref, repo: c.repo, branch: c.branch, prNumber: c.prNumber, state: c.state,
      revision: c.latestRevision, url: caseUrl(origin(), c.id),
    },
    board,
    counts: c && laneCounts(db, c, lane, input.occurredAt),
    policies: policySummaries(db, versionIds),
    decision: input.decision ?? null,
    link: c ? caseUrl(origin(), c.id) : `${origin()}/governance/${input.event === 'integration.test' ? 'integrations' : 'exceptions'}`,
  };
}

type Finding = ReturnType<typeof latestFindings>[number];

/** The latest-revision findings of the board's lane (every finding when no board is given). */
function laneFindings(db: Db, c: CaseRow, boardId: string | null): Finding[] {
  const findings = latestFindings(db, c.id);
  if (boardId === null || findings.length === 0) return findings;
  const owners = new Map(db.select({ id: cpgPolicyVersions.id, owningBoardIds: cpgPolicyVersions.owningBoardIds }).from(cpgPolicyVersions)
    .where(inArray(cpgPolicyVersions.id, [...new Set(findings.map((f) => f.policyVersionId))])).all().map((v) => [v.id, boardIdsOf(v)]));
  return findings.filter((f) => owners.get(f.policyVersionId)?.includes(boardId));
}

function laneCounts(db: Db, c: CaseRow, lane: readonly Finding[], now: string): NonNullable<CaseNotificationSummary['counts']> {
  const byFingerprint = new Map(lane.map((f) => [f.fingerprint, f]));
  const distinct = [...byFingerprint.values()];
  const blocking = distinct.filter(isBlocking);
  const cover = caseCover(db, c, lane.filter(isBlocking), now);
  const covered = (status: string) => blocking.filter((f) => cover.get(f.fingerprint)?.status === status).length;
  return {
    blocking: blocking.length,
    advisory: distinct.length - blocking.length,
    approved: covered('approved'),
    rejected: covered('rejected'),
    excepted: covered('excepted'),
    byTier: {
      'review-required': blocking.filter((f) => f.tier === 'review-required').length,
      prohibited: blocking.filter((f) => f.tier === 'prohibited').length,
    },
    // D18: file paths can be sensitive; only their number is sent.
    files: new Set(lane.map((f) => f.filePath)).size,
  };
}

function policySummaries(db: Db, versionIds: readonly string[]): CaseNotificationSummary['policies'] {
  if (versionIds.length === 0) return [];
  return db.select({ key: cpgPolicies.policyKey, version: cpgPolicyVersions.version, title: cpgPolicyVersions.title, tier: cpgPolicyVersions.tier })
    .from(cpgPolicyVersions).innerJoin(cpgPolicies, eq(cpgPolicies.id, cpgPolicyVersions.policyId))
    .where(inArray(cpgPolicyVersions.id, [...versionIds])).all()
    .map((p) => ({ ...p, title: p.title.slice(0, 120) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version)
    .slice(0, 50);
}
