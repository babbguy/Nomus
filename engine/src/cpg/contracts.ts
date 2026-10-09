import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { cpgRoles, cpgTeamRepos, cpgUserRoles } from '../db/schema-cpg.js';
import { PERMISSION_KEYS } from './rbac/catalog.js';
import { rolePermissionKeys, type GrantRow, type RoleRow } from './rbac/grants.js';

/**
 * Engine-only CPG contracts (design spec §9.1, §9.3): strict zod schemas for
 * every request body and response of the Phase 1 endpoints (E1 to E18).
 * Responses are built by the serializers below and parsed with their schema
 * before they are sent, so the contract is enforced, not just documented.
 */

type Db = BetterSQLite3Database<any>;

const uuid = z.string().uuid();
const isoDate = z.string().datetime();
const scopeType = z.enum(['org', 'team', 'repo']);
const permissionKey = z.enum(PERMISSION_KEYS as [string, ...string[]]);

export const roleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, 'lowercase letters, digits and _; starts with a letter; at most 50');
export const teamKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/, 'lowercase letters, digits, _ and -; starts with a letter; at most 50');
const singleLine = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^\r\n]*$/, 'must be a single line');

// ─── Responses ─────────────────────────────────────────────────────────

export const permissionResponseSchema = z.object({
  key: z.string(),
  category: z.enum(['org', 'rbac', 'policy', 'case', 'exception', 'audit', 'integration', 'ci']),
  scopable: z.boolean(),
  description: z.string(),
}).strict();

export const roleResponseSchema = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  createdAt: isoDate,
  createdBy: z.string(),
  archivedAt: isoDate.nullable(),
  archivedBy: z.string().nullable(),
}).strict();

export const grantResponseSchema = z.object({
  id: uuid,
  userId: uuid,
  roleId: uuid,
  roleKey: z.string(),
  roleName: z.string(),
  scopeType,
  scopeId: z.string().nullable(),
  grantedBy: z.string(),
  grantedAt: isoDate,
  revokedAt: isoDate.nullable(),
  revokedBy: z.string().nullable(),
  revokeReason: z.string().nullable(),
}).strict();

export const orgUserResponseSchema = z.object({
  id: uuid,
  name: z.string(),
  email: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  grants: z.array(grantResponseSchema),
  /** Board memberships arrive with Phase 2; always empty in Phase 1. */
  boards: z.array(z.object({ id: uuid, name: z.string() }).strict()),
}).strict();

export const teamResponseSchema = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  repoPatterns: z.array(z.string()),
  createdAt: isoDate,
  createdBy: z.string(),
  archivedAt: isoDate.nullable(),
}).strict();

export const cpgSettingsResponseSchema = z.object({
  orgId: uuid,
  enabled: z.boolean(),
  reviewerContextLlm: z.boolean(),
  /** Whether the instance has an LLM provider configured (the settings page discloses where snippets go). */
  llmProviderConfigured: z.boolean(),
  rbacMigratedAt: isoDate.nullable(),
  updatedAt: isoDate,
  updatedBy: z.string(),
}).strict();

export const auditEventResponseSchema = z.object({
  id: uuid,
  seq: z.number().int().min(1),
  actor: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: isoDate,
}).strict();

export const auditListResponseSchema = z.object({
  items: z.array(auditEventResponseSchema),
  nextCursor: z.string().nullable(),
  chainValid: z.boolean(),
}).strict();

export const meResponseSchema = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string() }).strict(),
  orgId: uuid,
  cpgEnabled: z.boolean(),
  isPlatformAdmin: z.boolean(),
  permissions: z.array(z.object({ key: z.string(), scope: scopeType, scopeId: z.string().nullable() }).strict()),
  boards: z.array(z.object({ id: uuid, name: z.string() }).strict()),
  identity: z.enum(['session', 'user_key', 'org_key']),
}).strict();

export const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) }).strict();

export type RoleResponse = z.infer<typeof roleResponseSchema>;
export type GrantResponse = z.infer<typeof grantResponseSchema>;
export type OrgUserResponse = z.infer<typeof orgUserResponseSchema>;
export type TeamResponse = z.infer<typeof teamResponseSchema>;
export type CpgSettingsResponse = z.infer<typeof cpgSettingsResponseSchema>;
export type AuditEventResponse = z.infer<typeof auditEventResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;

// ─── Requests ──────────────────────────────────────────────────────────

const permissionList = z.array(permissionKey).max(PERMISSION_KEYS.length)
  .refine((ps) => new Set(ps).size === ps.length, 'permissions must not repeat');

export const createRoleRequestSchema = z.object({
  key: roleKeySchema,
  name: singleLine(1, 100),
  description: z.string().trim().max(500).optional(),
  permissions: permissionList,
}).strict();

export const patchRoleRequestSchema = z.object({
  name: singleLine(1, 100).optional(),
  description: z.string().trim().max(500).optional(),
  permissions: permissionList.optional(),
}).strict().refine((b) => b.name !== undefined || b.description !== undefined || b.permissions !== undefined, 'nothing to update');

export const emptyRequestSchema = z.object({}).strict();

export const createUserRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  name: singleLine(1, 200),
  roleKeys: z.array(roleKeySchema).max(20).optional(),
}).strict();

export const patchUserRequestSchema = z.object({
  name: singleLine(1, 200).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((b) => b.name !== undefined || b.isActive !== undefined, 'nothing to update');

export const createGrantRequestSchema = z.object({
  roleId: uuid,
  scopeType,
  scopeId: z.string().min(1).max(200).nullable().optional(),
}).strict();

export const revokeGrantRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

const repoPatternList = z.array(z.string().min(1).max(200)).max(50)
  .refine((ps) => new Set(ps).size === ps.length, 'repoPatterns must not repeat');

export const createTeamRequestSchema = z.object({
  key: teamKeySchema,
  name: singleLine(1, 100),
  repoPatterns: repoPatternList,
}).strict();

export const patchTeamRequestSchema = z.object({
  name: singleLine(1, 100).optional(),
  repoPatterns: repoPatternList.optional(),
  archived: z.boolean().optional(),
}).strict().refine((b) => b.name !== undefined || b.repoPatterns !== undefined || b.archived !== undefined, 'nothing to update');

export const patchSettingsRequestSchema = z.object({
  enabled: z.boolean().optional(),
  reviewerContextLlm: z.boolean().optional(),
}).strict().refine((b) => b.enabled !== undefined || b.reviewerContextLlm !== undefined, 'nothing to update');

export const auditQuerySchema = z.object({
  action: z.string().min(1).max(100).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

// ─── Serializers ───────────────────────────────────────────────────────

export function serializeRole(db: Db, role: RoleRow): RoleResponse {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: rolePermissionKeys(db, role.id),
    createdAt: role.createdAt,
    createdBy: role.createdBy,
    archivedAt: role.archivedAt,
    archivedBy: role.archivedBy,
  };
}

export function serializeGrant(db: Db, grant: GrantRow): GrantResponse {
  const role = db.select({ key: cpgRoles.key, name: cpgRoles.name }).from(cpgRoles).where(eq(cpgRoles.id, grant.roleId)).get();
  if (!role) throw new Error(`Grant ${grant.id} references a missing role`);
  return {
    id: grant.id,
    userId: grant.userId,
    roleId: grant.roleId,
    roleKey: role.key,
    roleName: role.name,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    revokedAt: grant.revokedAt,
    revokedBy: grant.revokedBy,
    revokeReason: grant.revokeReason,
  };
}

export function activeGrantsOf(db: Db, orgId: string, userId: string): GrantResponse[] {
  return db.select().from(cpgUserRoles)
    .where(and(eq(cpgUserRoles.orgId, orgId), eq(cpgUserRoles.userId, userId)))
    .orderBy(asc(cpgUserRoles.grantedAt), asc(cpgUserRoles.id))
    .all()
    .filter((g) => !g.revokedAt)
    .map((g) => serializeGrant(db, g));
}

export function serializeOrgUser(db: Db, orgId: string, u: {
  id: string; name: string; email: string; isActive: boolean; mustChangePassword: boolean;
}): OrgUserResponse {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    grants: activeGrantsOf(db, orgId, u.id),
    boards: [],
  };
}

export function serializeTeam(db: Db, team: { id: string; key: string; name: string; createdAt: string; createdBy: string; archivedAt: string | null }): TeamResponse {
  const repoPatterns = db.select({ p: cpgTeamRepos.repoPattern }).from(cpgTeamRepos)
    .where(eq(cpgTeamRepos.teamId, team.id)).all().map((r) => r.p).sort();
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    repoPatterns,
    createdAt: team.createdAt,
    createdBy: team.createdBy,
    archivedAt: team.archivedAt,
  };
}
