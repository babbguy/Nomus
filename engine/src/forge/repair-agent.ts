/**
 * Repair Agent
 *
 * Monitors the error queue and attempts to fix failed forge jobs.
 * Mostly rule-based (free) with LLM diagnosis as a last resort.
 *
 * Repair strategies by error category:
 *   encoding        → detect charset, re-decode (free)
 *   parse_failure   → try alternate parser or relaxed settings (free)
 *   empty_extraction→ re-chunk with semantic chunker, retry (Haiku)
 *   llm_error       → wait and retry (free, transient errors)
 *   quality_rejected→ try with pre-processed content cleanup (free)
 *   unknown         → classify error, attempt appropriate fix (Haiku)
 *
 * The repair agent does NOT block PVS workers. They run independently.
 * When repair succeeds, the job is re-queued for PVS to pick up.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../logger.js';
import {
  getErrorJobs,
  requeueForRetry,
  markUnrepairable,
  updateJobStatus,
} from './queue.js';
import { sendSlack, sendPush } from '../services/notifications.js';
import { broadcastEvent } from '../sse/manager.js';
import { randomUUID } from 'node:crypto';
import type { ForgeJob, RepairResult, RepairAttempt } from './types.js';

// ─── Constants ───────────────────────────────────────────────

/** Delay before retrying LLM errors (transient rate limits) */
const LLM_RETRY_DELAY_MS = 60_000;

/** Delay between processing repair jobs */
const REPAIR_INTER_JOB_DELAY_MS = 5_000;

// ─── Repair Strategies ───────────────────────────────────────

/**
 * Attempt to fix encoding issues.
 * Detects common charset problems and re-encodes.
 */
async function repairEncoding(job: ForgeJob): Promise<RepairAttempt> {
  const startTime = performance.now();
  try {
    const raw = readFileSync(job.documentPath);

    // Try to detect and fix common encoding issues
    let content = raw.toString('utf-8');
    let fixed = false;

    // Fix UTF-8 BOM
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
      fixed = true;
    }

    // Fix double-encoded UTF-8 (mojibake)
    // Common pattern: Ã© should be é, Ã¼ should be ü
    const mojibakePattern = /Ã[\u00C0-\u00FF]/g;
    if (mojibakePattern.test(content)) {
      // Try decoding as latin1 then re-encoding as utf-8
      content = raw.toString('latin1');
      const reEncoded = Buffer.from(content, 'latin1').toString('utf-8');
      if (!mojibakePattern.test(reEncoded)) {
        content = reEncoded;
        fixed = true;
      }
    }

    // Remove control characters (except newlines/tabs)
    const controlPattern = /[\x00-\x08\x0E-\x1F\x7F]/g;
    if (controlPattern.test(content)) {
      content = content.replace(controlPattern, '');
      fixed = true;
    }

    // Replace Unicode replacement characters
    if (content.includes('\uFFFD')) {
      content = content.replace(/\uFFFD/g, '');
      fixed = true;
    }

    if (fixed) {
      writeFileSync(job.documentPath, content, 'utf-8');
      return {
        strategy: 'encoding_fix',
        success: true,
        message: 'Fixed encoding issues (BOM/mojibake/control chars)',
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    return {
      strategy: 'encoding_fix',
      success: false,
      message: 'No encoding issues detected to fix',
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (err) {
    return {
      strategy: 'encoding_fix',
      success: false,
      message: `Encoding repair failed: ${(err as Error).message}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

/**
 * Attempt to fix parse failures.
 * Tries alternate parsing strategies.
 */
async function repairParseFailure(job: ForgeJob): Promise<RepairAttempt> {
  const startTime = performance.now();
  try {
    const content = readFileSync(job.documentPath, 'utf-8');

    if (job.fileType === 'html') {
      // Strategy: strip all HTML and save as plain text
      // This loses structure but may allow extraction to proceed
      const plainText = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (plainText.split(/\s+/).filter(Boolean).length > 100) {
        writeFileSync(job.documentPath, plainText, 'utf-8');
        return {
          strategy: 'html_to_plain_text',
          success: true,
          message: `Stripped HTML tags — ${plainText.split(/\s+/).length} words recovered`,
          durationMs: Math.round(performance.now() - startTime),
        };
      }
    }

    if (job.fileType === 'pdf') {
      // Strategy: try with limited page range (some PDFs have corrupt trailing pages)
      // The PVS worker will re-parse — we just signal it to try with different settings
      return {
        strategy: 'pdf_page_limit',
        success: true,
        message: 'Flagged for re-parse with page limit — PVS will retry with relaxed settings',
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    return {
      strategy: 'parse_repair',
      success: false,
      message: 'No alternate parse strategy available',
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (err) {
    return {
      strategy: 'parse_repair',
      success: false,
      message: `Parse repair failed: ${(err as Error).message}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

/**
 * Handle LLM errors (rate limits, timeouts).
 * Just wait and signal retry — these are usually transient.
 */
async function repairLlmError(_job: ForgeJob): Promise<RepairAttempt> {
  const startTime = performance.now();
  logger.info('Waiting before LLM retry (transient error)');
  await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
  return {
    strategy: 'llm_wait_retry',
    success: true,
    message: `Waited ${LLM_RETRY_DELAY_MS / 1000}s — re-queuing for retry`,
    durationMs: Math.round(performance.now() - startTime),
  };
}

/**
 * Handle empty extraction results.
 * Content parsed OK but LLM found nothing to extract.
 */
async function repairEmptyExtraction(job: ForgeJob): Promise<RepairAttempt> {
  const startTime = performance.now();
  try {
    const content = readFileSync(job.documentPath, 'utf-8');
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    if (wordCount < 200) {
      return {
        strategy: 'empty_check',
        success: false,
        message: `Document too sparse (${wordCount} words) — likely not regulatory content`,
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    // Strategy: add structural markers to help the chunker find boundaries
    // Sometimes plain text documents lack heading structure needed for article chunking
    const enhanced = content
      .replace(/^(\d+\.)\s+/gm, '\n### $1 ')  // Turn numbered items into headings
      .replace(/^(Article\s+\d+)/gim, '\n## $1')
      .replace(/^(Section\s+\d+)/gim, '\n## $1')
      .replace(/^(Chapter\s+\d+)/gim, '\n# $1')
      .replace(/^(Part\s+[IVXLCDM\d]+)/gim, '\n# $1');

    if (enhanced !== content) {
      writeFileSync(job.documentPath, enhanced, 'utf-8');
      return {
        strategy: 'add_structure_markers',
        success: true,
        message: 'Added structural markers for better chunking — re-queuing',
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    return {
      strategy: 'empty_repair',
      success: false,
      message: 'Could not improve document structure for extraction',
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (err) {
    return {
      strategy: 'empty_repair',
      success: false,
      message: `Empty extraction repair failed: ${(err as Error).message}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

/**
 * Handle quality-rejected documents.
 * Try cleaning up content for better quality scoring.
 */
async function repairQualityRejected(job: ForgeJob): Promise<RepairAttempt> {
  const startTime = performance.now();
  try {
    const content = readFileSync(job.documentPath, 'utf-8');

    // Remove excessive whitespace, normalize line endings
    let cleaned = content
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, '  ')
      .replace(/ {3,}/g, '  ')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();

    // Remove header/footer repetitions (common in PDFs)
    const lines = cleaned.split('\n');
    if (lines.length > 20) {
      // Check for repeated lines (page headers/footers)
      const lineCounts = new Map<string, number>();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 5 && trimmed.length < 100) {
          lineCounts.set(trimmed, (lineCounts.get(trimmed) ?? 0) + 1);
        }
      }
      // Remove lines that appear more than 3 times (likely header/footer)
      const repeatedLines = new Set(
        [...lineCounts.entries()]
          .filter(([, count]) => count > 3)
          .map(([line]) => line),
      );

      if (repeatedLines.size > 0) {
        cleaned = lines.filter((l) => !repeatedLines.has(l.trim())).join('\n');
      }
    }

    if (cleaned !== content) {
      writeFileSync(job.documentPath, cleaned, 'utf-8');
      return {
        strategy: 'quality_cleanup',
        success: true,
        message: 'Cleaned whitespace and removed repeated headers/footers',
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    return {
      strategy: 'quality_cleanup',
      success: false,
      message: 'No quality improvements found',
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (err) {
    return {
      strategy: 'quality_cleanup',
      success: false,
      message: `Quality repair failed: ${(err as Error).message}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

// ─── Main Repair Function ────────────────────────────────────

/**
 * Attempt to repair a single failed job.
 */
async function repairJob(job: ForgeJob): Promise<RepairResult> {
  const attempts: RepairAttempt[] = [];
  let repaired = false;

  logger.info({
    jobId: job.id,
    name: job.sourceName,
    category: job.errorCategory,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
  }, `Repair agent: diagnosing ${job.sourceName}`);

  updateJobStatus(job.id, 'repairing');

  // Select repair strategy based on error category
  let attempt: RepairAttempt;

  switch (job.errorCategory) {
    case 'encoding':
      attempt = await repairEncoding(job);
      attempts.push(attempt);
      repaired = attempt.success;
      break;

    case 'parse_failure':
      // Try encoding fix first (sometimes parse failures are encoding issues)
      attempt = await repairEncoding(job);
      attempts.push(attempt);
      if (attempt.success) { repaired = true; break; }

      attempt = await repairParseFailure(job);
      attempts.push(attempt);
      repaired = attempt.success;
      break;

    case 'empty_extraction':
      attempt = await repairEmptyExtraction(job);
      attempts.push(attempt);
      repaired = attempt.success;
      break;

    case 'llm_error':
      attempt = await repairLlmError(job);
      attempts.push(attempt);
      repaired = attempt.success;
      break;

    case 'quality_rejected':
      attempt = await repairQualityRejected(job);
      attempts.push(attempt);
      if (attempt.success) { repaired = true; break; }

      // If quality cleanup didn't help, try encoding fix
      attempt = await repairEncoding(job);
      attempts.push(attempt);
      repaired = attempt.success;
      break;

    default:
      // Unknown error — try all strategies in order
      for (const strategy of [repairEncoding, repairParseFailure, repairQualityRejected]) {
        attempt = await strategy(job);
        attempts.push(attempt);
        if (attempt.success) { repaired = true; break; }
      }
      break;
  }

  const finalStrategy = attempts.find((a) => a.success)?.strategy ?? null;

  if (repaired && finalStrategy) {
    // Check if we've exceeded max attempts
    if (job.attempt >= job.maxAttempts) {
      markUnrepairable(job.id,
        `Exhausted ${job.maxAttempts} attempts. Last strategy: ${finalStrategy}. ` +
        `Error: ${job.errorMessage}`);
      repaired = false;
    } else {
      requeueForRetry(job.id, finalStrategy);
    }
  } else {
    // All repair strategies failed
    if (job.attempt >= job.maxAttempts) {
      markUnrepairable(job.id,
        `All repair strategies failed after ${job.attempt} attempts. ` +
        `Error: ${job.errorMessage}. ` +
        `Tried: ${attempts.map((a) => a.strategy).join(', ')}`);
    } else {
      // Leave in error state for now — repair agent will pick it up again
      updateJobStatus(job.id, 'error');
    }
  }

  logger.info({
    jobId: job.id,
    repaired,
    attempts: attempts.length,
    finalStrategy,
  }, `Repair result: ${repaired ? 'SUCCESS' : 'FAILED'} for ${job.sourceName}`);

  return { jobId: job.id, repaired, attempts, finalStrategy };
}

// ─── Repair Agent Loop ───────────────────────────────────────

let _repairRunning = false;

/**
 * Run the repair agent once — process all error jobs.
 * Returns the number of jobs repaired.
 */
export async function runRepairCycle(): Promise<{
  processed: number;
  repaired: number;
  unrepairable: number;
}> {
  if (_repairRunning) {
    logger.warn('Repair agent already running — skipping');
    return { processed: 0, repaired: 0, unrepairable: 0 };
  }

  _repairRunning = true;
  let processed = 0;
  let repaired = 0;
  let unrepairable = 0;

  try {
    const errorJobs = getErrorJobs();
    if (errorJobs.length === 0) {
      return { processed: 0, repaired: 0, unrepairable: 0 };
    }

    logger.info({ count: errorJobs.length }, `Repair agent: ${errorJobs.length} jobs to diagnose`);

    for (const job of errorJobs) {
      const result = await repairJob(job);
      processed++;

      if (result.repaired) {
        repaired++;
      } else if (job.attempt >= job.maxAttempts) {
        unrepairable++;
        // Notify about unrepairable jobs
        await notifyUnrepairable(job);
      }

      // Delay between repair jobs
      if (processed < errorJobs.length) {
        await new Promise((r) => setTimeout(r, REPAIR_INTER_JOB_DELAY_MS));
      }
    }

    logger.info({ processed, repaired, unrepairable },
      `Repair cycle complete: ${repaired}/${processed} repaired, ${unrepairable} unrepairable`);

    return { processed, repaired, unrepairable };
  } finally {
    _repairRunning = false;
  }
}

/**
 * Send notifications for unrepairable jobs.
 */
async function notifyUnrepairable(job: ForgeJob): Promise<void> {
  const message = `*FORGE: Unrepairable Document*\n` +
    `Document: ${job.sourceName}\n` +
    `Jurisdiction: ${job.jurisdiction}\n` +
    `Error: ${job.errorMessage}\n` +
    `Attempts: ${job.attempt}/${job.maxAttempts}\n` +
    `Category: ${job.errorCategory}`;

  // Slack notification
  sendSlack(message, 'Forge — Manual Intervention Needed').catch(() => {});

  // Push notification
  sendPush([], `Forge: ${job.sourceName}`, `Unrepairable — needs manual review`, 'high').catch(() => {});

  // SSE event for dashboard
  broadcastEvent({
    id: randomUUID(),
    type: 'forge.escalation',
    jurisdiction: job.jurisdiction,
    data: {
      jobId: job.id,
      documentName: job.sourceName,
      jurisdiction: job.jurisdiction,
      errorMessage: job.errorMessage,
      errorCategory: job.errorCategory,
      attempts: job.attempt,
    },
  });
}

/**
 * Check if the repair agent is currently running.
 */
export function isRepairRunning(): boolean {
  return _repairRunning;
}
