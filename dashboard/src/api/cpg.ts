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

/** Awaits a request and parses its body with `schema`; `endpoint` names the call in a contract error. */
async function call<S extends z.ZodTypeAny>(request: Promise<{ data: unknown }>, schema: S, endpoint: string): Promise<z.infer<S>> {
  return parseResponse(schema, (await request).data, endpoint);
}

/** The same for an `{ items }` answer, unwrapped. */
async function callItems<S extends z.ZodType<{ items: unknown[] }>>(request: Promise<{ data: unknown }>, schema: S, endpoint: string): Promise<z.infer<S>['items']> {
  return (await call(request, schema, endpoint)).items;
}

const id = (v: string | number) => encodeURIComponent(String(v));

// ─── E1 me ─────────────────────────────────────────────────────────────

export const getCpgMe = (): Promise<CpgMe> => call(api.get('/cpg/me'), meSchema, 'GET /cpg/me');

// ─── E2 permissions, E3–E6 roles ───────────────────────────────────────

export const listPermissions = (): Promise<Permission[]> => callItems(api.get('/cpg/permissions'), listOf(permissionSchema), 'GET /cpg/permissions');

export const listRoles = (): Promise<Role[]> => callItems(api.get('/cpg/roles'), listOf(roleSchema), 'GET /cpg/roles');

export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string;
  permissions: string[];
}

export const createRole = (input: CreateRoleInput): Promise<Role> => call(api.post('/cpg/roles', input), roleSchema, 'POST /cpg/roles');

export const updateRole = (roleId: string, input: { name?: string; description?: string; permissions?: string[] }): Promise<Role> =>
  call(api.patch(`/cpg/roles/${id(roleId)}`, input), roleSchema, 'PATCH /cpg/roles/:id');

export const archiveRole = (roleId: string): Promise<Role> =>
  call(api.post(`/cpg/roles/${id(roleId)}/archive`, {}), roleSchema, 'POST /cpg/roles/:id/archive');

// ─── E7–E11 users and grants ───────────────────────────────────────────

export const listOrgUsers = (): Promise<OrgUser[]> => callItems(api.get('/cpg/users'), listOf(orgUserSchema), 'GET /cpg/users');

export const inviteOrgUser = (input: { email: string; name: string; roleKeys?: string[] }): Promise<InviteResult> =>
  call(api.post('/cpg/users', input), inviteResultSchema, 'POST /cpg/users');

export const updateOrgUser = (userId: string, input: { name?: string; isActive?: boolean }): Promise<OrgUser> =>
  call(api.patch(`/cpg/users/${id(userId)}`, input), orgUserSchema, 'PATCH /cpg/users/:id');

export interface CreateGrantInput {
  roleId: string;
  scopeType: ScopeType;
  /** Omitted for org; a team id for team; a canonical owner/name for repo. */
  scopeId?: string;
}

export function createGrant(userId: string, input: CreateGrantInput): Promise<Grant> {
  const body = input.scopeType === 'org'
    ? { roleId: input.roleId, scopeType: 'org' as const }
    : { roleId: input.roleId, scopeType: input.scopeType, scopeId: input.scopeId };
  return call(api.post(`/cpg/users/${id(userId)}/grants`, body), grantSchema, 'POST /cpg/users/:id/grants');
}

export const revokeGrant = (grantId: string, reason: string): Promise<Grant> =>
  call(api.post(`/cpg/grants/${id(grantId)}/revoke`, { reason }), grantSchema, 'POST /cpg/grants/:id/revoke');

// ─── E12–E14 teams ─────────────────────────────────────────────────────

export const listTeams = (): Promise<Team[]> => callItems(api.get('/cpg/teams'), listOf(teamSchema), 'GET /cpg/teams');

export const createTeam = (input: { key: string; name: string; repoPatterns: string[] }): Promise<Team> =>
  call(api.post('/cpg/teams', input), teamSchema, 'POST /cpg/teams');

export const updateTeam = (teamId: string, input: { name?: string; repoPatterns?: string[]; archived?: boolean }): Promise<Team> =>
  call(api.patch(`/cpg/teams/${id(teamId)}`, input), teamSchema, 'PATCH /cpg/teams/:id');

// ─── E15–E16 settings ──────────────────────────────────────────────────

export const getCpgSettings = (): Promise<CpgSettings> => call(api.get('/cpg/settings'), cpgSettingsSchema, 'GET /cpg/settings');

export const updateCpgSettings = (input: { enabled?: boolean; reviewerContextLlm?: boolean }): Promise<CpgSettings> =>
  call(api.patch('/cpg/settings', input), cpgSettingsSchema, 'PATCH /cpg/settings');

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

export const listAuditEvents = (q: AuditQuery = {}): Promise<AuditList> =>
  call(api.get(`/cpg/audit${auditQueryString(q)}`), auditListSchema, 'GET /cpg/audit');

/** E73: the signed governance audit export (audit.export). */
export const exportGovernanceAudit = (): Promise<GovernanceExport> =>
  call(api.get('/cpg/audit/export'), governanceExportSchema, 'GET /cpg/audit/export');

// ─── E19–E24 boards ────────────────────────────────────────────────────

export const listBoards = (): Promise<Board[]> => callItems(api.get('/cpg/boards'), listOf(boardSchema), 'GET /cpg/boards');

export const createBoard = (input: { key: string; name: string; kind: BoardKind; description?: string }): Promise<Board> =>
  call(api.post('/cpg/boards', input), boardSchema, 'POST /cpg/boards');

export const updateBoard = (boardId: string, input: { name?: string; description?: string }): Promise<Board> =>
  call(api.patch(`/cpg/boards/${id(boardId)}`, input), boardSchema, 'PATCH /cpg/boards/:id');

export const archiveBoard = (boardId: string): Promise<Board> =>
  call(api.post(`/cpg/boards/${id(boardId)}/archive`, {}), boardSchema, 'POST /cpg/boards/:id/archive');

export const addBoardMember = (boardId: string, userId: string): Promise<BoardMember> =>
  call(api.post(`/cpg/boards/${id(boardId)}/members`, { userId }), boardMemberSchema, 'POST /cpg/boards/:id/members');

export const removeBoardMember = (boardId: string, userId: string): Promise<BoardMember> =>
  call(api.post(`/cpg/boards/${id(boardId)}/members/${id(userId)}/remove`, {}), boardMemberSchema, 'POST /cpg/boards/:id/members/:userId/remove');

// ─── E25–E28 quorum ────────────────────────────────────────────────────

export const getQuorum = (): Promise<QuorumVersion> => call(api.get('/cpg/quorum'), quorumVersionSchema, 'GET /cpg/quorum');

export const putQuorum = (config: QuorumConfig, changeNote: string): Promise<QuorumVersion> =>
  call(api.put('/cpg/quorum', { config, changeNote }), quorumVersionSchema, 'PUT /cpg/quorum');

export const listQuorumVersions = (): Promise<QuorumVersionSummary[]> =>
  callItems(api.get('/cpg/quorum/versions'), listOf(quorumVersionSummarySchema), 'GET /cpg/quorum/versions');

export const getQuorumVersion = (version: number): Promise<QuorumVersion> =>
  call(api.get(`/cpg/quorum/versions/${id(version)}`), quorumVersionSchema, 'GET /cpg/quorum/versions/:version');

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

export function compilePolicy(input: CompileInput): Promise<CompileRecord> {
  const body = input.policyId
    ? { plainText: input.plainText, policyId: input.policyId, examples: input.examples }
    : { plainText: input.plainText, examples: input.examples };
  return call(api.post('/cpg/compile', body), compileRecordSchema, 'POST /cpg/compile');
}

export const getCompileRecord = (recordId: string): Promise<CompileRecord> =>
  call(api.get(`/cpg/compile/${id(recordId)}`), compileRecordSchema, 'GET /cpg/compile/:id');

// ─── E31–E37 the policy log ────────────────────────────────────────────

export const listPolicies = (state?: PolicyState): Promise<PolicyHead[]> =>
  callItems(api.get(state ? `/cpg/policies?state=${id(state)}` : '/cpg/policies'), listOf(policyHeadSchema), 'GET /cpg/policies');

export const getPolicy = (policyId: string): Promise<PolicyDetail> =>
  call(api.get(`/cpg/policies/${id(policyId)}`), policyDetailSchema, 'GET /cpg/policies/:id');

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

export const proposePolicy = (input: ProposeInput & { policyKey: string }): Promise<PolicyDetail> =>
  call(api.post('/cpg/policies', { ...proposeBody(input), policyKey: input.policyKey }), policyDetailSchema, 'POST /cpg/policies');

export const proposePolicyVersion = (policyId: string, input: ProposeInput): Promise<PolicyDetail> =>
  call(api.post(`/cpg/policies/${id(policyId)}/versions`, proposeBody(input)), policyDetailSchema, 'POST /cpg/policies/:id/versions');

export const proposeRetirement = (policyId: string, reason: string): Promise<PolicyDetail> =>
  call(api.post(`/cpg/policies/${id(policyId)}/retire`, { reason }), policyDetailSchema, 'POST /cpg/policies/:id/retire');

export function voteOnVersion(versionId: string, vote: 'approve' | 'reject', comment?: string): Promise<VoteResult> {
  const body = comment && comment.trim() ? { vote, comment: comment.trim() } : { vote };
  return call(api.post(`/cpg/policy-versions/${id(versionId)}/votes`, body), voteResultSchema, 'POST /cpg/policy-versions/:id/votes');
}

export const withdrawVersion = (versionId: string): Promise<PolicyDetail> =>
  call(api.post(`/cpg/policy-versions/${id(versionId)}/withdraw`, {}), policyDetailSchema, 'POST /cpg/policy-versions/:id/withdraw');

// ─── E41–E52 review cases ──────────────────────────────────────────────

export interface CaseQuery {
  state?: CaseState;
  boardId?: string;
  cursor?: string;
  limit?: number;
}

export function listCases(q: CaseQuery = {}): Promise<CaseList> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return call(api.get(`/cpg/cases${qs ? `?${qs}` : ''}`), caseListSchema, 'GET /cpg/cases');
}

export const getCase = (caseId: string): Promise<CaseDetail> => call(api.get(`/cpg/cases/${id(caseId)}`), caseDetailSchema, 'GET /cpg/cases/:id');

/** E63: a case's CI runs, newest first (the first 50). */
export const listCaseCiRuns = (caseId: string): Promise<CiRunList> =>
  call(api.get(`/cpg/ci/runs?caseId=${id(caseId)}`), ciRunListSchema, 'GET /cpg/ci/runs');

export const getCaseRevision = (caseId: string, revision: number): Promise<RevisionDetail> =>
  call(api.get(`/cpg/cases/${id(caseId)}/revisions/${id(revision)}`), revisionDetailSchema, 'GET /cpg/cases/:id/revisions/:revision');

/** E51 (generated on the first request when the org allows it) or, with `retry`, E52 after a failure. */
export function getReviewerContext(caseId: string, findingId: string, retry = false): Promise<ReviewerContext> {
  const path = `/cpg/cases/${id(caseId)}/findings/${id(findingId)}/context`;
  return retry
    ? call(api.post(`${path}/retry`, {}), reviewerContextSchema, 'POST /cpg/cases/:id/findings/:findingId/context/retry')
    : call(api.get(path), reviewerContextSchema, 'GET /cpg/cases/:id/findings/:findingId/context');
}

/** A comment, or with `threadId` a reply to that thread. */
export function addCaseComment(caseId: string, body: string, threadId?: string): Promise<CaseComment> {
  const input = threadId ? { kind: 'reply', threadId, body } : { kind: 'comment', body };
  return call(api.post(`/cpg/cases/${id(caseId)}/comments`, input), caseCommentSchema, 'POST /cpg/cases/:id/comments');
}

export const requestCaseChanges = (caseId: string, input: { boardId: string; body: string; fingerprints: string[] }): Promise<CaseComment> =>
  call(api.post(`/cpg/cases/${id(caseId)}/request-changes`, input), caseCommentSchema, 'POST /cpg/cases/:id/request-changes');

/** E49 withdraw (the opener, or case.close) or E50 close (case.close). */
export const endCase = (caseId: string, how: 'withdraw' | 'close', reason: string) =>
  call(api.post(`/cpg/cases/${id(caseId)}/${how}`, { reason }), caseStatusSchema, `POST /cpg/cases/:id/${how}`);

// ─── E54 to E60 proposals, votes, decisions, standing exceptions ───────

export type ProposalInput =
  | { caseId: string; scope: 'snippet' | 'bulk'; outcome: 'approve' | 'reject'; fingerprints: string[]; expiresAt?: string; rationale: string }
  | { scope: 'standing'; caseId?: string; pattern: StandingPattern; expiresAt: string; rationale: string };

export const propose = (input: ProposalInput): Promise<Proposal> => call(api.post('/cpg/proposals', input), proposalSchema, 'POST /cpg/proposals');

/** A case's proposals, oldest first. */
export const listCaseProposals = (caseId: string): Promise<Proposal[]> =>
  callItems(api.get(`/cpg/proposals?caseId=${id(caseId)}`), proposalListSchema, 'GET /cpg/proposals');

/** The organization's standing exception proposals the caller may read, oldest first. */
export const listStandingProposals = (status?: ProposalStatus): Promise<Proposal[]> =>
  callItems(api.get(`/cpg/proposals?scope=standing${status ? `&status=${status}` : ''}`), proposalListSchema, 'GET /cpg/proposals');

export const voteOnProposal = (proposalId: string, vote: 'approve' | 'reject', comment: string): Promise<CastVote> =>
  call(api.post(`/cpg/proposals/${id(proposalId)}/votes`, { vote, ...(comment.trim() ? { comment: comment.trim() } : {}) }), castVoteSchema, 'POST /cpg/proposals/:id/votes');

export const getDecision = (decisionId: string): Promise<Decision> => call(api.get(`/cpg/decisions/${id(decisionId)}`), decisionSchema, 'GET /cpg/decisions/:id');

export const revokeDecision = (decisionId: string, reason: string) =>
  call(api.post(`/cpg/decisions/${id(decisionId)}/revoke`, { reason }), revocationSchema, 'POST /cpg/decisions/:id/revoke');

/** Finalized standing exceptions the caller may read, oldest first. */
export const listStandingExceptions = (policyKey?: string): Promise<StandingException[]> =>
  callItems(api.get(`/cpg/exceptions${policyKey ? `?policyKey=${id(policyKey)}` : ''}`), standingExceptionListSchema, 'GET /cpg/exceptions');

// ─── E64–E70 integrations and the delivery log ─────────────────────────

export type IntegrationInput = {
  kind: IntegrationKind; name: string; boardIds: string[]; events: CpgEvent[]; enabled: boolean;
  config: Record<string, unknown>; apiToken?: string;
};

export const listIntegrations = (): Promise<Integration[]> => callItems(api.get('/cpg/integrations'), listOf(integrationSchema), 'GET /cpg/integrations');

export const createIntegration = (input: IntegrationInput): Promise<IntegrationWithSecret> =>
  call(api.post('/cpg/integrations', input), integrationWithSecretSchema, 'POST /cpg/integrations');

export const updateIntegration = (integrationId: string, patch: Partial<Pick<IntegrationInput, 'name' | 'boardIds' | 'events' | 'enabled' | 'config'>>): Promise<Integration> =>
  call(api.patch(`/cpg/integrations/${id(integrationId)}`, patch), integrationSchema, 'PATCH /cpg/integrations/:id');

/** A webhook gets a new signing secret (returned once); a Jira integration takes the new token. */
export const rotateIntegrationSecret = (integrationId: string, apiToken?: string): Promise<IntegrationWithSecret> =>
  call(api.post(`/cpg/integrations/${id(integrationId)}/rotate-secret`, apiToken ? { apiToken } : {}), integrationWithSecretSchema, 'POST /cpg/integrations/:id/rotate-secret');

export const testIntegration = (integrationId: string): Promise<Delivery> =>
  call(api.post(`/cpg/integrations/${id(integrationId)}/test`, {}), deliverySchema, 'POST /cpg/integrations/:id/test');

export const listDeliveries = (q: { status?: DeliveryStatus; limit?: number; cursor?: string } = {}): Promise<DeliveryList> =>
  call(api.get('/cpg/deliveries', { params: q }), deliveryListSchema, 'GET /cpg/deliveries');

export const retryDelivery = (deliveryId: string): Promise<Delivery> =>
  call(api.post(`/cpg/deliveries/${id(deliveryId)}/retry`, {}), deliverySchema, 'POST /cpg/deliveries/:id/retry');
