import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { canonicalJson, corporateRuleSchema, ruleHashOf, validateCorporateRule, type CorporateRule } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import {
  cpgBoards, cpgCompileRecords, cpgPolicies, cpgPolicyApprovals, cpgPolicyHeads, cpgPolicyVersionEvents, cpgPolicyVersions,
} from '../../db/schema-cpg.js';
import { users } from '../../db/schema.js';
import { appendAuditEvent } from '../audit/log.js';
import { CpgError, notFound } from '../errors.js';
import { currentQuorum } from '../quorum/store.js';
import { verifyExamples, type CompileRequest } from './compile.js';
import { activationSignedText, cpgSign, retirementSignedText } from './signing.js';

/**
 * The corporate policy log (design spec §8.5): proposals, four-eyes
 * approval, activation with a grace period, retirement, and the heads
 * projection. Versions (T15), their lifecycle events (T16) and votes (T17)
 * are append-only; cpg_policy_heads (T18) is a projection updated only in the
 * transaction that writes the matching event, and rebuildHeads() recomputes
 * it from the log.
 *
 * Self-approval is impossible: the version's author and the compile
 * requester are refused here (403 self_approval_forbidden) and by the
 * trg_cpg_policy_approvals_four_eyes trigger.
 */

const DAY_MS = 86_400_000;

export type Tier = 'advisory' | 'review-required' | 'prohibited';
export type PolicyState = 'draft' | 'proposed' | 'active' | 'retired';
export type VersionStatus = 'pending' | 'active' | 'superseded' | 'rejected' | 'withdrawn' | 'expired' | 'retired';
export type VersionRow = typeof cpgPolicyVersions.$inferSelect;
export type EventRow = typeof cpgPolicyVersionEvents.$inferSelect;
export type HeadRow = typeof cpgPolicyHeads.$inferSelect;
export type PolicyRow = typeof cpgPolicies.$inferSelect;

/** What a policy change means for distribution; the caller invalidates the bundle and notifies after commit. */
export interface ChangeEffect {
  bundleChanged: boolean;
}

// ─── Reads ─────────────────────────────────────────────────────────────

export function getPolicy(db: Db, orgId: string, policyId: string): PolicyRow {
  const p = db.select().from(cpgPolicies).where(and(eq(cpgPolicies.id, policyId), eq(cpgPolicies.orgId, orgId))).get();
  if (!p) throw notFound('Policy');
  return p;
}

export function getHead(db: Db, policyId: string): HeadRow {
  const h = db.select().from(cpgPolicyHeads).where(eq(cpgPolicyHeads.policyId, policyId)).get();
  if (!h) throw new Error(`Policy ${policyId} has no head row`);
  return h;
}

export function getVersion(db: Db, orgId: string, versionId: string): VersionRow {
  const v = db.select().from(cpgPolicyVersions).where(and(eq(cpgPolicyVersions.id, versionId), eq(cpgPolicyVersions.orgId, orgId))).get();
  if (!v) throw notFound('Policy version');
  return v;
}

export function versionsOf(db: Db, policyId: string): VersionRow[] {
  return db.select().from(cpgPolicyVersions).where(eq(cpgPolicyVersions.policyId, policyId)).orderBy(asc(cpgPolicyVersions.version)).all();
}

export function eventsOf(db: Db, versionIds: string[]): EventRow[] {
  if (versionIds.length === 0) return [];
  return db.select().from(cpgPolicyVersionEvents).where(inArray(cpgPolicyVersionEvents.versionId, versionIds))
    // Events of one transaction share a timestamp: insertion order (rowid) breaks the tie.
    .orderBy(asc(cpgPolicyVersionEvents.createdAt), asc(sql`rowid`)).all();
}

export function votesOf(db: Db, versionIds: string[]) {
  if (versionIds.length === 0) return [];
  return db.select().from(cpgPolicyApprovals).where(inArray(cpgPolicyApprovals.versionId, versionIds))
    .orderBy(asc(cpgPolicyApprovals.createdAt), asc(sql`rowid`)).all();
}

const STATUS_BY_EVENT: Record<EventRow['event'], VersionStatus> = {
  proposed: 'pending',
  approved: 'active',
  activated: 'active',
  superseded: 'superseded',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  expired_proposal: 'expired',
  retired: 'retired',
};

/** A version's status: the meaning of its latest lifecycle event. */
export function statusOf(events: EventRow[]): VersionStatus {
  const last = events[events.length - 1];
  return last ? STATUS_BY_EVENT[last.event] : 'pending';
}

export function boardIdsOf(v: Pick<VersionRow, 'owningBoardIds'>): string[] {
  return JSON.parse(v.owningBoardIds) as string[];
}

/** Policy keys whose active or pending version names this board as an owner (archiving is refused while any exist). */
export function policiesOwnedByBoard(db: Db, orgId: string, boardId: string): string[] {
  const rows = rawSqlite(db).prepare(`
    SELECT DISTINCT p.policy_key AS key FROM cpg_policy_heads h
    JOIN cpg_policies p ON p.id = h.policy_id
    JOIN cpg_policy_versions v ON (v.id = h.pending_version_id OR (h.state = 'active' AND v.id = h.active_version_id))
    WHERE h.org_id = ? AND EXISTS (SELECT 1 FROM json_each(v.owning_board_ids) j WHERE j.value = ?)
    ORDER BY 1
  `).all(orgId, boardId) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

// ─── Writes: helpers ───────────────────────────────────────────────────

function addEvent(db: Db, orgId: string, versionId: string, event: EventRow['event'], actor: string, details: Record<string, unknown>, createdAt = new Date().toISOString()): EventRow {
  const row: EventRow = { id: randomUUID(), versionId, orgId, event, actor, details: canonicalJson(details), createdAt };
  db.insert(cpgPolicyVersionEvents).values(row).run();
  return row;
}

function setHead(db: Db, policyId: string, patch: Partial<Omit<HeadRow, 'policyId' | 'orgId'>>): void {
  db.update(cpgPolicyHeads).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(cpgPolicyHeads.policyId, policyId)).run();
}

/** State of a head once its pending version is gone. */
function settledState(head: HeadRow): PolicyState {
  if (head.state === 'retired') return 'retired';
  return head.activeVersionId ? 'active' : 'draft';
}

function validateBoards(db: Db, orgId: string, ids: string[]): string[] {
  const unique = [...new Set(ids)].sort();
  const rows = db.select({ id: cpgBoards.id }).from(cpgBoards)
    .where(and(eq(cpgBoards.orgId, orgId), inArray(cpgBoards.id, unique), isNull(cpgBoards.archivedAt))).all();
  const found = new Set(rows.map((r) => r.id));
  const unknown = unique.filter((id) => !found.has(id));
  if (unknown.length > 0) throw new CpgError(422, 'unknown_board', 'Every owning board must be an active board of this organization', { boardIds: unknown });
  return unique;
}

function lapsedAt(version: VersionRow, lapseDays: number): number {
  return Date.parse(version.createdAt) + lapseDays * DAY_MS;
}

/**
 * Expire the pending version of a policy when its proposal has lapsed
 * (quorum `proposalLapseDays`). Checked lazily on every action that touches
 * the pending version.
 */
function expireIfLapsed(db: Db, orgId: string, head: HeadRow, now: number): boolean {
  if (!head.pendingVersionId) return false;
  const version = getVersion(db, orgId, head.pendingVersionId);
  const lapseDays = currentQuorum(db, orgId).config.proposalLapseDays;
  if (now < lapsedAt(version, lapseDays)) return false;
  addEvent(db, orgId, version.id, 'expired_proposal', 'system:lapse', { lapseDays });
  setHead(db, head.policyId, { state: settledState(head), pendingVersionId: null });
  appendAuditEvent(db, { orgId, actor: 'system:lapse', action: 'policy.proposal_expired', targetType: 'policy_version', targetId: version.id, payload: { policyId: head.policyId, version: version.version, lapseDays } });
  return true;
}

/** Leaf-level differences between two JSON values, for the `proposed` event of an edited rule. */
export function jsonDiff(before: unknown, after: unknown, path = ''): Array<{ path: string; before: unknown; after: unknown }> {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => jsonDiff(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((b, i) => jsonDiff(b, after[i], `${path}[${i}]`));
  }
  return canonicalJson({ v: before }) === canonicalJson({ v: after }) ? [] : [{ path: path || '(root)', before: before ?? null, after: after ?? null }];
}

// ─── Propose ───────────────────────────────────────────────────────────

export interface ProposeInput {
  orgId: string;
  actorUserId: string;
  /** Set for a new version of an existing policy; absent for a new policy. */
  policyId?: string;
  policyKey?: string;
  compileRecordId: string;
  title: string;
  tier: Tier;
  owningBoardIds: string[];
  rule?: unknown;
  graceDays?: number;
  enforceFrom?: string;
}

/**
 * Propose a new policy (E32) or a new version (E34) from a successful compile
 * record. An edited rule is re-validated and re-checked against the compile
 * record's examples before it is accepted.
 */
export async function proposeVersion(db: Db, input: ProposeInput): Promise<{ policyId: string; versionId: string }> {
  const actor = `user:${input.actorUserId}`;
  const { orgId } = input;
  const record = db.select().from(cpgCompileRecords).where(and(eq(cpgCompileRecords.id, input.compileRecordId), eq(cpgCompileRecords.orgId, orgId))).get();
  if (!record) throw notFound('Compile record');
  if (record.status !== 'compiled' || !record.compiledRule) {
    throw new CpgError(422, 'compile_not_successful', `The compile record has status ${record.status}; only a compiled record can be proposed`);
  }
  if (input.policyId && record.policyId && record.policyId !== input.policyId) {
    throw new CpgError(422, 'compile_policy_mismatch', 'The compile record was made for another policy');
  }
  if (!input.policyId && record.policyId) {
    throw new CpgError(422, 'compile_policy_mismatch', 'The compile record was made for an existing policy; propose it as a new version of that policy');
  }
  if (input.enforceFrom && Date.parse(input.enforceFrom) < Date.now()) {
    throw new CpgError(422, 'enforce_from_in_past', 'enforceFrom must not be in the past');
  }

  const compiled = corporateRuleSchema.parse(JSON.parse(record.compiledRule));
  let rule: CorporateRule = compiled;
  let edited = false;
  let diff: ReturnType<typeof jsonDiff> = [];
  if (input.rule !== undefined) {
    const validation = validateCorporateRule(input.rule);
    if (!validation.ok) throw new CpgError(422, 'rule_validation_failed', 'The edited rule is not valid', { reasons: validation.reasons });
    if (ruleHashOf(validation.rule) !== ruleHashOf(compiled)) {
      const examples = JSON.parse(record.examples) as CompileRequest['examples'];
      const check = await verifyExamples(validation.rule, examples);
      if (!check.passed) throw new CpgError(422, 'rule_examples_failed', "The edited rule does not satisfy the compile record's examples", { exampleResults: check.results });
      rule = validation.rule;
      edited = true;
      diff = jsonDiff(compiled, rule);
    }
  }

  return rawSqlite(db).transaction(() => {
    const boards = validateBoards(db, orgId, input.owningBoardIds);
    const now = new Date().toISOString();
    let policyId = input.policyId;
    let versionNumber = 1;
    if (policyId) {
      getPolicy(db, orgId, policyId);
      const head = getHead(db, policyId);
      if (head.state === 'retired') throw new CpgError(409, 'policy_retired', 'The policy is retired');
      expireIfLapsed(db, orgId, head, Date.now());
      if (getHead(db, policyId).pendingVersionId) throw new CpgError(409, 'version_pending', 'The policy already has a pending version');
      versionNumber = (versionsOf(db, policyId).at(-1)?.version ?? 0) + 1;
    } else {
      const key = input.policyKey!;
      const taken = db.select({ id: cpgPolicies.id }).from(cpgPolicies).where(and(eq(cpgPolicies.orgId, orgId), eq(cpgPolicies.policyKey, key))).get();
      if (taken) throw new CpgError(409, 'policy_key_taken', `A policy with key "${key}" already exists`);
      policyId = randomUUID();
      db.insert(cpgPolicies).values({ id: policyId, orgId, policyKey: key, createdBy: actor, createdAt: now, originCaseId: null }).run();
      db.insert(cpgPolicyHeads).values({
        policyId, orgId, state: 'draft', activeVersionId: null, activeVersion: null, enforceFrom: null,
        activationSignature: null, pendingVersionId: null, updatedAt: now,
      }).run();
    }
    const used = db.select({ id: cpgPolicyVersions.id }).from(cpgPolicyVersions).where(eq(cpgPolicyVersions.compileRecordId, record.id)).get();
    if (used) throw new CpgError(409, 'compile_record_used', 'This compile record already backs a policy version');

    const version: VersionRow = {
      id: randomUUID(), policyId, orgId, version: versionNumber, kind: 'define', title: input.title, plainText: record.inputText,
      tier: input.tier, owningBoardIds: JSON.stringify(boards), rule: canonicalJson(rule), ruleHash: ruleHashOf(rule),
      compileRecordId: record.id, editedFromCompile: edited, graceDays: input.graceDays ?? null,
      enforceFromRequested: input.enforceFrom ?? null, createdBy: actor, createdAt: now,
    };
    db.insert(cpgPolicyVersions).values(version).run();
    addEvent(db, orgId, version.id, 'proposed', actor, {
      compileRecordId: record.id, compiledRuleHash: record.compiledRuleHash, ruleHash: version.ruleHash,
      editedFromCompile: edited, ruleDiff: diff,
    }, now);
    const head = getHead(db, policyId);
    setHead(db, policyId, { state: head.state === 'active' ? 'active' : 'proposed', pendingVersionId: version.id });
    appendAuditEvent(db, {
      orgId, actor, action: 'policy.version_proposed', targetType: 'policy_version', targetId: version.id,
      payload: { policyId, version: versionNumber, tier: input.tier, owningBoardIds: boards, ruleHash: version.ruleHash, editedFromCompile: edited },
    });
    return { policyId, versionId: version.id };
  })();
}

/** Propose retiring an active policy (E35): a `retire` version through the same four-eyes approval. */
export function proposeRetirement(db: Db, input: { orgId: string; actorUserId: string; policyId: string; reason: string }): { versionId: string } {
  const actor = `user:${input.actorUserId}`;
  const { orgId, policyId } = input;
  return rawSqlite(db).transaction(() => {
    getPolicy(db, orgId, policyId);
    const head = getHead(db, policyId);
    if (head.state !== 'active' || !head.activeVersionId) throw new CpgError(409, 'policy_not_active', 'Only an active policy can be retired');
    expireIfLapsed(db, orgId, head, Date.now());
    if (getHead(db, policyId).pendingVersionId) throw new CpgError(409, 'version_pending', 'The policy already has a pending version');
    const active = getVersion(db, orgId, head.activeVersionId);
    const now = new Date().toISOString();
    const version: VersionRow = {
      id: randomUUID(), policyId, orgId, version: (versionsOf(db, policyId).at(-1)?.version ?? 0) + 1, kind: 'retire',
      title: active.title, plainText: input.reason, tier: active.tier, owningBoardIds: active.owningBoardIds, rule: null, ruleHash: null,
      compileRecordId: null, editedFromCompile: false, graceDays: null, enforceFromRequested: null, createdBy: actor, createdAt: now,
    };
    db.insert(cpgPolicyVersions).values(version).run();
    addEvent(db, orgId, version.id, 'proposed', actor, { kind: 'retire', reason: input.reason }, now);
    setHead(db, policyId, { pendingVersionId: version.id });
    appendAuditEvent(db, { orgId, actor, action: 'policy.retirement_proposed', targetType: 'policy_version', targetId: version.id, payload: { policyId, version: version.version } });
    return { versionId: version.id };
  })();
}

// ─── Vote, activate, withdraw ──────────────────────────────────────────

export interface VoteResult {
  /** null when the proposal had lapsed: it is now expired and no vote was recorded. */
  voteId: string | null;
  status: VersionStatus;
  effect: ChangeEffect;
}

/**
 * Cast a vote on a pending version (E36). The caller must hold
 * policy.approve (checked by the route). Four-eyes: the author and the
 * compile requester are refused. One reject rejects the version; the
 * configured number of approvals activates it in the same transaction.
 */
export function castVote(db: Db, input: { orgId: string; voterUserId: string; versionId: string; vote: 'approve' | 'reject'; comment: string }): VoteResult {
  const { orgId, voterUserId, versionId } = input;
  const actor = `user:${voterUserId}`;
  return rawSqlite(db).transaction(() => {
    const version = getVersion(db, orgId, versionId);
    const head = getHead(db, version.policyId);
    if (head.pendingVersionId !== version.id) throw new CpgError(409, 'proposal_not_pending', 'The version is not pending approval');
    if (expireIfLapsed(db, orgId, head, Date.now())) {
      return { voteId: null, status: 'expired' as VersionStatus, effect: { bundleChanged: false } };
    }
    const requester = version.compileRecordId
      ? db.select({ by: cpgCompileRecords.requestedBy }).from(cpgCompileRecords).where(eq(cpgCompileRecords.id, version.compileRecordId)).get()?.by
      : undefined;
    if (version.createdBy === actor || requester === actor) {
      throw new CpgError(403, 'self_approval_forbidden', 'You cannot vote on a policy version you proposed or compiled');
    }
    const prior = db.select({ id: cpgPolicyApprovals.id }).from(cpgPolicyApprovals)
      .where(and(eq(cpgPolicyApprovals.versionId, versionId), eq(cpgPolicyApprovals.voterUserId, voterUserId))).get();
    if (prior) throw new CpgError(409, 'already_voted', 'You have already voted on this version');

    const quorum = currentQuorum(db, orgId);
    const voteRow = {
      id: randomUUID(), versionId, orgId, voterUserId, vote: input.vote, comment: input.comment,
      quorumConfigVersion: quorum.version, createdAt: new Date().toISOString(),
    };
    db.insert(cpgPolicyApprovals).values(voteRow).run();
    appendAuditEvent(db, {
      orgId, actor, action: 'policy.vote_cast', targetType: 'policy_version', targetId: versionId,
      payload: { policyId: version.policyId, version: version.version, vote: input.vote, quorumConfigVersion: quorum.version },
    });

    if (input.vote === 'reject') {
      addEvent(db, orgId, versionId, 'rejected', actor, { quorumConfigVersion: quorum.version, voteId: voteRow.id });
      setHead(db, version.policyId, { state: settledState(head), pendingVersionId: null });
      appendAuditEvent(db, { orgId, actor, action: 'policy.version_rejected', targetType: 'policy_version', targetId: versionId, payload: { policyId: version.policyId, version: version.version } });
      return { voteId: voteRow.id, status: 'rejected' as VersionStatus, effect: { bundleChanged: false } };
    }

    const approvals = votesOf(db, [versionId]).filter((v) => v.vote === 'approve');
    if (approvals.length < quorum.config.policyApproval.approvals) {
      return { voteId: voteRow.id, status: 'pending' as VersionStatus, effect: { bundleChanged: false } };
    }
    activate(db, orgId, version, head, quorum.version, approvals.map((a) => a.voterUserId));
    return { voteId: voteRow.id, status: (version.kind === 'retire' ? 'retired' : 'active') as VersionStatus, effect: { bundleChanged: true } };
  })();
}

/** The enforce-from instant (§8.5): requested (never before activation), else activation + grace days. */
export function computeEnforceFrom(activatedAt: string, graceDays: number, requested: string | null): string {
  if (requested) return Date.parse(requested) > Date.parse(activatedAt) ? new Date(Date.parse(requested)).toISOString() : activatedAt;
  return new Date(Date.parse(activatedAt) + graceDays * DAY_MS).toISOString();
}

function activate(db: Db, orgId: string, version: VersionRow, head: HeadRow, quorumVersion: number, approvers: string[]): void {
  const policy = getPolicy(db, orgId, version.policyId);
  const activatedAt = new Date().toISOString();
  addEvent(db, orgId, version.id, 'approved', 'system:quorum', { quorumConfigVersion: quorumVersion, approverUserIds: approvers }, activatedAt);

  if (version.kind === 'retire') {
    const signature = cpgSign(retirementSignedText({ orgId, policyId: policy.id, policyKey: policy.policyKey, version: version.version, retiredAt: activatedAt }));
    addEvent(db, orgId, version.id, 'retired', 'system:quorum', { quorumConfigVersion: quorumVersion, retiredAt: activatedAt, signature }, activatedAt);
    if (head.activeVersionId) addEvent(db, orgId, head.activeVersionId, 'superseded', 'system:quorum', { supersededBy: version.id }, activatedAt);
    setHead(db, policy.id, {
      state: 'retired', activeVersionId: version.id, activeVersion: version.version, enforceFrom: null,
      activationSignature: signature, pendingVersionId: null,
    });
    appendAuditEvent(db, { orgId, actor: 'system:quorum', action: 'policy.retired', targetType: 'policy', targetId: policy.id, payload: { policyKey: policy.policyKey, version: version.version, quorumConfigVersion: quorumVersion } });
    return;
  }

  const config = currentQuorum(db, orgId).config;
  const graceDays = version.graceDays ?? (head.activeVersionId ? config.gracePeriod.newVersionDefaultDays : config.gracePeriod.newPolicyDefaultDays);
  const enforceFrom = computeEnforceFrom(activatedAt, graceDays, version.enforceFromRequested);
  const boardIds = boardIdsOf(version);
  const boards = db.select({ id: cpgBoards.id, name: cpgBoards.name }).from(cpgBoards).where(inArray(cpgBoards.id, boardIds)).all();
  const nameOf = new Map(boards.map((b) => [b.id, b.name]));
  const signature = cpgSign(activationSignedText(orgId, {
    policyId: policy.id, policyKey: policy.policyKey, version: version.version, title: version.title, tier: version.tier,
    owningBoards: boardIds.map((id) => ({ id, name: nameOf.get(id) ?? '' })), enforceFrom, activatedAt, ruleHash: version.ruleHash!,
  }));
  addEvent(db, orgId, version.id, 'activated', 'system:quorum', { quorumConfigVersion: quorumVersion, activatedAt, enforceFrom, graceDays, signature }, activatedAt);
  if (head.activeVersionId) addEvent(db, orgId, head.activeVersionId, 'superseded', 'system:quorum', { supersededBy: version.id }, activatedAt);
  setHead(db, policy.id, {
    state: 'active', activeVersionId: version.id, activeVersion: version.version, enforceFrom,
    activationSignature: signature, pendingVersionId: null,
  });
  appendAuditEvent(db, {
    orgId, actor: 'system:quorum', action: 'policy.activated', targetType: 'policy', targetId: policy.id,
    payload: { policyKey: policy.policyKey, version: version.version, tier: version.tier, enforceFrom, activatedAt, ruleHash: version.ruleHash, quorumConfigVersion: quorumVersion },
  });
}

/** The author withdraws their own pending proposal (E37). */
export function withdrawVersion(db: Db, input: { orgId: string; actorUserId: string; versionId: string }): { policyId: string } {
  const actor = `user:${input.actorUserId}`;
  return rawSqlite(db).transaction(() => {
    const version = getVersion(db, input.orgId, input.versionId);
    if (version.createdBy !== actor) throw new CpgError(403, 'forbidden', 'Only the author can withdraw a proposal', { reason: 'not_author' });
    const head = getHead(db, version.policyId);
    if (head.pendingVersionId !== version.id) throw new CpgError(409, 'proposal_not_pending', 'The version is not pending approval');
    addEvent(db, input.orgId, version.id, 'withdrawn', actor, {});
    setHead(db, version.policyId, { state: settledState(head), pendingVersionId: null });
    appendAuditEvent(db, { orgId: input.orgId, actor, action: 'policy.version_withdrawn', targetType: 'policy_version', targetId: version.id, payload: { policyId: version.policyId, version: version.version } });
    return { policyId: version.policyId };
  })();
}

// ─── Heads projection rebuild ──────────────────────────────────────────

/**
 * Recompute every head of an org from the append-only log (T15 + T16). The
 * stored projection must always equal this; a unit test compares them.
 */
export function rebuildHeads(db: Db, orgId: string): Array<Omit<HeadRow, 'updatedAt'>> {
  const policies = db.select().from(cpgPolicies).where(eq(cpgPolicies.orgId, orgId)).orderBy(asc(cpgPolicies.policyKey)).all();
  return policies.map((p) => {
    const versions = versionsOf(db, p.id);
    const events = eventsOf(db, versions.map((v) => v.id));
    let state: PolicyState = 'draft';
    let activeVersionId: string | null = null;
    let activeVersion: number | null = null;
    let enforceFrom: string | null = null;
    let activationSignature: string | null = null;
    let pendingVersionId: string | null = null;
    const byId = new Map(versions.map((v) => [v.id, v]));
    for (const e of events) {
      const v = byId.get(e.versionId)!;
      const d = JSON.parse(e.details) as Record<string, unknown>;
      if (e.event === 'proposed') {
        pendingVersionId = v.id;
        if (state === 'draft') state = 'proposed';
      } else if (['rejected', 'withdrawn', 'expired_proposal'].includes(e.event)) {
        pendingVersionId = null;
        state = state === 'retired' ? 'retired' : activeVersionId ? 'active' : 'draft';
      } else if (e.event === 'activated') {
        state = 'active'; activeVersionId = v.id; activeVersion = v.version; pendingVersionId = null;
        enforceFrom = d.enforceFrom as string; activationSignature = d.signature as string;
      } else if (e.event === 'retired') {
        state = 'retired'; activeVersionId = v.id; activeVersion = v.version; pendingVersionId = null;
        enforceFrom = null; activationSignature = d.signature as string;
      }
    }
    return { policyId: p.id, orgId, state, activeVersionId, activeVersion, enforceFrom, activationSignature, pendingVersionId };
  });
}

/** The heads of an org, optionally by state, newest first. */
export function listHeads(db: Db, orgId: string, state?: PolicyState) {
  const where = state ? and(eq(cpgPolicyHeads.orgId, orgId), eq(cpgPolicyHeads.state, state)) : eq(cpgPolicyHeads.orgId, orgId);
  return db.select({ head: cpgPolicyHeads, policy: cpgPolicies }).from(cpgPolicyHeads)
    .innerJoin(cpgPolicies, eq(cpgPolicies.id, cpgPolicyHeads.policyId))
    .where(where).orderBy(asc(cpgPolicies.policyKey)).all();
}

/** Display names of users, for votes in the detail view. */
export function userNames(db: Db, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(ids)])).all().map((u) => [u.id, u.name]));
}

/** The latest compile records of an org (newest first), for the detail's compile summary. */
export function compileRecordsFor(db: Db, orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select({ id: cpgCompileRecords.id, status: cpgCompileRecords.status, createdAt: cpgCompileRecords.createdAt, requestedBy: cpgCompileRecords.requestedBy })
    .from(cpgCompileRecords).where(and(eq(cpgCompileRecords.orgId, orgId), inArray(cpgCompileRecords.id, ids)))
    .orderBy(desc(cpgCompileRecords.createdAt)).all();
}
