import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { cpgBoards } from '../../db/schema-cpg.js';
import {
  compileRecordResponseSchema, policyDetailResponseSchema, policyExportResponseSchema, policyHeadResponseSchema,
  type CompileRecordResponse, type PolicyDetailResponse, type PolicyExportResponse, type PolicyHeadResponse,
  type PolicyVersionResponse,
} from '../contracts.js';
import { currentQuorum, listQuorumVersions } from '../quorum/store.js';
import type { CompileRecordRow } from './compile.js';
import {
  boardIdsOf, compileRecordsFor, eventsOf, getHead, getPolicy, listHeads, statusOf, userNames, versionsOf, votesOf,
  type EventRow, type HeadRow, type PolicyRow, type PolicyState, type VersionRow,
} from './service.js';
import { contentHashOf, cpgSign, exportSignedText, POLICY_EXPORT_KIND } from './signing.js';

/**
 * Serializers for the policy registry responses. Each result is parsed with
 * its zod contract before it leaves the engine, so the contract is enforced.
 */

export function serializeCompileRecord(r: CompileRecordRow): CompileRecordResponse {
  const json = (text: string | null) => (text ? JSON.parse(text) : null);
  return compileRecordResponseSchema.parse({
    id: r.id, policyId: r.policyId, requestedBy: r.requestedBy, status: r.status, inputText: r.inputText, inputHash: r.inputHash,
    promptVersion: r.promptVersion, provider: r.provider, model: r.model, rejection: json(r.rejection), suggestion: json(r.suggestion),
    compiledRule: json(r.compiledRule), compiledRuleHash: r.compiledRuleHash, examples: JSON.parse(r.examples),
    exampleResults: json(r.exampleResults), tokensIn: r.tokensIn, tokensOut: r.tokensOut, createdAt: r.createdAt,
  });
}

function boardNames(db: Db, versions: VersionRow[]): Map<string, string> {
  const ids = [...new Set(versions.flatMap(boardIdsOf))];
  if (ids.length === 0) return new Map();
  return new Map(db.select({ id: cpgBoards.id, name: cpgBoards.name }).from(cpgBoards).where(inArray(cpgBoards.id, ids)).all().map((b) => [b.id, b.name]));
}

const owningBoardsOf = (v: VersionRow, names: Map<string, string>) => boardIdsOf(v).map((id) => ({ id, name: names.get(id) ?? '' }));

function serializeVersion(v: VersionRow, events: EventRow[], names: Map<string, string>): PolicyVersionResponse {
  const own = events.filter((e) => e.versionId === v.id);
  const effect = own.find((e) => e.event === 'activated' || e.event === 'retired');
  const d = effect ? JSON.parse(effect.details) as { enforceFrom?: string; activatedAt?: string; retiredAt?: string; signature?: string } : null;
  return {
    id: v.id, version: v.version, kind: v.kind, status: statusOf(own), title: v.title, plainText: v.plainText, tier: v.tier,
    owningBoards: owningBoardsOf(v, names), rule: v.rule ? JSON.parse(v.rule) : null, ruleHash: v.ruleHash,
    compileRecordId: v.compileRecordId, editedFromCompile: v.editedFromCompile, graceDays: v.graceDays,
    enforceFromRequested: v.enforceFromRequested, enforceFrom: d?.enforceFrom ?? null, activatedAt: d?.activatedAt ?? d?.retiredAt ?? null,
    signature: d?.signature ?? null, createdBy: v.createdBy, createdAt: v.createdAt,
  };
}

function serializeHeadWith(policy: PolicyRow, head: HeadRow, versions: VersionRow[], names: Map<string, string>, now = Date.now()): PolicyHeadResponse {
  const shown = versions.find((v) => v.id === head.activeVersionId) ?? versions[versions.length - 1];
  const pending = versions.find((v) => v.id === head.pendingVersionId) ?? null;
  return policyHeadResponseSchema.parse({
    policyId: policy.id, policyKey: policy.policyKey, state: head.state, title: shown.title, tier: shown.tier,
    owningBoards: owningBoardsOf(shown, names), activeVersion: head.activeVersion, enforceFrom: head.enforceFrom,
    inGracePeriod: head.state === 'active' && !!head.enforceFrom && Date.parse(head.enforceFrom) > now,
    pendingVersionId: head.pendingVersionId, pendingVersion: pending?.version ?? null, pendingVersionKind: pending?.kind ?? null,
    latestVersion: versions[versions.length - 1].version, createdAt: policy.createdAt, createdBy: policy.createdBy, updatedAt: head.updatedAt,
  });
}

export function serializeHeads(db: Db, orgId: string, state?: PolicyState): PolicyHeadResponse[] {
  return listHeads(db, orgId, state).map(({ head, policy }) => {
    const versions = versionsOf(db, policy.id);
    return serializeHeadWith(policy, head, versions, boardNames(db, versions));
  });
}

interface PolicyHistory {
  versions: PolicyVersionResponse[];
  events: PolicyDetailResponse['events'];
  votes: PolicyDetailResponse['votes'];
}

function historyOf(db: Db, versions: VersionRow[], names: Map<string, string>): PolicyHistory {
  const ids = versions.map((v) => v.id);
  const events = eventsOf(db, ids);
  const votes = votesOf(db, ids);
  const voters = userNames(db, votes.map((v) => v.voterUserId));
  const number = new Map(versions.map((v) => [v.id, v.version]));
  return {
    versions: versions.map((v) => serializeVersion(v, events, names)),
    events: events.map((e) => ({
      id: e.id, versionId: e.versionId, version: number.get(e.versionId)!, event: e.event, actor: e.actor,
      details: JSON.parse(e.details) as Record<string, unknown>, createdAt: e.createdAt,
    })),
    votes: votes.map((v) => ({
      id: v.id, versionId: v.versionId, voterUserId: v.voterUserId, voterName: voters.get(v.voterUserId) ?? '',
      vote: v.vote, comment: v.comment, quorumConfigVersion: v.quorumConfigVersion, createdAt: v.createdAt,
    })),
  };
}

export function serializePolicyDetail(db: Db, orgId: string, policyId: string): PolicyDetailResponse {
  const policy = getPolicy(db, orgId, policyId);
  const head = getHead(db, policyId);
  const versions = versionsOf(db, policyId);
  const names = boardNames(db, versions);
  const history = historyOf(db, versions, names);
  const compileIds = versions.map((v) => v.compileRecordId).filter((x): x is string => !!x);
  return policyDetailResponseSchema.parse({
    policy: serializeHeadWith(policy, head, versions, names),
    ...history,
    compileRecords: compileRecordsFor(db, orgId, compileIds),
    requiredApprovals: currentQuorum(db, orgId).config.policyApproval.approvals,
  });
}

/**
 * The signed policy-log export (E39): every policy with all its versions,
 * events (including activation signatures) and votes, and the signed quorum
 * versions, under one export signature an auditor can verify offline.
 */
export function buildPolicyExport(db: Db, orgId: string): PolicyExportResponse {
  const policies = listHeads(db, orgId).map(({ policy }) => {
    const versions = versionsOf(db, policy.id);
    const history = historyOf(db, versions, boardNames(db, versions));
    return { policyId: policy.id, policyKey: policy.policyKey, createdAt: policy.createdAt, createdBy: policy.createdBy, ...history };
  });
  const quorumVersions = listQuorumVersions(db, orgId).map((q) => ({
    version: q.version, configHash: q.configHash, changeNote: q.changeNote, createdAt: q.createdAt, createdBy: q.createdBy, signature: q.signature,
  }));
  const content = { policies, quorumVersions };
  const exportedAt = new Date().toISOString();
  const contentHash = contentHashOf(content);
  return policyExportResponseSchema.parse({
    kind: POLICY_EXPORT_KIND, orgId, exportedAt, content, contentHash,
    signature: cpgSign(exportSignedText({ kind: POLICY_EXPORT_KIND, orgId, exportedAt, contentHash })),
  });
}
