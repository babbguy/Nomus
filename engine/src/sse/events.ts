import { desc, gt } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyEvents } from '../db/schema.js';

/**
 * Get events after a given sequence number (for SSE catch-up on reconnect).
 */
export function getEventsSince(lastSequence: number, limit = 1000) {
  const db = getDb();
  return db.select().from(policyEvents)
    .where(gt(policyEvents.sequence, lastSequence))
    .orderBy(policyEvents.sequence)
    .limit(limit)
    .all();
}

/**
 * Get the latest event sequence number.
 */
export function getLatestSequence(): number {
  const db = getDb();
  const latest = db.select({ sequence: policyEvents.sequence })
    .from(policyEvents)
    .orderBy(desc(policyEvents.sequence))
    .limit(1)
    .get();
  return latest?.sequence ?? 0;
}
