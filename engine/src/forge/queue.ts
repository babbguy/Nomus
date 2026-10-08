/**
 * Forge Job Queue — SQLite-Backed, Crash-Safe
 *
 * Manages the processing queue for bulk regulatory document ingestion.
 * Jobs survive process restarts: if the process dies, in-progress jobs
 * are re-queued on next startup.
 *
 * Zero external dependencies — uses the existing SQLite DB.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql, asc, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { forgeJobs } from '../db/schema.js';
import { logger } from '../logger.js';
import type { ForgeJob, ForgeJobStatus, ForgeErrorCategory } from './types.js';

// ─── Queue Operations ────────────────────────────────────────

/**
 * Enqueue a new document for processing.
 * Returns null if a job with the same contentHash already exists (dedup).
 */
export function enqueueJob(params: {
  documentPath: string;
  jurisdiction: string;
  sourceName: string;
  sourceId?: string;
  contentHash: string;
  fileType: 'html' | 'pdf' | 'md';
}): ForgeJob | null {
  const db = getDb();

  // Dedup: skip if we already have a job for this exact content
  const existing = db.select({ id: forgeJobs.id, status: forgeJobs.status })
    .from(forgeJobs)
    .where(eq(forgeJobs.contentHash, params.contentHash))
    .get();

  if (existing) {
    // Re-queue if previous attempt failed and isn't marked unrepairable
    if (existing.status === 'error') {
      db.update(forgeJobs)
        .set({ status: 'queued', attempt: 1, errorMessage: null, errorCategory: null })
        .where(eq(forgeJobs.id, existing.id))
        .run();
      logger.info({ jobId: existing.id, hash: params.contentHash.slice(0, 12) },
        'Re-queued previously failed job');
      return db.select().from(forgeJobs).where(eq(forgeJobs.id, existing.id)).get() as ForgeJob;
    }
    logger.info({ hash: params.contentHash.slice(0, 12), status: existing.status },
      'Job already exists for this content — skipping');
    return null;
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  db.insert(forgeJobs).values({
    id,
    documentPath: params.documentPath,
    jurisdiction: params.jurisdiction,
    sourceName: params.sourceName,
    sourceId: params.sourceId ?? null,
    contentHash: params.contentHash,
    fileType: params.fileType,
    status: 'queued',
    attempt: 1,
    maxAttempts: 3,
    queuedAt: now,
  }).run();

  logger.info({
    jobId: id,
    name: params.sourceName,
    jurisdiction: params.jurisdiction,
    hash: params.contentHash.slice(0, 12),
  }, 'Enqueued forge job');

  return db.select().from(forgeJobs).where(eq(forgeJobs.id, id)).get() as ForgeJob;
}

/**
 * Claim the next queued job for processing.
 * Uses atomic update to prevent race conditions between concurrent workers.
 * Returns null if no jobs are available.
 */
export function claimNextJob(): ForgeJob | null {
  const db = getDb();

  // Atomic: find oldest queued job and mark it as processing
  const job = db.select().from(forgeJobs)
    .where(eq(forgeJobs.status, 'queued'))
    .orderBy(asc(forgeJobs.queuedAt))
    .limit(1)
    .get();

  if (!job) return null;

  const now = new Date().toISOString();
  db.update(forgeJobs)
    .set({ status: 'processing', startedAt: now })
    .where(and(
      eq(forgeJobs.id, job.id),
      eq(forgeJobs.status, 'queued'), // Double-check: prevents race condition
    ))
    .run();

  // Verify we actually claimed it
  const claimed = db.select().from(forgeJobs)
    .where(and(
      eq(forgeJobs.id, job.id),
      eq(forgeJobs.status, 'processing'),
    ))
    .get();

  if (!claimed) return null; // Another worker claimed it first

  logger.info({ jobId: job.id, name: job.sourceName }, 'Claimed forge job');
  return claimed as ForgeJob;
}

/**
 * Update job status with progress data.
 */
export function updateJobStatus(
  jobId: string,
  status: ForgeJobStatus,
  data?: Partial<{
    qualityGrade: string;
    rulesExtracted: number;
    rulesAccepted: number;
    rulesRejected: number;
    rulesDuplicate: number;
    rulesFlagged: number;
    llmTokensIn: number;
    llmTokensOut: number;
    llmCostCents: number;
    durationMs: number;
    errorMessage: string;
    errorCategory: ForgeErrorCategory;
    repairStrategy: string;
  }>,
): void {
  const db = getDb();
  const updates: Record<string, unknown> = { status };

  if (data) {
    if (data.qualityGrade !== undefined) updates.qualityGrade = data.qualityGrade;
    if (data.rulesExtracted !== undefined) updates.rulesExtracted = data.rulesExtracted;
    if (data.rulesAccepted !== undefined) updates.rulesAccepted = data.rulesAccepted;
    if (data.rulesRejected !== undefined) updates.rulesRejected = data.rulesRejected;
    if (data.rulesDuplicate !== undefined) updates.rulesDuplicate = data.rulesDuplicate;
    if (data.rulesFlagged !== undefined) updates.rulesFlagged = data.rulesFlagged;
    if (data.llmTokensIn !== undefined) updates.llmTokensIn = data.llmTokensIn;
    if (data.llmTokensOut !== undefined) updates.llmTokensOut = data.llmTokensOut;
    if (data.llmCostCents !== undefined) updates.llmCostCents = data.llmCostCents;
    if (data.durationMs !== undefined) updates.durationMs = data.durationMs;
    if (data.errorMessage !== undefined) updates.errorMessage = data.errorMessage;
    if (data.errorCategory !== undefined) updates.errorCategory = data.errorCategory;
    if (data.repairStrategy !== undefined) updates.repairStrategy = data.repairStrategy;
  }

  if (status === 'completed' || status === 'error' || status === 'unrepairable') {
    updates.completedAt = new Date().toISOString();
  }

  db.update(forgeJobs).set(updates).where(eq(forgeJobs.id, jobId)).run();
}

/**
 * Mark a job as failed with error details.
 */
export function failJob(
  jobId: string,
  errorMessage: string,
  errorCategory: ForgeErrorCategory,
): void {
  const db = getDb();
  const job = db.select({ attempt: forgeJobs.attempt, maxAttempts: forgeJobs.maxAttempts })
    .from(forgeJobs)
    .where(eq(forgeJobs.id, jobId))
    .get();

  if (!job) return;

  // If we've exhausted attempts, mark as error for the repair agent
  const status: ForgeJobStatus = 'error';

  updateJobStatus(jobId, status, { errorMessage, errorCategory });
  logger.warn({ jobId, attempt: job.attempt, error: errorMessage, category: errorCategory },
    `Forge job failed (attempt ${job.attempt}/${job.maxAttempts})`);
}

/**
 * Get all jobs with error status for the repair agent.
 */
export function getErrorJobs(): ForgeJob[] {
  const db = getDb();
  return db.select().from(forgeJobs)
    .where(eq(forgeJobs.status, 'error'))
    .orderBy(asc(forgeJobs.queuedAt))
    .all() as ForgeJob[];
}

/**
 * Get all unrepairable jobs (for dashboard/notifications).
 */
export function getUnrepairableJobs(): ForgeJob[] {
  const db = getDb();
  return db.select().from(forgeJobs)
    .where(eq(forgeJobs.status, 'unrepairable'))
    .all() as ForgeJob[];
}

/**
 * Re-queue a repaired job for another processing attempt.
 */
export function requeueForRetry(jobId: string, repairStrategy: string): void {
  const db = getDb();
  const job = db.select({ attempt: forgeJobs.attempt })
    .from(forgeJobs)
    .where(eq(forgeJobs.id, jobId))
    .get();

  if (!job) return;

  db.update(forgeJobs)
    .set({
      status: 'queued',
      attempt: job.attempt + 1,
      repairStrategy,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(forgeJobs.id, jobId))
    .run();

  logger.info({ jobId, attempt: job.attempt + 1, strategy: repairStrategy },
    'Re-queued job after repair');
}

/**
 * Mark a job as unrepairable (repair agent gave up).
 */
export function markUnrepairable(jobId: string, reason: string): void {
  updateJobStatus(jobId, 'unrepairable', { errorMessage: reason });
  logger.error({ jobId, reason }, 'Job marked as unrepairable — needs manual intervention');
}

/**
 * Get job counts by status for the orchestrator dashboard.
 */
export function getJobCounts(): Record<ForgeJobStatus, number> {
  const db = getDb();
  const rows = db.select({
    status: forgeJobs.status,
    count: sql<number>`count(*)`,
  }).from(forgeJobs)
    .groupBy(forgeJobs.status)
    .all();

  const counts: Record<string, number> = {
    queued: 0, processing: 0, validating: 0, scoring: 0,
    committing: 0, completed: 0, error: 0, repairing: 0, unrepairable: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts as Record<ForgeJobStatus, number>;
}

/**
 * Get all jobs with optional status filter, pagination.
 */
export function getJobs(opts?: {
  status?: ForgeJobStatus;
  limit?: number;
  offset?: number;
}): { jobs: ForgeJob[]; total: number } {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let query = db.select().from(forgeJobs).$dynamic();
  let countQuery = db.select({ count: sql<number>`count(*)` }).from(forgeJobs).$dynamic();

  if (opts?.status) {
    query = query.where(eq(forgeJobs.status, opts.status));
    countQuery = countQuery.where(eq(forgeJobs.status, opts.status));
  }

  const total = countQuery.get()?.count ?? 0;
  const jobs = query.orderBy(asc(forgeJobs.queuedAt)).limit(limit).offset(offset).all();

  return { jobs: jobs as ForgeJob[], total };
}

/**
 * Get a single job by ID.
 */
export function getJob(jobId: string): ForgeJob | null {
  const db = getDb();
  const job = db.select().from(forgeJobs).where(eq(forgeJobs.id, jobId)).get();
  return (job as ForgeJob) ?? null;
}

/**
 * Recovery: re-queue any jobs that were processing when the process died.
 * Called on startup.
 */
export function recoverStaleJobs(): number {
  const db = getDb();
  const staleStatuses: ForgeJobStatus[] = ['processing', 'validating', 'scoring', 'committing', 'repairing'];
  let recovered = 0;

  for (const status of staleStatuses) {
    const result = db.update(forgeJobs)
      .set({ status: 'queued', startedAt: null })
      .where(eq(forgeJobs.status, status))
      .run();
    recovered += result.changes;
  }

  if (recovered > 0) {
    logger.info({ recovered }, `Recovered ${recovered} stale forge jobs on startup`);
  }

  return recovered;
}

/**
 * Get aggregate stats for cost tracking.
 */
export function getForgeStats(): {
  totalJobs: number;
  completedJobs: number;
  totalRulesCreated: number;
  totalLlmCostCents: number;
  totalDurationMs: number;
} {
  const db = getDb();
  const stats = db.select({
    totalJobs: sql<number>`count(*)`,
    completedJobs: sql<number>`sum(case when status = 'completed' then 1 else 0 end)`,
    totalRulesCreated: sql<number>`sum(rules_accepted)`,
    totalLlmCostCents: sql<number>`sum(llm_cost_cents)`,
    totalDurationMs: sql<number>`sum(duration_ms)`,
  }).from(forgeJobs).get();

  return {
    totalJobs: stats?.totalJobs ?? 0,
    completedJobs: stats?.completedJobs ?? 0,
    totalRulesCreated: stats?.totalRulesCreated ?? 0,
    totalLlmCostCents: stats?.totalLlmCostCents ?? 0,
    totalDurationMs: stats?.totalDurationMs ?? 0,
  };
}
