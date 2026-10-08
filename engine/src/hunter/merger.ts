import { resolveProvider } from '../llm/provider.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ExtractionResult, ExtractedRequirement } from './bulk-extractor.js';
import { logger } from '../logger.js';

export interface MergedShredMap {
  requirements: ExtractedRequirement[];
  totalBeforeMerge: number;
  totalAfterMerge: number;
  tokensIn: number;
  tokensOut: number;
}

const MERGE_PROMPT = `You are merging regulatory requirements extracted from multiple sections of the same legal document.

TASK:
1. Deduplicate — remove requirements that say the same thing from different sections
2. Group by topic/category
3. Resolve conflicts — if the same article is referenced differently, keep the most complete version
4. Consolidate industry impact — if multiple sections affect the same industry, merge into one scope
5. Preserve ALL unique requirements — do not drop anything unless it's a true duplicate

Output a clean JSON array. Each item:
{"ref": "...", "type": "...", "who": "...", "what": "...", "conditions": "...", "severity": "...", "effective_date": "...", "industries": [...], "industry_scope": "...", "industry_notes": "..."}

Output ONLY the JSON array. No explanation.`;

/** If extractions fit in one call, skip the LLM merge and dedupe locally */
const LOCAL_MERGE_THRESHOLD = 50;

/**
 * Stage 4: Merge all chunk extractions into a single deduplicated shred map.
 * Uses local dedup for small sets, LLM merge for large sets.
 */
export async function hierarchicalMerge(
  extractions: ExtractionResult[],
): Promise<MergedShredMap> {
  // Collect all requirements
  const allReqs = extractions.flatMap((e) => e.requirements);
  const totalBefore = allReqs.length;

  if (totalBefore === 0) {
    return { requirements: [], totalBeforeMerge: 0, totalAfterMerge: 0, tokensIn: 0, tokensOut: 0 };
  }

  logger.info({ totalRequirements: totalBefore }, 'Merging extracted requirements');

  // For small sets, do a fast local dedup (free, no LLM)
  if (totalBefore <= LOCAL_MERGE_THRESHOLD) {
    const deduped = localDedup(allReqs);
    logger.info({ before: totalBefore, after: deduped.length }, 'Local dedup complete (no LLM needed)');
    return { requirements: deduped, totalBeforeMerge: totalBefore, totalAfterMerge: deduped.length, tokensIn: 0, tokensOut: 0 };
  }

  // For large sets, use LLM to merge intelligently
  const { provider, model } = await resolveProvider('classifier');

  // Serialize requirements for the prompt
  const reqsJson = JSON.stringify(allReqs, null, 1);

  // If even the serialized requirements exceed token limits, pre-dedup locally first
  let inputReqs = allReqs;
  if (reqsJson.length > 50000) {
    inputReqs = localDedup(allReqs);
    logger.info({ before: totalBefore, afterLocalDedup: inputReqs.length },
      'Pre-deduped locally before LLM merge');
  }

  const inputJson = JSON.stringify(inputReqs, null, 1);

  // If still too large, split into two merge passes
  if (inputJson.length > 80000) {
    const mid = Math.floor(inputReqs.length / 2);
    const firstHalf = inputReqs.slice(0, mid);
    const secondHalf = inputReqs.slice(mid);

    logger.info({ firstHalf: firstHalf.length, secondHalf: secondHalf.length },
      'Two-pass merge (requirements too large for single call)');

    const [r1, r2] = await Promise.all([
      llmMerge(firstHalf, provider, model),
      llmMerge(secondHalf, provider, model),
    ]);

    // Final merge of the two halves
    const combined = [...r1.requirements, ...r2.requirements];
    const final = localDedup(combined);

    return {
      requirements: final,
      totalBeforeMerge: totalBefore,
      totalAfterMerge: final.length,
      tokensIn: r1.tokensIn + r2.tokensIn,
      tokensOut: r1.tokensOut + r2.tokensOut,
    };
  }

  return await llmMerge(inputReqs, provider, model);
}

async function llmMerge(
  reqs: ExtractedRequirement[],
  provider: LLMProvider,
  model: string,
): Promise<MergedShredMap> {
  const inputJson = JSON.stringify(reqs, null, 1);
  const response = await provider.generate(MERGE_PROMPT, inputJson, model);

  let merged: ExtractedRequirement[] = [];
  try {
    const jsonStr = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      merged = parsed.filter((r: unknown) => r && typeof r === 'object' && (r as Record<string, unknown>).ref);
    }
  } catch {
    logger.warn('LLM merge produced invalid JSON — falling back to local dedup');
    merged = localDedup(reqs);
  }

  logger.info({ before: reqs.length, after: merged.length, tokensIn: response.tokensIn, tokensOut: response.tokensOut },
    'LLM merge complete');

  return {
    requirements: merged,
    totalBeforeMerge: reqs.length,
    totalAfterMerge: merged.length,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
  };
}

/**
 * Fast local deduplication — no LLM cost.
 * Dedupes by normalized reference + what.
 */
function localDedup(reqs: ExtractedRequirement[]): ExtractedRequirement[] {
  const seen = new Map<string, ExtractedRequirement>();

  for (const req of reqs) {
    const key = `${req.ref.toLowerCase().replace(/\s+/g, '')}::${req.what.slice(0, 80).toLowerCase()}`;
    if (!seen.has(key)) {
      seen.set(key, req);
    } else {
      // Keep the one with more detail
      const existing = seen.get(key)!;
      if (req.what.length > existing.what.length) {
        seen.set(key, req);
      }
    }
  }

  return Array.from(seen.values());
}
