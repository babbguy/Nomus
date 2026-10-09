import type { z } from 'zod';
import api from './client';
import {
  auditListSchema, cpgSettingsSchema, grantSchema, inviteResultSchema, listOf, meSchema, orgUserSchema,
  permissionSchema, roleSchema, teamSchema,
  type AuditList, type CpgMe, type CpgSettings, type Grant, type InviteResult, type OrgUser, type Permission,
  type Role, type ScopeType, type Team,
} from './cpg-schemas';

export * from './cpg-schemas';

/**
 * Typed client for the Corporate Policy Governance API (/api/v1/cpg),
 * Phase 1: RBAC, settings and the audit log (E1 to E17). Every response is
 * parsed with its zod contract (cpg-schemas.ts); a response that does not
 * match throws CpgContractError, which pages show as a load failure.
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
