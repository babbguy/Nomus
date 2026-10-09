/**
 * Append-only enforcement (design spec §2.2, §2.4), proven two ways:
 *   1. the database refuses UPDATE and DELETE (triggers abort with
 *      SQLITE_CONSTRAINT_TRIGGER), and the write-once and projection guards
 *      allow exactly the declared changes;
 *   2. no engine source issues an UPDATE or DELETE against an append-only
 *      table (code scan).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { appendAuditEvent } from './audit/log.js';
import { APPEND_ONLY_TABLES, PROJECTION_TABLES, WRITE_ONCE_TABLES } from './append-only.js';

const sqlite = new Database(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const NOW = '2026-10-08T12:00:00.000Z';
let orgId: string;
let otherOrgId: string;
let userId: string;

function triggerError(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
}

function run(sql: string, ...params: unknown[]) {
  return sqlite.prepare(sql).run(...params);
}

function role(org: string, key: string): { id: string; is_system: number } {
  return sqlite.prepare('SELECT id, is_system FROM cpg_roles WHERE org_id = ? AND key = ?').get(org, key) as { id: string; is_system: number };
}

function insertOrg(): string {
  const id = randomUUID();
  run('INSERT INTO organizations (id, name, slug, jurisdiction_access, is_active, created_at, updated_at) VALUES (?, ?, ?, \'[]\', 1, ?, ?)', id, `Org ${id}`, `org-${id}`, NOW, NOW);
  return id;
}

function insertUser(org: string): string {
  const id = randomUUID();
  run(`INSERT INTO users (id, org_id, email, name, role, auth_provider, must_change_password, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'U', 'member', 'local', 0, 1, ?, ?)`, id, org, `${id}@gate.example.org`, NOW, NOW);
  return id;
}

const H = 'a'.repeat(64);
const registry = { boardId: '', policyId: '', compileId: '', versionId: '', authorId: '', approverId: '', memberId: '' };

/** One row in every Phase 2 table (cpg_0002), written with raw SQL. */
function seedRegistry(): void {
  registry.authorId = insertUser(orgId);
  registry.approverId = insertUser(orgId);
  registry.boardId = randomUUID();
  run("INSERT INTO cpg_boards (id, org_id, key, name, kind, created_by, created_at) VALUES (?, ?, 'ai', 'AI Review Board', 'ai', 'test', ?)", registry.boardId, orgId, NOW);
  registry.memberId = randomUUID();
  run("INSERT INTO cpg_board_members (id, board_id, org_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, 'test', ?)", registry.memberId, registry.boardId, orgId, registry.approverId, NOW);
  run("INSERT INTO cpg_quorum_config_versions (id, org_id, version, config, config_hash, change_note, created_by, created_at, signature) VALUES (?, ?, 1, '{}', ?, 'seed', 'system:seed', ?, 'sig')", randomUUID(), orgId, H, NOW);
  registry.policyId = randomUUID();
  run("INSERT INTO cpg_policies (id, org_id, policy_key, created_by, created_at) VALUES (?, ?, 'corp.no-direct-openai', ?, ?)", registry.policyId, orgId, `user:${registry.authorId}`, NOW);
  registry.compileId = randomUUID();
  run(`INSERT INTO cpg_compile_records (id, org_id, requested_by, input_text, input_hash, examples, prompt_version, status, compiled_rule, compiled_rule_hash, created_at)
       VALUES (?, ?, ?, 'Do not call OpenAI directly from code.', ?, '{}', 1, 'compiled', '{}', ?, ?)`, registry.compileId, orgId, `user:${registry.authorId}`, H, H, NOW);
  registry.versionId = randomUUID();
  run(`INSERT INTO cpg_policy_versions (id, policy_id, org_id, version, kind, title, plain_text, tier, owning_board_ids, rule, rule_hash, compile_record_id, edited_from_compile, created_by, created_at)
       VALUES (?, ?, ?, 1, 'define', 'No direct OpenAI', 'text', 'prohibited', ?, '{}', ?, ?, 0, ?, ?)`,
  registry.versionId, registry.policyId, orgId, JSON.stringify([registry.boardId]), H, registry.compileId, `user:${registry.authorId}`, NOW);
  run("INSERT INTO cpg_policy_version_events (id, version_id, org_id, event, actor, details, created_at) VALUES (?, ?, ?, 'proposed', 'test', '{}', ?)", randomUUID(), registry.versionId, orgId, NOW);
  run("INSERT INTO cpg_policy_approvals (id, version_id, org_id, voter_user_id, vote, quorum_config_version, created_at) VALUES (?, ?, ?, ?, 'approve', 1, ?)", randomUUID(), registry.versionId, orgId, registry.approverId, NOW);
  run("INSERT INTO cpg_policy_heads (policy_id, org_id, state, pending_version_id, updated_at) VALUES (?, ?, 'proposed', ?, ?)", registry.policyId, orgId, registry.versionId, NOW);
}

beforeAll(() => {
  runMigrations(db);
  orgId = insertOrg();
  otherOrgId = insertOrg();
  userId = insertUser(orgId);
  // Seed both orgs (system roles, settings) the way startup does.
  runMigrations(db);
  appendAuditEvent(db, { orgId, actor: 'test', action: 'test.event', targetType: 'test', targetId: null, payload: { a: 1 } });
  seedRegistry();
});

describe('strictly append-only tables refuse UPDATE and DELETE', () => {
  const firstRowSql: Record<string, string> = {
    schema_migrations: 'SELECT rowid FROM schema_migrations LIMIT 1',
    cpg_permissions: 'SELECT rowid FROM cpg_permissions LIMIT 1',
    cpg_audit_events: 'SELECT rowid FROM cpg_audit_events LIMIT 1',
    cpg_quorum_config_versions: 'SELECT rowid FROM cpg_quorum_config_versions LIMIT 1',
    cpg_policies: 'SELECT rowid FROM cpg_policies LIMIT 1',
    cpg_compile_records: 'SELECT rowid FROM cpg_compile_records LIMIT 1',
    cpg_policy_versions: 'SELECT rowid FROM cpg_policy_versions LIMIT 1',
    cpg_policy_version_events: 'SELECT rowid FROM cpg_policy_version_events LIMIT 1',
    cpg_policy_approvals: 'SELECT rowid FROM cpg_policy_approvals LIMIT 1',
  };

  for (const { table } of APPEND_ONLY_TABLES) {
    it(`${table}: UPDATE and DELETE abort with SQLITE_CONSTRAINT_TRIGGER`, () => {
      const row = sqlite.prepare(firstRowSql[table]).get() as { rowid: number } | undefined;
      expect(row, `${table} needs a row for this test`).toBeDefined();
      const firstCol = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)[1].name;
      expect(triggerError(() => run(`UPDATE ${table} SET ${firstCol} = ${firstCol} WHERE rowid = ?`, row!.rowid))).toBe('SQLITE_CONSTRAINT_TRIGGER');
      expect(triggerError(() => run(`DELETE FROM ${table} WHERE rowid = ?`, row!.rowid))).toBe('SQLITE_CONSTRAINT_TRIGGER');
      expect(triggerError(() => run(`DELETE FROM ${table}`))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    });
  }

  it('the table list covers every append-only table of the applied migrations', () => {
    const withBothTriggers = (sqlite.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%_no_update'").all() as Array<{ tbl_name: string }>)
      .map((r) => r.tbl_name)
      .filter((t) => (sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(`trg_${t}_no_update`) as { sql: string }).sql.includes('is append-only'));
    expect(withBothTriggers.sort()).toEqual(APPEND_ONLY_TABLES.map((t) => t.table).sort());
  });
});

describe('cpg_user_roles: revocation is written once, nothing else changes, nothing is deleted', () => {
  function grant(): string {
    const id = randomUUID();
    run(`INSERT INTO cpg_user_roles (id, org_id, user_id, role_id, scope_type, scope_id, granted_by, granted_at)
         VALUES (?, ?, ?, ?, 'repo', ?, 'test', ?)`, id, orgId, userId, role(orgId, 'auditor').id, `acme/${id.slice(0, 8)}`, NOW);
    return id;
  }

  it('allows one revocation, then refuses a second', () => {
    const id = grant();
    run('UPDATE cpg_user_roles SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?', NOW, 'test', 'r', id);
    expect(triggerError(() => run('UPDATE cpg_user_roles SET revoked_at = ?, revoked_by = ? WHERE id = ?', '2026-10-09T12:00:00.000Z', 'x', id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('UPDATE cpg_user_roles SET revoke_reason = ? WHERE id = ?', 'changed', id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });

  it('refuses changes to the grant itself and updates that do not revoke', () => {
    const id = grant();
    for (const sql of [
      `UPDATE cpg_user_roles SET role_id = '${role(orgId, 'org_admin').id}' WHERE id = ?`,
      "UPDATE cpg_user_roles SET scope_id = 'other/repo' WHERE id = ?",
      "UPDATE cpg_user_roles SET granted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      "UPDATE cpg_user_roles SET granted_by = 'someone' WHERE id = ?",
      "UPDATE cpg_user_roles SET revoke_reason = 'no revocation' WHERE id = ?",
    ]) {
      expect(triggerError(() => run(sql, id)), sql).toBe('SQLITE_CONSTRAINT_TRIGGER');
    }
    expect(triggerError(() => run('DELETE FROM cpg_user_roles WHERE id = ?', id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });

  it('refuses a grant whose role, user or team belongs to another org', () => {
    const insert = (roleId: string, scopeType: string, scopeId: string | null) => () => run(
      `INSERT INTO cpg_user_roles (id, org_id, user_id, role_id, scope_type, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`,
      randomUUID(), orgId, userId, roleId, scopeType, scopeId, NOW,
    );
    expect(triggerError(insert(role(otherOrgId, 'developer').id, 'org', null))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    const otherUser = insertUser(otherOrgId);
    expect(triggerError(() => run(
      `INSERT INTO cpg_user_roles (id, org_id, user_id, role_id, scope_type, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, 'org', NULL, 'test', ?)`,
      randomUUID(), orgId, otherUser, role(orgId, 'developer').id, NOW,
    ))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    const team = randomUUID();
    run("INSERT INTO cpg_teams (id, org_id, key, name, created_by, created_at) VALUES (?, ?, 'other', 'Other', 'test', ?)", team, otherOrgId, NOW);
    expect(triggerError(insert(role(orgId, 'auditor').id, 'team', team))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });

  it('enforces the scope pairing and one active grant per (user, role, scope)', () => {
    const insert = (scopeType: string, scopeId: string | null) => () => run(
      `INSERT INTO cpg_user_roles (id, org_id, user_id, role_id, scope_type, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`,
      randomUUID(), orgId, userId, role(orgId, 'policy_author').id, scopeType, scopeId, NOW,
    );
    expect(triggerError(insert('org', 'acme/x'))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(insert('repo', null))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(insert('repo', 'Acme/X'))).toBe('SQLITE_CONSTRAINT_CHECK');
    // The same-org trigger (BEFORE INSERT) or the CHECK refuses it, whichever runs first.
    expect(triggerError(insert('team', 'not-a-uuid'))).toMatch(/^SQLITE_CONSTRAINT_(CHECK|TRIGGER)$/);
    expect(triggerError(insert('org', null))).toBeNull();
    expect(triggerError(insert('org', null))).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });

  it('is listed as write-once', () => {
    expect(WRITE_ONCE_TABLES.map((t) => t.table)).toContain('cpg_user_roles');
  });
});

describe('projection guards', () => {
  it('cpg_roles: name, description and archive columns change; identity columns do not; system roles cannot be archived; no delete', () => {
    const custom = randomUUID();
    run("INSERT INTO cpg_roles (id, org_id, key, name, description, is_system, created_by, created_at) VALUES (?, ?, 'custom_one', 'Custom', '', 0, 'test', ?)", custom, orgId, NOW);
    expect(triggerError(() => run("UPDATE cpg_roles SET name = 'Renamed', description = 'd' WHERE id = ?", custom))).toBeNull();
    expect(triggerError(() => run("UPDATE cpg_roles SET archived_at = ?, archived_by = 'test' WHERE id = ?", NOW, custom))).toBeNull();
    for (const sql of [
      "UPDATE cpg_roles SET key = 'other_key' WHERE id = ?",
      `UPDATE cpg_roles SET org_id = '${otherOrgId}' WHERE id = ?`,
      'UPDATE cpg_roles SET is_system = 1 WHERE id = ?',
      "UPDATE cpg_roles SET created_by = 'x' WHERE id = ?",
      "UPDATE cpg_roles SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ]) {
      expect(triggerError(() => run(sql, custom)), sql).toBe('SQLITE_CONSTRAINT_TRIGGER');
    }
    const admin = role(orgId, 'org_admin').id;
    expect(triggerError(() => run("UPDATE cpg_roles SET archived_at = ?, archived_by = 'test' WHERE id = ?", NOW, admin))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('DELETE FROM cpg_roles WHERE id = ?', custom))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });

  it('cpg_role_permissions: the system org_admin role keeps the two RBAC permissions (anti-lockout)', () => {
    const admin = role(orgId, 'org_admin').id;
    for (const p of ['rbac.roles.manage', 'rbac.users.manage']) {
      expect(triggerError(() => run('DELETE FROM cpg_role_permissions WHERE role_id = ? AND permission_key = ?', admin, p))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    }
    // Other permissions of org_admin, and the same permissions on other roles, can be removed.
    expect(triggerError(() => run("DELETE FROM cpg_role_permissions WHERE role_id = ? AND permission_key = 'ci.read'", admin))).toBeNull();
    const custom = randomUUID();
    run("INSERT INTO cpg_roles (id, org_id, key, name, is_system, created_by, created_at) VALUES (?, ?, 'custom_admin', 'C', 0, 'test', ?)", custom, orgId, NOW);
    run("INSERT INTO cpg_role_permissions (role_id, permission_key) VALUES (?, 'rbac.users.manage')", custom);
    expect(triggerError(() => run("DELETE FROM cpg_role_permissions WHERE role_id = ? AND permission_key = 'rbac.users.manage'", custom))).toBeNull();
    expect(triggerError(() => run("UPDATE cpg_role_permissions SET permission_key = 'audit.read' WHERE role_id = ?", admin))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });

  it('cpg_teams: name and archive change; identity does not; no delete. cpg_team_repos: no update', () => {
    const team = randomUUID();
    run("INSERT INTO cpg_teams (id, org_id, key, name, created_by, created_at) VALUES (?, ?, 'payments', 'Payments', 'test', ?)", team, orgId, NOW);
    expect(triggerError(() => run("UPDATE cpg_teams SET name = 'Pay', archived_at = ? WHERE id = ?", NOW, team))).toBeNull();
    expect(triggerError(() => run("UPDATE cpg_teams SET key = 'other' WHERE id = ?", team))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('DELETE FROM cpg_teams WHERE id = ?', team))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    run("INSERT INTO cpg_team_repos (team_id, repo_pattern, added_by, added_at) VALUES (?, 'acme/*', 'test', ?)", team, NOW);
    expect(triggerError(() => run("UPDATE cpg_team_repos SET repo_pattern = 'acme/x' WHERE team_id = ?", team))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run("INSERT INTO cpg_team_repos (team_id, repo_pattern, added_by, added_at) VALUES (?, 'Acme/*', 'test', ?)", team, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run('DELETE FROM cpg_team_repos WHERE team_id = ?', team))).toBeNull();
  });

  it('cpg_org_settings: settings change, rbac_migrated_at is write-once, org_id is fixed, no delete', () => {
    expect(triggerError(() => run("UPDATE cpg_org_settings SET enabled = 1, updated_by = 'test', updated_at = ? WHERE org_id = ?", NOW, orgId))).toBeNull();
    expect(triggerError(() => run("UPDATE cpg_org_settings SET rbac_migrated_at = '2030-01-01T00:00:00.000Z' WHERE org_id = ?", orgId))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('UPDATE cpg_org_settings SET rbac_migrated_at = NULL WHERE org_id = ?', orgId))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('UPDATE cpg_org_settings SET org_id = ? WHERE org_id = ?', otherOrgId, orgId))).not.toBeNull();
    expect(triggerError(() => run('DELETE FROM cpg_org_settings WHERE org_id = ?', orgId))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('UPDATE cpg_org_settings SET enabled = 2 WHERE org_id = ?', orgId))).toBe('SQLITE_CONSTRAINT_CHECK');
  });

  it('is listed as projections', () => {
    expect(PROJECTION_TABLES.map((t) => t.table).sort()).toEqual(['cpg_boards', 'cpg_org_settings', 'cpg_policy_heads', 'cpg_roles', 'cpg_teams']);
  });

  it('cpg_boards: name and description change; identity and kind do not; archiving is final; no delete', () => {
    const id = registry.boardId;
    expect(triggerError(() => run("UPDATE cpg_boards SET name = 'AI Board', description = 'd' WHERE id = ?", id))).toBeNull();
    for (const sql of ["UPDATE cpg_boards SET key = 'other' WHERE id = ?", "UPDATE cpg_boards SET kind = 'legal' WHERE id = ?", `UPDATE cpg_boards SET org_id = '${otherOrgId}' WHERE id = ?`]) {
      expect(triggerError(() => run(sql, id)), sql).toBe('SQLITE_CONSTRAINT_TRIGGER');
    }
    const spare = randomUUID();
    run("INSERT INTO cpg_boards (id, org_id, key, name, kind, created_by, created_at) VALUES (?, ?, 'spare', 'Spare', 'custom', 'test', ?)", spare, orgId, NOW);
    expect(triggerError(() => run("UPDATE cpg_boards SET archived_at = ?, archived_by = 'test' WHERE id = ?", NOW, spare))).toBeNull();
    expect(triggerError(() => run('UPDATE cpg_boards SET archived_at = NULL, archived_by = NULL WHERE id = ?', spare))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('DELETE FROM cpg_boards WHERE id = ?', id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run("INSERT INTO cpg_boards (id, org_id, key, name, kind, created_by, created_at) VALUES (?, ?, 'x1', 'X', 'finance', 't', ?)", randomUUID(), orgId, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
  });

  it('cpg_policy_heads: identity columns are fixed; no delete; an active head must carry its activation data', () => {
    expect(triggerError(() => run(`UPDATE cpg_policy_heads SET org_id = '${otherOrgId}' WHERE policy_id = ?`, registry.policyId))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run("UPDATE cpg_policy_heads SET state = 'active' WHERE policy_id = ?", registry.policyId))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run('DELETE FROM cpg_policy_heads WHERE policy_id = ?', registry.policyId))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });
});

describe('cpg_board_members: removal is written once, nothing else changes, nothing is deleted', () => {
  it('allows one removal, then refuses a second and any other change', () => {
    const user = insertUser(orgId);
    const id = randomUUID();
    run("INSERT INTO cpg_board_members (id, board_id, org_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, 'test', ?)", id, registry.boardId, orgId, user, NOW);
    expect(triggerError(() => run("INSERT INTO cpg_board_members (id, board_id, org_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, 'test', ?)", randomUUID(), registry.boardId, orgId, user, NOW))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(triggerError(() => run('UPDATE cpg_board_members SET user_id = ? WHERE id = ?', userId, id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run("UPDATE cpg_board_members SET removed_at = ?, removed_by = 'test' WHERE id = ?", NOW, id))).toBeNull();
    expect(triggerError(() => run("UPDATE cpg_board_members SET removed_at = ?, removed_by = 'x' WHERE id = ?", '2026-10-09T12:00:00.000Z', id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(() => run('DELETE FROM cpg_board_members WHERE id = ?', id))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(WRITE_ONCE_TABLES.map((t) => t.table)).toContain('cpg_board_members');
  });

  it('refuses a member from another org', () => {
    const outsider = insertUser(otherOrgId);
    expect(triggerError(() => run("INSERT INTO cpg_board_members (id, board_id, org_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, 'test', ?)", randomUUID(), registry.boardId, orgId, outsider, NOW))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });
});

describe('cpg_policy_approvals: four-eyes is enforced by the database', () => {
  const vote = (versionId: string, voter: string) => () => run(
    "INSERT INTO cpg_policy_approvals (id, version_id, org_id, voter_user_id, vote, quorum_config_version, created_at) VALUES (?, ?, ?, ?, 'approve', 1, ?)",
    randomUUID(), versionId, orgId, voter, NOW,
  );

  it('refuses a vote by the version author', () => {
    expect(triggerError(vote(registry.versionId, registry.authorId))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });

  it('refuses a vote by the compile requester even when someone else authored the version', () => {
    const requester = insertUser(orgId);
    const author = insertUser(orgId);
    const compileId = randomUUID();
    run(`INSERT INTO cpg_compile_records (id, org_id, requested_by, input_text, input_hash, examples, prompt_version, status, compiled_rule, compiled_rule_hash, created_at)
         VALUES (?, ?, ?, 'Never put card numbers in source code.', ?, '{}', 1, 'compiled', '{}', ?, ?)`, compileId, orgId, `user:${requester}`, H, H, NOW);
    const versionId = randomUUID();
    run(`INSERT INTO cpg_policy_versions (id, policy_id, org_id, version, kind, title, plain_text, tier, owning_board_ids, rule, rule_hash, compile_record_id, edited_from_compile, created_by, created_at)
         VALUES (?, ?, ?, 2, 'define', 'No cards', 't', 'advisory', ?, '{}', ?, ?, 0, ?, ?)`, versionId, registry.policyId, orgId, JSON.stringify([registry.boardId]), H, compileId, `user:${author}`, NOW);
    expect(triggerError(vote(versionId, requester))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(vote(versionId, author))).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(triggerError(vote(versionId, insertUser(orgId)))).toBeNull();
  });

  it('refuses a second vote by the same user and a voter from another org', () => {
    expect(triggerError(vote(registry.versionId, registry.approverId))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(triggerError(vote(registry.versionId, insertUser(otherOrgId)))).toBe('SQLITE_CONSTRAINT_TRIGGER');
  });
});

describe('policy registry CHECK constraints', () => {
  it('policy keys are corp.* without a colon; compile status and rule agree; retire versions carry no rule; titles are one line', () => {
    for (const key of ['corp.Upper', 'other.key', 'corp.a:b', 'corp.']) {
      expect(triggerError(() => run("INSERT INTO cpg_policies (id, org_id, policy_key, created_by, created_at) VALUES (?, ?, ?, 'user:x', ?)", randomUUID(), orgId, key, NOW)), key).toBe('SQLITE_CONSTRAINT_CHECK');
    }
    expect(triggerError(() => run(`INSERT INTO cpg_compile_records (id, org_id, requested_by, input_text, input_hash, examples, prompt_version, status, created_at)
      VALUES (?, ?, 'user:x', 'Policy text that is long enough.', ?, '{}', 1, 'compiled', ?)`, randomUUID(), orgId, H, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run(`INSERT INTO cpg_policy_versions (id, policy_id, org_id, version, kind, title, plain_text, tier, owning_board_ids, rule, rule_hash, edited_from_compile, created_by, created_at)
      VALUES (?, ?, ?, 9, 'retire', 'Retire it', 'r', 'advisory', ?, '{}', ?, 0, 'user:x', ?)`, randomUUID(), registry.policyId, orgId, JSON.stringify([registry.boardId]), H, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run(`INSERT INTO cpg_policy_versions (id, policy_id, org_id, version, kind, title, plain_text, tier, owning_board_ids, rule, rule_hash, compile_record_id, edited_from_compile, created_by, created_at)
      VALUES (?, ?, ?, 9, 'define', ?, 't', 'advisory', ?, '{}', ?, ?, 0, 'user:x', ?)`, randomUUID(), registry.policyId, orgId, 'Two\nlines', JSON.stringify([registry.boardId]), H, registry.compileId, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run("INSERT INTO cpg_quorum_config_versions (id, org_id, version, config, config_hash, change_note, created_by, created_at, signature) VALUES (?, ?, 2, '{}', ?, 'n', 'system:seed', ?, 's')", randomUUID(), orgId, H, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
  });
});

describe('conventions are CHECK constraints', () => {
  it('rejects non-UUID ids, non-ISO timestamps and invalid JSON', () => {
    expect(triggerError(() => run("INSERT INTO cpg_teams (id, org_id, key, name, created_by, created_at) VALUES ('ABC', ?, 'k1', 'n', 't', ?)", orgId, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run("INSERT INTO cpg_teams (id, org_id, key, name, created_by, created_at) VALUES (?, ?, 'k2', 'n', 't', '2026-10-08 12:00:00')", randomUUID(), orgId))).toBe('SQLITE_CONSTRAINT_CHECK');
    // A UUID with the hyphens stripped is refused.
    expect(triggerError(() => run("INSERT INTO cpg_teams (id, org_id, key, name, created_by, created_at) VALUES (?, ?, 'k3', 'n', 't', ?)", randomUUID().replace(/-/g, ''), orgId, NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(triggerError(() => run(`INSERT INTO cpg_audit_events (id, org_id, seq, actor, action, target_type, payload, prev_hash, hash, created_at)
      VALUES (?, ?, 999, 'a', 'b', 'c', '{not json', ?, ?, ?)`, randomUUID(), orgId, '0'.repeat(64), 'a'.repeat(64), NOW))).toBe('SQLITE_CONSTRAINT_CHECK');
  });
});

describe('code scan: no UPDATE or DELETE path against append-only tables', () => {
  const srcRoot = resolve(import.meta.dirname, '..');
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__fixtures__')) out.push(p);
    }
    return out;
  }
  const files = sourceFiles(srcRoot).map((p) => ({ path: relative(srcRoot, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

  it('scans the engine sources', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.path === 'cpg/audit/log.ts')).toBe(true);
  });

  for (const { table, drizzleName } of APPEND_ONLY_TABLES) {
    it(`${table}: no .update(${drizzleName}) / .delete(${drizzleName}) and no raw UPDATE / DELETE FROM`, () => {
      const drizzleRe = new RegExp(`\\.(update|delete)\\(\\s*${drizzleName}\\s*\\)`);
      const rawRe = new RegExp(`\\b(UPDATE\\s+${table}\\b|DELETE\\s+FROM\\s+${table}\\b)`, 'i');
      const offenders = files.filter((f) => drizzleRe.test(f.text) || rawRe.test(f.text)).map((f) => f.path);
      expect(offenders).toEqual([]);
    });
  }
});
