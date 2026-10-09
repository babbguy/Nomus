import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendOnlyTriggers } from './sql-helpers.js';
import { cpg0001Rbac } from './cpg-0001-rbac.js';
import { cpg0002PolicyRegistry } from './cpg-0002-policy-registry.js';
import { cpg0003ReviewCases } from './cpg-0003-review-cases.js';
import { cpg0004Approvals } from './cpg-0004-approvals.js';
import { cpg0005Ci } from './cpg-0005-ci.js';

/**
 * Numbered raw-SQL migration runner for Corporate Policy Governance (design
 * spec §2.1).
 *
 * The legacy metadata migrator in migrate.ts cannot express foreign keys,
 * composite or partial indexes, CHECK constraints or triggers, all of which
 * CPG relies on. Each migration here is an ordered list of statements applied
 * once, inside one transaction, and recorded in `schema_migrations` with a
 * checksum of its text. On every start the checksum of each applied migration
 * is recomputed: an edited migration is a startup failure, never silent drift.
 */

export interface Migration {
  /** Stable id, e.g. `cpg_0001_rbac`. Never reused, never renamed. */
  id: string;
  /** One SQL statement per element (a CREATE TRIGGER … END is one statement). */
  statements: string[];
}

/** Ordered, append-only. New phases append; nothing is ever removed or edited. */
export const MIGRATIONS: readonly Migration[] = [cpg0001Rbac, cpg0002PolicyRegistry, cpg0003ReviewCases, cpg0004Approvals, cpg0005Ci];

export class MigrationChecksumError extends Error {
  constructor(public readonly migrationId: string, expected: string, actual: string) {
    super(`Applied migration ${migrationId} has been modified: recorded checksum ${expected}, code checksum ${actual}. Applied migrations must never be edited; add a new migration instead.`);
    this.name = 'MigrationChecksumError';
  }
}

export class UnknownMigrationError extends Error {
  constructor(public readonly migrationIds: string[]) {
    super(`The database has migrations this build does not know: ${migrationIds.join(', ')}. It was migrated by a newer Nomus; refusing to start.`);
    this.name = 'UnknownMigrationError';
  }
}

/** sha256 over the statements joined by newlines (§2.1). */
export function migrationChecksum(m: Migration): string {
  return createHash('sha256').update(m.statements.join('\n')).digest('hex');
}

/** The better-sqlite3 handle behind a Drizzle database. */
export function rawSqlite(db: BetterSQLite3Database<any>): Database.Database {
  const client = (db as unknown as { $client?: Database.Database }).$client;
  if (!client || typeof client.prepare !== 'function') {
    throw new Error('CPG requires a better-sqlite3 Drizzle database ($client missing)');
  }
  return client;
}

const SCHEMA_MIGRATIONS_DDL = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  // The bookkeeping table is append-only too (§2.3 T1).
  ...appendOnlyTriggers('schema_migrations').map((s) => s.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')),
];

export interface MigrationRunResult {
  applied: string[];
  verified: string[];
}

/**
 * Apply every migration not yet recorded, and verify the checksum of every
 * migration already recorded. Throws (and applies nothing further) on any
 * mismatch or unknown applied migration.
 */
export function runCpgMigrations(
  db: BetterSQLite3Database<any>,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationRunResult {
  const sqlite = rawSqlite(db);

  const ids = migrations.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Duplicate migration id in ${ids.join(', ')}`);
  }

  sqlite.transaction(() => {
    for (const stmt of SCHEMA_MIGRATIONS_DDL) sqlite.prepare(stmt).run();
  })();

  const recorded = new Map(
    (sqlite.prepare('SELECT id, checksum FROM schema_migrations').all() as Array<{ id: string; checksum: string }>)
      .map((r) => [r.id, r.checksum]),
  );

  const unknown = [...recorded.keys()].filter((id) => !ids.includes(id));
  if (unknown.length > 0) throw new UnknownMigrationError(unknown);

  const result: MigrationRunResult = { applied: [], verified: [] };
  for (const m of migrations) {
    const checksum = migrationChecksum(m);
    const existing = recorded.get(m.id);
    if (existing !== undefined) {
      if (existing !== checksum) throw new MigrationChecksumError(m.id, existing, checksum);
      result.verified.push(m.id);
      continue;
    }
    sqlite.transaction(() => {
      for (const stmt of m.statements) sqlite.prepare(stmt).run();
      sqlite.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)')
        .run(m.id, checksum, new Date().toISOString());
    })();
    result.applied.push(m.id);
  }
  return result;
}
