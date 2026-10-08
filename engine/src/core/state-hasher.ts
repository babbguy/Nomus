import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules, stateHashes } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * The corpus state hash: SHA-256 over the sorted Ed25519 signatures of the
 * active rules, joined by '|'. This is the value GET /api/v1/policies/hash,
 * the policy bundle, attestation receipts (per jurisdiction), the Modus sync
 * and the MCP provenance stamp all report, so anyone can recompute it.
 *
 * (The stored/anchored hash used to be computed differently — over
 * "ruleKey:version:signature" — so the admin dashboard showed a hash that
 * matched nothing else the API served for the same corpus.)
 */
export function corpusStateHash(signatures: string[]): string {
  return createHash('sha256').update([...signatures].sort().join('|')).digest('hex');
}

/** The current corpus state hash, without storing it. */
export function computeCurrentStateHash(): { hash: string; ruleCount: number } {
  const rules = getDb().select({ signature: policyRules.signature })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();
  return { hash: corpusStateHash(rules.map((r) => r.signature)), ruleCount: rules.length };
}

/**
 * Compute the corpus state hash and store it for integrity auditing (and the
 * daily on-chain anchor).
 */
export function computeAndStoreStateHash(): { hash: string; ruleCount: number } {
  const { hash, ruleCount } = computeCurrentStateHash();

  getDb().insert(stateHashes).values({
    id: randomUUID(),
    hash,
    ruleCount,
    computedAt: new Date().toISOString(),
  }).run();

  logger.info({ hash: hash.slice(0, 16) + '...', ruleCount }, 'State hash computed');

  return { hash, ruleCount };
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
