/**
 * PVS Worker — Parse → Validate → Score
 *
 * Processes a single forge job through the full extraction pipeline.
 * Reuses all existing Nomus pipeline components for consistency:
 *   - html-parser / pdf-parser for parsing
 *   - quality-scorer for free local quality check
 *   - article-chunker for legal-boundary splitting
 *   - bulk-extractor for Haiku-based rule extraction
 *   - rule-scorer for Haiku-based quality scoring
 *   - analyzer for pre-commit dedup/garbage/bloat checks
 *
 * Rules produced by The Forge are identical in quality to rules from
 * the existing pipeline — same prompts, same scoring, same dedup.
 */

import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  regulatorySources, rawSnapshots, policyRules,
  pipelineRuns, policyEvents,
} from '../db/schema.js';
import { scoreDocumentQuality } from '../hunter/quality-scorer.js';
import { articleChunk } from '../hunter/article-chunker.js';
import { bulkExtract } from '../hunter/bulk-extractor.js';
import { scoreRules } from '../hunter/rule-scorer.js';
import { signRule } from '../core/rule-signing.js';
import { upsertExtractedRule } from '../core/rule-upsert.js';
import { policyBundleCache } from '../core/policy-cache.js';
import { resolveProvider } from '../llm/provider.js';
import { calculateCostCents } from '../llm/pricing.js';
import { broadcastEvent } from '../sse/manager.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { updateJobStatus, failJob } from './queue.js';
import { analyzeRules } from './analyzer.js';
import type { ForgeJob, ForgeErrorCategory } from './types.js';
import type { PolicyEffect, PolicySeverity } from '@nomus/shared';

// ─── Types ───────────────────────────────────────────────────

export interface PvsResult {
  jobId: string;
  status: 'completed' | 'error';
  rulesExtracted: number;
  rulesAccepted: number;
  rulesRejected: number;
  rulesDuplicate: number;
  rulesFlagged: number;
  llmTokensIn: number;
  llmTokensOut: number;
  llmCostCents: number;
  durationMs: number;
  qualityGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  errorMessage?: string;
  errorCategory?: ForgeErrorCategory;
}

// ─── Progress Broadcaster ────────────────────────────────────

function broadcastProgress(job: ForgeJob, phase: string, detail?: string, pct?: number): void {
  broadcastEvent({
    id: randomUUID(),
    type: 'forge.progress',
    jurisdiction: job.jurisdiction,
    data: {
      jobId: job.id,
      documentName: job.sourceName,
      jurisdiction: job.jurisdiction,
      phase,
      detail,
      percentComplete: pct,
    },
  });
}

// ─── Ensure Source Exists ────────────────────────────────────

/**
 * Ensure a regulatory source record exists for this document.
 * Creates one if it doesn't exist yet (needed for rule foreign keys).
 */
function ensureSource(job: ForgeJob, docUrl?: string): string {
  const db = getDb();

  // If job already has a sourceId, verify it exists
  if (job.sourceId) {
    const existing = db.select({ id: regulatorySources.id })
      .from(regulatorySources)
      .where(eq(regulatorySources.id, job.sourceId))
      .get();
    if (existing) return job.sourceId;
  }

  // Check if a source exists for this jurisdiction + name
  const existing = db.select({ id: regulatorySources.id })
    .from(regulatorySources)
    .where(eq(regulatorySources.name, job.sourceName))
    .get();
  if (existing) return existing.id;

  // Create a new source record
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  db.insert(regulatorySources).values({
    id: sourceId,
    name: job.sourceName,
    jurisdiction: job.jurisdiction,
    url: docUrl ?? `forge://local/${job.documentPath}`,
    parserType: job.fileType === 'pdf' ? 'pdf' : 'html',
    provenanceGrade: 'A', // Forge-processed = authoritative
    tier: 1,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();

  logger.info({ sourceId, name: job.sourceName }, 'Created regulatory source for Forge job');
  return sourceId;
}

// ─── Main PVS Worker ─────────────────────────────────────────

/**
 * Process a single forge job through Parse → Validate → Score.
 * Returns the result — the caller (orchestrator) handles job status updates.
 */
export async function processJob(job: ForgeJob): Promise<PvsResult> {
  const startTime = performance.now();
  let llmTokensIn = 0;
  let llmTokensOut = 0;
  let llmCostCents = 0;

  try {
    // ─── PARSE Phase ───────────────────────────────────────
    broadcastProgress(job, 'parse', 'Loading and parsing document', 5);
    updateJobStatus(job.id, 'processing');

    // Read raw content from disk
    const rawContent = readFileSync(job.documentPath, job.fileType === 'pdf' ? undefined : 'utf-8');

    let parsedContent: string;

    if (job.fileType === 'pdf') {
      const { parsePdf } = await import('../hunter/sources/parsers/pdf-parser.js');
      const buffer = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent);
      parsedContent = await parsePdf(buffer, {});
    } else if (job.fileType === 'md') {
      // Markdown is already structured text — use directly
      parsedContent = typeof rawContent === 'string' ? rawContent : rawContent.toString('utf-8');
    } else {
      // HTML
      const content = typeof rawContent === 'string' ? rawContent : rawContent.toString('utf-8');
      // Check if content is already extracted text (no HTML tags) or raw HTML
      if (content.includes('<') && (content.includes('<html') || content.includes('<body') || content.includes('<div'))) {
        const { parseHtml } = await import('../hunter/sources/parsers/html-parser.js');
        parsedContent = parseHtml(content, {});
      } else {
        // Already plain text (from Harvester's extractTextContent)
        parsedContent = content;
      }
    }

    // Quality check (free, <10ms)
    const quality = scoreDocumentQuality(parsedContent);

    if (quality.overallGrade === 'F') {
      const duration = Math.round(performance.now() - startTime);
      return {
        jobId: job.id, status: 'error',
        rulesExtracted: 0, rulesAccepted: 0, rulesRejected: 0,
        rulesDuplicate: 0, rulesFlagged: 0,
        llmTokensIn: 0, llmTokensOut: 0, llmCostCents: 0,
        durationMs: duration, qualityGrade: 'F',
        errorMessage: `Quality grade F — ${quality.issues.join('; ')}`,
        errorCategory: 'quality_rejected',
      };
    }

    logger.info({
      jobId: job.id,
      grade: quality.overallGrade,
      words: quality.wordCount,
      tokens: quality.estimatedTokens,
      issues: quality.issues.length > 0 ? quality.issues : undefined,
    }, `Parsed: Grade ${quality.overallGrade}, ${quality.wordCount} words`);

    // ─── VALIDATE Phase (Extract Requirements) ─────────────
    broadcastProgress(job, 'validate', 'Chunking and extracting requirements', 20);
    updateJobStatus(job.id, 'validating');

    // Chunk at article boundaries
    const chunks = articleChunk(parsedContent);
    const chunkInputs = chunks.map((ac) => ({
      content: ac.content,
      breadcrumb: ac.breadcrumb,
      index: ac.index,
      totalChunks: ac.totalChunks,
      articleRef: ac.articleRef,
    }));

    logger.info({
      jobId: job.id,
      chunks: chunkInputs.length,
      strategy: chunks[0]?.strategy ?? 'unknown',
    }, `Chunked into ${chunkInputs.length} pieces`);

    broadcastProgress(job, 'validate',
      `Extracting from ${chunkInputs.length} chunks (Haiku)`, 30);

    // Extract requirements with Haiku
    const extractions = await bulkExtract(chunkInputs, {
      sourceId: job.sourceId ?? undefined,
      sourceName: job.sourceName,
      jurisdiction: job.jurisdiction,
    });
    llmTokensIn += extractions.reduce((s, e) => s + e.tokensIn, 0);
    llmTokensOut += extractions.reduce((s, e) => s + e.tokensOut, 0);

    // Local dedup (free) — same logic as existing pipeline
    const allReqs = extractions.flatMap((e) => e.requirements);
    const dedupMap = new Map<string, typeof allReqs[0]>();
    for (const req of allReqs) {
      const key = `${req.ref}::${req.what.slice(0, 60)}`.toLowerCase();
      if (!dedupMap.has(key) || req.what.length > (dedupMap.get(key)?.what.length ?? 0)) {
        dedupMap.set(key, req);
      }
    }
    const uniqueReqs = Array.from(dedupMap.values());

    logger.info({ jobId: job.id, extracted: allReqs.length, unique: uniqueReqs.length },
      `Extracted: ${allReqs.length} → ${uniqueReqs.length} unique requirements`);

    if (uniqueReqs.length === 0) {
      const duration = Math.round(performance.now() - startTime);
      return {
        jobId: job.id, status: 'error',
        rulesExtracted: 0, rulesAccepted: 0, rulesRejected: 0,
        rulesDuplicate: 0, rulesFlagged: 0,
        llmTokensIn, llmTokensOut, llmCostCents: 0,
        durationMs: duration, qualityGrade: quality.overallGrade,
        errorMessage: 'Extraction produced zero requirements',
        errorCategory: 'empty_extraction',
      };
    }

    // Convert to candidate rules (same logic as existing pipeline)
    const jurisdictionPrefix = job.jurisdiction.toLowerCase().replace(/-/g, '_');
    const typeToEffect: Record<string, string> = {
      obligation: 'allow_with_audit', prohibition: 'deny', disclosure: 'require_disclosure',
      penalty: 'deny', definition: 'flag', exemption: 'flag',
    };
    const typeToCategory: Record<string, string> = {
      obligation: 'accountability', prohibition: 'safety', disclosure: 'transparency',
      penalty: 'accountability', definition: 'transparency', exemption: 'transparency',
    };

    const candidateRules: Array<{
      ruleKey: string; jurisdiction: string; category: string;
      conditions: Record<string, string>; effect: string; severity: string;
      humanSummary: string; legalReference: string; effectiveDate: string;
      expiresAt: string | null; industries: string[]; industryScope: string; industryNotes: string;
    }> = [];
    const seenKeys = new Set<string>();

    for (const req of uniqueReqs) {
      const refSlug = req.ref.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
      const topicSlug = req.what.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const ruleKey = `${jurisdictionPrefix}.${refSlug}.${topicSlug}`;

      if (seenKeys.has(ruleKey)) continue;
      seenKeys.add(ruleKey);

      candidateRules.push({
        ruleKey,
        jurisdiction: job.jurisdiction,
        category: typeToCategory[req.type] ?? 'transparency',
        conditions: {
          action: 'ai_operation',
          region: job.jurisdiction,
          ...(req.who ? { who: req.who } : {}),
          ...(req.conditions ? { condition: req.conditions } : {}),
        },
        effect: typeToEffect[req.type] ?? 'flag',
        severity: req.severity || 'medium',
        humanSummary: req.what.length > 490 ? req.what.slice(0, 487) + '...' : req.what,
        legalReference: req.ref,
        effectiveDate: req.effective_date || new Date().toISOString().split('T')[0],
        expiresAt: null,
        industries: req.industries || ['all'],
        industryScope: req.industry_scope || 'global',
        industryNotes: req.industry_notes || '',
      });
    }

    // ─── SCORE Phase ───────────────────────────────────────
    broadcastProgress(job, 'score',
      `Scoring ${candidateRules.length} candidate rules (Haiku)`, 60);
    updateJobStatus(job.id, 'scoring');

    const scoreResult = await scoreRules(candidateRules, job.sourceName, job.jurisdiction, {
      sourceId: job.sourceId ?? undefined,
      sourceName: job.sourceName,
    });
    llmTokensIn += scoreResult.tokensIn;
    llmTokensOut += scoreResult.tokensOut;

    // Compute LLM cost
    const resolved = await resolveProvider('classifier');
    llmCostCents = calculateCostCents(llmTokensIn, llmTokensOut, resolved.model, resolved.providerName);

    logger.info({
      jobId: job.id,
      candidates: candidateRules.length,
      scored: scoreResult.rules.length,
      rejected: scoreResult.rejected.length,
      score: scoreResult.overallScore,
    }, `Scored: ${candidateRules.length} → ${scoreResult.rules.length} rules`);

    // ─── ANALYZE Phase (Pre-Commit) ────────────────────────
    broadcastProgress(job, 'analyze', 'Running pre-commit analyzer', 75);

    const commitDecision = analyzeRules(scoreResult.rules, job.jurisdiction);

    if (commitDecision.approved.length === 0) {
      const duration = Math.round(performance.now() - startTime);
      logger.warn({ jobId: job.id, stats: commitDecision.stats },
        'Analyzer rejected all rules — nothing to commit');

      return {
        jobId: job.id, status: 'completed',
        rulesExtracted: uniqueReqs.length,
        rulesAccepted: 0,
        rulesRejected: commitDecision.stats.rejected,
        rulesDuplicate: commitDecision.stats.duplicates,
        rulesFlagged: commitDecision.stats.flagged,
        llmTokensIn, llmTokensOut, llmCostCents,
        durationMs: Math.round(performance.now() - startTime),
        qualityGrade: quality.overallGrade,
      };
    }

    // ─── COMMIT Phase (Transactional DB Write) ─────────────
    broadcastProgress(job, 'commit',
      `Committing ${commitDecision.approved.length} rules to DB`, 85);
    updateJobStatus(job.id, 'committing');

    const db = getDb();
    const sourceId = ensureSource(job);
    const now = new Date().toISOString();
    let rulesCreated = 0;
    let rulesUpdated = 0;
    let rulesSkippedLocked = 0;

    // Store snapshot for provenance. This is the authoritative committed
    // document for a Forge-ingested source (it is NOT re-promoted by
    // runPipeline), so mark it promoted so the read path serves it as current
    // law. Forge ingests document files → 'upload' provenance.
    const snapshotId = randomUUID();
    db.insert(rawSnapshots).values({
      id: snapshotId,
      sourceId,
      contentHash: createHash('sha256').update(parsedContent.slice(0, 500_000)).digest('hex'),
      content: parsedContent.slice(0, 500_000), // Cap at 500KB to be safe
      scrapedAt: now,
      provenanceMode: 'upload',
      promoted: true,
    }).run();

    // Transactional rule upsert — identical to existing pipeline
    db.transaction((tx) => {
      const lastEvent = tx.select({ sequence: policyEvents.sequence })
        .from(policyEvents)
        .orderBy(desc(policyEvents.sequence))
        .limit(1)
        .get();
      let nextSequence = (lastEvent?.sequence ?? 0) + 1;

      for (const rule of commitDecision.approved) {
        const outcome = upsertExtractedRule(
          tx,
          { sourceId, now, nextSequence: () => nextSequence++ },
          rule,
        );
        if (outcome === 'created') rulesCreated++;
        else if (outcome === 'updated') rulesUpdated++;
        else if (outcome === 'skipped_locked') rulesSkippedLocked++;
      }

      // Update source metadata
      tx.update(regulatorySources).set({
        lastScrapedAt: now,
        lastContentHash: job.contentHash,
        updatedAt: now,
      }).where(eq(regulatorySources.id, sourceId)).run();
    });

    // Invalidate policy cache
    policyBundleCache.invalidate();

    const duration = Math.round(performance.now() - startTime);
    const rulesAccepted = rulesCreated + rulesUpdated;

    // Record pipeline run for cost tracking
    db.insert(pipelineRuns).values({
      id: randomUUID(),
      sourceId,
      status: 'completed',
      stepReached: 3,
      diffDetected: true,
      classification: 'material',
      rulesCreated,
      rulesUpdated,
      llmProvider: resolved.providerName,
      llmModel: resolved.model,
      llmTokensIn,
      llmTokensOut,
      llmCostCents,
      durationMs: duration,
      startedAt: new Date(Date.now() - duration).toISOString(),
      completedAt: now,
    }).run();

    broadcastProgress(job, 'commit',
      `Committed ${rulesAccepted} rules (${rulesCreated} new, ${rulesUpdated} updated)`, 100);

    logger.info({
      jobId: job.id,
      rulesCreated,
      rulesUpdated,
      rulesSkippedLocked,
      rulesAccepted,
      llmCostCents,
      durationMs: duration,
    }, `PVS complete: ${rulesAccepted} rules committed`);

    return {
      jobId: job.id,
      status: 'completed',
      rulesExtracted: uniqueReqs.length,
      rulesAccepted,
      rulesRejected: commitDecision.stats.rejected + scoreResult.rejected.length,
      rulesDuplicate: commitDecision.stats.duplicates,
      rulesFlagged: commitDecision.stats.flagged,
      llmTokensIn,
      llmTokensOut,
      llmCostCents,
      durationMs: duration,
      qualityGrade: quality.overallGrade,
    };

  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Classify the error
    let category: ForgeErrorCategory = 'unknown';
    if (errorMsg.includes('encoding') || errorMsg.includes('charset') || errorMsg.includes('mojibake')) {
      category = 'encoding';
    } else if (errorMsg.includes('parse') || errorMsg.includes('cheerio') || errorMsg.includes('pdf')) {
      category = 'parse_failure';
    } else if (errorMsg.includes('zero requirements') || errorMsg.includes('empty')) {
      category = 'empty_extraction';
    } else if (errorMsg.includes('rate limit') || errorMsg.includes('429') || errorMsg.includes('timeout')) {
      category = 'llm_error';
    }

    logger.error({ jobId: job.id, error: errorMsg, category, durationMs: duration },
      `PVS failed: ${errorMsg}`);

    return {
      jobId: job.id,
      status: 'error',
      rulesExtracted: 0, rulesAccepted: 0, rulesRejected: 0,
      rulesDuplicate: 0, rulesFlagged: 0,
      llmTokensIn, llmTokensOut, llmCostCents,
      durationMs: duration,
      qualityGrade: 'F',
      errorMessage: errorMsg,
      errorCategory: category,
    };
  }
}
