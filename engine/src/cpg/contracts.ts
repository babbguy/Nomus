import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { cpgRoles, cpgTeamRepos, cpgUserRoles } from '../db/schema-cpg.js';
import { PERMISSION_KEYS } from './rbac/catalog.js';
import { rolePermissionKeys, type GrantRow, type RoleRow } from './rbac/grants.js';
import { corporateRuleSchema } from '@nomus/scanner/corporate';
import { quorumConfigSchema } from './quorum/schema.js';
import { boardsOfUser } from './boards/service.js';

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
  /** Active boards the user is a member of. */
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
  /** The active roles the user holds at any scope, sorted by key (the dashboard's user card names them). */
  roles: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), isSystem: z.boolean() }).strict()),
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

// ═══ Phase 2: boards, quorum, compile, policy log, export (E19–E39) ═════

const tierSchema = z.enum(['advisory', 'review-required', 'prohibited']);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const boardRef = z.object({ id: uuid, name: z.string() }).strict();

export const boardKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/, 'lowercase letters, digits, _ and -; starts with a letter; at most 50');
export const boardKindSchema = z.enum(['governance', 'legal', 'ai', 'security', 'custom']);

export const boardMemberResponseSchema = z.object({
  id: uuid,
  boardId: uuid,
  userId: uuid,
  userName: z.string(),
  userEmail: z.string(),
  addedAt: isoDate,
  addedBy: z.string(),
  removedAt: isoDate.nullable(),
  removedBy: z.string().nullable(),
}).strict();

export const boardResponseSchema = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  kind: boardKindSchema,
  description: z.string(),
  createdAt: isoDate,
  createdBy: z.string(),
  archivedAt: isoDate.nullable(),
  archivedBy: z.string().nullable(),
  memberCount: z.number().int().min(0),
  /** Active members; only for callers holding boards.manage (null otherwise). */
  members: z.array(boardMemberResponseSchema).nullable(),
}).strict();

export const createBoardRequestSchema = z.object({
  key: boardKeySchema,
  name: singleLine(1, 100),
  kind: boardKindSchema,
  description: z.string().trim().max(500).optional(),
}).strict();

export const patchBoardRequestSchema = z.object({
  name: singleLine(1, 100).optional(),
  description: z.string().trim().max(500).optional(),
}).strict().refine((b) => b.name !== undefined || b.description !== undefined, 'nothing to update');

export const addBoardMemberRequestSchema = z.object({ userId: uuid }).strict();

export const quorumVersionResponseSchema = z.object({
  version: z.number().int().min(1),
  config: quorumConfigSchema,
  configHash: sha256Hex,
  changeNote: z.string(),
  createdAt: isoDate,
  createdBy: z.string(),
  signature: z.string().min(1),
}).strict();

export const quorumVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  configHash: sha256Hex,
  changeNote: z.string(),
  createdAt: isoDate,
  createdBy: z.string(),
}).strict();

export const putQuorumRequestSchema = z.object({
  config: quorumConfigSchema,
  changeNote: z.string().trim().min(1).max(1000),
}).strict();

const exampleSchema = z.object({ path: z.string(), code: z.string() }).strict();

export const compileRecordResponseSchema = z.object({
  id: uuid,
  policyId: uuid.nullable(),
  requestedBy: z.string(),
  status: z.enum(['compiled', 'rejected_unexpressible', 'rejected_schema', 'rejected_validation', 'rejected_examples', 'llm_error']),
  inputText: z.string(),
  inputHash: sha256Hex,
  promptVersion: z.number().int().min(1),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  rejection: z.object({ code: z.string(), reasons: z.array(z.string()) }).strict().nullable(),
  suggestion: z.discriminatedUnion('expressible', [
    z.object({
      expressible: z.literal(true), suggestedKey: z.string(), title: z.string(), suggestedTier: tierSchema,
      rationale: z.string(), limitations: z.array(z.string()),
    }).strict(),
    z.object({ expressible: z.literal(false), reason: z.string(), closestExpressible: z.string().nullable() }).strict(),
  ]).nullable(),
  compiledRule: corporateRuleSchema.nullable(),
  compiledRuleHash: sha256Hex.nullable(),
  examples: z.object({ violating: z.array(exampleSchema), compliant: z.array(exampleSchema) }).strict(),
  exampleResults: z.array(z.object({
    kind: z.enum(['violating', 'compliant']),
    index: z.number().int().min(0),
    path: z.string(),
    expected: z.enum(['finding', 'no_finding']),
    findings: z.number().int().min(0),
    lines: z.array(z.number().int().min(1)),
    passed: z.boolean(),
    note: z.string().nullable(),
  }).strict()).nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  createdAt: isoDate,
}).strict();

const versionStatusSchema = z.enum(['pending', 'active', 'superseded', 'rejected', 'withdrawn', 'expired', 'retired']);

export const policyVersionResponseSchema = z.object({
  id: uuid,
  version: z.number().int().min(1),
  kind: z.enum(['define', 'retire']),
  status: versionStatusSchema,
  title: z.string(),
  plainText: z.string(),
  tier: tierSchema,
  owningBoards: z.array(boardRef).min(1),
  rule: corporateRuleSchema.nullable(),
  ruleHash: sha256Hex.nullable(),
  compileRecordId: uuid.nullable(),
  editedFromCompile: z.boolean(),
  graceDays: z.number().int().nullable(),
  enforceFromRequested: isoDate.nullable(),
  enforceFrom: isoDate.nullable(),
  activatedAt: isoDate.nullable(),
  /** Activation (or retirement) signature, once approved. */
  signature: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDate,
}).strict();

export const policyVersionEventResponseSchema = z.object({
  id: uuid,
  versionId: uuid,
  version: z.number().int().min(1),
  event: z.enum(['proposed', 'approved', 'rejected', 'withdrawn', 'activated', 'superseded', 'retired', 'expired_proposal']),
  actor: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
}).strict();

export const policyVoteResponseSchema = z.object({
  id: uuid,
  versionId: uuid,
  voterUserId: uuid,
  voterName: z.string(),
  vote: z.enum(['approve', 'reject']),
  comment: z.string(),
  quorumConfigVersion: z.number().int().min(1),
  createdAt: isoDate,
}).strict();

export const policyHeadResponseSchema = z.object({
  policyId: uuid,
  policyKey: z.string(),
  state: z.enum(['draft', 'proposed', 'active', 'retired']),
  /** Title and tier of the active version, else of the latest version. */
  title: z.string(),
  tier: tierSchema,
  owningBoards: z.array(boardRef),
  activeVersion: z.number().int().min(1).nullable(),
  enforceFrom: isoDate.nullable(),
  /** True while the active version is inside its grace period (advisory everywhere). */
  inGracePeriod: z.boolean(),
  pendingVersionId: uuid.nullable(),
  pendingVersion: z.number().int().min(1).nullable(),
  /** Whether the pending version defines the policy or retires it; null when nothing is pending. */
  pendingVersionKind: z.enum(['define', 'retire']).nullable(),
  latestVersion: z.number().int().min(1),
  createdAt: isoDate,
  createdBy: z.string(),
  updatedAt: isoDate,
}).strict();

export const policyDetailResponseSchema = z.object({
  policy: policyHeadResponseSchema,
  versions: z.array(policyVersionResponseSchema),
  events: z.array(policyVersionEventResponseSchema),
  votes: z.array(policyVoteResponseSchema),
  compileRecords: z.array(z.object({ id: uuid, status: z.string(), requestedBy: z.string(), createdAt: isoDate }).strict()),
  /** Approvals needed under the quorum configuration in force now. */
  requiredApprovals: z.number().int().min(1),
}).strict();

export const voteResponseSchema = z.object({
  vote: policyVoteResponseSchema,
  versionState: versionStatusSchema,
}).strict();

const notBoth = (b: { graceDays?: number; enforceFrom?: string }) => !(b.graceDays !== undefined && b.enforceFrom !== undefined);
const proposeBase = z.object({
  compileRecordId: uuid,
  title: singleLine(3, 120),
  tier: tierSchema,
  owningBoardIds: z.array(uuid).min(1).max(10).refine((ids) => new Set(ids).size === ids.length, 'owningBoardIds must not repeat'),
  /** An edited rule; re-validated and re-checked against the compile record's examples. */
  rule: z.unknown().optional(),
  graceDays: z.number().int().min(0).max(365).optional(),
  enforceFrom: isoDate.optional(),
});

export const proposePolicyRequestSchema = proposeBase.extend({
  policyKey: z.string().regex(/^corp\.[a-z0-9][a-z0-9._-]{0,84}$/, 'corp. followed by lowercase letters, digits, ., _ or -'),
}).strict().refine(notBoth, 'give graceDays or enforceFrom, not both');

export const proposeVersionRequestSchema = proposeBase.strict().refine(notBoth, 'give graceDays or enforceFrom, not both');

export const retirePolicyRequestSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

export const voteRequestSchema = z.object({
  vote: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(2000).optional(),
}).strict();

export const policyListQuerySchema = z.object({
  state: z.enum(['draft', 'proposed', 'active', 'retired']).optional(),
}).strict();

export const policyExportResponseSchema = z.object({
  kind: z.literal('nomus.cpg-policy-export.v1'),
  orgId: uuid,
  exportedAt: isoDate,
  content: z.object({
    policies: z.array(z.object({
      policyId: uuid,
      policyKey: z.string(),
      createdAt: isoDate,
      createdBy: z.string(),
      versions: z.array(policyVersionResponseSchema),
      events: z.array(policyVersionEventResponseSchema),
      votes: z.array(policyVoteResponseSchema),
    }).strict()),
    quorumVersions: z.array(quorumVersionSummarySchema.extend({ signature: z.string() }).strict()),
  }).strict(),
  /** sha256(canonicalJson(content)). */
  contentHash: sha256Hex,
  /** Ed25519 over canonicalJson({kind, orgId, exportedAt, contentHash}). */
  signature: z.string().min(1),
}).strict();

export type BoardResponse = z.infer<typeof boardResponseSchema>;
export type BoardMemberResponse = z.infer<typeof boardMemberResponseSchema>;
export type CompileRecordResponse = z.infer<typeof compileRecordResponseSchema>;
export type PolicyHeadResponse = z.infer<typeof policyHeadResponseSchema>;
export type PolicyVersionResponse = z.infer<typeof policyVersionResponseSchema>;
export type PolicyDetailResponse = z.infer<typeof policyDetailResponseSchema>;
export type PolicyExportResponse = z.infer<typeof policyExportResponseSchema>;

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
    boards: boardsOfUser(db, orgId, u.id),
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
