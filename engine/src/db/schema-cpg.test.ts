/**
 * The Drizzle declarations in schema-cpg.ts are for typed queries only; the
 * raw SQL migrations are the source of truth (design spec §2.1). This test
 * keeps the two in step: the declared column names of every CPG table equal
 * PRAGMA table_info of the migrated database.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { runMigrations } from './migrate.js';
import { CPG_DRIZZLE_TABLES } from './schema-cpg.js';

describe('schema-cpg.ts matches the migrated CPG tables', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  runMigrations(drizzle(sqlite));

  for (const table of CPG_DRIZZLE_TABLES) {
    const config = getTableConfig(table);
    it(`${config.name}: declared columns equal PRAGMA table_info`, () => {
      const actual = (sqlite.prepare(`PRAGMA table_info(${config.name})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
      const declared = config.columns.map((c) => c.name).sort();
      expect(actual.length).toBeGreaterThan(0);
      expect(declared).toEqual(actual);
    });
  }

  it('declares every cpg_ table that the migrations create', () => {
    const created = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'cpg\\_%' ESCAPE '\\' OR name = 'schema_migrations') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const declared = CPG_DRIZZLE_TABLES.map((t) => getTableConfig(t).name).sort();
    expect(declared).toEqual(created);
  });
});
