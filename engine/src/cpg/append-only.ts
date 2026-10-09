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
] as const;

/**
 * Tables whose only permitted UPDATE writes a revocation/removal once
 * (§2.4 "write-once columns"). DELETE is always refused.
 */
export const WRITE_ONCE_TABLES = [
  { table: 'cpg_user_roles', drizzleName: 'cpgUserRoles' },
] as const;

/**
 * Projection tables: mutable only in whitelisted columns (trigger-guarded),
 * never deleted.
 */
export const PROJECTION_TABLES = [
  { table: 'cpg_roles', drizzleName: 'cpgRoles' },
  { table: 'cpg_teams', drizzleName: 'cpgTeams' },
  { table: 'cpg_org_settings', drizzleName: 'cpgOrgSettings' },
] as const;
