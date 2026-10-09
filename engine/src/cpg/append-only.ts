/**
 * The strictly append-only CPG tables (design spec §2.4). Each one has
 * BEFORE UPDATE and BEFORE DELETE triggers that abort, and append-only.test.ts
 * proves both the triggers and that no code path issues an UPDATE or DELETE
 * against them.
 *
 * `drizzleName` is the export in db/schema-cpg.ts, used by the code scan to
 * catch `.update(x)` / `.delete(x)` calls. Later phases append to this list.
 */
export const APPEND_ONLY_TABLES = [
  { table: 'schema_migrations', drizzleName: 'schemaMigrations' },
  { table: 'cpg_permissions', drizzleName: 'cpgPermissions' },
  { table: 'cpg_audit_events', drizzleName: 'cpgAuditEvents' },
  { table: 'cpg_quorum_config_versions', drizzleName: 'cpgQuorumConfigVersions' },
  { table: 'cpg_policies', drizzleName: 'cpgPolicies' },
  { table: 'cpg_compile_records', drizzleName: 'cpgCompileRecords' },
  { table: 'cpg_policy_versions', drizzleName: 'cpgPolicyVersions' },
  { table: 'cpg_policy_version_events', drizzleName: 'cpgPolicyVersionEvents' },
  { table: 'cpg_policy_approvals', drizzleName: 'cpgPolicyApprovals' },
  { table: 'cpg_case_events', drizzleName: 'cpgCaseEvents' },
  { table: 'cpg_case_revisions', drizzleName: 'cpgCaseRevisions' },
  { table: 'cpg_snippets', drizzleName: 'cpgSnippets' },
  { table: 'cpg_case_findings', drizzleName: 'cpgCaseFindings' },
  { table: 'cpg_reviewer_contexts', drizzleName: 'cpgReviewerContexts' },
  { table: 'cpg_justifications', drizzleName: 'cpgJustifications' },
  { table: 'cpg_comments', drizzleName: 'cpgComments' },
  { table: 'cpg_proposals', drizzleName: 'cpgProposals' },
  { table: 'cpg_votes', drizzleName: 'cpgVotes' },
  { table: 'cpg_proposal_events', drizzleName: 'cpgProposalEvents' },
  { table: 'cpg_decisions', drizzleName: 'cpgDecisions' },
  { table: 'cpg_revocations', drizzleName: 'cpgRevocations' },
  { table: 'cpg_ci_runs', drizzleName: 'cpgCiRuns' },
] as const;

/**
 * Tables whose only permitted UPDATE writes a revocation/removal once
 * (§2.4 "write-once columns"). DELETE is always refused.
 */
export const WRITE_ONCE_TABLES = [
  { table: 'cpg_user_roles', drizzleName: 'cpgUserRoles' },
  { table: 'cpg_board_members', drizzleName: 'cpgBoardMembers' },
] as const;

/**
 * Projection tables: mutable only in whitelisted columns (trigger-guarded),
 * never deleted.
 */
export const PROJECTION_TABLES = [
  { table: 'cpg_roles', drizzleName: 'cpgRoles' },
  { table: 'cpg_teams', drizzleName: 'cpgTeams' },
  { table: 'cpg_org_settings', drizzleName: 'cpgOrgSettings' },
  { table: 'cpg_boards', drizzleName: 'cpgBoards' },
  { table: 'cpg_policy_heads', drizzleName: 'cpgPolicyHeads' },
  { table: 'cpg_cases', drizzleName: 'cpgCases' },
] as const;
