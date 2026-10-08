/**
 * Tests for raw snapshot retention.
 *
 * Uses an isolated in-memory SQLite database (not the shared test DB) so
 * the table-wide DELETE cannot interfere with other test files.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema.js';
import { rawSnapshots } from '../db/schema.js';
import { cleanupRawSnapshots } from './snapshot-retention.js';

const sqlite = new Database(':memory:');
sqlite.exec(`
  CREATE TABLE raw_snapshots (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    scraped_at TEXT NOT NULL,
    raw_bytes_hash TEXT,
    raw_bytes_size INTEGER,
    raw_content TEXT,
    fetched_url TEXT,
    http_status INTEGER,
    content_type TEXT,
    user_agent TEXT,
    provenance_mode TEXT NOT NULL DEFAULT 'byte_exact',
    provenance_manifest TEXT,
    ingestion_channel TEXT,
    point_in_time_coordinate TEXT,
    promoted INTEGER NOT NULL DEFAULT 0
  );
`);
const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function insertSnapshot(sourceId: string, scrapedAt: string): string {
  const id = randomUUID();
  db.insert(rawSnapshots).values({
    id,
    sourceId,
    contentHash: `hash-${id.slice(0, 8)}`,
    content: 'regulation text',
    scrapedAt,
  }).run();
  return id;
}

function remainingIds(): string[] {
  return db.select({ id: rawSnapshots.id }).from(rawSnapshots).all().map((r) => r.id);
}

describe('cleanupRawSnapshots', () => {
  beforeEach(() => {
    db.delete(rawSnapshots).run();
  });

  afterAll(() => {
    sqlite.close();
  });

  it('deletes nothing when retention is undefined (default: keep forever)', () => {
    const sourceA = randomUUID();
    insertSnapshot(sourceA, daysAgo(400));
    insertSnapshot(sourceA, daysAgo(200));
    insertSnapshot(sourceA, daysAgo(1));

    const deleted = cleanupRawSnapshots(undefined, db);

    expect(deleted).toBe(0);
    expect(remainingIds()).toHaveLength(3);
  });

  it('deletes nothing for non-positive or non-integer retention values', () => {
    const sourceA = randomUUID();
    insertSnapshot(sourceA, daysAgo(400));
    insertSnapshot(sourceA, daysAgo(1));

    expect(cleanupRawSnapshots(0, db)).toBe(0);
    expect(cleanupRawSnapshots(-30, db)).toBe(0);
    expect(cleanupRawSnapshots(1.5, db)).toBe(0);
    expect(remainingIds()).toHaveLength(2);
  });

  it('purges snapshots older than retention but keeps newer ones', () => {
    const sourceA = randomUUID();
    const oldId = insertSnapshot(sourceA, daysAgo(60));
    const midId = insertSnapshot(sourceA, daysAgo(20));
    const newId = insertSnapshot(sourceA, daysAgo(1));

    const deleted = cleanupRawSnapshots(30, db);

    expect(deleted).toBe(1);
    const ids = remainingIds();
    expect(ids).toContain(midId);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it('always keeps the most recent snapshot per source, even past retention', () => {
    const sourceA = randomUUID();
    const aOldest = insertSnapshot(sourceA, daysAgo(500));
    const aOld = insertSnapshot(sourceA, daysAgo(400));
    const aLatest = insertSnapshot(sourceA, daysAgo(300)); // all past 30d cutoff

    const sourceB = randomUUID();
    const bOld = insertSnapshot(sourceB, daysAgo(90));
    const bLatest = insertSnapshot(sourceB, daysAgo(2));

    const deleted = cleanupRawSnapshots(30, db);

    const ids = remainingIds();
    // Source A: everything is past retention, but the latest survives.
    expect(ids).toContain(aLatest);
    expect(ids).not.toContain(aOldest);
    expect(ids).not.toContain(aOld);
    // Source B: old one purged, latest kept.
    expect(ids).toContain(bLatest);
    expect(ids).not.toContain(bOld);
    expect(deleted).toBe(3);
  });

  it('never leaves a source with zero snapshots', () => {
    const sources = [randomUUID(), randomUUID(), randomUUID()];
    for (const s of sources) {
      insertSnapshot(s, daysAgo(1000)); // single ancient snapshot each
    }

    const deleted = cleanupRawSnapshots(7, db);

    expect(deleted).toBe(0);
    expect(remainingIds()).toHaveLength(3);
  });
});
