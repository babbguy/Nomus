import { z } from 'zod';

/**
 * Response contracts of the Corporate Policy Governance API (/api/v1/cpg),
 * endpoints E1 to E37, mirroring engine/src/cpg/contracts.ts.
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

/** Shared by every CPG contract module. */
export const uuid = z.string().uuid();
export const isoDate = z.string().datetime();
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

const signedRecordSchema = z.object({ id: uuid, signedPayloadCanonicalJson: z.string(), signature: z.string() }).strict();

/** E73: the signed governance audit export the Auditor downloads (verifiable offline). */
export const governanceExportSchema = z.object({
  kind: z.literal('nomus.cpg-governance-export.v1'),
  orgId: uuid,
  exportedAt: isoDate,
  content: z.object({
    chainValid: z.boolean(),
    auditEvents: z.array(auditEventSchema),
    decisions: z.array(signedRecordSchema),
    revocations: z.array(signedRecordSchema),
    caseClosures: z.array(signedRecordSchema),
    ciRuns: z.array(signedRecordSchema),
  }).strict(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string(),
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
  roles: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), isSystem: z.boolean() }).strict()),
  identity: z.enum(['session', 'user_key', 'org_key']),
}).strict();

export const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) }).strict();

// ═══ Phase 2: boards, quorum, compile and the policy log (E19–E37) ══════

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const tierSchema = z.enum(['advisory', 'review-required', 'prohibited']);
export const boardKindSchema = z.enum(['governance', 'legal', 'ai', 'security', 'custom']);

export const boardMemberSchema = z.object({
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

export const boardSchema = z.object({
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
  /** Active members; null for callers without boards.manage. */
  members: z.array(boardMemberSchema).nullable(),
}).strict();

/**
 * The corporate rule as the engine returns it (after its own validation, so
 * every default is filled in), and the shape an author may edit (the same
 * defaults apply). It mirrors the structure of
 * packages/scanner/src/corporate/rule-schema.ts without the closed
 * vocabularies: the server is the authority on what a rule may contain
 * (vocabularies, regex safety, globs, limits) and revalidates every edited rule.
 */
const strings = z.array(z.string());
export const ruleMatcherSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sdk_call'), sdks: strings, methods: strings.optional() }).strict(),
  z.object({ kind: z.literal('sdk_import'), sdks: strings }).strict(),
  z.object({ kind: z.literal('capability'), capabilities: strings }).strict(),
  z.object({ kind: z.literal('data_pattern'), categories: strings, labels: strings.optional() }).strict(),
  z.object({ kind: z.literal('data_flow'), sources: strings.optional(), sinks: strings.optional() }).strict(),
  z.object({
    kind: z.literal('line_regex'),
    pattern: z.object({ source: z.string(), flags: z.enum(['', 'i']), ignoreComments: z.boolean().default(true) }).strict(),
  }).strict(),
]);

export const corporateRuleSchema = z.object({
  schemaVersion: z.literal(1),
  match: z.object({
    all: z.array(ruleMatcherSchema).min(1),
    withinLines: z.number().int().nullable().default(null),
    unless: z.array(ruleMatcherSchema).default([]),
    unlessScope: z.enum(['window', 'file']).default('file'),
  }).strict(),
  files: z.object({
    include: strings.min(1).default(['**/*']),
    exclude: strings.default([]),
    languages: strings.optional(),
  }).strict(),
  snippet: z.object({ contextBefore: z.number().int().default(0), contextAfter: z.number().int().default(0) }).strict().default({}),
  message: z.string().min(10).max(300),
}).strict();

const exampleSchema = z.object({ path: z.string(), code: z.string() }).strict();

export const compileStatusSchema = z.enum(['compiled', 'rejected_unexpressible', 'rejected_schema', 'rejected_validation', 'rejected_examples', 'llm_error']);

export const exampleResultSchema = z.object({
  kind: z.enum(['violating', 'compliant']),
  index: z.number().int().min(0),
  path: z.string(),
  expected: z.enum(['finding', 'no_finding']),
  findings: z.number().int().min(0),
  lines: z.array(z.number().int().min(1)),
  passed: z.boolean(),
  note: z.string().nullable(),
}).strict();

export const compileRecordSchema = z.object({
  id: uuid,
  policyId: uuid.nullable(),
  requestedBy: z.string(),
  status: compileStatusSchema,
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
  exampleResults: z.array(exampleResultSchema).nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  createdAt: isoDate,
}).strict();

export const versionStatusSchema = z.enum(['pending', 'active', 'superseded', 'rejected', 'withdrawn', 'expired', 'retired']);
export const policyStateSchema = z.enum(['draft', 'proposed', 'active', 'retired']);

export const policyVersionSchema = z.object({
  id: uuid,
  version: z.number().int().min(1),
  kind: z.enum(['define', 'retire']),
  status: versionStatusSchema,
  title: z.string(),
  plainText: z.string(),
  tier: tierSchema,
  owningBoards: z.array(boardRefSchema).min(1),
  rule: corporateRuleSchema.nullable(),
  ruleHash: sha256Hex.nullable(),
  compileRecordId: uuid.nullable(),
  editedFromCompile: z.boolean(),
  graceDays: z.number().int().nullable(),
  enforceFromRequested: isoDate.nullable(),
  enforceFrom: isoDate.nullable(),
  activatedAt: isoDate.nullable(),
  signature: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDate,
}).strict();

export const policyEventSchema = z.object({
  id: uuid,
  versionId: uuid,
  version: z.number().int().min(1),
  event: z.enum(['proposed', 'approved', 'rejected', 'withdrawn', 'activated', 'superseded', 'retired', 'expired_proposal']),
  actor: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
}).strict();

export const policyVoteSchema = z.object({
  id: uuid,
  versionId: uuid,
  voterUserId: uuid,
  voterName: z.string(),
  vote: z.enum(['approve', 'reject']),
  comment: z.string(),
  quorumConfigVersion: z.number().int().min(1),
  createdAt: isoDate,
}).strict();

export const policyHeadSchema = z.object({
  policyId: uuid,
  policyKey: z.string(),
  state: policyStateSchema,
  title: z.string(),
  tier: tierSchema,
  owningBoards: z.array(boardRefSchema),
  activeVersion: z.number().int().min(1).nullable(),
  enforceFrom: isoDate.nullable(),
  inGracePeriod: z.boolean(),
  pendingVersionId: uuid.nullable(),
  pendingVersion: z.number().int().min(1).nullable(),
  pendingVersionKind: z.enum(['define', 'retire']).nullable(),
  latestVersion: z.number().int().min(1),
  createdAt: isoDate,
  createdBy: z.string(),
  updatedAt: isoDate,
}).strict();

export const policyDetailSchema = z.object({
  policy: policyHeadSchema,
  versions: z.array(policyVersionSchema),
  events: z.array(policyEventSchema),
  votes: z.array(policyVoteSchema),
  compileRecords: z.array(z.object({ id: uuid, status: z.string(), requestedBy: z.string(), createdAt: isoDate }).strict()),
  requiredApprovals: z.number().int().min(1),
}).strict();

export const voteResultSchema = z.object({
  vote: policyVoteSchema,
  versionState: versionStatusSchema,
}).strict();

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
export type GovernanceExport = z.infer<typeof governanceExportSchema>;
export type AuditList = z.infer<typeof auditListSchema>;
export type CpgMe = z.infer<typeof meSchema>;
export type Tier = z.infer<typeof tierSchema>;
export type BoardKind = z.infer<typeof boardKindSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardMember = z.infer<typeof boardMemberSchema>;
export type CorporateRule = z.infer<typeof corporateRuleSchema>;
export type RuleMatcher = z.infer<typeof ruleMatcherSchema>;
export type CompileStatus = z.infer<typeof compileStatusSchema>;
export type ExampleResult = z.infer<typeof exampleResultSchema>;
export type CompileRecord = z.infer<typeof compileRecordSchema>;
export type VersionStatus = z.infer<typeof versionStatusSchema>;
export type PolicyState = z.infer<typeof policyStateSchema>;
export type PolicyVersion = z.infer<typeof policyVersionSchema>;
export type PolicyEvent = z.infer<typeof policyEventSchema>;
export type PolicyVote = z.infer<typeof policyVoteSchema>;
export type PolicyHead = z.infer<typeof policyHeadSchema>;
export type PolicyDetail = z.infer<typeof policyDetailSchema>;
export type VoteResult = z.infer<typeof voteResultSchema>;
export type MePermission = z.infer<typeof mePermissionSchema>;
