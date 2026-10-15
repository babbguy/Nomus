/**
 * The numbered CPG migration runner (design spec §2.1): applies each
 * migration once in one transaction, is idempotent, refuses an edited
 * applied migration or an unknown one, and rolls back a migration that fails
 * half way.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  MIGRATIONS, MigrationChecksumError, UnknownMigrationError, migrationChecksum, runCpgMigrations, type Migration,
} from './runner.js';
import { runMigrations } from '../migrate.js';

function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite, db: drizzle(sqlite) };
}

const m1: Migration = { id: 'test_0001', statements: ['CREATE TABLE t1 (id INTEGER PRIMARY KEY, v TEXT NOT NULL)', 'CREATE INDEX ix_t1_v ON t1 (v)'] };
const m2: Migration = { id: 'test_0002', statements: ['CREATE TABLE t2 (id INTEGER PRIMARY KEY)'] };

function tables(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

describe('runCpgMigrations', () => {
  it('applies pending migrations in order and records id, checksum and an ISO timestamp', () => {
    const { sqlite, db } = freshDb();
    const res = runCpgMigrations(db, [m1, m2]);
    expect(res).toEqual({ applied: ['test_0001', 'test_0002'], verified: [] });
    expect(tables(sqlite)).toEqual(expect.arrayContaining(['schema_migrations', 't1', 't2']));
    const rows = sqlite.prepare('SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id').all() as Array<{ id: string; checksum: string; applied_at: string }>;
    expect(rows.map((r) => r.id)).toEqual(['test_0001', 'test_0002']);
    expect(rows[0].checksum).toBe(migrationChecksum(m1));
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(rows[0].applied_at).toISOString()).toBe(rows[0].applied_at);
  });

  it('is idempotent: a second run applies nothing and verifies every checksum', () => {
    const { sqlite, db } = freshDb();
    runCpgMigrations(db, [m1, m2]);
    const again = runCpgMigrations(db, [m1, m2]);
    expect(again).toEqual({ applied: [], verified: ['test_0001', 'test_0002'] });
    expect((sqlite.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(2);
  });

  it('applies only the new migration when one is appended', () => {
    const { db } = freshDb();
    runCpgMigrations(db, [m1]);
    expect(runCpgMigrations(db, [m1, m2])).toEqual({ applied: ['test_0002'], verified: ['test_0001'] });
  });

  it('throws on a checksum mismatch when an applied migration was edited', () => {
    const { db } = freshDb();
    runCpgMigrations(db, [m1]);
    const edited: Migration = { id: 'test_0001', statements: [...m1.statements, 'CREATE TABLE sneaky (id INTEGER)'] };
    expect(() => runCpgMigrations(db, [edited])).toThrow(MigrationChecksumError);
    expect(() => runCpgMigrations(db, [edited])).toThrow(/test_0001 has been modified/);
  });

  it('refuses to start when the database has a migration this build does not know', () => {
    const { db } = freshDb();
    runCpgMigrations(db, [m1, m2]);
    expect(() => runCpgMigrations(db, [m1])).toThrow(UnknownMigrationError);
  });

  it('rolls back a migration that fails half way and records nothing for it', () => {
    const { sqlite, db } = freshDb();
    const broken: Migration = { id: 'test_0003', statements: ['CREATE TABLE half (id INTEGER)', 'THIS IS NOT SQL'] };
    expect(() => runCpgMigrations(db, [m1, broken])).toThrow();
    expect(tables(sqlite)).not.toContain('half');
    expect((sqlite.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id = 'test_0003'").get() as { n: number }).n).toBe(0);
    // The earlier migration stays applied; fixing the broken one lets it apply.
    expect(runCpgMigrations(db, [m1, { id: 'test_0003', statements: ['CREATE TABLE half (id INTEGER)'] }]).applied).toEqual(['test_0003']);
  });

  it('rejects duplicate migration ids', () => {
    const { db } = freshDb();
    expect(() => runCpgMigrations(db, [m1, m1])).toThrow(/Duplicate migration id/);
  });

  it('makes schema_migrations itself append-only', () => {
    const { sqlite, db } = freshDb();
    runCpgMigrations(db, [m1]);
    expect(() => sqlite.prepare("UPDATE schema_migrations SET checksum = 'x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare('DELETE FROM schema_migrations').run()).toThrow(/append-only/);
  });
});

describe('runMigrations() integration', () => {
  it('creates the CPG tables on a fresh database and is safe to run again', () => {
    const { sqlite, db } = freshDb();
    runMigrations(db);
    runMigrations(db);
    const names = tables(sqlite);
    for (const t of ['schema_migrations', 'cpg_permissions', 'cpg_roles', 'cpg_role_permissions', 'cpg_user_roles', 'cpg_teams', 'cpg_team_repos', 'cpg_org_settings', 'cpg_audit_events']) {
      expect(names).toContain(t);
    }
    const applied = (sqlite.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    const cols = (sqlite.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('user_id');
    const idx = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_keys'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain('ix_api_keys_user');
  });

  it('upgrades a v1.1.0 database that has api_keys without user_id', () => {
    const { sqlite, db } = freshDb();
    // The v1.1.0 shape of api_keys, created before the column existed.
    sqlite.prepare(`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, jurisdiction_access TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    sqlite.prepare(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, label TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', rate_limit_rpm INTEGER NOT NULL DEFAULT 60, last_used_at TEXT, expires_at TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`).run();
    sqlite.prepare(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Old', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    sqlite.prepare(`INSERT INTO api_keys (id, org_id, key_hash, key_prefix, label, created_at) VALUES ('k1', '00000000-0000-4000-8000-000000000001', 'h', 'p', 'VS Code Extension', '2026-01-01T00:00:00.000Z')`).run();
    runMigrations(db);
    const row = sqlite.prepare("SELECT user_id FROM api_keys WHERE id = 'k1'").get() as { user_id: string | null };
    expect(row.user_id).toBeNull();
    // The pre-existing org is seeded: system roles and a settings row.
    const roles = (sqlite.prepare("SELECT key FROM cpg_roles WHERE org_id = '00000000-0000-4000-8000-000000000001' ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
    expect(roles).toEqual(['auditor', 'case_reviewer', 'developer', 'exception_approver', 'org_admin', 'policy_approver', 'policy_author']);
  });
});
