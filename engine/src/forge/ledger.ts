/**
 * The Ledger — Immutable Processing Registry
 *
 * Records every document processed by The Forge with cryptographic signatures.
 * Provides public transparency about what regulations
 * Nomus has verified.
 *
 * Publishing gate: Ledger entries are recorded internally but only exposed
 * publicly when FORGE_LEDGER_PUBLISH is enabled. This prevents publishing
 * garbage while the system is being validated.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc, sql, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { forgeLedger, platformSettings } from '../db/schema.js';
import { signData } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import { logger } from '../logger.js';
import type {
  ForgeJob,
  LedgerEntry,
  LedgerPublicEntry,
  LedgerDetailEntry,
} from './types.js';
import type { PvsResult } from './pvs-worker.js';

// ─── Publishing Gate ─────────────────────────────────────────

/**
 * Check if Ledger publishing is enabled.
 * Default: false — entries are recorded but not exposed publicly.
 */
export function isPublishingEnabled(): boolean {
  // Check env var first
  if (process.env.FORGE_LEDGER_PUBLISH === 'true') return true;

  // Check platform settings
  try {
    const db = getDb();
    const setting = db.select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, 'forge.ledger.publish'))
      .get();
    return setting?.value === 'true';
  } catch {
    return false;
  }
}

// ─── Write Ledger Entry ──────────────────────────────────────

/**
 * Record a completed Forge job in the Ledger.
 * Only called after rules have been successfully committed to the DB.
 */
export function writeLedgerEntry(
  job: ForgeJob,
  result: PvsResult,
  sourceUrl?: string | null,
): LedgerEntry {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Determine status based on results
  let status: 'verified' | 'flagged' | 'rejected';
  if (result.rulesAccepted > 0 && result.rulesFlagged === 0) {
    status = 'verified';
  } else if (result.rulesAccepted > 0 && result.rulesFlagged > 0) {
    status = 'flagged'; // Has rules but some need review
  } else {
    status = 'rejected'; // No rules accepted
  }

  // Build processing chain
  const processingChain = ['parse', 'validate', 'score', 'analyze'];
  if (result.rulesAccepted > 0) processingChain.push('commit');

  // Sign the entry for integrity verification
  const signaturePayload = canonicalJSON({
    documentHash: job.contentHash,
    documentName: job.sourceName,
    jurisdiction: job.jurisdiction,
    status,
    rulesAccepted: result.rulesAccepted,
    verifiedAt: now,
  });
  const signature = signData(signaturePayload);

  const published = isPublishingEnabled();

  db.insert(forgeLedger).values({
    id,
    forgeJobId: job.id,
    documentHash: job.contentHash,
    documentName: job.sourceName,
    jurisdiction: job.jurisdiction,
    sourceUrl: sourceUrl ?? null,
    fileType: job.fileType,
    status,
    qualityGrade: result.qualityGrade,
    rulesExtracted: result.rulesExtracted,
    rulesAccepted: result.rulesAccepted,
    rulesRejected: result.rulesRejected,
    processingChain: JSON.stringify(processingChain),
    llmCostCents: result.llmCostCents,
    durationMs: result.durationMs,
    sourceId: job.sourceId,
    signature,
    isPublished: published,
    verifiedAt: now,
  }).run();

  logger.info({
    ledgerId: id,
    documentName: job.sourceName,
    status,
    rulesAccepted: result.rulesAccepted,
    published,
  }, `Ledger entry: ${status} — ${job.sourceName}`);

  return {
    id,
    forgeJobId: job.id,
    documentHash: job.contentHash,
    documentName: job.sourceName,
    jurisdiction: job.jurisdiction,
    sourceUrl: sourceUrl ?? null,
    fileType: job.fileType,
    status,
    qualityGrade: result.qualityGrade,
    rulesExtracted: result.rulesExtracted,
    rulesAccepted: result.rulesAccepted,
    rulesRejected: result.rulesRejected,
    processingChain,
    llmCostCents: result.llmCostCents,
    durationMs: result.durationMs,
    sourceId: job.sourceId,
    signature,
    isPublished: published,
    verifiedAt: now,
  };
}

// ─── Read Ledger ─────────────────────────────────────────────

/**
 * Get public Ledger entries.
 * Only returns published entries with limited fields.
 */
export function getPublicLedger(opts?: {
  jurisdiction?: string;
  limit?: number;
  offset?: number;
}): { entries: LedgerPublicEntry[]; total: number } {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const conditions = [eq(forgeLedger.isPublished, true)];
  if (opts?.jurisdiction) {
    conditions.push(eq(forgeLedger.jurisdiction, opts.jurisdiction));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const total = db.select({ count: sql<number>`count(*)` })
    .from(forgeLedger)
    .where(where!)
    .get();

  const rows = db.select({
    documentName: forgeLedger.documentName,
    jurisdiction: forgeLedger.jurisdiction,
    status: forgeLedger.status,
    rulesAccepted: forgeLedger.rulesAccepted,
    verifiedAt: forgeLedger.verifiedAt,
  }).from(forgeLedger)
    .where(where!)
    .orderBy(desc(forgeLedger.verifiedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return {
    entries: rows as LedgerPublicEntry[],
    total: total?.count ?? 0,
  };
}

/**
 * Get detailed Ledger entries (admin view).
 */
export function getDetailedLedger(opts?: {
  jurisdiction?: string;
  status?: 'verified' | 'flagged' | 'rejected';
  limit?: number;
  offset?: number;
}): { entries: LedgerDetailEntry[]; total: number } {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const conditions: any[] = [];
  if (opts?.jurisdiction) {
    conditions.push(eq(forgeLedger.jurisdiction, opts.jurisdiction));
  }
  if (opts?.status) {
    conditions.push(eq(forgeLedger.status, opts.status));
  }

  const where = conditions.length === 0
    ? undefined
    : conditions.length === 1
      ? conditions[0]
      : and(...conditions);

  const total = db.select({ count: sql<number>`count(*)` })
    .from(forgeLedger)
    .where(where)
    .get();

  const rows = db.select().from(forgeLedger)
    .where(where)
    .orderBy(desc(forgeLedger.verifiedAt))
    .limit(limit)
    .offset(offset)
    .all();

  const entries: LedgerDetailEntry[] = rows.map((r) => ({
    documentName: r.documentName,
    jurisdiction: r.jurisdiction,
    status: r.status,
    rulesAccepted: r.rulesAccepted,
    verifiedAt: r.verifiedAt,
    documentHash: r.documentHash,
    fileType: r.fileType,
    qualityGrade: r.qualityGrade,
    rulesExtracted: r.rulesExtracted,
    rulesRejected: r.rulesRejected,
    processingChain: JSON.parse(r.processingChain),
    llmCostCents: r.llmCostCents,
    durationMs: r.durationMs,
    signature: r.signature,
  }));

  return { entries, total: total?.count ?? 0 };
}

/**
 * Get a single Ledger entry by ID.
 */
export function getLedgerEntry(id: string): LedgerDetailEntry | null {
  const db = getDb();
  const row = db.select().from(forgeLedger)
    .where(eq(forgeLedger.id, id))
    .get();

  if (!row) return null;

  return {
    documentName: row.documentName,
    jurisdiction: row.jurisdiction,
    status: row.status,
    rulesAccepted: row.rulesAccepted,
    verifiedAt: row.verifiedAt,
    documentHash: row.documentHash,
    fileType: row.fileType,
    qualityGrade: row.qualityGrade,
    rulesExtracted: row.rulesExtracted,
    rulesRejected: row.rulesRejected,
    processingChain: JSON.parse(row.processingChain),
    llmCostCents: row.llmCostCents,
    durationMs: row.durationMs,
    signature: row.signature,
  };
}

/**
 * Get Ledger summary stats for the transparency page.
 */
/** publishedOnly: count only entries the public ledger lists. */
export function getLedgerStats(opts?: { publishedOnly?: boolean }): {
  totalDocuments: number;
  verified: number;
  flagged: number;
  rejected: number;
  totalRulesAccepted: number;
  jurisdictions: string[];
  publishingEnabled: boolean;
} {
  const db = getDb();

  const byStatus = db.select({
    status: forgeLedger.status,
    count: sql<number>`count(*)`,
    rules: sql<number>`sum(rules_accepted)`,
  }).from(forgeLedger)
    .where(opts?.publishedOnly ? eq(forgeLedger.isPublished, true) : undefined)
    .groupBy(forgeLedger.status)
    .all();

  const jurisdictions = db.select({
    jurisdiction: forgeLedger.jurisdiction,
  }).from(forgeLedger)
    .where(opts?.publishedOnly ? eq(forgeLedger.isPublished, true) : undefined)
    .groupBy(forgeLedger.jurisdiction)
    .all()
    .map((r) => r.jurisdiction);

  const stats = {
    totalDocuments: 0,
    verified: 0,
    flagged: 0,
    rejected: 0,
    totalRulesAccepted: 0,
    jurisdictions,
    publishingEnabled: isPublishingEnabled(),
  };

  for (const row of byStatus) {
    const count = row.count ?? 0;
    const rules = row.rules ?? 0;
    stats.totalDocuments += count;
    stats.totalRulesAccepted += rules;
    if (row.status === 'verified') stats.verified = count;
    else if (row.status === 'flagged') stats.flagged = count;
    else if (row.status === 'rejected') stats.rejected = count;
  }

  return stats;
}

/**
 * Toggle Ledger publishing on/off via platform settings.
 */
export function setPublishingEnabled(enabled: boolean): void {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.select().from(platformSettings)
    .where(eq(platformSettings.key, 'forge.ledger.publish'))
    .get();

  if (existing) {
    db.update(platformSettings)
      .set({ value: enabled ? 'true' : 'false', updatedAt: now })
      .where(eq(platformSettings.key, 'forge.ledger.publish'))
      .run();
  } else {
    db.insert(platformSettings).values({
      key: 'forge.ledger.publish',
      value: enabled ? 'true' : 'false',
      updatedAt: now,
    }).run();
  }

  logger.info({ enabled }, `Ledger publishing ${enabled ? 'enabled' : 'disabled'}`);
}
