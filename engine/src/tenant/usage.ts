import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { usageRecords } from '../db/schema.js';

/**
 * Record an API usage event. Fire-and-forget — never blocks the response.
 */
export function recordUsage(
  orgId: string,
  apiKeyId: string,
  endpoint: string,
  method: string,
  statusCode: number,
  responseMs: number,
): void {
  try {
    const db = getDb();
    db.insert(usageRecords).values({
      id: randomUUID(),
      orgId,
      apiKeyId,
      endpoint,
      method,
      statusCode,
      responseMs,
      recordedAt: new Date().toISOString(),
    }).run();
  } catch {
    // Usage tracking should never crash the request
  }
}
