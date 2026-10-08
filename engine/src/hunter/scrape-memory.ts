/**
 * Scrape Memory — Source Strategy Tracking
 * ==========================================
 * Tracks which healing strategy last succeeded for each regulatory source.
 * On next scrape, if the last successful strategy was not 'direct', try that
 * strategy first before the primary URL.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { regulatorySources } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HealingStrategy } from './scrape-healer.js';

/**
 * Record which strategy succeeded for a source.
 */
export function recordSuccessfulStrategy(sourceId: string, strategy: HealingStrategy): void {
  try {
    const db = getDb();
    db.update(regulatorySources)
      .set({
        lastSuccessfulStrategy: strategy,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(regulatorySources.id, sourceId))
      .run();

    logger.info({ sourceId, strategy }, `Scrape memory: recorded successful strategy "${strategy}"`);
  } catch (err) {
    // Best-effort — do not break the pipeline if this fails
    logger.warn({ sourceId, strategy, error: (err as Error).message },
      'Scrape memory: failed to record strategy');
  }
}

/**
 * Get the last successful strategy for a source.
 * Returns null if no strategy is recorded or if it was 'direct'.
 */
export function getLastSuccessfulStrategy(sourceId: string): HealingStrategy | null {
  try {
    const db = getDb();
    const source = db.select({ lastSuccessfulStrategy: regulatorySources.lastSuccessfulStrategy })
      .from(regulatorySources)
      .where(eq(regulatorySources.id, sourceId))
      .get();

    if (!source || !source.lastSuccessfulStrategy || source.lastSuccessfulStrategy === 'direct') {
      return null;
    }

    return source.lastSuccessfulStrategy as HealingStrategy;
  } catch {
    return null;
  }
}
