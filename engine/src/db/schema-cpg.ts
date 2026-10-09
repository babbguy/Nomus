import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle declarations of the CPG tables, for typed queries only.
 *
 * The source of truth is the raw SQL in db/migrations/cpg-*.ts (constraints,
 * indexes and triggers live there). These tables are deliberately NOT in the
 * `tables` list of migrate.ts. schema-cpg.test.ts asserts that the column
 * names declared here equal `PRAGMA table_info` for every CPG table.
 */

export const schemaMigrations = sqliteTable('schema_migrations', {
  id: text('id').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: text('applied_at').notNull(),
});

export const cpgPermissions = sqliteTable('cpg_permissions', {
  key: text('key').primaryKey(),
  category: text('category', { enum: ['org', 'rbac', 'policy', 'case', 'exception', 'audit', 'integration', 'ci'] }).notNull(),
  scopable: integer('scopable', { mode: 'boolean' }).notNull(),
  description: text('description').notNull(),
});

export const cpgRoles = sqliteTable('cpg_roles', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  archivedAt: text('archived_at'),
  archivedBy: text('archived_by'),
});

export const cpgRolePermissions = sqliteTable('cpg_role_permissions', {
  roleId: text('role_id').notNull(),
  permissionKey: text('permission_key').notNull(),
}, (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })]);

export const cpgUserRoles = sqliteTable('cpg_user_roles', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  roleId: text('role_id').notNull(),
  scopeType: text('scope_type', { enum: ['org', 'team', 'repo'] }).notNull(),
  scopeId: text('scope_id'),
  grantedBy: text('granted_by').notNull(),
  grantedAt: text('granted_at').notNull(),
  revokedAt: text('revoked_at'),
  revokedBy: text('revoked_by'),
  revokeReason: text('revoke_reason'),
});

export const cpgTeams = sqliteTable('cpg_teams', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  archivedAt: text('archived_at'),
});

export const cpgTeamRepos = sqliteTable('cpg_team_repos', {
  teamId: text('team_id').notNull(),
  repoPattern: text('repo_pattern').notNull(),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.repoPattern] })]);

export const cpgOrgSettings = sqliteTable('cpg_org_settings', {
  orgId: text('org_id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  reviewerContextLlm: integer('reviewer_context_llm', { mode: 'boolean' }).notNull().default(false),
  rbacMigratedAt: text('rbac_migrated_at'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const cpgAuditEvents = sqliteTable('cpg_audit_events', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  seq: integer('seq').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  payload: text('payload').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  createdAt: text('created_at').notNull(),
});

// ─── Phase 2: boards, quorum and the policy registry (cpg_0002) ────────

export const cpgBoards = sqliteTable('cpg_boards', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['governance', 'legal', 'ai', 'security', 'custom'] }).notNull(),
  description: text('description').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  archivedAt: text('archived_at'),
  archivedBy: text('archived_by'),
});

export const cpgBoardMembers = sqliteTable('cpg_board_members', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull(),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(),
  removedAt: text('removed_at'),
  removedBy: text('removed_by'),
});

export const cpgQuorumConfigVersions = sqliteTable('cpg_quorum_config_versions', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  version: integer('version').notNull(),
  config: text('config').notNull(),
  configHash: text('config_hash').notNull(),
  changeNote: text('change_note').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  signature: text('signature').notNull(),
});

export const cpgPolicies = sqliteTable('cpg_policies', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  policyKey: text('policy_key').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  originCaseId: text('origin_case_id'),
});

export const cpgCompileRecords = sqliteTable('cpg_compile_records', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  policyId: text('policy_id'),
  requestedBy: text('requested_by').notNull(),
  inputText: text('input_text').notNull(),
  inputHash: text('input_hash').notNull(),
  examples: text('examples').notNull(),
  promptVersion: integer('prompt_version').notNull(),
  provider: text('provider'),
  model: text('model'),
  rawOutput: text('raw_output'),
  status: text('status', { enum: ['compiled', 'rejected_unexpressible', 'rejected_schema', 'rejected_validation', 'rejected_examples', 'llm_error'] }).notNull(),
  rejection: text('rejection'),
  suggestion: text('suggestion'),
  compiledRule: text('compiled_rule'),
  compiledRuleHash: text('compiled_rule_hash'),
  exampleResults: text('example_results'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  createdAt: text('created_at').notNull(),
});

export const cpgPolicyVersions = sqliteTable('cpg_policy_versions', {
  id: text('id').primaryKey(),
  policyId: text('policy_id').notNull(),
  orgId: text('org_id').notNull(),
  version: integer('version').notNull(),
  kind: text('kind', { enum: ['define', 'retire'] }).notNull(),
  title: text('title').notNull(),
  plainText: text('plain_text').notNull(),
  tier: text('tier', { enum: ['advisory', 'review-required', 'prohibited'] }).notNull(),
  owningBoardIds: text('owning_board_ids').notNull(),
  rule: text('rule'),
  ruleHash: text('rule_hash'),
  compileRecordId: text('compile_record_id'),
  editedFromCompile: integer('edited_from_compile', { mode: 'boolean' }).notNull(),
  graceDays: integer('grace_days'),
  enforceFromRequested: text('enforce_from_requested'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgPolicyVersionEvents = sqliteTable('cpg_policy_version_events', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull(),
  orgId: text('org_id').notNull(),
  event: text('event', { enum: ['proposed', 'approved', 'rejected', 'withdrawn', 'activated', 'superseded', 'retired', 'expired_proposal'] }).notNull(),
  actor: text('actor').notNull(),
  details: text('details').notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgPolicyApprovals = sqliteTable('cpg_policy_approvals', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull(),
  orgId: text('org_id').notNull(),
  voterUserId: text('voter_user_id').notNull(),
  vote: text('vote', { enum: ['approve', 'reject'] }).notNull(),
  comment: text('comment').notNull().default(''),
  quorumConfigVersion: integer('quorum_config_version').notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgPolicyHeads = sqliteTable('cpg_policy_heads', {
  policyId: text('policy_id').primaryKey(),
  orgId: text('org_id').notNull(),
  state: text('state', { enum: ['draft', 'proposed', 'active', 'retired'] }).notNull(),
  activeVersionId: text('active_version_id'),
  activeVersion: integer('active_version'),
  enforceFrom: text('enforce_from'),
  activationSignature: text('activation_signature'),
  pendingVersionId: text('pending_version_id'),
  updatedAt: text('updated_at').notNull(),
});

export const CASE_STATES = ['open', 'in_review', 'changes_requested', 'decided', 'closed'] as const;
const CLOSE_REASONS = ['merged', 'withdrawn', 'closed_by_reviewer', 'pr_closed_unmerged', 'abandoned'] as const;
const TIERS = ['advisory', 'review-required', 'prohibited'] as const;

export const cpgCases = sqliteTable('cpg_cases', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  ref: text('ref').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull(),
  prNumber: integer('pr_number'),
  state: text('state', { enum: CASE_STATES }).notNull(),
  closeReason: text('close_reason', { enum: CLOSE_REASONS }),
  latestRevision: integer('latest_revision').notNull().default(0),
  openedBy: text('opened_by').notNull(),
  openedAt: text('opened_at').notNull(),
  closedAt: text('closed_at'),
  closedBy: text('closed_by'),
  closureSignature: text('closure_signature'),
  updatedAt: text('updated_at').notNull(),
});

export const cpgCaseEvents = sqliteTable('cpg_case_events', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull(),
  orgId: text('org_id').notNull(),
  seq: integer('seq').notNull(),
  event: text('event', {
    enum: ['opened', 'revision_added', 'submitted', 'pr_attached', 'pr_changed', 'commit_linked', 'ci_result', 'state_changed',
      'changes_requested', 'justification_added', 'comment_added', 'proposal_created', 'decision_recorded',
      'policy_proposed_from_case', 'integration_linked', 'closed'],
  }).notNull(),
  actor: text('actor').notNull(),
  details: text('details').notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgCaseRevisions = sqliteTable('cpg_case_revisions', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull(),
  orgId: text('org_id').notNull(),
  revision: integer('revision').notNull(),
  source: text('source', { enum: ['vscode', 'ci', 'dashboard'] }).notNull(),
  headSha: text('head_sha'),
  bundleHash: text('bundle_hash').notNull(),
  findingsDigest: text('findings_digest').notNull(),
  addedCount: integer('added_count').notNull(),
  carriedCount: integer('carried_count').notNull(),
  resolvedCount: integer('resolved_count').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgSnippets = sqliteTable('cpg_snippets', {
  orgId: text('org_id').notNull(),
  snippetHash: text('snippet_hash').notNull(),
  normalizedText: text('normalized_text').notNull(),
  lineCount: integer('line_count').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.snippetHash] })]);

export const cpgCaseFindings = sqliteTable('cpg_case_findings', {
  id: text('id').primaryKey(),
  revisionId: text('revision_id').notNull(),
  caseId: text('case_id').notNull(),
  orgId: text('org_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  snippetHash: text('snippet_hash').notNull(),
  policyId: text('policy_id').notNull(),
  policyVersionId: text('policy_version_id').notNull(),
  policyKey: text('policy_key').notNull(),
  policyVersion: integer('policy_version').notNull(),
  tier: text('tier', { enum: TIERS }).notNull(),
  enforced: integer('enforced', { mode: 'boolean' }).notNull(),
  filePath: text('file_path').notNull(),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  language: text('language'),
  statusAtRevision: text('status_at_revision', { enum: ['new', 'carried'] }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgReviewerContexts = sqliteTable('cpg_reviewer_contexts', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  snippetHash: text('snippet_hash').notNull(),
  policyVersionId: text('policy_version_id').notNull(),
  status: text('status', { enum: ['generated', 'failed', 'disabled'] }).notNull(),
  whatItDoes: text('what_it_does'),
  whyFlagged: text('why_flagged'),
  provider: text('provider'),
  model: text('model'),
  promptVersion: integer('prompt_version').notNull(),
  attempt: integer('attempt').notNull().default(1),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

export const cpgJustifications = sqliteTable('cpg_justifications', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull(),
  orgId: text('org_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  authorUserId: text('author_user_id').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
});

export const cpgComments = sqliteTable('cpg_comments', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull(),
  orgId: text('org_id').notNull(),
  threadId: text('thread_id').notNull(),
  parentId: text('parent_id'),
  kind: text('kind', { enum: ['comment', 'change_request', 'reply'] }).notNull(),
  boardId: text('board_id'),
  fingerprints: text('fingerprints').notNull(),
  authorUserId: text('author_user_id').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
});

/** Every CPG table declared above, for the column-parity test. */
export const CPG_DRIZZLE_TABLES = [
  schemaMigrations,
  cpgPermissions,
  cpgRoles,
  cpgRolePermissions,
  cpgUserRoles,
  cpgTeams,
  cpgTeamRepos,
  cpgOrgSettings,
  cpgAuditEvents,
  cpgBoards,
  cpgBoardMembers,
  cpgQuorumConfigVersions,
  cpgPolicies,
  cpgCompileRecords,
  cpgPolicyVersions,
  cpgPolicyVersionEvents,
  cpgPolicyApprovals,
  cpgPolicyHeads,
  cpgCases,
  cpgCaseEvents,
  cpgCaseRevisions,
  cpgSnippets,
  cpgCaseFindings,
  cpgReviewerContexts,
  cpgJustifications,
  cpgComments,
] as const;
