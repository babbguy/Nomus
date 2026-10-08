/**
 * Raw snapshot retention.
 *
 * Raw snapshots are the byte-exact provenance record backing Nomus's
 * source-exact regulation guarantee: every stored regulation carries a
 * SHA-256 of the unmodified HTTP body (`raw_bytes_hash`), and the
 * verification CLI proves stored regulations match the publisher
 * byte-for-byte. Deleting raw snapshots destroys that proof.
 *
 * Policy:
 *   - Default (NOMUS_RAW_SNAPSHOT_RETENTION_DAYS unset): NEVER delete.
 *   - When a positive integer retention is configured: purge snapshots
 *     older than the cutoff, but ALWAYS keep the most recent snapshot per
 *     source so every source retains at least its latest raw bytes.
 */
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getDb } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * Purge raw snapshots older than `retentionDays`, keeping the most recent
 * snapshot per source unconditionally.
 *
 * @param retentionDays Positive integer number of days to retain. When
 *   undefined (the default configuration), nothing is deleted — retention
 *   is forever. Non-positive or non-integer values are rejected (no-op).
 * @returns Number of rows deleted.
 */
export function cleanupRawSnapshots(
  retentionDays: number | undefined,
  db: BetterSQLite3Database<typeof schema> = getDb(),
): number {
  // Default: keep forever — the source-exact provenance guarantee.
  if (retentionDays === undefined) return 0;

  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    logger.warn({ retentionDays },
      'Invalid NOMUS_RAW_SNAPSHOT_RETENTION_DAYS — skipping snapshot cleanup (retention stays forever)');
    return 0;
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Delete rows older than the cutoff, EXCEPT any row that is the most
  // recent snapshot for its source (scraped_at ties are kept, conservatively).
  const result = db.run(sql`
    DELETE FROM raw_snapshots
    WHERE scraped_at < ${cutoff}
      AND scraped_at < (
        SELECT MAX(rs2.scraped_at)
        FROM raw_snapshots AS rs2
        WHERE rs2.source_id = raw_snapshots.source_id
      )
  `);

  return Number(result.changes ?? 0);
}
