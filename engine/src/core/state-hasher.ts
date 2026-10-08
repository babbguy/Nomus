import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules, stateHashes } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * Compute SHA-256 hash of all active policy rules.
 * Stores the result for integrity auditing.
 */
export function computeAndStoreStateHash(): { hash: string; ruleCount: number } {
  const db = getDb();

  const rules = db.select({
    ruleKey: policyRules.ruleKey,
    version: policyRules.version,
    signature: policyRules.signature,
  })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  // Deterministic hash: sort by ruleKey, concatenate signatures
  const sorted = rules.sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));
  const payload = sorted.map((r) => `${r.ruleKey}:${r.version}:${r.signature}`).join('|');
  const hash = createHash('sha256').update(payload).digest('hex');

  // Store (skip SIGNING_KEY entries)
  db.insert(stateHashes).values({
    id: randomUUID(),
    hash,
    ruleCount: rules.length,
    computedAt: new Date().toISOString(),
  }).run();

  logger.info({ hash: hash.slice(0, 16) + '...', ruleCount: rules.length }, 'State hash computed');

  return { hash, ruleCount: rules.length };
}

/**
 * Get the latest state hash (excluding signing key entries).
 */
export function getLatestStateHash(): { hash: string; ruleCount: number; computedAt: string } | null {
  const db = getDb();
  const all = db.select().from(stateHashes).all()
    .filter((h) => !h.hash.startsWith('SIGNING_KEY:'))
    .sort((a, b) => b.computedAt.localeCompare(a.computedAt));

  return all[0] ?? null;
}
