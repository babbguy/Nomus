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
] as const;
