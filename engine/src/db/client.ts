import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../config/env.js';
import * as schema from './schema.js';

/** A drizzle handle on any SQLite schema: the app's, or a test's own database. */
export type Db = BetterSQLite3Database<any>;

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const dbPath = env().NOMUS_DB_PATH;

  // Ensure data directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _sqlite = new Database(dbPath);

  // Performance pragmas
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('busy_timeout = 5000');
  _sqlite.pragma('synchronous = NORMAL');
  _sqlite.pragma('cache_size = -20000'); // 20MB cache
  _sqlite.pragma('foreign_keys = ON');
  _sqlite.pragma('temp_store = MEMORY');

  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
