import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { regulatorySources, regulatorySignals } from '../db/schema.js';
import { broadcastEvent } from '../sse/manager.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

/** Threshold before we recommend manual upload */
const UPLOAD_RECOMMEND_THRESHOLD = 2;

/** Threshold before auto-deactivation */
const AUTO_DEACTIVATE_THRESHOLD = 5;

/**
 * Record a scrape failure for a source.
 * - At 2 failures: broadcast SSE warning recommending manual upload
 * - At 5 failures: auto-deactivate and create alert signal
 */
export function recordScrapeFailure(sourceId: string, error: string): void {
  const db = getDb();
  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) return;

  const prevFailures = source.consecutiveFailures ?? 0;
  const failures = prevFailures + 1;
  const now = new Date().toISOString();

  // Actually increment the failure counter
  db.run(sql`UPDATE regulatory_sources SET consecutive_failures = ${failures}, updated_at = ${now} WHERE id = ${sourceId}`);

  logger.warn({ sourceId, name: source.name, consecutiveFailures: failures, error },
    `Scrape failure #${failures} for ${source.name}`);

  // At threshold: recommend manual upload via SSE
  if (failures >= UPLOAD_RECOMMEND_THRESHOLD && failures < AUTO_DEACTIVATE_THRESHOLD) {
    broadcastEvent({
      type: 'source.failing',
      data: {
        sourceId,
        sourceName: source.name,
        consecutiveFailures: failures,
        lastError: error.slice(0, 200),
        recommendation: 'manual_upload',
        message: `${source.name} has failed ${failures} times consecutively. Consider uploading the regulation manually.`,
      },
      jurisdiction: source.jurisdiction,
    });
  }

  // At higher threshold: auto-deactivate
  if (failures >= AUTO_DEACTIVATE_THRESHOLD && source.isActive) {
    db.run(sql`UPDATE regulatory_sources SET is_active = 0 WHERE id = ${sourceId}`);

    // Create alert signal
    db.insert(regulatorySignals).values({
      id: randomUUID(),
      sourceId,
      title: `Source Deactivated: ${source.name}`,
      jurisdiction: source.jurisdiction,
      stage: 'active',
      likelihoodPercent: 100,
      summary: `Automatically deactivated after ${failures} consecutive scrape failures. Last error: ${error}. Upload the regulation manually to restore.`,
      detectedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    broadcastEvent({
      type: 'source.deactivated',
      data: {
        sourceId,
        sourceName: source.name,
        consecutiveFailures: failures,
        lastError: error.slice(0, 200),
        message: `${source.name} auto-deactivated after ${failures} failures. Upload required.`,
      },
      jurisdiction: source.jurisdiction,
    });

    logger.error({ sourceId, name: source.name, failures, error },
      'Source auto-deactivated after consecutive failures — manual upload required');
  }
}

/**
 * Record a successful scrape — reset failure counter and update last success timestamp.
 */
export function recordScrapeSuccess(sourceId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  // A successful capture (promotion or confirmed no-change) clears any prior
  // ACCESS-ESCALATION manual-upload hold — the source recovered automatically.
  db.run(sql`UPDATE regulatory_sources SET consecutive_failures = 0, last_successful_scrape_at = ${now}, needs_manual_upload = 0, manual_upload_reason = NULL, updated_at = ${now} WHERE id = ${sourceId}`);
}

/**
 * Check all sources for SLA breaches.
 * Sources that haven't been scraped within their slaMaxAgeHours are flagged.
 */
export function checkSlaBreaches(): { breached: number; total: number } {
  const db = getDb();
  const sources = db.select().from(regulatorySources)
    .where(eq(regulatorySources.isActive, true))
    .all();

  let breached = 0;
  const now = Date.now();

  for (const source of sources) {
    if (!source.lastScrapedAt) {
      breached++;
      continue;
    }

    const lastScraped = new Date(source.lastScrapedAt).getTime();
    const maxAgeMs = (source.slaMaxAgeHours ?? 48) * 60 * 60 * 1000;

    if (now - lastScraped > maxAgeMs) {
      breached++;
    }
  }

  return { breached, total: sources.length };
}

/**
 * Get health status for all sources.
 */
export function getSourceHealthStatus(): Array<{
  id: string;
  name: string;
  jurisdiction: string;
  isActive: boolean;
  lastScrapedAt: string | null;
  slaMaxAgeHours: number;
  slaBreached: boolean;
  provenanceGrade: string;
}> {
  const db = getDb();
  const sources = db.select().from(regulatorySources).all();
  const now = Date.now();

  return sources.map((s) => {
    const lastScraped = s.lastScrapedAt ? new Date(s.lastScrapedAt).getTime() : 0;
    const maxAgeMs = (s.slaMaxAgeHours ?? 48) * 60 * 60 * 1000;
    const slaBreached = !s.lastScrapedAt || (now - lastScraped > maxAgeMs);

    return {
      id: s.id,
      name: s.name,
      jurisdiction: s.jurisdiction,
      isActive: s.isActive,
      lastScrapedAt: s.lastScrapedAt,
      slaMaxAgeHours: s.slaMaxAgeHours ?? 48,
      slaBreached: s.isActive ? slaBreached : false,
      provenanceGrade: s.provenanceGrade ?? 'G',
    };
  });
}
