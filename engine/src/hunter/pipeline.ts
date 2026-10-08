import { randomUUID, createHash } from 'node:crypto';
import { eq, desc, sql, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  regulatorySources,
  rawSnapshots,
  policyRules,
  pipelineRuns,
  policyEvents,
  regulatorySignals,
  stagedContent,
} from '../db/schema.js';
import { scrapeSource, ManualUploadRequiredError } from './scraper.js';
import { hasContentChanged, extractChangedSections } from './differ.js';
import { classifyChange } from './classifier.js';
import { translateToRules } from './translator.js';
import { signRule } from '../core/rule-signing.js';
import { getOntologyForPrompt } from '../db/ontology.js';
import { buildFeedbackContext } from '../feedback/refiner.js';
import { broadcastEvent } from '../sse/manager.js';
import { env } from '../config/env.js';
import { upsertExtractedRule } from '../core/rule-upsert.js';
import { publishRuleEvents, type PendingRuleEvent } from '../core/rule-management.js';
import { logger } from '../logger.js';
import { scoreDocumentQuality, diagnoseQualityFailure } from './quality-scorer.js';
import { healContent } from './scrape-healer.js';
import { recordSuccessfulStrategy } from './scrape-memory.js';
import { articleChunk } from './article-chunker.js';
import { bulkExtract } from './bulk-extractor.js';
import { scoreRules } from './rule-scorer.js';
import { resolveProvider } from '../llm/provider.js';
import { calculateCostCents } from '../llm/pricing.js';
import { cleanContent, selectCleaningProfile } from './content-cleaner.js';
import { verifyStructure } from './structural-verifier.js';
import { notifyPipelineComplete, notifyPipelineError } from '../services/notifications.js';
import { notifyRulesUpdated, notifyRulesError } from '../services/webhook-dispatcher.js';
import { recordScrapeFailure, recordScrapeSuccess } from './source-health.js';
import { runGatekeeper } from './gatekeeper.js';
import { gatekeeperLogs } from '../db/schema.js';
import { isPromotableProvenance, describeProvenance } from './provenance.js';

export interface PipelineResult {
  sourceId: string;
  sourceName: string;
  status: 'completed' | 'no_change' | 'typo_only' | 'error';
  stepReached: number;
  rulesCreated: number;
  rulesUpdated: number;
  /** Re-extracted rules left untouched because a person edited them (locked). */
  rulesSkippedLocked?: number;
  durationMs: number;
  error?: string;
}

/**
 * Run the full 5-Step Regulatory Pipeline for a single source.
 *
 * STAGED PIPELINE (v3):
 *   Step 1: Scrape/Upload -> staged_content (NOT rawSnapshots, NOT lastContentHash)
 *   Step 2: Clean -> strip HTML/non-content, produce verbatim regulatory text
 *           Quality score the cleaned text (F/D: heal or reject, C: needs_review, A/B: continue)
 *   Step 3: Verify -> structural verification of cleaned text
 *           Check article numbering, cross-references, truncation, content integrity
 *           LLM spot-check ONLY on flagged sections
 *   Step 4: Extract -> chunk verified text, bulk extract rules, score/validate
 *   Step 5: Promote (transactional):
 *           - Write to rawSnapshots
 *           - Write rules to policyRules
 *           - Update lastContentHash on source
 *           - Set pipelineStatus = 'promoted'
 *
 * RESUME LOGIC:
 *   On entry, check staged_content for existing entries for this source.
 *   Resume from where it left off if the entry is recoverable.
 *
 * CRITICAL: lastContentHash is NOT updated until promotion succeeds.
 *   If the pipeline fails mid-way, the next run will see "changed" content
 *   and can resume from the staged entry.
 */
const PIPELINE_TIMEOUT_MS = 120 * 60 * 1000; // 2 hours

// Pipeline mutex — prevents concurrent runs on the same source.
const activePipelines = new Map<string, number>();
const STALE_PIPELINE_MS = 120 * 60 * 1000;

/**
 * Run the pipeline for a source and announce how it ended.
 *
 * Every run ends with one `pipeline.progress` event carrying `done: true` and
 * an `outcome` (completed / no_change / error), whichever path it took. The
 * dashboard used to infer completion from step numbers, so runs that stopped
 * early (rejected upload, grade C review, verification failure, a thrown
 * error) left their source card spinning and every Scrape button disabled.
 */
export async function runPipeline(sourceId: string): Promise<PipelineResult> {
  let result: PipelineResult;
  try {
    result = await runPipelineSteps(sourceId);
  } catch (err) {
    announcePipelineEnd(sourceId, {
      sourceId, sourceName: 'unknown', status: 'error', stepReached: 0,
      rulesCreated: 0, rulesUpdated: 0, durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  // A refused concurrent start must not end the run that is in progress.
  if (!(result.stepReached === 0 && result.error?.startsWith('Pipeline already running'))) {
    announcePipelineEnd(sourceId, result);
  }
  return result;
}

function announcePipelineEnd(sourceId: string, result: PipelineResult): void {
  const source = getDb().select({ name: regulatorySources.name, jurisdiction: regulatorySources.jurisdiction })
    .from(regulatorySources).where(eq(regulatorySources.id, sourceId)).get();
  const outcome = result.status === 'completed' ? 'completed'
    : result.status === 'error' ? 'error'
    : 'no_change';
  broadcastEvent({
    type: 'pipeline.progress',
    data: {
      sourceId,
      sourceName: source?.name ?? result.sourceName,
      step: 5,
      stepName: outcome === 'completed' ? 'Complete' : outcome === 'error' ? 'Failed' : 'No changes detected',
      done: true,
      outcome,
      stepReached: result.stepReached,
      rulesCreated: result.rulesCreated,
      rulesUpdated: result.rulesUpdated,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      percentComplete: 100,
    },
    jurisdiction: source?.jurisdiction ?? '*',
  });
}

async function runPipelineSteps(sourceId: string): Promise<PipelineResult> {
  const existing = activePipelines.get(sourceId);
  if (existing) {
    const age = Date.now() - existing;
    if (age < STALE_PIPELINE_MS) {
      return {
        sourceId,
        sourceName: 'unknown',
        status: 'error',
        stepReached: 0,
        rulesCreated: 0,
        rulesUpdated: 0,
        durationMs: 0,
        error: `Pipeline already running for source ${sourceId} (started ${Math.round(age / 1000)}s ago)`,
      };
    }
    logger.warn({ sourceId, ageMs: age }, `Clearing stale pipeline lock (${Math.round(age / 60000)} min old)`);
    activePipelines.delete(sourceId);
  }
  activePipelines.set(sourceId, Date.now());
  const db = getDb();
  const startTime = performance.now();

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) throw new Error(`Source ${sourceId} not found`);

  let stepReached = 0;
  let rulesCreated = 0;
  let rulesUpdated = 0;
  let llmProvider: string | undefined;
  let llmModel: string | undefined;
  let llmTokensIn = 0;
  let llmTokensOut = 0;
  let llmCostCents = 0;

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), PIPELINE_TIMEOUT_MS);

  try {
    const checkTimeout = () => {
      if (timeoutController.signal.aborted) {
        throw new Error(`Pipeline timeout: exceeded ${PIPELINE_TIMEOUT_MS / 1000}s limit`);
      }
    };

    const progress = (step: number, stepName: string, detail?: Record<string, unknown>) => {
      broadcastEvent({
        type: 'pipeline.progress',
        data: { sourceId, sourceName: source.name, step, stepName, ...detail },
        jurisdiction: source.jurisdiction,
      });
    };

    // ─── RESUME CHECK: Look for existing staged entry ───────────
    const existingStaged = db.select().from(stagedContent)
      .where(eq(stagedContent.sourceId, sourceId))
      .orderBy(desc(stagedContent.createdAt))
      .limit(1)
      .get();

    if (existingStaged) {
      const st = existingStaged;

      // If needs_intervention with retryCount >= 2 — refuse to process
      if (st.pipelineStatus === 'needs_intervention' && st.retryCount >= 2) {
        const duration = Math.round(performance.now() - startTime);
        logger.error({ sourceId, stagedId: st.id, retryCount: st.retryCount },
          'Pipeline blocked: staged entry has failed 2+ times and requires manual intervention');
        return {
          sourceId, sourceName: source.name,
          status: 'error', stepReached: 0,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
          error: `Pipeline blocked: requires manual intervention (${st.retryCount} failed retries). Use admin API to retry or reject.`,
        };
      }

      // If status is 'needs_review' — cannot auto-process, admin must approve
      if (st.pipelineStatus === 'needs_review') {
        const duration = Math.round(performance.now() - startTime);
        logger.info({ sourceId, stagedId: st.id, grade: st.qualityGrade },
          'Pipeline paused: staged entry awaiting admin review (grade C)');
        return {
          sourceId, sourceName: source.name,
          status: 'error', stepReached: 2,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
          error: `Staged content awaiting admin review (grade ${st.qualityGrade}). Approve or reject via admin API.`,
        };
      }

      // If 'rejected' with same contentHash as current scrape — skip
      if (st.pipelineStatus === 'rejected') {
        // We'll check after scraping if the hash matches
        // For now, just note it exists
      }

      // If 'promoted' — this entry is done. Let a new scrape proceed.
      // Fall through to scrape logic.

      // RESUMABLE STATES: pending, cleaning, cleaned, verifying, verified, scoring, scored, extracting, extracted, promoting
      if (['pending', 'cleaning', 'cleaned', 'verifying', 'verified', 'scoring', 'scored', 'extracting', 'extracted', 'promoting'].includes(st.pipelineStatus)) {
        logger.info({ sourceId, stagedId: st.id, status: st.pipelineStatus, step: st.pipelineStep },
          `Resuming staged pipeline from status=${st.pipelineStatus}`);

        const resumeResult = await resumeFromStaged(
          db, source, st, progress, checkTimeout,
          llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, startTime,
        );
        return resumeResult;
      }
    }

    // ─── Step 1: Get Content (upload or scrape) ────────────────────
    stepReached = 1;

    let scrapeResult: Awaited<ReturnType<typeof scrapeSource>>;
    const hasPendingUpload = !!source.pendingUploadHash;

    if (hasPendingUpload) {
      // ─── UPLOAD MODE: Use the uploaded content directly ────────
      progress(1, 'Processing uploaded file');
      logger.info({ sourceId, name: source.name, file: source.pendingUploadFile },
        'Step 1: Processing uploaded file — skipping live scrape');

      const uploadedSnapshot = db.select().from(rawSnapshots)
        .where(eq(rawSnapshots.sourceId, sourceId))
        .orderBy(desc(rawSnapshots.scrapedAt))
        .limit(1)
        .get();

      if (!uploadedSnapshot || !uploadedSnapshot.content) {
        throw new Error('Uploaded content not found in snapshots. Please re-upload the file.');
      }

      let parsedContent = uploadedSnapshot.content;
      const registeredType = source.parserType as 'html' | 'pdf';
      let selectorConfig: Record<string, unknown>;
      try {
        selectorConfig = JSON.parse(source.selectorConfig);
      } catch {
        selectorConfig = {};
      }

      // Defense-in-depth auto-detection: the upload route should already have
      // set source.parserType correctly, but we also sniff the content here so
      // a misregistered source can't produce silent zero-rule output.
      // - PDFs are base64-encoded; decoding the first 16 chars yields "%PDF"
      // - HTML starts with or contains standard HTML tags in the first 2KB
      let effectiveType: 'html' | 'pdf' = registeredType;
      try {
        const head = Buffer.from(parsedContent.slice(0, 16), 'base64').toString('binary');
        if (head.startsWith('%PDF')) {
          effectiveType = 'pdf';
        } else if (parsedContent.includes('<') && /<(!DOCTYPE|html|head|body|div|p|h[1-6])\b/i.test(parsedContent.slice(0, 2000))) {
          effectiveType = 'html';
        }
      } catch {
        // stay with registered type
      }

      if (effectiveType !== registeredType) {
        logger.warn(
          { sourceId, registered: registeredType, effective: effectiveType },
          'Uploaded content type differs from registered parserType — using effective type',
        );
      }

      if (effectiveType === 'html') {
        const { parseHtml } = await import('./sources/parsers/html-parser.js');
        parsedContent = parseHtml(parsedContent, selectorConfig);
        logger.info({ sourceId, rawLength: uploadedSnapshot.content.length, parsedLength: parsedContent.length },
          'Parsed uploaded HTML to clean text');
      } else {
        const { parsePdf } = await import('./sources/parsers/pdf-parser.js');
        const buffer = Buffer.from(parsedContent, 'base64');
        if (buffer.length < 16 || !buffer.subarray(0, 4).toString('binary').startsWith('%PDF')) {
          throw new Error('Uploaded content is not a valid PDF. Expected base64-encoded PDF starting with %PDF magic bytes.');
        }
        parsedContent = await parsePdf(buffer, selectorConfig);
        logger.info({ sourceId, parsedLength: parsedContent.length }, 'Parsed uploaded PDF to clean text');
      }

      const contentHash = createHash('sha256').update(parsedContent).digest('hex');
      const wordCount = parsedContent.split(/\s+/).filter(Boolean).length;
      scrapeResult = {
        content: parsedContent,
        contentHash,
        contentQuality: 'valid' as const,
        fetchedAt: new Date().toISOString(),
        wordCount,
        source: 'upload' as const,
      };
    } else {
      // ─── SCRAPE MODE: Fetch from live URL ─────────────────────
      progress(1, 'Fetching source content');
      logger.info({ sourceId, name: source.name }, 'Step 1: Scraping source...');

      let selectorConfig: Record<string, unknown>;
      try {
        selectorConfig = JSON.parse(source.selectorConfig);
      } catch {
        throw new Error(`Source ${source.name}: selectorConfig is not valid JSON: ${source.selectorConfig.slice(0, 100)}`);
      }
      // For official-API conditional fetching: hand the adapter the coordinate
      // of the last promoted snapshot so it can skip re-downloading unchanged
      // official content (it ALWAYS re-hashes on an actual fetch).
      const lastPromotedForCoord = db.select({ coord: rawSnapshots.pointInTimeCoordinate })
        .from(rawSnapshots)
        .where(and(eq(rawSnapshots.sourceId, source.id), eq(rawSnapshots.promoted, true)))
        .orderBy(desc(rawSnapshots.scrapedAt))
        .limit(1)
        .get();
      let lastCoordinate: import('./sources/adapters/types.js').PointInTimeCoordinate | null = null;
      if (lastPromotedForCoord?.coord) {
        try {
          lastCoordinate = JSON.parse(lastPromotedForCoord.coord);
        } catch {
          lastCoordinate = null;
        }
      }

      scrapeResult = await scrapeSource(
        source.url,
        source.parserType as 'html' | 'pdf',
        selectorConfig,
        {
          sourceId: source.id,
          sourceName: source.name,
          maxCacheAgeHours: source.slaMaxAgeHours ?? 168,
          lastContentHash: source.lastContentHash,
          lastCoordinate,
          // ACCESS-ESCALATION: JS-rendered / bot-walled sources go straight to a
          // headless capture; the optional proxy is wired into the browser context.
          needsHeadless: source.needsHeadless ?? false,
          proxyUrl: env().NOMUS_HEADLESS_PROXY,
          onEvent: (tier, message, details) => {
            if (tier === 1) {
              logger.info({ sourceId, tier, message, ...details }, `Scraper auto-fix: ${message}`);
            } else if (tier === 2) {
              logger.warn({ sourceId, tier, message, ...details }, `Scraper notify: ${message}`);
              // G4 fix: was sendPush([], ...) — a hardcoded empty topic list,
              // so configured push topics never received scraper events.
              import('../services/notifications.js').then((n) => {
                n.sendSlack(`*${source.name}*: ${message}`, 'Scraper Auto-Fix').catch(() => {});
                n.sendPush(n.getPushTopics(), `Scraper: ${source.name}`, message).catch(() => {});
              }).catch(() => {});
            } else {
              logger.error({ sourceId, tier, message, ...details }, `SCRAPER ESCALATION: ${message}`);
            import('../services/notifications.js').then((n) => {
              n.sendSlack(`*URGENT — ${source.name}*\n${message}`, 'Source Unreachable').catch(() => {});
              n.sendPush(n.getPushTopics(), `URGENT: ${source.name}`, message, 'urgent').catch(() => {});
            }).catch(() => {});
          }
        },
      },
    );
    } // end else (scrape mode)

    // Clear pending upload after processing
    if (hasPendingUpload) {
      db.update(regulatorySources)
        .set({ pendingUploadFile: null, pendingUploadHash: null, pendingUploadAt: null })
        .where(eq(regulatorySources.id, sourceId))
        .run();
      logger.info({ sourceId }, 'Pending upload cleared — returning to normal scrape mode');
    }

    // Validate content quality — reject garbage before staging
    if (scrapeResult.contentQuality === 'rejected') {
      const duration = Math.round(performance.now() - startTime);
      const rejectError = `Content rejected: ${scrapeResult.rejectionReason}`;
      recordPipelineRun(db, source.id, 'error', 1, false, null, 0, 0, duration,
        undefined, undefined, 0, 0, 0, rejectError);

      recordScrapeFailure(sourceId, rejectError);

      db.update(regulatorySources)
        .set({
          lastScrapedAt: scrapeResult.fetchedAt,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(regulatorySources.id, sourceId))
        .run();

      logger.warn({ sourceId, reason: scrapeResult.rejectionReason, durationMs: duration },
        'Step 1: Content quality check failed — stopping pipeline');
      return {
        sourceId, sourceName: source.name,
        status: 'error', stepReached: 1,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
        error: rejectError,
      };
    }

    // Check if content changed — SKIP for uploads (user explicitly wants to process)
    if (!hasPendingUpload && !hasContentChanged(source.lastContentHash, scrapeResult.contentHash)) {
      const duration = Math.round(performance.now() - startTime);
      recordPipelineRun(db, source.id, 'no_change', 1, false, null, 0, 0, duration);
      recordScrapeSuccess(sourceId);

      db.update(regulatorySources)
        .set({ lastScrapedAt: scrapeResult.fetchedAt })
        .where(eq(regulatorySources.id, sourceId))
        .run();

      logger.info({ sourceId, durationMs: duration }, 'Step 1: No changes detected — stopping');
      return {
        sourceId, sourceName: source.name,
        status: 'no_change', stepReached: 1,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
      };
    }

    // Check if a previous staged entry already rejected this exact content
    // (Not for uploads: an admin re-processing an uploaded file asked for it,
    // and silently answering "no change" left the upload unprocessed.)
    if (!hasPendingUpload && existingStaged && existingStaged.pipelineStatus === 'rejected' && existingStaged.contentHash === scrapeResult.contentHash) {
      const duration = Math.round(performance.now() - startTime);
      logger.info({ sourceId, contentHash: scrapeResult.contentHash },
        'Step 1: Content was previously evaluated and rejected — skipping');
      return {
        sourceId, sourceName: source.name,
        status: 'no_change', stepReached: 1,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
      };
    }

    // Save to content cache for future fallback
    try {
      const { saveCacheContent } = await import('./content-cache.js');
      saveCacheContent(source.id, scrapeResult.content, source.parserType);
    } catch {
      // Cache save is best-effort
    }

    // Store raw snapshot for viewer and audit trail
    const now = new Date().toISOString();
    const snapshotId = randomUUID();
    db.insert(rawSnapshots).values({
      id: snapshotId,
      sourceId: source.id,
      contentHash: scrapeResult.contentHash,
      content: scrapeResult.content,
      scrapedAt: scrapeResult.fetchedAt,
      // Provenance: store the unmodified HTTP body and metadata so we can
      // prove this regulation matches the source byte-for-byte at scrape time.
      rawBytesHash: scrapeResult.rawBytesHash,
      rawBytesSize: scrapeResult.rawBytesSize,
      rawContent: scrapeResult.rawContent,
      fetchedUrl: scrapeResult.fetchedUrl,
      httpStatus: scrapeResult.httpStatus,
      contentType: scrapeResult.contentType,
      userAgent: scrapeResult.userAgent,
      provenanceMode: hasPendingUpload ? 'upload' : (scrapeResult.provenanceMode ?? 'byte_exact'),
      provenanceManifest: scrapeResult.provenanceManifest
        ? JSON.stringify(scrapeResult.provenanceManifest)
        : null,
      // API-first ingestion: channel + official point-in-time coordinate.
      ingestionChannel: scrapeResult.channel ?? null,
      pointInTimeCoordinate: scrapeResult.pointInTimeCoordinate
        ? JSON.stringify(scrapeResult.pointInTimeCoordinate)
        : null,
      // Intermediate scrape snapshot — NOT a promotion. Only the transactional
      // promote step writes promoted=true rows (the last known-good version).
      promoted: false,
    }).run();

    // ─── STAGE the content for pipeline processing ──
    const stagedId = randomUUID();

    // Clean up any old non-terminal staged entries for this source
    db.delete(stagedContent)
      .where(and(
        eq(stagedContent.sourceId, sourceId),
        // Only delete entries that are not in terminal states we want to keep
        // We keep 'rejected' (so we can skip re-evaluation) and 'promoted' for history
      ))
      .run();

    db.insert(stagedContent).values({
      id: stagedId,
      sourceId: source.id,
      contentHash: scrapeResult.contentHash,
      content: scrapeResult.content,
      fetchedAt: scrapeResult.fetchedAt,
      wordCount: scrapeResult.wordCount,
      source: hasPendingUpload ? 'upload' : 'scrape',
      pipelineStep: 1,
      pipelineStatus: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      // Carry raw provenance through staging so promotion can copy it forward
      rawBytesHash: scrapeResult.rawBytesHash,
      rawBytesSize: scrapeResult.rawBytesSize,
      rawContent: scrapeResult.rawContent,
      fetchedUrl: scrapeResult.fetchedUrl,
      httpStatus: scrapeResult.httpStatus,
      contentType: scrapeResult.contentType,
      provenanceMode: hasPendingUpload ? 'upload' : (scrapeResult.provenanceMode ?? 'byte_exact'),
      provenanceManifest: scrapeResult.provenanceManifest
        ? JSON.stringify(scrapeResult.provenanceManifest)
        : null,
      // API-first ingestion: carry channel + coordinate through staging so
      // promotion can copy the official version reference forward.
      ingestionChannel: scrapeResult.channel ?? null,
      pointInTimeCoordinate: scrapeResult.pointInTimeCoordinate
        ? JSON.stringify(scrapeResult.pointInTimeCoordinate)
        : null,
    }).run();

    // ─── Fail-closed hold: non-promotable provenance ───────────
    // A stale-cache hit (live source unreachable) has NO live HTTP provenance
    // and must NEVER be promoted as current law. Hold it as unverified so the
    // read path keeps serving the last known-good promoted snapshot. (The
    // intermediate snapshot above is retained for audit but is promoted=false.)
    const stagedProvenance = hasPendingUpload ? 'upload' : (scrapeResult.provenanceMode ?? 'byte_exact');
    if (!isPromotableProvenance(stagedProvenance)) {
      const holdReason = `Held (not promoted): ${describeProvenance(stagedProvenance).label} has no live provenance and cannot be presented as current law. Last known-good version remains served.`;
      db.update(stagedContent)
        .set({ pipelineStatus: 'needs_intervention', pipelineError: holdReason, updatedAt: new Date().toISOString() })
        .where(eq(stagedContent.id, stagedId))
        .run();

      // ACCESS-ESCALATION terminal tier: the scraper exhausted every automated
      // tier (scrape + headless) and served a stale cached copy. Flag the source
      // so the admin UI/API surfaces "awaiting manual upload".
      if (scrapeResult.needsManualUpload) {
        db.update(regulatorySources)
          .set({
            needsManualUpload: true,
            manualUploadReason: scrapeResult.manualUploadReason ?? holdReason,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(regulatorySources.id, sourceId))
          .run();
      }

      const duration = Math.round(performance.now() - startTime);
      recordPipelineRun(db, source.id, 'error', 1, false, null, 0, 0, duration,
        undefined, undefined, llmTokensIn, llmTokensOut, 0, holdReason);
      recordScrapeFailure(sourceId, holdReason);

      logger.warn({ sourceId, provenanceMode: stagedProvenance },
        'Step 1: Non-promotable provenance — holding as unverified, keeping last known-good');
      return {
        sourceId, sourceName: source.name,
        status: 'error', stepReached: 1,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
        error: holdReason,
      };
    }

    // ─── Step 1.5: Gatekeeper — LLM content verification ────────
    progress(1, 'Verifying content integrity');
    const gatekeeperResult = await runGatekeeper(
      scrapeResult.content,
      source.name,
      source.jurisdiction,
    );
    llmTokensIn += gatekeeperResult.tokensIn;
    llmTokensOut += gatekeeperResult.tokensOut;

    // Log gatekeeper decision
    db.insert(gatekeeperLogs).values({
      id: randomUUID(),
      sourceId: source.id,
      snapshotId,
      status: gatekeeperResult.status,
      issues: JSON.stringify(gatekeeperResult.issues),
      strippedBytes: gatekeeperResult.strippedBytes,
      tokensIn: gatekeeperResult.tokensIn,
      tokensOut: gatekeeperResult.tokensOut,
      createdAt: new Date().toISOString(),
    }).run();

    // Update verification status on source
    db.run(sql`UPDATE regulatory_sources SET
      content_verification = ${gatekeeperResult.status},
      content_verification_at = ${new Date().toISOString()},
      content_verification_issues = ${JSON.stringify(gatekeeperResult.issues)}
      WHERE id = ${sourceId}`);

    if (gatekeeperResult.status === 'failed') {
      const duration = Math.round(performance.now() - startTime);
      const failReason = `Gatekeeper: content failed verification — ${gatekeeperResult.issues.map((i) => i.type).join(', ')}`;
      recordPipelineRun(db, source.id, 'error', 1, false, null, 0, 0, duration,
        undefined, undefined, llmTokensIn, llmTokensOut, 0, failReason);
      recordScrapeFailure(sourceId, failReason);
      return {
        sourceId, sourceName: source.name,
        status: 'error' as const, stepReached: 1,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
        error: failReason,
      };
    }

    if (gatekeeperResult.status === 'cleaned' && gatekeeperResult.strippedContent) {
      // Update snapshot with cleaned content
      const cleanHash = createHash('sha256').update(gatekeeperResult.strippedContent).digest('hex');
      db.update(rawSnapshots)
        .set({ content: gatekeeperResult.strippedContent, contentHash: cleanHash })
        .where(eq(rawSnapshots.id, snapshotId))
        .run();

      scrapeResult.content = gatekeeperResult.strippedContent;
      scrapeResult.contentHash = cleanHash;

      logger.warn({
        sourceId, issueCount: gatekeeperResult.issues.length,
        strippedBytes: gatekeeperResult.strippedBytes,
      }, `Gatekeeper: stripped ${gatekeeperResult.strippedBytes} bytes of contamination`);
    }

    // Get previous snapshot for diffing
    const previousSnapshot = db.select().from(rawSnapshots)
      .where(eq(rawSnapshots.sourceId, source.id))
      .orderBy(desc(rawSnapshots.scrapedAt))
      .limit(2)
      .all()[1]; // Second most recent

    const isFirstScrape = !previousSnapshot || hasPendingUpload; // Uploads always process full content
    let diff: ReturnType<typeof extractChangedSections> = { hasChanges: true, changedSections: [], summary: 'First scrape' };

    // Always update lastContentHash after successful scrape (even if pipeline fails later)
    // This prevents re-processing identical content on retry
    db.update(regulatorySources)
      .set({ lastScrapedAt: scrapeResult.fetchedAt, lastContentHash: scrapeResult.contentHash })
      .where(eq(regulatorySources.id, sourceId))
      .run();
    const staged = db.select().from(stagedContent)
      .where(eq(stagedContent.id, stagedId))
      .get()!;

    const result = await resumeFromStaged(
      db, source, staged, progress, checkTimeout,
      llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, startTime,
    );
    return result;

  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);

    // ACCESS-ESCALATION terminal tier: the scraper exhausted every automated tier
    // (scrape + headless) with no cached copy. Flag the source so the admin
    // UI/API surfaces "awaiting manual upload". The last known-good promoted
    // snapshot keeps serving (read path is unchanged / refuse-to-guess).
    if (err instanceof ManualUploadRequiredError) {
      db.update(regulatorySources)
        .set({
          needsManualUpload: true,
          manualUploadReason: err.reason,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(regulatorySources.id, sourceId))
        .run();
    }

    recordPipelineRun(db, source.id, 'error', stepReached, stepReached > 1, null,
      rulesCreated, rulesUpdated, duration,
      llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, errorMsg);

    recordScrapeFailure(sourceId, errorMsg);

    logger.error({ sourceId, stepReached, error: errorMsg, durationMs: duration },
      'Pipeline failed — defaulting to last known safe state');

    notifyPipelineError({
      sourceName: source.name,
      stepReached,
      errorMessage: errorMsg,
    }).catch((err) => logger.error({ error: (err as Error).message }, 'notifyPipelineError failed'));

    notifyRulesError({
      sourceId: source.id,
      sourceName: source.name,
      error: errorMsg,
      stepReached,
    }).catch((err) => logger.error({ error: (err as Error).message }, 'notifyRulesError webhook failed'));

    return {
      sourceId, sourceName: source.name,
      status: 'error', stepReached,
      rulesCreated, rulesUpdated, durationMs: duration,
      error: errorMsg,
    };
  } finally {
    clearTimeout(timeout);
    activePipelines.delete(sourceId);
  }
}

// ─── RESUME FROM STAGED ENTRY ─────────────────────────────────
// Handles the 5-step pipeline: 1=Scrape, 2=Clean, 3=Verify, 4=Extract, 5=Promote.
// Can be called from a fresh pipeline run or a resume.

async function resumeFromStaged(
  db: ReturnType<typeof getDb>,
  source: {
    id: string; name: string; jurisdiction: string; parserType: string;
    selectorConfig: string; lastContentHash: string | null;
    pendingUploadHash: string | null; url: string;
  },
  stagedParam: typeof stagedContent.$inferSelect,
  progress: (step: number, stepName: string, detail?: Record<string, unknown>) => void,
  checkTimeout: () => void,
  llmProvider: string | undefined,
  llmModel: string | undefined,
  llmTokensIn: number,
  llmTokensOut: number,
  llmCostCents: number,
  startTime: number,
): Promise<PipelineResult> {
  let staged = stagedParam;
  const sourceId = source.id;
  let stepReached = staged.pipelineStep;
  let rulesCreated = 0;
  let rulesUpdated = 0;
  let rulesSkippedLocked = 0;

  // Accumulate LLM stats from staged entry if resuming
  llmTokensIn += staged.llmTokensIn;
  llmTokensOut += staged.llmTokensOut;
  llmCostCents += staged.llmCostCents;
  if (staged.llmProvider) llmProvider = staged.llmProvider;
  if (staged.llmModel) llmModel = staged.llmModel;

  const now = () => new Date().toISOString();

  const updateStaged = (fields: Partial<typeof stagedContent.$inferInsert>) => {
    db.update(stagedContent)
      .set({ ...fields, updatedAt: now() })
      .where(eq(stagedContent.id, staged.id))
      .run();
  };

  const markIntervention = (error: string) => {
    const newRetry = staged.retryCount + 1;
    updateStaged({
      pipelineStatus: newRetry >= 2 ? 'needs_intervention' : 'pending',
      pipelineError: error,
      retryCount: newRetry,
    });
  };

  try {
    // ═══════════════════════════════════════════════════════════
    // STEP 2: CLEAN — Strip non-content, preserve verbatim text
    // ═══════════════════════════════════════════════════════════
    if (['pending', 'cleaning'].includes(staged.pipelineStatus)) {
      checkTimeout();
      stepReached = 2;
      progress(2, 'Cleaning content');
      updateStaged({ pipelineStatus: 'cleaning', pipelineStep: 2 });

      // CHANNEL-APPROPRIATE CLEANING: official-API-derived text (byte_exact
      // from an adapter) is already clean text from an authoritative structured
      // artifact, so it gets the LIGHT 'structured' profile — the aggressive
      // HTML-chrome stripping would damage legitimate regulatory text. Scraped
      // HTML/PDF keeps the aggressive profile. Cleaning still RUNS for every
      // channel; only its profile changes. The channel signal is carried on the
      // staged row by the API-first ingestion work.
      const cleaningProfile = selectCleaningProfile({
        ingestionChannel: staged.ingestionChannel,
        provenanceMode: staged.provenanceMode,
      });
      const cleanResult = cleanContent(staged.content, source.parserType as 'html' | 'pdf', cleaningProfile);

      // Quality check on the cleaned content (UNCONDITIONAL — runs for every
      // profile; provenance never lets content skip the accuracy gate).
      const quality = scoreDocumentQuality(cleanResult.cleanText);

      updateStaged({
        cleanedText: cleanResult.cleanText,
        wordCount: cleanResult.wordCount,
        qualityGrade: quality.overallGrade,
        qualityStructure: quality.structureScore,
        qualityText: quality.textScore,
        qualityIssues: JSON.stringify(quality.issues),
        pipelineStep: 2,
      });

      logger.info({
        sourceId, stagedId: staged.id,
        cleaningProfile,
        ingestionChannel: staged.ingestionChannel,
        grade: quality.overallGrade,
        wordCount: cleanResult.wordCount,
        articlesFound: cleanResult.articlesFound.length,
        removedElements: cleanResult.removedElements.length,
        warnings: cleanResult.warnings,
      }, `Step 2: Content cleaned (${cleaningProfile}) — Grade ${quality.overallGrade}, ${cleanResult.wordCount} words, ${cleanResult.articlesFound.length} articles`);

      if ((quality.overallGrade === 'F' || quality.overallGrade === 'D') && staged.provenanceMode === 'upload') {
        // A manually uploaded document is processed on its own path. Self-
        // healing would refetch the live URL or an archive copy and process
        // THAT instead of the file the admin uploaded, so it never runs for
        // uploads: the upload is rejected with the reason, and the source's
        // scrape-health counters are left alone (no scrape happened).
        const diagnostic = diagnoseQualityFailure(cleanResult.cleanText, quality);
        const rejectError = `Uploaded document scored quality grade ${quality.overallGrade}: ${diagnostic}. ` +
          'Upload a copy containing the full legal text (without site navigation or scanned images) and process it again.';
        updateStaged({ pipelineStatus: 'rejected', qualityDiagnostic: diagnostic, pipelineError: rejectError });
        const duration = Math.round(performance.now() - startTime);
        recordPipelineRun(db, sourceId, 'error', 2, false, null, 0, 0, duration,
          llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, rejectError);
        logger.warn({ sourceId, grade: quality.overallGrade, diagnostic }, 'Step 2: Uploaded document rejected on quality');
        progress(2, 'Uploaded document rejected', { grade: quality.overallGrade, diagnostic });
        return {
          sourceId, sourceName: source.name,
          status: 'error', stepReached: 2,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
          error: rejectError,
        };
      }

      if (quality.overallGrade === 'F' || quality.overallGrade === 'D') {
        // Before rejecting, try self-healing pipeline
        const diagnostic = diagnoseQualityFailure(cleanResult.cleanText, quality);
        logger.info({ sourceId, grade: quality.overallGrade, diagnostic },
          'Step 2: Grade D/F after cleaning — attempting self-healing');
        progress(2, 'Quality check failed — attempting healing', { grade: quality.overallGrade, diagnostic });

        let selectorConfig: Record<string, unknown>;
        try {
          selectorConfig = JSON.parse(source.selectorConfig);
        } catch {
          selectorConfig = {};
        }

        const healingResult = await healContent(staged.content, {
          sourceId: source.id,
          sourceName: source.name,
          url: source.url,
          selectorConfig,
          parserType: source.parserType as 'html' | 'pdf',
        });

        updateStaged({
          healingAttempted: true,
          healingLog: JSON.stringify(healingResult.attempts),
          healingStrategy: healingResult.strategy,
        });

        if (healingResult.healed && healingResult.content && healingResult.contentHash) {
          logger.info({
            sourceId,
            strategy: healingResult.strategy,
            newGrade: healingResult.grade,
            wordCount: healingResult.wordCount,
          }, `Step 2: Healing succeeded via "${healingResult.strategy}" — grade improved to ${healingResult.grade}`);

          progress(2, 'Healing succeeded', { strategy: healingResult.strategy, newGrade: healingResult.grade });

          // Re-clean the healed content
          const healedClean = cleanContent(healingResult.content, source.parserType as 'html' | 'pdf');

          // G3 provenance honesty: content fetched from an alternative source
          // (wayback/pdf_direct) must carry THAT fetch's provenance — never
          // the failed primary fetch's fields — and be marked 'healed'.
          // 'repaired' keeps the original provenance (it transformed the
          // original bytes) but is still marked so nobody mistakes the
          // cleaned text for a byte-exact extraction.
          const healedProvenance = healingResult.provenance
            ? {
                rawBytesHash: healingResult.provenance.rawBytesHash,
                rawBytesSize: healingResult.provenance.rawBytesSize,
                rawContent: healingResult.provenance.rawContent,
                fetchedUrl: healingResult.provenance.fetchedUrl,
                httpStatus: healingResult.provenance.httpStatus,
                contentType: healingResult.provenance.contentType,
              }
            : {};

          updateStaged({
            content: healingResult.content,
            contentHash: healingResult.contentHash,
            cleanedText: healedClean.cleanText,
            wordCount: healedClean.wordCount,
            qualityGrade: healingResult.grade as 'A' | 'B',
            qualityDiagnostic: `${diagnostic} [HEALED via ${healingResult.strategy}]`,
            pipelineStatus: 'cleaned',
            provenanceMode: 'healed',
            provenanceManifest: null,
            ...healedProvenance,
          });

          staged = {
            ...staged,
            content: healingResult.content,
            contentHash: healingResult.contentHash,
            cleanedText: healedClean.cleanText,
            wordCount: healedClean.wordCount,
            qualityGrade: healingResult.grade as 'A' | 'B',
            pipelineStatus: 'cleaned',
            provenanceMode: 'healed',
            provenanceManifest: null,
            ...healedProvenance,
          };

          if (healingResult.strategy) {
            recordSuccessfulStrategy(sourceId, healingResult.strategy);
          }
          recordScrapeSuccess(sourceId);
        } else {
          updateStaged({
            pipelineStatus: 'rejected',
            qualityDiagnostic: `${diagnostic} [HEALING FAILED: ${healingResult.attempts.length} strategies tried]`,
            pipelineError: `Quality grade ${quality.overallGrade}: ${diagnostic}. Healing attempted but all strategies failed.`,
          });

          const duration = Math.round(performance.now() - startTime);
          const rejectError = `Content quality too low (grade ${quality.overallGrade}): ${diagnostic}. Self-healing attempted (${healingResult.attempts.length} strategies) but failed.`;
          recordPipelineRun(db, sourceId, 'error', 2, false, null, 0, 0, duration,
            llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, rejectError);
          recordScrapeFailure(sourceId, rejectError);

          logger.warn({ sourceId, grade: quality.overallGrade, diagnostic, healingAttempts: healingResult.attempts.length },
            'Step 2: Content rejected — healing could not improve quality');

          progress(2, 'Quality check failed — healing unsuccessful', {
            grade: quality.overallGrade, diagnostic, healingAttempts: healingResult.attempts.length,
          });

          notifyPipelineError({
            sourceName: source.name,
            stepReached: 2,
            errorMessage: rejectError,
          }).catch(() => {});

          return {
            sourceId, sourceName: source.name,
            status: 'error', stepReached: 2,
            rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
            error: rejectError,
          };
        }
      } else if (quality.overallGrade === 'C') {
        const diagnostic = diagnoseQualityFailure(cleanResult.cleanText, quality);
        updateStaged({
          pipelineStatus: 'needs_review',
          qualityDiagnostic: diagnostic,
        });

        import('../services/notifications.js').then((n) => {
          n.sendSlack(
            `*${source.name}*: Content scored Grade C after cleaning — requires admin review.\nDiagnostic: ${diagnostic}`,
            'Pipeline Quality Review',
          ).catch(() => {});
          // Configured push topics (an empty list delivered to nobody).
          n.sendPush(n.getPushTopics(), `Quality Review: ${source.name}`, `Grade C — ${diagnostic}`).catch(() => {});
        }).catch(() => {});

        const duration = Math.round(performance.now() - startTime);
        recordPipelineRun(db, sourceId, 'error', 2, true, null, 0, 0, duration,
          llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents,
          `Grade C: awaiting admin review — ${diagnostic}`);

        logger.info({ sourceId, grade: 'C', diagnostic },
          'Step 2: Grade C — paused for admin review');

        progress(2, 'Needs admin review', { grade: 'C', diagnostic });

        return {
          sourceId, sourceName: source.name,
          status: 'error', stepReached: 2,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
          error: `Content scored Grade C — awaiting admin review. Diagnostic: ${diagnostic}`,
        };
      } else {
        // Grade A or B — continue
        updateStaged({ pipelineStatus: 'cleaned' });
        staged = { ...staged, cleanedText: cleanResult.cleanText, pipelineStatus: 'cleaned' };
      }

      progress(2, 'Content cleaned', { grade: quality.overallGrade, wordCount: cleanResult.wordCount });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3: VERIFY — Structural verification of cleaned text
    // ═══════════════════════════════════════════════════════════
    if (['cleaned', 'verifying'].includes(staged.pipelineStatus)) {
      checkTimeout();
      stepReached = 3;
      progress(3, 'Verifying document structure');
      updateStaged({ pipelineStatus: 'verifying', pipelineStep: 3 });

      // Use cleanedText if available, fall back to content
      const textToVerify = staged.cleanedText || staged.content;

      const verification = await verifyStructure(textToVerify, source.name, source.jurisdiction);

      // Accumulate LLM costs from verification spot-check
      if (verification.llmTokensIn > 0) {
        llmTokensIn += verification.llmTokensIn;
        llmTokensOut += verification.llmTokensOut;
        llmCostCents += verification.llmCostCents;
      }

      updateStaged({
        verificationPassed: verification.passed,
        verificationIssues: JSON.stringify(verification.issues),
        verificationStats: JSON.stringify(verification.stats),
        llmSpotCheckUsed: verification.llmSpotCheckUsed,
        pipelineStep: 3,
        llmTokensIn: staged.llmTokensIn + verification.llmTokensIn,
        llmTokensOut: staged.llmTokensOut + verification.llmTokensOut,
        llmCostCents: staged.llmCostCents + verification.llmCostCents,
      });

      logger.info({
        sourceId, stagedId: staged.id,
        passed: verification.passed,
        articles: verification.stats.articlesFound,
        sections: verification.stats.sectionsFound,
        crossRefs: `${verification.stats.crossRefsResolved}/${verification.stats.crossRefsFound}`,
        completeness: verification.stats.estimatedCompleteness,
        llmUsed: verification.llmSpotCheckUsed,
        issueCount: verification.issues.length,
      }, `Step 3: Verification ${verification.passed ? 'PASSED' : 'FAILED'}`);

      if (!verification.passed) {
        const errorIssues = verification.issues.filter(i => i.severity === 'error');
        const issueText = errorIssues.map(i => `${i.type}: ${i.description}`).join('; ');
        const rejectError = `Structural verification failed: ${issueText}`;

        updateStaged({
          pipelineStatus: 'rejected',
          pipelineError: rejectError,
        });

        const duration = Math.round(performance.now() - startTime);
        recordPipelineRun(db, sourceId, 'error', 3, false, null, 0, 0, duration,
          llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, rejectError);
        recordScrapeFailure(sourceId, rejectError);

        progress(3, 'Verification failed', {
          issues: errorIssues.length,
          completeness: verification.stats.estimatedCompleteness,
        });

        notifyPipelineError({
          sourceName: source.name,
          stepReached: 3,
          errorMessage: rejectError,
        }).catch(() => {});

        return {
          sourceId, sourceName: source.name,
          status: 'error', stepReached: 3,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
          error: rejectError,
        };
      }

      updateStaged({ pipelineStatus: 'verified' });
      staged = { ...staged, pipelineStatus: 'verified', verificationPassed: true };

      progress(3, 'Verification passed', {
        articles: verification.stats.articlesFound,
        crossRefs: verification.stats.crossRefsResolved,
        completeness: verification.stats.estimatedCompleteness,
      });
    }

    // ─── Diff/Classify (for non-first scrapes, between verify and extract) ──
    // Use the cleaned/verified text for diffing
    const verifiedText = staged.cleanedText || staged.content;

    const previousSnapshot = db.select().from(rawSnapshots)
      .where(eq(rawSnapshots.sourceId, sourceId))
      .orderBy(desc(rawSnapshots.scrapedAt))
      .limit(1)
      .get();

    const isFirstScrape = !previousSnapshot || staged.source === 'upload';
    let diff: ReturnType<typeof extractChangedSections> = { hasChanges: true, changedSections: [], summary: 'First scrape' };

    if (!isFirstScrape) {
      diff = extractChangedSections(previousSnapshot.content, verifiedText);

      if (diff.changedSections.length === 0 && diff.hasChanges === false) {
        const duration = Math.round(performance.now() - startTime);
        updateStaged({ pipelineStatus: 'rejected', pipelineError: 'No material changes detected after diff' });
        recordPipelineRun(db, sourceId, 'no_change', 3, false, null, 0, 0, duration);
        progress(5, 'No changes detected', { percentComplete: 100 });
        logger.info({ sourceId, durationMs: duration }, 'No material changes in verified text — stopping');
        return {
          sourceId, sourceName: source.name,
          status: 'no_change', stepReached: 3,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
        };
      }

      checkTimeout();
      logger.info({ sourceId, changedSections: diff.changedSections.length }, 'Classifying changes...');

      const classification = await classifyChange(
        source.name,
        source.jurisdiction,
        diff.changedSections,
      );

      llmProvider = classification.llmResponse.provider;
      llmModel = classification.llmResponse.model;
      llmTokensIn += classification.llmResponse.tokensIn;
      llmTokensOut += classification.llmResponse.tokensOut;
      llmCostCents += calculateCostCents(
        classification.llmResponse.tokensIn,
        classification.llmResponse.tokensOut,
        classification.llmResponse.model,
        classification.llmResponse.provider,
      );

      updateStaged({
        llmProvider, llmModel,
        llmTokensIn: staged.llmTokensIn + classification.llmResponse.tokensIn,
        llmTokensOut: staged.llmTokensOut + classification.llmResponse.tokensOut,
        llmCostCents: staged.llmCostCents + calculateCostCents(
          classification.llmResponse.tokensIn,
          classification.llmResponse.tokensOut,
          classification.llmResponse.model,
          classification.llmResponse.provider,
        ),
      });

      if (classification.classification !== 'material') {
        const duration = Math.round(performance.now() - startTime);
        updateStaged({ pipelineStatus: 'rejected', pipelineError: `Non-material change: ${classification.classification}` });
        recordPipelineRun(db, sourceId, 'typo_only', 3, true, classification.classification, 0, 0, duration,
          llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents);
        recordScrapeSuccess(sourceId);

        logger.info({ sourceId, classification: classification.classification, durationMs: duration },
          'Non-material change — stopping');
        return {
          sourceId, sourceName: source.name,
          status: 'typo_only', stepReached: 3,
          rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
        };
      }

      if (classification.confidence < 0.7) {
        logger.warn({ sourceId, confidence: classification.confidence },
          'Material classification with low confidence — proceeding with caution');
      }
    } else {
      progress(3, 'First scrape — processing full verified content', { contentLength: verifiedText.length });
      logger.info({ sourceId, contentLength: verifiedText.length },
        'First scrape — skipping diff, processing full verified content');
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: EXTRACT — Chunk, extract rules, score
    // ═══════════════════════════════════════════════════════════
    if (['verified', 'scored', 'extracting'].includes(staged.pipelineStatus) || staged.pipelineStep <= 3) {
      checkTimeout();
      stepReached = 4;
      updateStaged({ pipelineStatus: 'extracting', pipelineStep: 4 });

      const step3TokensIn = llmTokensIn;
      const step3TokensOut = llmTokensOut;

      const changedContent = isFirstScrape
        ? verifiedText
        : diff.changedSections.join('\n\n---\n\n');

      const articleChunks = articleChunk(changedContent);
      const chunks = articleChunks.map((ac) => ({
        content: ac.content,
        breadcrumb: ac.breadcrumb,
        index: ac.index,
        totalChunks: ac.totalChunks,
        articleRef: ac.articleRef,
      }));

      progress(4, 'Extracting requirements', {
        chunks: chunks.length,
        strategy: articleChunks[0]?.strategy ?? 'unknown',
      });
      logger.info({
        sourceId,
        chunks: chunks.length,
        strategy: articleChunks[0]?.strategy ?? 'unknown',
        articleRefs: articleChunks.slice(0, 5).map((c) => c.articleRef),
      }, `Shredded into ${chunks.length} chunks (strategy: ${articleChunks[0]?.strategy ?? 'unknown'})`);

      // PROCESS: bulk extract
      checkTimeout();
      const extractions = await bulkExtract(chunks, {
        sourceId: source.id,
        sourceName: source.name,
        jurisdiction: source.jurisdiction,
      });
      llmTokensIn += extractions.reduce((s, e) => s + e.tokensIn, 0);
      llmTokensOut += extractions.reduce((s, e) => s + e.tokensOut, 0);

      // Report chunk failures
      const failedChunks = extractions.filter((e) => !e.success);
      if (failedChunks.length > 0) {
        const failRate = Math.round((failedChunks.length / extractions.length) * 100);
        logger.warn({ failedChunks: failedChunks.length, totalChunks: extractions.length, failRate },
          `${failedChunks.length}/${extractions.length} chunks failed extraction (${failRate}% failure rate)`);

        broadcastEvent({
          type: 'pipeline.progress',
          data: {
            sourceId: source.id,
            sourceName: source.name,
            step: 4,
            stepName: 'Extraction partially failed',
            chunks: extractions.length,
            failedChunks: failedChunks.length,
            failedChunkErrors: failedChunks.slice(0, 3).map((c) => c.error).filter(Boolean),
          },
          jurisdiction: source.jurisdiction,
        });

        if (failRate > 80) {
          const error = `Extraction critically failed: ${failedChunks.length}/${extractions.length} chunks failed (${failRate}%). ` +
            `Errors: ${failedChunks.slice(0, 3).map((c) => c.error).join('; ')}`;
          markIntervention(error);
          throw new Error(error);
        }
      }

      // Local dedup
      const allReqs = extractions.flatMap((e) => e.requirements);
      const dedupMap = new Map<string, typeof allReqs[0]>();
      for (const req of allReqs) {
        const key = `${req.ref}::${req.what.slice(0, 60)}`.toLowerCase();
        if (!dedupMap.has(key) || req.what.length > (dedupMap.get(key)?.what.length ?? 0)) {
          dedupMap.set(key, req);
        }
      }
      const uniqueReqs = Array.from(dedupMap.values());

      logger.info({ extracted: allReqs.length, deduped: uniqueReqs.length },
        `Processed: ${allReqs.length} -> ${uniqueReqs.length} unique requirements`);

      if (uniqueReqs.length === 0) {
        const error = 'Extraction produced zero requirements';
        markIntervention(error);
        throw new Error(error);
      }

      // Convert to candidate rules
      const jurisdictionPrefix = source.jurisdiction.toLowerCase().replace(/-/g, '_');
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
          jurisdiction: source.jurisdiction,
          category: typeToCategory[req.type] ?? 'transparency',
          conditions: { action: 'ai_operation', region: source.jurisdiction, ...(req.who ? { who: req.who } : {}), ...(req.conditions ? { condition: req.conditions } : {}) },
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

      // Store extracted rules on staged entry
      updateStaged({
        extractedRules: JSON.stringify(candidateRules),
        extractedCount: candidateRules.length,
      });

      // SCORE: agent reviews rules, removes false positives
      progress(4, 'Scoring and validating rules', { candidateRules: candidateRules.length });
      checkTimeout();
      const scoreResult = await scoreRules(candidateRules, source.name, source.jurisdiction, {
        sourceId: source.id,
        sourceName: source.name,
      });
      llmTokensIn += scoreResult.tokensIn;
      llmTokensOut += scoreResult.tokensOut;

      const finalRules = scoreResult.rules;
      const resolved = await resolveProvider('classifier');
      llmProvider = resolved.providerName;
      llmModel = resolved.model;
      const step4TokensIn = llmTokensIn - step3TokensIn;
      const step4TokensOut = llmTokensOut - step3TokensOut;
      llmCostCents += calculateCostCents(step4TokensIn, step4TokensOut, llmModel, llmProvider);

      logger.info({
        candidates: candidateRules.length,
        accepted: finalRules.length,
        rejected: candidateRules.length - finalRules.length,
        score: scoreResult.overallScore,
      }, `Scored: ${candidateRules.length} -> ${finalRules.length} rules (score: ${scoreResult.overallScore}/10)`);

      // Store scored rules on staged entry
      updateStaged({
        pipelineStatus: 'extracted',
        scoredRules: JSON.stringify(finalRules),
        scoredCount: finalRules.length,
        rejectedCount: candidateRules.length - finalRules.length,
        llmProvider, llmModel,
        llmTokensIn, llmTokensOut, llmCostCents,
      });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 5: PROMOTE (transactional)
    // ═══════════════════════════════════════════════════════════
    checkTimeout();
    stepReached = 5;
    progress(5, 'Promoting staged content');
    updateStaged({ pipelineStatus: 'promoting', pipelineStep: 5 });

    // Re-read staged entry to get latest scored rules (may have been set by resume)
    const freshStaged = db.select().from(stagedContent)
      .where(eq(stagedContent.id, staged.id))
      .get()!;

    const finalRules: Array<{
      ruleKey: string; jurisdiction: string; category: string;
      conditions: Record<string, string>; effect: string; severity: string;
      humanSummary: string; legalReference: string; effectiveDate: string;
      expiresAt: string | null; industries?: string[]; industryScope?: string; industryNotes?: string;
    }> = JSON.parse(freshStaged.scoredRules || '[]');

    if (finalRules.length === 0) {
      const duration = Math.round(performance.now() - startTime);
      updateStaged({ pipelineStatus: 'rejected', pipelineError: 'No rules survived scoring' });
      recordPipelineRun(db, sourceId, 'completed', 4, true, 'material', 0, 0, duration,
        llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents);
      recordScrapeSuccess(sourceId);
      logger.info({ sourceId }, 'Step 5: No rules survived scoring — nothing to promote');
      return {
        sourceId, sourceName: source.name,
        status: 'completed', stepReached: 4,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
      };
    }

    // ─── Fail-closed promotion gate ────────────────────────────
    // Never write partial/unverifiable content to rawSnapshots as promoted.
    // Block when the provenance mode is non-promotable (e.g. stale_cache) or
    // an assembled capture is flagged incomplete. Structural-verification
    // failures already returned at Step 3; this is defense-in-depth so the
    // last-known-good promoted snapshot is preserved and keeps serving.
    const promoteProvenance = freshStaged.provenanceMode ?? 'byte_exact';
    if (!isPromotableProvenance(promoteProvenance)) {
      const holdReason = `Promotion blocked: ${describeProvenance(promoteProvenance).label} is not promotable as current law. Held as unverified; last known-good version preserved.`;
      updateStaged({ pipelineStatus: 'needs_intervention', pipelineError: holdReason });
      const duration = Math.round(performance.now() - startTime);
      recordPipelineRun(db, sourceId, 'error', 5, true, 'material', 0, 0, duration,
        llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, holdReason);
      recordScrapeFailure(sourceId, holdReason);
      logger.warn({ sourceId, provenanceMode: promoteProvenance }, 'Step 5: Promotion blocked by provenance gate');
      return {
        sourceId, sourceName: source.name,
        status: 'error', stepReached: 5,
        rulesCreated: 0, rulesUpdated: 0, durationMs: duration,
        error: holdReason,
      };
    }

    const promoteNow = now();

    // TRANSACTIONAL PROMOTION: snapshot + rules + source hash update
    const pendingEvents: PendingRuleEvent[] = [];
    db.transaction((tx) => {
      // 1. Write to rawSnapshots (store verified clean text, not raw HTML)
      const snapshotId = randomUUID();
      const contentToStore = freshStaged.cleanedText || freshStaged.content;
      // Self-consistency invariant: the stored contentHash MUST be sha256 of the
      // stored `content`. Cleaning (Step 2) transforms the text after the scrape
      // hash was computed, so we recompute here — otherwise a customer hashing
      // the displayed text could never reproduce the stored hash.
      const storedContentHash = createHash('sha256').update(contentToStore).digest('hex');
      tx.insert(rawSnapshots).values({
        id: snapshotId,
        sourceId: source.id,
        contentHash: storedContentHash,
        content: contentToStore,
        scrapedAt: freshStaged.fetchedAt,
        // Carry the raw HTTP provenance forward into the promoted snapshot
        rawBytesHash: freshStaged.rawBytesHash,
        rawBytesSize: freshStaged.rawBytesSize,
        rawContent: freshStaged.rawContent,
        fetchedUrl: freshStaged.fetchedUrl,
        httpStatus: freshStaged.httpStatus,
        contentType: freshStaged.contentType,
        provenanceMode: promoteProvenance,
        provenanceManifest: freshStaged.provenanceManifest,
        // Carry the API-first ingestion channel + official point-in-time
        // coordinate forward so the promoted snapshot cites the exact official
        // version of the law it represents.
        ingestionChannel: freshStaged.ingestionChannel,
        pointInTimeCoordinate: freshStaged.pointInTimeCoordinate,
        // THE last known-good version — served as current law by the read path.
        promoted: true,
      }).run();

      // Update snapshot reference on staged entry
      tx.update(stagedContent)
        .set({ snapshotId, updatedAt: promoteNow })
        .where(eq(stagedContent.id, staged.id))
        .run();

      // 2. Write rules to policyRules
      const lastEvent = tx.select({ sequence: policyEvents.sequence })
        .from(policyEvents)
        .orderBy(desc(policyEvents.sequence))
        .limit(1)
        .get();
      let nextSequence = (lastEvent?.sequence ?? 0) + 1;

      for (const rule of finalRules) {
        const outcome = upsertExtractedRule(
          tx,
          { sourceId: source.id, now: promoteNow, nextSequence: () => nextSequence++ },
          rule,
          pendingEvents,
        );
        if (outcome === 'created') rulesCreated++;
        else if (outcome === 'updated') rulesUpdated++;
        else if (outcome === 'skipped_locked') rulesSkippedLocked++;
      }

      // 3. Update lastContentHash on source (THE CRITICAL LINE)
      tx.update(regulatorySources).set({
        lastScrapedAt: freshStaged.fetchedAt,
        lastContentHash: freshStaged.contentHash,
        updatedAt: promoteNow,
      }).where(eq(regulatorySources.id, sourceId)).run();

      // 4. Mark staged entry as promoted
      tx.update(stagedContent).set({
        pipelineStatus: 'promoted',
        pipelineStep: 5,
        // An earlier failed attempt's error must not linger on a promoted entry.
        pipelineError: null,
        updatedAt: promoteNow,
      }).where(eq(stagedContent.id, staged.id)).run();
    }); // end transaction

    // Tell live subscribers about every rule the transaction wrote (also
    // invalidates the policy cache). Runs after commit, never inside it.
    publishRuleEvents(pendingEvents);

    // ─── Delta Card: Auto-create Radar signal + broadcast ─────
    if (rulesCreated > 0 || rulesUpdated > 0) {
      const deltaSummary = `${source.name} (${source.jurisdiction}): ${rulesCreated} new rules, ${rulesUpdated} updated rules detected`;

      db.insert(regulatorySignals).values({
        id: randomUUID(),
        sourceId: source.id,
        title: `Regulation Change: ${source.name}`,
        jurisdiction: source.jurisdiction,
        stage: 'active',
        likelihoodPercent: 100,
        summary: deltaSummary,
        detectedAt: promoteNow,
        createdAt: promoteNow,
        updatedAt: promoteNow,
      }).run();

      broadcastEvent({
        type: 'regulation.changed',
        data: {
          source: source.name,
          jurisdiction: source.jurisdiction,
          rulesCreated,
          rulesUpdated,
          summary: deltaSummary,
        },
        jurisdiction: source.jurisdiction,
      });

      logger.info({ sourceId, deltaSummary }, 'Delta card created and broadcast');
    }

    const duration = Math.round(performance.now() - startTime);
    recordPipelineRun(db, sourceId, 'completed', 5, true, 'material',
      rulesCreated, rulesUpdated, duration,
      llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents);

    recordScrapeSuccess(sourceId);

    logger.info({
      sourceId, rulesCreated, rulesUpdated, rulesSkippedLocked, durationMs: duration,
      llmCostCents,
    }, 'Pipeline completed successfully — content promoted');

    progress(5, 'Complete', { rulesCreated, rulesUpdated, durationMs: duration, percentComplete: 100 });

    notifyPipelineComplete({
      sourceName: source.name,
      rulesCreated,
      rulesUpdated,
      durationMs: duration,
      llmCostCents,
    }).catch((err) => logger.error({ error: (err as Error).message }, 'notifyPipelineComplete failed'));

    const allActiveRules = db.select({ signature: policyRules.signature })
      .from(policyRules)
      .where(eq(policyRules.isActive, true))
      .all();
    const webhookStateHash = createHash('sha256')
      .update(allActiveRules.map((r) => r.signature).sort().join('|'))
      .digest('hex');

    notifyRulesUpdated({
      sourceId: source.id,
      sourceName: source.name,
      jurisdiction: source.jurisdiction,
      rulesCreated,
      rulesUpdated,
      stateHash: webhookStateHash,
      generatedAt: new Date().toISOString(),
    }).catch((err) => logger.error({ error: (err as Error).message }, 'notifyRulesUpdated webhook failed'));

    return {
      sourceId, sourceName: source.name,
      status: 'completed', stepReached: 5,
      rulesCreated, rulesUpdated, rulesSkippedLocked, durationMs: duration,
    };
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);

    // If we haven't already marked intervention, do it now
    const checkStaged = db.select().from(stagedContent)
      .where(eq(stagedContent.id, staged.id))
      .get();
    if (checkStaged && !['rejected', 'needs_intervention', 'needs_review'].includes(checkStaged.pipelineStatus)) {
      markIntervention(errorMsg);
    }

    recordPipelineRun(db, sourceId, 'error', stepReached, stepReached > 1, null,
      rulesCreated, rulesUpdated, duration,
      llmProvider, llmModel, llmTokensIn, llmTokensOut, llmCostCents, errorMsg);

    recordScrapeFailure(sourceId, errorMsg);

    logger.error({ sourceId, stepReached, error: errorMsg, durationMs: duration },
      'Staged pipeline failed');

    notifyPipelineError({
      sourceName: source.name,
      stepReached,
      errorMessage: errorMsg,
    }).catch(() => {});

    notifyRulesError({
      sourceId: source.id,
      sourceName: source.name,
      error: errorMsg,
      stepReached,
    }).catch(() => {});

    return {
      sourceId, sourceName: source.name,
      status: 'error', stepReached,
      rulesCreated, rulesUpdated, durationMs: duration,
      error: errorMsg,
    };
  }
}

function recordPipelineRun(
  db: ReturnType<typeof getDb>,
  sourceId: string,
  status: string,
  stepReached: number,
  diffDetected: boolean,
  classification: string | null,
  rulesCreated: number,
  rulesUpdated: number,
  durationMs: number,
  llmProvider?: string,
  llmModel?: string,
  llmTokensIn?: number,
  llmTokensOut?: number,
  llmCostCents?: number,
  errorMessage?: string,
): void {
  const now = new Date().toISOString();
  db.insert(pipelineRuns).values({
    id: randomUUID(),
    sourceId,
    status: status as 'completed' | 'no_change' | 'typo_only' | 'error',
    stepReached,
    diffDetected,
    classification,
    rulesCreated,
    rulesUpdated,
    llmProvider: llmProvider ?? null,
    llmModel: llmModel ?? null,
    llmTokensIn: llmTokensIn ?? null,
    llmTokensOut: llmTokensOut ?? null,
    llmCostCents: llmCostCents ?? null,
    errorMessage: errorMessage ?? null,
    durationMs,
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    completedAt: now,
  }).run();
}
