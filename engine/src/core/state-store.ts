/**
 * SQLite-backed ephemeral state store.
 *
 * Replaces in-memory Maps for short-lived state that must survive restarts
 * (OAuth CSRF tokens, GitHub installation tokens, etc.).
 *
 * Features:
 * - Automatic TTL-based expiry with cleanup on every read
 * - Optional AES-256-GCM encryption for sensitive values
 * - Namespaced keys to prevent collisions between subsystems
 */

import { eq, and, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { ephemeralState } from '../db/schema.js';
import { encryptForStorage, decryptFromStorage } from './crypto.js';

/** Ensure the ephemeral_state table exists (safe to call multiple times). */
export function ensureEphemeralTable(): void {
  const db = getDb();
  db.run(sql`CREATE TABLE IF NOT EXISTS ephemeral_state (
    key TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ephemeral_namespace ON ephemeral_state(namespace)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ephemeral_expires ON ephemeral_state(expires_at)`);
}

/**
 * Store a value with a TTL.
 *
 * @param namespace - Subsystem identifier (e.g. 'oauth_csrf', 'github_token')
 * @param key - Unique key within the namespace
 * @param value - Value to store
 * @param ttlMs - Time-to-live in milliseconds
 * @param encrypt - Whether to encrypt the value at rest (default: false)
 */
export function setState(
  namespace: string,
  key: string,
  value: string,
  ttlMs: number,
  encrypt = false,
): void {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const storedValue = encrypt ? encryptForStorage(value) : value;
  const compositeKey = `${namespace}:${key}`;

  db.insert(ephemeralState)
    .values({
      key: compositeKey,
      namespace,
      value: storedValue,
      expiresAt,
      createdAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: ephemeralState.key,
      set: {
        value: storedValue,
        expiresAt,
        createdAt: now.toISOString(),
      },
    })
    .run();
}

/**
 * Retrieve a value. Returns null if not found or expired.
 * Automatically cleans up expired entries on read.
 */
export function getState(namespace: string, key: string, encrypted = false): string | null {
  const db = getDb();
  const compositeKey = `${namespace}:${key}`;
  const now = new Date().toISOString();

  const row = db.select()
    .from(ephemeralState)
    .where(eq(ephemeralState.key, compositeKey))
    .get();

  if (!row) return null;

  // Check expiry
  if (row.expiresAt < now) {
    db.delete(ephemeralState).where(eq(ephemeralState.key, compositeKey)).run();
    return null;
  }

  return encrypted ? decryptFromStorage(row.value) : row.value;
}

/**
 * Delete a specific entry.
 */
export function deleteState(namespace: string, key: string): void {
  const db = getDb();
  const compositeKey = `${namespace}:${key}`;
  db.delete(ephemeralState).where(eq(ephemeralState.key, compositeKey)).run();
}

/**
 * Check if a key exists and is not expired.
 */
export function hasState(namespace: string, key: string): boolean {
  return getState(namespace, key) !== null;
}

/**
 * Count active (non-expired) entries in a namespace.
 */
export function countState(namespace: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.select({ count: sql<number>`count(*)` })
    .from(ephemeralState)
    .where(and(
      eq(ephemeralState.namespace, namespace),
      sql`${ephemeralState.expiresAt} >= ${now}`,
    ))
    .get();
  return result?.count ?? 0;
}

/**
 * Remove all expired entries across all namespaces.
 * Called periodically to keep the table clean.
 */
export function cleanupExpired(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.delete(ephemeralState)
    .where(lt(ephemeralState.expiresAt, now))
    .run();
  return result.changes;
}
