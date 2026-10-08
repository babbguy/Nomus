import { runMigrations } from '../src/db/migrate.js';

/**
 * Create all tables in the in-memory test database by running the real
 * production migrator. This guarantees test schema always matches what
 * production sees on a fresh install — there is no second hardcoded
 * table list to drift out of sync.
 */
export function createTestTables(): void {
  runMigrations();
}
