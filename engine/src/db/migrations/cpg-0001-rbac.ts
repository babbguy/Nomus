import type { Migration } from './runner.js';
import {
  appendOnlyTriggers,
  boolCheck,
  immutableColumnsTrigger,
  isoCheck,
  isoOrNullCheck,
  noDeleteTrigger,
  sha256HexCheck,
  uuidCheck,
} from './sql-helpers.js';

/**
 * CPG Phase 1: RBAC, teams, org settings and the hash-chained audit log
 * (design spec §2.3, migration `cpg_0001_rbac`).
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */
export const cpg0001Rbac: Migration = {
  id: 'cpg_0001_rbac',
  statements: [
    // ── T2 cpg_permissions: static catalog, seeded from code with INSERT OR IGNORE
    `CREATE TABLE cpg_permissions (
      key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*.[a-z_]*' AND key NOT GLOB '*[^a-z_.]*' AND length(key) <= 64),
      category TEXT NOT NULL CHECK (category IN ('org','rbac','policy','case','exception','audit','integration','ci')),
      scopable INTEGER NOT NULL CHECK ${boolCheck('scopable')},
      description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500)
    )`,
    ...appendOnlyTriggers('cpg_permissions'),

    // ── T3 cpg_roles: projection; name, description and archive columns mutable
    `CREATE TABLE cpg_roles (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      key TEXT NOT NULL CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_]*' AND length(key) <= 50),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
      is_system INTEGER NOT NULL DEFAULT 0 CHECK ${boolCheck('is_system')},
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      archived_at TEXT NULL CHECK ${isoOrNullCheck('archived_at')},
      archived_by TEXT NULL,
      CHECK ((archived_at IS NULL) = (archived_by IS NULL))
    )`,
    'CREATE UNIQUE INDEX ux_cpg_roles_org_key ON cpg_roles (org_id, key)',
    immutableColumnsTrigger('cpg_roles', ['id', 'org_id', 'key', 'is_system', 'created_by', 'created_at']),
    `CREATE TRIGGER trg_cpg_roles_no_archive_system BEFORE UPDATE ON cpg_roles
      WHEN OLD.is_system = 1 AND NEW.archived_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'cpg_roles: system roles cannot be archived'); END`,
    noDeleteTrigger('cpg_roles'),

    // ── T4 cpg_role_permissions: current state, insert and delete only
    `CREATE TABLE cpg_role_permissions (
      role_id TEXT NOT NULL REFERENCES cpg_roles(id),
      permission_key TEXT NOT NULL REFERENCES cpg_permissions(key),
      PRIMARY KEY (role_id, permission_key)
    )`,
    `CREATE TRIGGER trg_cpg_role_permissions_no_update BEFORE UPDATE ON cpg_role_permissions
      BEGIN SELECT RAISE(ABORT, 'cpg_role_permissions rows are inserted or deleted, never updated'); END`,
    // Anti-lockout: the system org_admin role always keeps the two RBAC permissions.
    `CREATE TRIGGER trg_cpg_role_permissions_admin_lockout BEFORE DELETE ON cpg_role_permissions
      WHEN OLD.permission_key IN ('rbac.roles.manage', 'rbac.users.manage')
        AND EXISTS (SELECT 1 FROM cpg_roles r WHERE r.id = OLD.role_id AND r.is_system = 1 AND r.key = 'org_admin')
      BEGIN SELECT RAISE(ABORT, 'cpg_role_permissions: org_admin must keep rbac.roles.manage and rbac.users.manage'); END`,

    // ── T6 cpg_teams (created before grants, which may be team-scoped)
    `CREATE TABLE cpg_teams (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      key TEXT NOT NULL CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_-]*' AND length(key) <= 50),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      archived_at TEXT NULL CHECK ${isoOrNullCheck('archived_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_teams_org_key ON cpg_teams (org_id, key)',
    immutableColumnsTrigger('cpg_teams', ['id', 'org_id', 'key', 'created_by', 'created_at']),
    noDeleteTrigger('cpg_teams'),

    // ── T7 cpg_team_repos: current state, insert and delete only
    `CREATE TABLE cpg_team_repos (
      team_id TEXT NOT NULL REFERENCES cpg_teams(id),
      repo_pattern TEXT NOT NULL CHECK (repo_pattern = lower(repo_pattern) AND length(repo_pattern) BETWEEN 1 AND 200),
      added_by TEXT NOT NULL CHECK (length(added_by) BETWEEN 1 AND 100),
      added_at TEXT NOT NULL CHECK ${isoCheck('added_at')},
      PRIMARY KEY (team_id, repo_pattern)
    )`,
    `CREATE TRIGGER trg_cpg_team_repos_no_update BEFORE UPDATE ON cpg_team_repos
      BEGIN SELECT RAISE(ABORT, 'cpg_team_repos rows are inserted or deleted, never updated'); END`,

    // ── T5 cpg_user_roles (grants): semi-append-only, revocation written once
    `CREATE TABLE cpg_user_roles (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role_id TEXT NOT NULL REFERENCES cpg_roles(id),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('org','team','repo')),
      scope_id TEXT NULL,
      granted_by TEXT NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 100),
      granted_at TEXT NOT NULL CHECK ${isoCheck('granted_at')},
      revoked_at TEXT NULL CHECK ${isoOrNullCheck('revoked_at')},
      revoked_by TEXT NULL,
      revoke_reason TEXT NULL CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
      CHECK (
        (scope_type = 'org' AND scope_id IS NULL)
        OR (scope_type = 'team' AND scope_id IS NOT NULL AND ${uuidCheck('scope_id')})
        OR (scope_type = 'repo' AND scope_id IS NOT NULL AND scope_id = lower(scope_id) AND length(scope_id) BETWEEN 3 AND 200)
      ),
      CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
    )`,
    'CREATE INDEX ix_cpg_user_roles_user ON cpg_user_roles (user_id, revoked_at)',
    `CREATE UNIQUE INDEX ux_cpg_user_roles_active ON cpg_user_roles (user_id, role_id, scope_type, IFNULL(scope_id, ''))
      WHERE revoked_at IS NULL`,
    // A grant must stay inside one org: the role, the user and a scoping team all belong to it.
    `CREATE TRIGGER trg_cpg_user_roles_same_org BEFORE INSERT ON cpg_user_roles
      WHEN (SELECT org_id FROM cpg_roles WHERE id = NEW.role_id) IS NOT NEW.org_id
        OR (SELECT org_id FROM users WHERE id = NEW.user_id) IS NOT NEW.org_id
        OR (NEW.scope_type = 'team' AND (SELECT org_id FROM cpg_teams WHERE id = NEW.scope_id) IS NOT NEW.org_id)
      BEGIN SELECT RAISE(ABORT, 'cpg_user_roles: role, user and team must belong to the grant org'); END`,
    `CREATE TRIGGER trg_cpg_user_roles_revoke_once BEFORE UPDATE ON cpg_user_roles
      WHEN OLD.revoked_at IS NOT NULL
        OR NEW.revoked_at IS NULL
        OR NEW.id IS NOT OLD.id
        OR NEW.org_id IS NOT OLD.org_id
        OR NEW.user_id IS NOT OLD.user_id
        OR NEW.role_id IS NOT OLD.role_id
        OR NEW.scope_type IS NOT OLD.scope_type
        OR NEW.scope_id IS NOT OLD.scope_id
        OR NEW.granted_by IS NOT OLD.granted_by
        OR NEW.granted_at IS NOT OLD.granted_at
      BEGIN SELECT RAISE(ABORT, 'cpg_user_roles: only a single revocation may be recorded'); END`,
    noDeleteTrigger('cpg_user_roles'),

    // ── T8 cpg_org_settings: projection, every change audited
    `CREATE TABLE cpg_org_settings (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK ${boolCheck('enabled')},
      reviewer_context_llm INTEGER NOT NULL DEFAULT 0 CHECK ${boolCheck('reviewer_context_llm')},
      rbac_migrated_at TEXT NULL CHECK ${isoOrNullCheck('rbac_migrated_at')},
      updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
      updated_at TEXT NOT NULL CHECK ${isoCheck('updated_at')}
    )`,
    immutableColumnsTrigger('cpg_org_settings', ['org_id']),
    `CREATE TRIGGER trg_cpg_org_settings_migrated_once BEFORE UPDATE ON cpg_org_settings
      WHEN OLD.rbac_migrated_at IS NOT NULL AND NEW.rbac_migrated_at IS NOT OLD.rbac_migrated_at
      BEGIN SELECT RAISE(ABORT, 'cpg_org_settings: rbac_migrated_at is write-once'); END`,
    noDeleteTrigger('cpg_org_settings'),

    // ── T9 cpg_audit_events: hash-chained per org, strictly append-only
    `CREATE TABLE cpg_audit_events (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      seq INTEGER NOT NULL CHECK (seq >= 1),
      actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
      action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
      target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 50),
      target_id TEXT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      prev_hash TEXT NOT NULL CHECK ${sha256HexCheck('prev_hash')},
      hash TEXT NOT NULL CHECK ${sha256HexCheck('hash')},
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_audit_events_org_seq ON cpg_audit_events (org_id, seq)',
    ...appendOnlyTriggers('cpg_audit_events'),

    // ── api_keys.user_id (column added by the alterations list in migrate.ts)
    'CREATE INDEX ix_api_keys_user ON api_keys (user_id)',
  ],
};
