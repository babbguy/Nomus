import type { z } from 'zod';
import api from './client';
import {
  auditListSchema, boardMemberSchema, governanceExportSchema, boardSchema, compileRecordSchema, cpgSettingsSchema, grantSchema, inviteResultSchema,
  listOf, meSchema, orgUserSchema, permissionSchema, policyDetailSchema, policyHeadSchema, roleSchema, teamSchema,
  voteResultSchema,
  type AuditList, type GovernanceExport, type Board, type BoardKind, type BoardMember, type CompileRecord, type CpgMe, type CpgSettings, type Grant,
  type InviteResult, type OrgUser, type Permission, type PolicyDetail, type PolicyHead, type PolicyState, type Role,
  type ScopeType, type Team, type Tier, type VoteResult,
} from './cpg-schemas';
import {
  quorumVersionSchema, quorumVersionSummarySchema,
  type QuorumConfig, type QuorumVersion, type QuorumVersionSummary,
} from './cpg-quorum';

import {
  caseCommentSchema, caseDetailSchema, caseListSchema, caseStatusSchema, castVoteSchema, ciRunListSchema, decisionSchema, proposalListSchema, proposalSchema,
  reviewerContextSchema, revisionDetailSchema, revocationSchema, standingExceptionListSchema,
  type CaseComment, type CaseDetail, type CaseList, type CaseState, type CastVote, type CiRunList, type Decision, type Proposal, type ProposalStatus,
  type ReviewerContext, type RevisionDetail, type StandingException, type StandingPattern,
} from './cpg-case-schemas';
import {
  deliveryListSchema, deliverySchema, integrationSchema, integrationWithSecretSchema,
  type CpgEvent, type Delivery, type DeliveryList, type DeliveryStatus, type Integration, type IntegrationKind, type IntegrationWithSecret,
} from './cpg-integration-schemas';

export * from './cpg-schemas';
export * from './cpg-quorum';
export * from './cpg-case-schemas';
export * from './cpg-integration-schemas';

/**
 * Typed client for the Corporate Policy Governance API (/api/v1/cpg):
 * RBAC, settings and the audit log (E1 to E17); boards, quorum, compile and
 * the policy log (E19 to E37); review cases (E41 to E52); proposals,
 * decisions and standing exceptions (E54 to E60); a case's CI runs (E63); the
 * signed governance audit export (E73). Every response is parsed with its zod
 * contract (cpg-schemas.ts, cpg-quorum.ts); a response that does not match
 * throws CpgContractError, which pages show as a load failure.
 */

/** A response that does not match the documented contract. */
export class CpgContractError extends Error {
  readonly endpoint: string;
  readonly issues: z.ZodIssue[];

  constructor(endpoint: string, issues: z.ZodIssue[]) {
    const first = issues[0];
    const where = first ? ` (${first.path.join('.') || 'body'}: ${first.message})` : '';
    super(`Unexpected response from ${endpoint}${where}`);
    this.name = 'CpgContractError';
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

export function parseResponse<S extends z.ZodTypeAny>(schema: S, data: unknown, endpoint: string): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CpgContractError(endpoint, parsed.error.issues);
  return parsed.data;
}

// ─── E1 me ─────────────────────────────────────────────────────────────

export async function getCpgMe(): Promise<CpgMe> {
  const { data } = await api.get('/cpg/me');
  return parseResponse(meSchema, data, 'GET /cpg/me');
}

// ─── E2 permissions, E3–E6 roles ───────────────────────────────────────

export async function listPermissions(): Promise<Permission[]> {
  const { data } = await api.get('/cpg/permissions');
  return parseResponse(listOf(permissionSchema), data, 'GET /cpg/permissions').items;
}

export async function listRoles(): Promise<Role[]> {
  const { data } = await api.get('/cpg/roles');
  return parseResponse(listOf(roleSchema), data, 'GET /cpg/roles').items;
}

export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string;
  permissions: string[];
}

export async function createRole(input: CreateRoleInput): Promise<Role> {
  const { data } = await api.post('/cpg/roles', input);
  return parseResponse(roleSchema, data, 'POST /cpg/roles');
}

export async function updateRole(id: string, input: { name?: string; description?: string; permissions?: string[] }): Promise<Role> {
  const { data } = await api.patch(`/cpg/roles/${encodeURIComponent(id)}`, input);
  return parseResponse(roleSchema, data, 'PATCH /cpg/roles/:id');
}

export async function archiveRole(id: string): Promise<Role> {
  const { data } = await api.post(`/cpg/roles/${encodeURIComponent(id)}/archive`, {});
  return parseResponse(roleSchema, data, 'POST /cpg/roles/:id/archive');
}

// ─── E7–E11 users and grants ───────────────────────────────────────────

export async function listOrgUsers(): Promise<OrgUser[]> {
  const { data } = await api.get('/cpg/users');
  return parseResponse(listOf(orgUserSchema), data, 'GET /cpg/users').items;
}

export async function inviteOrgUser(input: { email: string; name: string; roleKeys?: string[] }): Promise<InviteResult> {
  const { data } = await api.post('/cpg/users', input);
  return parseResponse(inviteResultSchema, data, 'POST /cpg/users');
}

export async function updateOrgUser(id: string, input: { name?: string; isActive?: boolean }): Promise<OrgUser> {
  const { data } = await api.patch(`/cpg/users/${encodeURIComponent(id)}`, input);
  return parseResponse(orgUserSchema, data, 'PATCH /cpg/users/:id');
}

export interface CreateGrantInput {
  roleId: string;
  scopeType: ScopeType;
  /** Omitted for org; a team id for team; a canonical owner/name for repo. */
  scopeId?: string;
}

export async function createGrant(userId: string, input: CreateGrantInput): Promise<Grant> {
  const body = input.scopeType === 'org'
    ? { roleId: input.roleId, scopeType: 'org' as const }
    : { roleId: input.roleId, scopeType: input.scopeType, scopeId: input.scopeId };
  const { data } = await api.post(`/cpg/users/${encodeURIComponent(userId)}/grants`, body);
  return parseResponse(grantSchema, data, 'POST /cpg/users/:id/grants');
}

export async function revokeGrant(grantId: string, reason: string): Promise<Grant> {
  const { data } = await api.post(`/cpg/grants/${encodeURIComponent(grantId)}/revoke`, { reason });
  return parseResponse(grantSchema, data, 'POST /cpg/grants/:id/revoke');
}

// ─── E12–E14 teams ─────────────────────────────────────────────────────

export async function listTeams(): Promise<Team[]> {
  const { data } = await api.get('/cpg/teams');
  return parseResponse(listOf(teamSchema), data, 'GET /cpg/teams').items;
}

export async function createTeam(input: { key: string; name: string; repoPatterns: string[] }): Promise<Team> {
  const { data } = await api.post('/cpg/teams', input);
  return parseResponse(teamSchema, data, 'POST /cpg/teams');
}

export async function updateTeam(id: string, input: { name?: string; repoPatterns?: string[]; archived?: boolean }): Promise<Team> {
  const { data } = await api.patch(`/cpg/teams/${encodeURIComponent(id)}`, input);
  return parseResponse(teamSchema, data, 'PATCH /cpg/teams/:id');
}

// ─── E15–E16 settings ──────────────────────────────────────────────────

export async function getCpgSettings(): Promise<CpgSettings> {
  const { data } = await api.get('/cpg/settings');
  return parseResponse(cpgSettingsSchema, data, 'GET /cpg/settings');
}

export async function updateCpgSettings(input: { enabled?: boolean; reviewerContextLlm?: boolean }): Promise<CpgSettings> {
  const { data } = await api.patch('/cpg/settings', input);
  return parseResponse(cpgSettingsSchema, data, 'PATCH /cpg/settings');
}

// ─── E17 audit ─────────────────────────────────────────────────────────

export interface AuditQuery {
  action?: string;
  /** ISO-8601 UTC. */
  since?: string;
  /** ISO-8601 UTC. */
  until?: string;
  cursor?: string;
  limit?: number;
}

export function auditQueryString(q: AuditQuery): string {
  const params = new URLSearchParams();
  if (q.action) params.set('action', q.action);
  if (q.since) params.set('since', q.since);
  if (q.until) params.set('until', q.until);
  if (q.cursor) params.set('cursor', q.cursor);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function listAuditEvents(q: AuditQuery = {}): Promise<AuditList> {
  const { data } = await api.get(`/cpg/audit${auditQueryString(q)}`);
  return parseResponse(auditListSchema, data, 'GET /cpg/audit');
}

/** E73: the signed governance audit export (audit.export). */
export async function exportGovernanceAudit(): Promise<GovernanceExport> {
  const { data } = await api.get('/cpg/audit/export');
  return parseResponse(governanceExportSchema, data, 'GET /cpg/audit/export');
}

// ─── E19–E24 boards ────────────────────────────────────────────────────

const id = (v: string) => encodeURIComponent(v);

export async function listBoards(): Promise<Board[]> {
  const { data } = await api.get('/cpg/boards');
  return parseResponse(listOf(boardSchema), data, 'GET /cpg/boards').items;
}

export async function createBoard(input: { key: string; name: string; kind: BoardKind; description?: string }): Promise<Board> {
  const { data } = await api.post('/cpg/boards', input);
  return parseResponse(boardSchema, data, 'POST /cpg/boards');
}

export async function updateBoard(boardId: string, input: { name?: string; description?: string }): Promise<Board> {
  const { data } = await api.patch(`/cpg/boards/${id(boardId)}`, input);
  return parseResponse(boardSchema, data, 'PATCH /cpg/boards/:id');
}

export async function archiveBoard(boardId: string): Promise<Board> {
  const { data } = await api.post(`/cpg/boards/${id(boardId)}/archive`, {});
  return parseResponse(boardSchema, data, 'POST /cpg/boards/:id/archive');
}

export async function addBoardMember(boardId: string, userId: string): Promise<BoardMember> {
  const { data } = await api.post(`/cpg/boards/${id(boardId)}/members`, { userId });
  return parseResponse(boardMemberSchema, data, 'POST /cpg/boards/:id/members');
}

export async function removeBoardMember(boardId: string, userId: string): Promise<BoardMember> {
  const { data } = await api.post(`/cpg/boards/${id(boardId)}/members/${id(userId)}/remove`, {});
  return parseResponse(boardMemberSchema, data, 'POST /cpg/boards/:id/members/:userId/remove');
}

// ─── E25–E28 quorum ────────────────────────────────────────────────────

export async function getQuorum(): Promise<QuorumVersion> {
  const { data } = await api.get('/cpg/quorum');
  return parseResponse(quorumVersionSchema, data, 'GET /cpg/quorum');
}

export async function putQuorum(config: QuorumConfig, changeNote: string): Promise<QuorumVersion> {
  const { data } = await api.put('/cpg/quorum', { config, changeNote });
  return parseResponse(quorumVersionSchema, data, 'PUT /cpg/quorum');
}

export async function listQuorumVersions(): Promise<QuorumVersionSummary[]> {
  const { data } = await api.get('/cpg/quorum/versions');
  return parseResponse(listOf(quorumVersionSummarySchema), data, 'GET /cpg/quorum/versions').items;
}

export async function getQuorumVersion(version: number): Promise<QuorumVersion> {
  const { data } = await api.get(`/cpg/quorum/versions/${id(String(version))}`);
  return parseResponse(quorumVersionSchema, data, 'GET /cpg/quorum/versions/:version');
}

// ─── E29–E30 compile ───────────────────────────────────────────────────

export interface CodeExample {
  path: string;
  code: string;
}

export interface CompileInput {
  plainText: string;
  /** Set when compiling a new version of an existing policy. */
  policyId?: string;
  examples: { violating: CodeExample[]; compliant: CodeExample[] };
}

export async function compilePolicy(input: CompileInput): Promise<CompileRecord> {
  const body = input.policyId
    ? { plainText: input.plainText, policyId: input.policyId, examples: input.examples }
    : { plainText: input.plainText, examples: input.examples };
  const { data } = await api.post('/cpg/compile', body);
  return parseResponse(compileRecordSchema, data, 'POST /cpg/compile');
}

export async function getCompileRecord(recordId: string): Promise<CompileRecord> {
  const { data } = await api.get(`/cpg/compile/${id(recordId)}`);
  return parseResponse(compileRecordSchema, data, 'GET /cpg/compile/:id');
}

// ─── E31–E37 the policy log ────────────────────────────────────────────

export async function listPolicies(state?: PolicyState): Promise<PolicyHead[]> {
  const { data } = await api.get(state ? `/cpg/policies?state=${id(state)}` : '/cpg/policies');
  return parseResponse(listOf(policyHeadSchema), data, 'GET /cpg/policies').items;
}

export async function getPolicy(policyId: string): Promise<PolicyDetail> {
  const { data } = await api.get(`/cpg/policies/${id(policyId)}`);
  return parseResponse(policyDetailSchema, data, 'GET /cpg/policies/:id');
}

export interface ProposeInput {
  compileRecordId: string;
  title: string;
  tier: Tier;
  owningBoardIds: string[];
  /** An edited rule (the server revalidates it and re-runs the compile record's examples). */
  rule?: unknown;
  /** Give graceDays or enforceFrom (ISO-8601 UTC), not both; neither uses the quorum defaults. */
  graceDays?: number;
  enforceFrom?: string;
}

function proposeBody(input: ProposeInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    compileRecordId: input.compileRecordId, title: input.title, tier: input.tier, owningBoardIds: input.owningBoardIds,
  };
  if (input.rule !== undefined) body.rule = input.rule;
  if (input.graceDays !== undefined) body.graceDays = input.graceDays;
  else if (input.enforceFrom !== undefined) body.enforceFrom = input.enforceFrom;
  return body;
}

export async function proposePolicy(input: ProposeInput & { policyKey: string }): Promise<PolicyDetail> {
  const { data } = await api.post('/cpg/policies', { ...proposeBody(input), policyKey: input.policyKey });
  return parseResponse(policyDetailSchema, data, 'POST /cpg/policies');
}

export async function proposePolicyVersion(policyId: string, input: ProposeInput): Promise<PolicyDetail> {
  const { data } = await api.post(`/cpg/policies/${id(policyId)}/versions`, proposeBody(input));
  return parseResponse(policyDetailSchema, data, 'POST /cpg/policies/:id/versions');
}

export async function proposeRetirement(policyId: string, reason: string): Promise<PolicyDetail> {
  const { data } = await api.post(`/cpg/policies/${id(policyId)}/retire`, { reason });
  return parseResponse(policyDetailSchema, data, 'POST /cpg/policies/:id/retire');
}

export async function voteOnVersion(versionId: string, vote: 'approve' | 'reject', comment?: string): Promise<VoteResult> {
  const body = comment && comment.trim() ? { vote, comment: comment.trim() } : { vote };
  const { data } = await api.post(`/cpg/policy-versions/${id(versionId)}/votes`, body);
  return parseResponse(voteResultSchema, data, 'POST /cpg/policy-versions/:id/votes');
}

export async function withdrawVersion(versionId: string): Promise<PolicyDetail> {
  const { data } = await api.post(`/cpg/policy-versions/${id(versionId)}/withdraw`, {});
  return parseResponse(policyDetailSchema, data, 'POST /cpg/policy-versions/:id/withdraw');
}

// ─── E41–E52 review cases ──────────────────────────────────────────────

export interface CaseQuery {
  state?: CaseState;
  boardId?: string;
  cursor?: string;
  limit?: number;
}

export async function listCases(q: CaseQuery = {}): Promise<CaseList> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  const { data } = await api.get(`/cpg/cases${qs ? `?${qs}` : ''}`);
  return parseResponse(caseListSchema, data, 'GET /cpg/cases');
}

export async function getCase(caseId: string): Promise<CaseDetail> {
  const { data } = await api.get(`/cpg/cases/${id(caseId)}`);
  return parseResponse(caseDetailSchema, data, 'GET /cpg/cases/:id');
}

/** E63: a case's CI runs, newest first (the first 50). */
export async function listCaseCiRuns(caseId: string): Promise<CiRunList> {
  const { data } = await api.get(`/cpg/ci/runs?caseId=${id(caseId)}`);
  return parseResponse(ciRunListSchema, data, 'GET /cpg/ci/runs');
}

export async function getCaseRevision(caseId: string, revision: number): Promise<RevisionDetail> {
  const { data } = await api.get(`/cpg/cases/${id(caseId)}/revisions/${id(String(revision))}`);
  return parseResponse(revisionDetailSchema, data, 'GET /cpg/cases/:id/revisions/:revision');
}

/** E51 (generated on the first request when the org allows it) or, with `retry`, E52 after a failure. */
export async function getReviewerContext(caseId: string, findingId: string, retry = false): Promise<ReviewerContext> {
  const path = `/cpg/cases/${id(caseId)}/findings/${id(findingId)}/context`;
  const { data } = retry ? await api.post(`${path}/retry`, {}) : await api.get(path);
  return parseResponse(reviewerContextSchema, data, retry ? 'POST /cpg/cases/:id/findings/:findingId/context/retry' : 'GET /cpg/cases/:id/findings/:findingId/context');
}

/** A comment, or with `threadId` a reply to that thread. */
export async function addCaseComment(caseId: string, body: string, threadId?: string): Promise<CaseComment> {
  const input = threadId ? { kind: 'reply', threadId, body } : { kind: 'comment', body };
  const { data } = await api.post(`/cpg/cases/${id(caseId)}/comments`, input);
  return parseResponse(caseCommentSchema, data, 'POST /cpg/cases/:id/comments');
}

export async function requestCaseChanges(caseId: string, input: { boardId: string; body: string; fingerprints: string[] }): Promise<CaseComment> {
  const { data } = await api.post(`/cpg/cases/${id(caseId)}/request-changes`, input);
  return parseResponse(caseCommentSchema, data, 'POST /cpg/cases/:id/request-changes');
}

/** E49 withdraw (the opener, or case.close) or E50 close (case.close). */
export async function endCase(caseId: string, how: 'withdraw' | 'close', reason: string) {
  const { data } = await api.post(`/cpg/cases/${id(caseId)}/${how}`, { reason });
  return parseResponse(caseStatusSchema, data, `POST /cpg/cases/:id/${how}`);
}

// ─── E54 to E60 proposals, votes, decisions, standing exceptions ───────

export type ProposalInput =
  | { caseId: string; scope: 'snippet' | 'bulk'; outcome: 'approve' | 'reject'; fingerprints: string[]; expiresAt?: string; rationale: string }
  | { scope: 'standing'; caseId?: string; pattern: StandingPattern; expiresAt: string; rationale: string };

export async function propose(input: ProposalInput): Promise<Proposal> {
  const { data } = await api.post('/cpg/proposals', input);
  return parseResponse(proposalSchema, data, 'POST /cpg/proposals');
}

/** A case's proposals, oldest first. */
export async function listCaseProposals(caseId: string): Promise<Proposal[]> {
  const { data } = await api.get(`/cpg/proposals?caseId=${encodeURIComponent(caseId)}`);
  return parseResponse(proposalListSchema, data, 'GET /cpg/proposals').items;
}

/** The organization's standing exception proposals the caller may read, oldest first. */
export async function listStandingProposals(status?: ProposalStatus): Promise<Proposal[]> {
  const { data } = await api.get(`/cpg/proposals?scope=standing${status ? `&status=${status}` : ''}`);
  return parseResponse(proposalListSchema, data, 'GET /cpg/proposals').items;
}

export async function voteOnProposal(proposalId: string, vote: 'approve' | 'reject', comment: string): Promise<CastVote> {
  const { data } = await api.post(`/cpg/proposals/${proposalId}/votes`, { vote, ...(comment.trim() ? { comment: comment.trim() } : {}) });
  return parseResponse(castVoteSchema, data, 'POST /cpg/proposals/:id/votes');
}

export async function getDecision(decisionId: string): Promise<Decision> {
  const { data } = await api.get(`/cpg/decisions/${decisionId}`);
  return parseResponse(decisionSchema, data, 'GET /cpg/decisions/:id');
}

export async function revokeDecision(decisionId: string, reason: string) {
  const { data } = await api.post(`/cpg/decisions/${decisionId}/revoke`, { reason });
  return parseResponse(revocationSchema, data, 'POST /cpg/decisions/:id/revoke');
}

/** Finalized standing exceptions the caller may read, oldest first. */
export async function listStandingExceptions(policyKey?: string): Promise<StandingException[]> {
  const { data } = await api.get(`/cpg/exceptions${policyKey ? `?policyKey=${encodeURIComponent(policyKey)}` : ''}`);
  return parseResponse(standingExceptionListSchema, data, 'GET /cpg/exceptions').items;
}

// ─── E64–E70 integrations and the delivery log ─────────────────────────

export type IntegrationInput = {
  kind: IntegrationKind; name: string; boardIds: string[]; events: CpgEvent[]; enabled: boolean;
  config: Record<string, unknown>; apiToken?: string;
};

export async function listIntegrations(): Promise<Integration[]> {
  const { data } = await api.get('/cpg/integrations');
  return parseResponse(listOf(integrationSchema), data, 'GET /cpg/integrations').items;
}

export async function createIntegration(input: IntegrationInput): Promise<IntegrationWithSecret> {
  const { data } = await api.post('/cpg/integrations', input);
  return parseResponse(integrationWithSecretSchema, data, 'POST /cpg/integrations');
}

export async function updateIntegration(integrationId: string, patch: Partial<Pick<IntegrationInput, 'name' | 'boardIds' | 'events' | 'enabled' | 'config'>>): Promise<Integration> {
  const { data } = await api.patch(`/cpg/integrations/${id(integrationId)}`, patch);
  return parseResponse(integrationSchema, data, 'PATCH /cpg/integrations/:id');
}

/** A webhook gets a new signing secret (returned once); a Jira integration takes the new token. */
export async function rotateIntegrationSecret(integrationId: string, apiToken?: string): Promise<IntegrationWithSecret> {
  const { data } = await api.post(`/cpg/integrations/${id(integrationId)}/rotate-secret`, apiToken ? { apiToken } : {});
  return parseResponse(integrationWithSecretSchema, data, 'POST /cpg/integrations/:id/rotate-secret');
}

export async function testIntegration(integrationId: string): Promise<Delivery> {
  const { data } = await api.post(`/cpg/integrations/${id(integrationId)}/test`, {});
  return parseResponse(deliverySchema, data, 'POST /cpg/integrations/:id/test');
}

export async function listDeliveries(q: { status?: DeliveryStatus; limit?: number; cursor?: string } = {}): Promise<DeliveryList> {
  const { data } = await api.get('/cpg/deliveries', { params: q });
  return parseResponse(deliveryListSchema, data, 'GET /cpg/deliveries');
}

export async function retryDelivery(deliveryId: string): Promise<Delivery> {
  const { data } = await api.post(`/cpg/deliveries/${id(deliveryId)}/retry`, {});
  return parseResponse(deliverySchema, data, 'POST /cpg/deliveries/:id/retry');
}
