import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { cpgRoles, cpgTeamRepos, cpgUserRoles } from '../db/schema-cpg.js';
import { PERMISSION_KEYS } from './rbac/catalog.js';
import { rolePermissionKeys, type GrantRow, type RoleRow } from './rbac/grants.js';
import {
  CANONICAL_REPO_RE, FINGERPRINT_RE, TIERS, caseStatusSchema, corporateRuleSchema, requestReviewRequestSchema,
} from '@nomus/scanner/corporate';
import { quorumConfigSchema } from './quorum/schema.js';
import { requirementSchema } from './quorum/evaluate.js';
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

// ─── Review cases (Phase 4, E40 to E52) ────────────────────────────────
// The shared client contracts (request review, case status, finding
// resolutions) are in @nomus/scanner/corporate; these are engine-only.

const fingerprintSchema = z.string().regex(FINGERPRINT_RE);
const caseStateSchema = z.enum(['open', 'in_review', 'changes_requested', 'decided', 'closed']);

const caseLaneSchema = caseStatusSchema.shape.lanes.element;

/** Who did something: the actor (`user:<id>`, `system:<what>`) and, for a user, their name. */
const actorRefSchema = z.object({ actor: z.string(), name: z.string().nullable() }).strict();

export const caseSummaryResponseSchema = z.object({
  id: uuid, ref: z.string(), repo: z.string(), branch: z.string(), prNumber: z.number().int().nullable(),
  state: caseStateSchema, closeReason: z.string().nullable(), latestRevision: z.number().int(),
  openedAt: isoDate, updatedAt: isoDate, closedAt: isoDate.nullable(),
  openedBy: actorRefSchema, lanes: z.array(caseLaneSchema),
}).strict();

export const caseListResponseSchema = z.object({ items: z.array(caseSummaryResponseSchema), nextCursor: z.string().nullable() }).strict();

export const justificationResponseSchema = z.object({
  id: uuid, fingerprint: fingerprintSchema, authorUserId: uuid, authorName: z.string(), body: z.string(), createdAt: isoDate,
}).strict();

export const commentResponseSchema = z.object({
  id: uuid, threadId: uuid, parentId: uuid.nullable(), kind: z.enum(['comment', 'change_request', 'reply']), boardId: uuid.nullable(),
  fingerprints: z.array(fingerprintSchema), authorUserId: uuid, authorName: z.string(), body: z.string(), createdAt: isoDate,
}).strict();

export const revisionSummaryResponseSchema = z.object({
  revision: z.number().int().min(1), source: z.enum(['vscode', 'ci', 'dashboard']), headSha: z.string().nullable(),
  findingsDigest: sha256Hex, addedCount: z.number().int(), carriedCount: z.number().int(), resolvedCount: z.number().int(), createdAt: isoDate,
}).strict();

/** The signed closure record of a closed case (§13.3), with the result of verifying its signature now. */
export const caseClosureResponseSchema = z.object({
  reason: z.string(), note: z.string().nullable(), closedAt: isoDate, closedBy: actorRefSchema,
  record: z.record(z.unknown()), signature: z.string(), signatureValid: z.boolean(),
}).strict();

export const caseDetailResponseSchema = z.object({
  case: caseStatusSchema,
  openedAt: isoDate,
  openedBy: actorRefSchema,
  closure: caseClosureResponseSchema.nullable(),
  /** What the caller may do on this case's repository (the server re-checks every write). */
  viewer: z.object({ comment: z.boolean(), review: z.boolean(), close: z.boolean(), withdraw: z.boolean() }).strict(),
  revisions: z.array(revisionSummaryResponseSchema),
  justifications: z.array(justificationResponseSchema),
  comments: z.array(commentResponseSchema),
}).strict();

export const caseFindingResponseSchema = z.object({
  id: uuid, fingerprint: fingerprintSchema, policyId: uuid, policyKey: z.string(), policyTitle: z.string(), policyVersion: z.number().int(),
  tier: z.enum(TIERS), blocking: z.boolean(), owningBoardIds: z.array(uuid),
  statusAtRevision: z.enum(['new', 'carried']), filePath: z.string(), startLine: z.number().int(), endLine: z.number().int(),
  language: z.string().nullable(), snippet: z.string(), justification: justificationResponseSchema.nullable(),
  /** The stored reviewer context of the snippet, if any (E51 generates one on first request). */
  contextStatus: z.enum(['none', 'generated', 'failed']),
}).strict();

export const revisionDetailResponseSchema = z.object({
  revision: revisionSummaryResponseSchema, findings: z.array(caseFindingResponseSchema),
}).strict();

export const reviewerContextResponseSchema = z.object({
  findingId: uuid,
  status: z.enum(['disabled', 'generated', 'failed']),
  /** "Generated by <provider> <model>" for generated context; null otherwise. */
  label: z.string().nullable(),
  whatItDoes: z.string().nullable(), whyFlagged: z.string().nullable(),
  provider: z.string().nullable(), model: z.string().nullable(),
  promptVersion: z.number().int(), attempt: z.number().int().nullable(), error: z.string().nullable(), createdAt: isoDate.nullable(),
}).strict();

export const caseListQuerySchema = z.object({
  state: caseStateSchema.optional(),
  repo: z.string().regex(CANONICAL_REPO_RE).optional(),
  /** Cases with a lane for this board (a latest-revision finding the board owns). */
  boardId: uuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
}).strict();

export const caseByBranchQuerySchema = requestReviewRequestSchema.pick({ repo: true, branch: true }).strict();

export const commentRequestSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  kind: z.enum(['comment', 'reply']),
  threadId: uuid.optional(),
  resolves: z.boolean().optional(),
  fingerprints: z.array(fingerprintSchema).max(500).default([]),
}).strict()
  .refine((b) => (b.kind === 'reply') === (b.threadId !== undefined), 'a reply names its threadId; a comment does not')
  .refine((b) => !b.resolves || b.kind === 'reply', 'only a reply can resolve a change request');

export const requestChangesRequestSchema = z.object({
  boardId: uuid, body: z.string().trim().min(1).max(8000), fingerprints: z.array(fingerprintSchema).min(1).max(500),
}).strict();

export const closeCaseRequestSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

export type CaseSummaryResponse = z.infer<typeof caseSummaryResponseSchema>;
export type JustificationResponse = z.infer<typeof justificationResponseSchema>;
export type CommentResponse = z.infer<typeof commentResponseSchema>;
export type ReviewerContextResponse = z.infer<typeof reviewerContextResponseSchema>;

// ─── Proposals, votes and decisions (Phase 5, E54 to E59) ──────────────

const outcomeSchema = z.enum(['approve', 'reject']);
const decisionScopeSchema = z.enum(['snippet', 'bulk', 'standing']);
export const proposalStatusSchema = z.enum(['pending', 'finalized', 'vetoed', 'invalidated', 'void', 'lapsed']);

export const proposalCreateRequestSchema = z.object({
  caseId: uuid,
  scope: z.enum(['snippet', 'bulk']),
  outcome: outcomeSchema,
  fingerprints: z.array(fingerprintSchema).min(1).max(500),
  /** Required for an approval (§4.3 step 6); a rejection never expires (D5). */
  expiresAt: isoDate.optional(),
  rationale: z.string().trim().min(20).max(4000),
}).strict()
  .refine((b) => new Set(b.fingerprints).size === b.fingerprints.length, { message: 'fingerprints must be distinct', path: ['fingerprints'] })
  .refine((b) => (b.scope === 'snippet') === (b.fingerprints.length === 1), { message: 'a snippet proposal decides one finding, a bulk proposal 2 to 500', path: ['fingerprints'] })
  .refine((b) => (b.outcome === 'approve') === (b.expiresAt !== undefined), { message: 'an approval needs expiresAt; a rejection has none', path: ['expiresAt'] });

export const proposalListQuerySchema = z.object({
  caseId: uuid,
  scope: z.enum(['snippet', 'bulk']).optional(),
  status: proposalStatusSchema.optional(),
}).strict();

// A vote's body is voteRequestSchema, shared with policy-version votes.

export const proposalVoteSchema = z.object({
  id: uuid, voterUserId: uuid, voterName: z.string(), vote: outcomeSchema,
  /** The required boards the voter was an active member of, and the permissions held, at vote time. */
  boards: z.array(uuid), permissions: z.array(z.string()), comment: z.string(), createdAt: isoDate,
}).strict();

export const proposalDetailResponseSchema = z.object({
  id: uuid, caseId: uuid.nullable(), scope: decisionScopeSchema, outcome: outcomeSchema, status: proposalStatusSchema,
  policyId: uuid, policyKey: z.string(), policyVersion: z.number().int(), tier: z.enum(TIERS),
  fingerprints: z.array(fingerprintSchema), requestedExpiresAt: isoDate.nullable(), rationale: z.string(),
  /** The requirement computed at creation; finalization re-evaluates it under the config then in force. */
  required: requirementSchema, quorumConfigVersionAtCreation: z.number().int(),
  proposer: z.object({ userId: uuid, name: z.string() }).strict(),
  createdAt: isoDate, lapsesAt: isoDate,
  votes: z.array(proposalVoteSchema), decisionIds: z.array(uuid),
  invalidation: z.object({ reason: z.string(), at: isoDate }).strict().nullable(),
  /** Whether the caller may vote now, else the code a vote would be refused with. */
  viewer: z.object({ canVote: z.boolean(), reason: z.string().nullable() }).strict(),
}).strict();

export const proposalListResponseSchema = z.object({ items: z.array(proposalDetailResponseSchema) }).strict();

export const castVoteResponseSchema = z.object({ vote: proposalVoteSchema, proposalStatus: proposalStatusSchema, decisionIds: z.array(uuid) }).strict();

export const decisionResponseSchema = z.object({
  id: uuid, proposalId: uuid, caseId: uuid.nullable(), scope: decisionScopeSchema, outcome: outcomeSchema,
  repo: z.string().nullable(), fingerprint: fingerprintSchema.nullable(), batchId: uuid.nullable(),
  policyId: uuid, policyKey: z.string(), policyVersion: z.number().int(), expiresAt: isoDate.nullable(),
  approverUserIds: z.array(uuid), quorumConfigVersion: z.number().int(), quorumConfigHash: sha256Hex, finalizedAt: isoDate,
  /** Canonical JSON (§13.2), signed with the instance Ed25519 key; verify it offline against /.well-known/nomus-keys. */
  signedPayload: z.string(), signature: z.string(), signatureValid: z.boolean(),
}).strict();

export type ProposalDetailResponse = z.infer<typeof proposalDetailResponseSchema>;
export type ProposalVoteResponse = z.infer<typeof proposalVoteSchema>;
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;
