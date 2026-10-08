/**
 * Forge Orchestrator
 *
 * Top-level coordinator for the bulk regulatory ingestion pipeline.
 * Manages PVS workers and the repair agent, tracks overall progress,
 * and handles graceful start/stop.
 *
 * Lifecycle:
 *   1. Scan regulations directory for new/changed documents
 *   2. Enqueue forge jobs for each document
 *   3. Spin up N concurrent PVS workers
 *   4. Run repair agent cycles between worker batches
 *   5. Write Ledger entries for completed jobs
 *   6. Broadcast progress via SSE
 *   7. Notify on completion
 *
 * Designed to run for hours/days unattended. Crash-safe: state is in SQLite.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { broadcastEvent } from '../sse/manager.js';
import {
  scanRegulationsDir,
  readManifest,
  hashFileContent,
  findDocumentFile,
  detectFileType,
} from './manifest.js';
import {
  enqueueJob,
  claimNextJob,
  updateJobStatus,
  failJob,
  getJobCounts,
  getForgeStats,
  recoverStaleJobs,
} from './queue.js';
import { processJob } from './pvs-worker.js';
import { runRepairCycle } from './repair-agent.js';
import { writeLedgerEntry } from './ledger.js';
import { notifyPipelineComplete, notifyPipelineError, sendSlack } from '../services/notifications.js';
import type { ForgeState, ForgeStatus, ForgeJob } from './types.js';

// ─── State ───────────────────────────────────────────────────

let _state: ForgeState = 'idle';
let _startedAt: string | null = null;
let _stopRequested = false;

/** Default number of concurrent PVS workers */
const DEFAULT_CONCURRENCY = parseInt(process.env.FORGE_CONCURRENCY ?? '3', 10);

/** Delay between repair cycles (check for new errors every N ms) */
const REPAIR_CYCLE_INTERVAL_MS = 30_000;

/** Delay between checking for new jobs when queue is empty */
const IDLE_POLL_INTERVAL_MS = 10_000;

// ─── Queue Population ────────────────────────────────────────

/**
 * Scan the regulations directory and enqueue jobs for new/changed documents.
 * Returns the number of jobs enqueued.
 */
export function populateQueue(): number {
  const docs = scanRegulationsDir();
  let enqueued = 0;

  for (const doc of docs) {
    if (!doc.documentFile) {
      logger.warn({ dir: doc.docDir }, 'No document file found in directory — skipping');
      continue;
    }

    const contentHash = hashFileContent(doc.documentFile);
    const manifest = doc.manifest;
    const fileType = detectFileType(doc.documentFile);

    const job = enqueueJob({
      documentPath: doc.documentFile,
      jurisdiction: doc.jurisdiction,
      sourceName: doc.sourceName,
      sourceId: manifest?.sourceId,
      contentHash,
      fileType,
    });

    if (job) enqueued++;
  }

  logger.info({ scanned: docs.length, enqueued }, `Queue populated: ${enqueued} new jobs from ${docs.length} documents`);
  return enqueued;
}

// ─── Worker Management ───────────────────────────────────────

/**
 * Run a single PVS worker iteration: claim a job and process it.
 * Returns true if a job was processed, false if queue is empty.
 */
async function runWorker(workerId: number): Promise<boolean> {
  const job = claimNextJob();
  if (!job) return false;

  logger.info({ workerId, jobId: job.id, name: job.sourceName },
    `Worker ${workerId}: processing ${job.sourceName}`);

  try {
    const result = await processJob(job);

    if (result.status === 'completed') {
      updateJobStatus(job.id, 'completed', {
        qualityGrade: result.qualityGrade,
        rulesExtracted: result.rulesExtracted,
        rulesAccepted: result.rulesAccepted,
        rulesRejected: result.rulesRejected,
        rulesDuplicate: result.rulesDuplicate,
        rulesFlagged: result.rulesFlagged,
        llmTokensIn: result.llmTokensIn,
        llmTokensOut: result.llmTokensOut,
        llmCostCents: result.llmCostCents,
        durationMs: result.durationMs,
      });

      // Write Ledger entry
      const manifest = readManifest(job.documentPath.replace(/\/[^/]+$/, ''));
      writeLedgerEntry(job, result, manifest?.url);

      // Notify success
      broadcastEvent({
        type: 'forge.completed',
        jurisdiction: job.jurisdiction,
        data: {
          jobId: job.id,
          documentName: job.sourceName,
          jurisdiction: job.jurisdiction,
          rulesAccepted: result.rulesAccepted,
          llmCostCents: result.llmCostCents,
          durationMs: result.durationMs,
        },
      });

      logger.info({
        workerId, jobId: job.id,
        rules: result.rulesAccepted,
        cost: result.llmCostCents,
        duration: result.durationMs,
      }, `Worker ${workerId}: completed ${job.sourceName} — ${result.rulesAccepted} rules`);

    } else {
      // Error — send to repair queue
      failJob(job.id, result.errorMessage ?? 'Unknown error', result.errorCategory ?? 'unknown');

      broadcastEvent({
        type: 'forge.error',
        jurisdiction: job.jurisdiction,
        data: {
          jobId: job.id,
          documentName: job.sourceName,
          jurisdiction: job.jurisdiction,
          errorMessage: result.errorMessage,
          errorCategory: result.errorCategory,
        },
      });

      logger.warn({
        workerId, jobId: job.id,
        error: result.errorMessage,
        category: result.errorCategory,
      }, `Worker ${workerId}: failed ${job.sourceName} — sent to repair queue`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    failJob(job.id, errorMsg, 'unknown');
    logger.error({ workerId, jobId: job.id, error: errorMsg },
      `Worker ${workerId}: unexpected error`);
  }

  return true;
}

/**
 * Run N workers concurrently, processing until queue is empty or stop requested.
 */
async function runWorkerPool(concurrency: number): Promise<void> {
  let consecutiveEmptyPolls = 0;

  while (!_stopRequested) {
    // Launch up to N workers concurrently
    const workerPromises: Promise<boolean>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workerPromises.push(runWorker(i + 1));
    }

    const results = await Promise.all(workerPromises);
    const anyProcessed = results.some((r) => r);

    if (!anyProcessed) {
      consecutiveEmptyPolls++;

      // Run repair cycle when queue is empty (repair may re-queue jobs)
      if (consecutiveEmptyPolls % 3 === 1) {
        const repairResult = await runRepairCycle();
        if (repairResult.repaired > 0) {
          consecutiveEmptyPolls = 0; // Reset — repair re-queued jobs
          continue;
        }
      }

      // Check if we're truly done (no queued, processing, or error jobs left)
      const counts = getJobCounts();
      const activeJobs = counts.queued + counts.processing + counts.validating +
        counts.scoring + counts.committing + counts.error + counts.repairing;

      if (activeJobs === 0) {
        logger.info('All jobs complete — no more work to do');
        break;
      }

      // Wait before checking again
      await new Promise((r) => setTimeout(r, IDLE_POLL_INTERVAL_MS));

      // Safety: don't poll forever if only unrepairable jobs remain
      if (consecutiveEmptyPolls > 30) {
        logger.info({ counts }, 'Idle for too long — stopping worker pool');
        break;
      }
    } else {
      consecutiveEmptyPolls = 0;
    }

    // Broadcast status update
    broadcastEvent({
      type: 'forge.status',
      jurisdiction: 'global',
      data: getStatus(),
    });
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Start the Forge pipeline.
 * Scans directory, populates queue, starts workers and repair agent.
 */
export async function startForge(opts?: {
  concurrency?: number;
  skipHarvest?: boolean;
}): Promise<void> {
  if (_state !== 'idle' && _state !== 'stopped') {
    logger.warn({ state: _state }, 'Forge already running');
    return;
  }

  _state = 'processing';
  _startedAt = new Date().toISOString();
  _stopRequested = false;

  logger.info({ concurrency: opts?.concurrency ?? DEFAULT_CONCURRENCY },
    'Starting The Forge');

  try {
    // Recover any stale jobs from previous crash
    recoverStaleJobs();

    // Scan directory and populate queue
    const enqueued = populateQueue();

    if (enqueued === 0) {
      const counts = getJobCounts();
      const pending = counts.queued + counts.error;
      if (pending === 0) {
        logger.info('No new documents and no pending jobs — nothing to do');
        _state = 'idle';
        _startedAt = null;
        return;
      }
      logger.info({ pending }, `No new documents but ${pending} pending jobs remain`);
    }

    broadcastEvent({
      type: 'forge.started',
      jurisdiction: 'global',
      data: {
        jobsEnqueued: enqueued,
        concurrency: opts?.concurrency ?? DEFAULT_CONCURRENCY,
      },
    });

    sendSlack(
      `*The Forge Started*\n${enqueued} documents queued for processing`,
      'Forge',
    ).catch(() => {});

    // Run worker pool
    await runWorkerPool(opts?.concurrency ?? DEFAULT_CONCURRENCY);

    // Final status
    const stats = getForgeStats();
    const counts = getJobCounts();

    _state = 'idle';

    broadcastEvent({
      type: 'forge.finished',
      jurisdiction: 'global',
      data: {
        ...stats,
        unrepairable: counts.unrepairable,
      },
    });

    const summary = `*The Forge Complete*\n` +
      `Completed: ${stats.completedJobs}/${stats.totalJobs}\n` +
      `Rules created: ${stats.totalRulesCreated}\n` +
      `LLM cost: $${(stats.totalLlmCostCents / 100).toFixed(2)}\n` +
      `Unrepairable: ${counts.unrepairable}`;

    sendSlack(summary, 'Forge').catch(() => {});

    logger.info({ ...stats, unrepairable: counts.unrepairable },
      'The Forge pipeline complete');

  } catch (err) {
    _state = 'stopped';
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMsg }, 'Forge pipeline crashed');

    sendSlack(`*Forge CRASHED*\n${errorMsg}`, 'Forge — Error').catch(() => {});

    broadcastEvent({
      type: 'forge.error',
      jurisdiction: 'global',
      data: { error: errorMsg, phase: 'orchestrator' },
    });
  }
}

/**
 * Request graceful stop of the Forge pipeline.
 * Current jobs will finish, but no new jobs will be picked up.
 */
export function stopForge(): void {
  if (_state !== 'processing') {
    logger.info({ state: _state }, 'Forge is not running');
    return;
  }

  _stopRequested = true;
  _state = 'stopping';

  logger.info('Forge stop requested — finishing current jobs');

  broadcastEvent({
    type: 'forge.stopping',
    jurisdiction: 'global',
    data: { message: 'Graceful stop requested — finishing current jobs' },
  });
}

/**
 * Get current Forge status.
 */
export function getStatus(): ForgeStatus {
  const counts = getJobCounts();
  const stats = getForgeStats();
  const elapsed = _startedAt
    ? Date.now() - new Date(_startedAt).getTime()
    : 0;

  return {
    state: _state,
    startedAt: _startedAt,
    jobsTotal: stats.totalJobs,
    jobsCompleted: counts.completed,
    jobsProcessing: counts.processing + counts.validating + counts.scoring + counts.committing,
    jobsError: counts.error,
    jobsUnrepairable: counts.unrepairable,
    jobsQueued: counts.queued,
    totalRulesCreated: stats.totalRulesCreated,
    totalLlmCostCents: stats.totalLlmCostCents,
    elapsedMs: elapsed,
  };
}

/**
 * Get current Forge state.
 */
export function getForgeState(): ForgeState {
  return _state;
}
