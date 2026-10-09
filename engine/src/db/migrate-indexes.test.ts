/**
 * The migrator must create every index declared in schema.ts (index() and
 * uniqueIndex()), idempotently, and refuse to build a UNIQUE index over
 * existing duplicate data instead of silently dropping or altering rows.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { is } from 'drizzle-orm';

import { runMigrations } from './migrate.js';
import * as schema from './schema.js';
import { logger } from '../logger.js';

interface Expected { table: string; name: string; unique: boolean }

// Independent of the migrator: walk every table exported from schema.ts.
function declaredInSchema(): Expected[] {
  const out: Expected[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    for (const idx of config.indexes) {
      out.push({ table: config.name, name: idx.config.name, unique: !!idx.config.unique });
    }
  }
  return out;
}

const open: Database.Database[] = [];
function freshDb(): { raw: Database.Database; db: BetterSQLite3Database<any> } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = OFF'); // fixtures insert bare rows without parents
  open.push(raw);
  return { raw, db: drizzle(raw) };
}
afterEach(() => {
  vi.restoreAllMocks();
  while (open.length) open.pop()!.close();
});

function indexRows(raw: Database.Database) {
  return raw
    .prepare(`SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx%'`)
    .all() as Array<{ name: string; tbl: string; sql: string | null }>;
}

function expectAllDeclared(raw: Database.Database) {
  const rows = new Map(indexRows(raw).map((r) => [r.name, r]));
  for (const e of declaredInSchema()) {
    const row = rows.get(e.name);
    expect(row, `index ${e.name} on ${e.table} missing`).toBeDefined();
    expect(row!.tbl).toBe(e.table);
    expect(/^CREATE UNIQUE/i.test(row!.sql ?? ''), `${e.name} uniqueness`).toBe(e.unique);
  }
}

function insertRule(raw: Database.Database, id: string, ruleKey: string) {
  const cfg = getTableConfig(schema.policyRules);
  const values: Record<string, unknown> = {};
  for (const col of cfg.columns) {
    if (col.notNull && col.default === undefined) {
      values[col.name] = col.dataType === 'number' || col.dataType === 'boolean' ? 1 : 'x';
    }
  }
  values.id = id;
  values.rule_key = ruleKey;
  const names = Object.keys(values);
  raw
    .prepare(`INSERT INTO policy_rules (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => values[n]));
}

const createdLogs = (info: { mock: { calls: unknown[][] } }) =>
  info.mock.calls.filter((c) => c[1] === 'Created database index');

describe('migrator creates declared indexes', () => {
  it('schema declares indexes (guards against the enumeration silently returning nothing)', () => {
    const declared = declaredInSchema();
    expect(declared.length).toBeGreaterThan(50);
    expect(declared.some((d) => d.name === 'idx_rules_key_unique' && d.unique)).toBe(true);
  });

  it('a fresh database gets every declared index', () => {
    const { raw, db } = freshDb();
    runMigrations(db);
    expectAllDeclared(raw);
  });

  it('every index declared in schema.ts exists after migration', () => {
    const { raw, db } = freshDb();
    runMigrations(db);
    const have = new Set(indexRows(raw).map((r) => r.name));
    const missing = declaredInSchema().filter((e) => !have.has(e.name)).map((e) => `${e.table}.${e.name}`);
    expect(missing).toEqual([]);
  });

  it('re-running the migrator is a no-op', () => {
    const { raw, db } = freshDb();
    runMigrations(db);
    const before = indexRows(raw);
    const info = vi.spyOn(logger, 'info');
    runMigrations(db);
    expect(indexRows(raw)).toEqual(before);
    expect(createdLogs(info)).toHaveLength(0);
  });

  it('an existing database without the indexes gets them, keeping its data', () => {
    const { raw, db } = freshDb();
    runMigrations(db);
    raw
      .prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('k', 'v', '2026-01-01T00:00:00.000Z')`)
      .run();
    for (const r of indexRows(raw)) raw.exec(`DROP INDEX ${r.name}`);
    expect(indexRows(raw)).toHaveLength(0);

    runMigrations(db);

    expectAllDeclared(raw);
    expect(raw.prepare(`SELECT value FROM platform_settings WHERE key = 'k'`).get()).toEqual({ value: 'v' });
  });

  it('enforces rule-key uniqueness in the database', () => {
    const { raw, db } = freshDb();
    runMigrations(db);
    insertRule(raw, 'a', 'dup.key');
    expect(() => insertRule(raw, 'b', 'dup.key')).toThrow(/UNIQUE/i);
  });

  it('logs each created index once at info level', () => {
    const { db } = freshDb();
    const info = vi.spyOn(logger, 'info');
    runMigrations(db);
    const created = createdLogs(info).map((c) => (c[0] as { index: string }).index);
    const expected = declaredInSchema().map((e) => e.name);
    expect([...created].sort()).toEqual([...expected].sort());
    expect(new Set(created).size).toBe(created.length);
  });
});

describe('duplicate keys block unique index creation', () => {
  it('fails with an error naming table, index and duplicated keys, and changes no data', () => {
    const { raw, db } = freshDb();
    runMigrations(db);
    raw.exec('DROP INDEX idx_rules_key_unique');
    raw.exec('DROP INDEX idx_api_keys_hash'); // a non-unique index that must not be created before the failure
    insertRule(raw, 'r1', 'dup.key');
    insertRule(raw, 'r2', 'dup.key');
    insertRule(raw, 'r3', 'unique.key');
    const info = vi.spyOn(logger, 'info');

    let error: Error | undefined;
    try {
      runMigrations(db);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain('policy_rules');
    expect(error!.message).toContain('idx_rules_key_unique');
    expect(error!.message).toContain('"dup.key"');
    expect(error!.message).not.toContain('unique.key');
    // Nothing deleted or altered, and no index was created before the failure.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM policy_rules').get()).toEqual({ n: 3 });
    const names = indexRows(raw).map((r) => r.name);
    expect(names).not.toContain('idx_rules_key_unique');
    expect(names).not.toContain('idx_api_keys_hash');
    expect(createdLogs(info)).toHaveLength(0);
  });
});
