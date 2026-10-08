import { resolveProvider } from '../llm/provider.js';
import type { LLMProvider } from '../llm/provider.js';
import { logger } from '../logger.js';
import { broadcastEvent } from '../sse/manager.js';
import { randomUUID } from 'node:crypto';

/** Generic chunk interface — works with both SemanticChunk and ArticleChunk */
export interface ChunkInput {
  content: string;
  breadcrumb: string;
  index: number;
  totalChunks: number;
  /** Optional article reference for precision tracing */
  articleRef?: string;
}

export interface ExtractedRequirement {
  ref: string;
  type: string;
  who: string;
  what: string;
  conditions: string;
  severity: string;
  effective_date: string | null;
  industries: string[];
  industry_scope: string;
  industry_notes: string;
}

export interface ExtractionResult {
  chunkIndex: number;
  breadcrumb: string;
  requirements: ExtractedRequirement[];
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  error?: string;
}

const EXTRACT_PROMPT = `You are a regulatory compliance analyst. Extract every distinct legal requirement, obligation, prohibition, or disclosure mandate from this regulatory text.

CRITICAL: The "ref" field must be the EXACT legal reference from the source text (e.g., "Article 6(1)(a)", "Section 3.2", "Recital 47"). Do NOT invent or generalize references. If the Legal Reference is provided in the context, use it to prefix your refs.

For each requirement, output a JSON object:
{"ref": "Article X, Section Y, Paragraph Z", "type": "obligation|prohibition|disclosure|penalty|definition|exemption", "who": "who must comply (be specific: 'providers of high-risk AI systems', not just 'organizations')", "what": "the specific requirement (preserve legal precision — do not paraphrase loosely)", "conditions": "when/where/to whom this applies", "severity": "critical|high|medium|low", "effective_date": "YYYY-MM-DD or null", "industries": ["all"] or specific sectors, "industry_scope": "global|sector_specific|subsector_specific", "industry_notes": "brief explanation of industry impact"}

Rules:
- Extract EVERY distinct requirement, even if they share an article
- Use the EXACT article/section/paragraph numbers from the text
- Preserve legal terminology — do not simplify or paraphrase
- If a single article contains multiple obligations, create separate entries for each
- "what" should be specific enough that a compliance officer can verify it without reading the source

Output ONLY a valid JSON array. No explanation, no markdown.`;

/** Max concurrent chunk extractions per batch */
const BATCH_SIZE = 3;
/** Delay between batches (ms) */
const BATCH_DELAY = 3000;
/** Max retries per failed chunk before giving up */
const MAX_CHUNK_RETRIES = 2;
/** Base delay between retries (doubles each attempt) */
const RETRY_BASE_DELAY_MS = 3_000;

/**
 * Stage 3: Blast all chunks through Haiku in parallel batches.
 * Extracts structured requirements with industry tagging.
 * Partial salvage — failed chunks are logged and skipped.
 */
export async function bulkExtract(
  chunks: ChunkInput[],
  context?: { sourceId?: string; sourceName?: string; jurisdiction?: string },
): Promise<ExtractionResult[]> {
  const { provider, model } = await resolveProvider('classifier');
  const results: ExtractionResult[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  logger.info({ totalChunks: chunks.length, batchSize: BATCH_SIZE },
    `Bulk extracting ${chunks.length} chunks in batches of ${BATCH_SIZE}`);

  // Process in parallel batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

    logger.info({ batch: batchNum, totalBatches, chunks: batch.length },
      `Processing batch ${batchNum}/${totalBatches}`);

    // Broadcast progress via SSE for live dashboard updates
    broadcastEvent({
      id: randomUUID(),
      type: 'pipeline.progress',
      data: {
        sourceId: context?.sourceId,
        sourceName: context?.sourceName,
        step: 4,
        stepName: 'Extracting requirements',
        batch: batchNum,
        totalBatches,
        percentComplete: Math.round((batchNum / totalBatches) * 100),
        requirementsSoFar: results.reduce((s, r) => s + r.requirements.length, 0),
      },
      jurisdiction: context?.jurisdiction ?? '*',
    });

    // Fire batch — with retry on failure
    for (const chunk of batch) {
      let lastError: string | undefined;
      let succeeded = false;

      for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        try {
          const result = await extractChunk(chunk, provider, model);
          results.push(result);
          totalTokensIn += result.tokensIn;
          totalTokensOut += result.tokensOut;
          succeeded = true;
          break;
        } catch (err) {
          lastError = (err as Error).message;
          logger.warn({ chunk: chunk.index, attempt, maxRetries: MAX_CHUNK_RETRIES, error: lastError },
            `Chunk ${chunk.index} extraction attempt ${attempt}/${MAX_CHUNK_RETRIES} failed: ${lastError}`);

          if (attempt < MAX_CHUNK_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      if (!succeeded) {
        logger.error({ chunk: chunk.index, breadcrumb: chunk.breadcrumb, error: lastError },
          `Chunk ${chunk.index} failed after ${MAX_CHUNK_RETRIES} retries — recording failure`);
        results.push({
          chunkIndex: chunk.index,
          breadcrumb: chunk.breadcrumb,
          requirements: [],
          tokensIn: 0,
          tokensOut: 0,
          success: false,
          error: lastError,
        });
      }
    }

    // Inter-batch delay to stay under rate limits
    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const totalReqs = results.reduce((sum, r) => sum + r.requirements.length, 0);

  logger.info({
    successCount,
    failedCount: results.length - successCount,
    totalRequirements: totalReqs,
    totalTokensIn,
    totalTokensOut,
  }, `Bulk extraction complete: ${totalReqs} requirements from ${successCount}/${chunks.length} chunks`);

  return results;
}

async function extractChunk(
  chunk: ChunkInput,
  provider: LLMProvider,
  model: string,
): Promise<ExtractionResult> {
  // Include article reference in context for precise tracing
  const context = chunk.articleRef
    ? `Legal Reference: ${chunk.articleRef}\nDocument Section: ${chunk.breadcrumb}`
    : `Context: ${chunk.breadcrumb}`;
  const userMessage = `${context}\n\n${chunk.content}`;

  // 180-second timeout per chunk — large regulatory articles need time
  const CHUNK_TIMEOUT_MS = 180_000;
  const response = await Promise.race([
    provider.generate(EXTRACT_PROMPT, userMessage, model),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Chunk extraction timeout after ${CHUNK_TIMEOUT_MS / 1000}s`)), CHUNK_TIMEOUT_MS)
    ),
  ]);

  // Parse JSON — lenient extraction
  let requirements: ExtractedRequirement[] = [];
  let parseError: string | undefined;
  try {
    const jsonStr = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) {
      parseError = 'model response was not a JSON array';
    } else if (parsed.length > 0 && !parsed.some((r: unknown) => {
      const req = r as Record<string, unknown> | null;
      return !!req && typeof req === 'object' && !!req.ref && typeof req.what === 'string';
    })) {
      parseError = `model returned ${parsed.length} item(s), none with a ref and requirement text`;
    }

    if (Array.isArray(parsed)) {
      // Validate each requirement individually — salvage valid ones
      requirements = parsed.filter((r: unknown) => {
        if (!r || typeof r !== 'object') return false;
        const req = r as Record<string, unknown>;
        return req.ref && req.what && typeof req.what === 'string';
      }).map((r: Record<string, unknown>) => ({
        ref: String(r.ref ?? ''),
        type: String(r.type ?? 'obligation'),
        who: String(r.who ?? 'unspecified'),
        what: String(r.what ?? ''),
        conditions: String(r.conditions ?? ''),
        severity: String(r.severity ?? 'medium'),
        effective_date: r.effective_date && r.effective_date !== 'null' ? String(r.effective_date) : null,
        industries: Array.isArray(r.industries) ? r.industries.map(String) : ['all'],
        industry_scope: String(r.industry_scope ?? 'global'),
        industry_notes: String(r.industry_notes ?? ''),
      }));
    }
  } catch {
    logger.warn({ chunk: chunk.index, content: response.content.slice(0, 100) },
      'Failed to parse chunk extraction JSON');
    parseError = 'model response was not a JSON array';
  }

  return {
    chunkIndex: chunk.index,
    breadcrumb: chunk.breadcrumb,
    requirements,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    // A well-formed empty array is a successful extraction: sections such as a
    // short title or a definitions-only article contain no requirements. They
    // were counted as failed chunks, so a definitions-heavy text could cross
    // the 80% failure threshold and abort a pipeline whose extraction worked.
    // The pipeline still stops when the whole document yields zero requirements.
    success: parseError === undefined,
    ...(parseError !== undefined ? { error: parseError } : {}),
  };
}
