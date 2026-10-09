import { z } from 'zod';

/**
 * Response contracts of the Corporate Policy Governance API (/api/v1/cpg),
 * Phase 1 endpoints E1 to E17, mirroring engine/src/cpg/contracts.ts.
 *
 * Every response the dashboard reads is parsed with one of these schemas
 * before a page sees it, so a contract drift shows up as a visible error
 * instead of NaN, "undefined" or a silently empty table. The schemas are
 * strict on purpose: an unexpected field means the two sides disagree.
 * engine/src/server/dashboard-api-contract.test.ts parses real engine
 * responses with this file.
 *
 * This module imports only zod (no axios, no browser APIs) so the engine's
 * contract test can load it.
 */

const uuid = z.string().uuid();
const isoDate = z.string().datetime();
export const scopeTypeSchema = z.enum(['org', 'team', 'repo']);

export const permissionCategorySchema = z.enum(['org', 'rbac', 'policy', 'case', 'exception', 'audit', 'integration', 'ci']);

export const permissionSchema = z.object({
  key: z.string(),
  category: permissionCategorySchema,
  scopable: z.boolean(),
  description: z.string(),
}).strict();

export const roleSchema = z.object({
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

export const grantSchema = z.object({
  id: uuid,
  userId: uuid,
  roleId: uuid,
  roleKey: z.string(),
  roleName: z.string(),
  scopeType: scopeTypeSchema,
  scopeId: z.string().nullable(),
  grantedBy: z.string(),
  grantedAt: isoDate,
  revokedAt: isoDate.nullable(),
  revokedBy: z.string().nullable(),
  revokeReason: z.string().nullable(),
}).strict();

const boardRefSchema = z.object({ id: uuid, name: z.string() }).strict();

export const orgUserSchema = z.object({
  id: uuid,
  name: z.string(),
  email: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  grants: z.array(grantSchema),
  boards: z.array(boardRefSchema),
}).strict();

export const inviteResultSchema = z.object({
  user: orgUserSchema,
  tempPassword: z.string().min(1),
}).strict();

export const teamSchema = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  repoPatterns: z.array(z.string()),
  createdAt: isoDate,
  createdBy: z.string(),
  archivedAt: isoDate.nullable(),
}).strict();

export const cpgSettingsSchema = z.object({
  orgId: uuid,
  enabled: z.boolean(),
  reviewerContextLlm: z.boolean(),
  llmProviderConfigured: z.boolean(),
  rbacMigratedAt: isoDate.nullable(),
  updatedAt: isoDate,
  updatedBy: z.string(),
}).strict();

export const auditEventSchema = z.object({
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

export const auditListSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
  chainValid: z.boolean(),
}).strict();

export const mePermissionSchema = z.object({
  key: z.string(),
  scope: scopeTypeSchema,
  scopeId: z.string().nullable(),
}).strict();

export const meSchema = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string() }).strict(),
  orgId: uuid,
  cpgEnabled: z.boolean(),
  isPlatformAdmin: z.boolean(),
  permissions: z.array(mePermissionSchema),
  boards: z.array(boardRefSchema),
  identity: z.enum(['session', 'user_key', 'org_key']),
}).strict();

export const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) }).strict();

export type ScopeType = z.infer<typeof scopeTypeSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type PermissionCategory = z.infer<typeof permissionCategorySchema>;
export type Role = z.infer<typeof roleSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type OrgUser = z.infer<typeof orgUserSchema>;
export type InviteResult = z.infer<typeof inviteResultSchema>;
export type Team = z.infer<typeof teamSchema>;
export type CpgSettings = z.infer<typeof cpgSettingsSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditList = z.infer<typeof auditListSchema>;
export type CpgMe = z.infer<typeof meSchema>;
export type MePermission = z.infer<typeof mePermissionSchema>;
