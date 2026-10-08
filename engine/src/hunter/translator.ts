import { resolveProvider } from '../llm/provider.js';
import type { LLMProvider, LLMResponse } from '../llm/provider.js';
import { TRANSLATOR_SYSTEM_PROMPT, buildTranslatorPrompt } from '../llm/prompts/translator.js';
import { llmPolicyArraySchema } from '@nomus/shared';
import { logger } from '../logger.js';
import type { z } from 'zod';

export type TranslatedRule = z.infer<typeof llmPolicyArraySchema>[number];

export interface TranslationResult {
  rules: TranslatedRule[];
  llmResponse: LLMResponse;
  chunksProcessed?: number;
}

/**
 * Approximate token count from text (rough: 1 token ≈ 4 chars).
 * Conservative estimate — better to over-chunk than hit limits.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Split text into chunks that fit within token limits.
 * Splits on paragraph boundaries (\n\n) to preserve context.
 */
function chunkText(text: string, maxTokensPerChunk: number): string[] {
  const maxCharsPerChunk = maxTokensPerChunk * 3; // Conservative: 3 chars per token

  if (text.length <= maxCharsPerChunk) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxCharsPerChunk) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = '';
      }
      // If a single paragraph exceeds the limit, split it further
      if (para.length > maxCharsPerChunk) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 > maxCharsPerChunk) {
            if (current.length > 0) chunks.push(current.trim());
            current = sentence;
          } else {
            current += (current ? ' ' : '') + sentence;
          }
        }
      } else {
        current = para;
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/** Max tokens per chunk sent to translator (leave room for system prompt + response) */
const MAX_INPUT_TOKENS_PER_CHUNK = 15000;

/** Threshold above which we summarize before translating (chars) */
const SUMMARIZE_THRESHOLD = 20000;

/** Delay between chunk translations to avoid rate limits (ms) */
const INTER_CHUNK_DELAY = 3000;

const SUMMARIZE_PROMPT = `You are a legal text summarizer. Extract ONLY the specific regulatory requirements from this text.
For each requirement, output one line: "REQUIREMENT: [article/section ref] — [what must be done, by whom, with what conditions]"
Be exhaustive — capture every obligation, prohibition, disclosure requirement, and penalty.
Skip preambles, recitals, definitions, and procedural text unless they contain actionable requirements.
Output plain text, not JSON.`;

/** Max retries for JSON parsing per chunk */
const MAX_PARSE_RETRIES = 2;

/**
 * Step 3: Expensive Brain.
 * Uses a frontier LLM to translate legal text into structured JSON policy rules.
 *
 * Production-hardened:
 * - Automatically chunks large documents to stay within token limits
 * - Retries on JSON parse failures
 * - Inter-chunk delay to avoid rate limits
 * - Merges rules from all chunks with deduplication
 */
export async function translateToRules(
  sourceName: string,
  jurisdiction: string,
  changedText: string,
  existingRuleKeys: string[],
  ontologyContext?: string,
): Promise<TranslationResult> {
  const { provider, model: translatorModel } = await resolveProvider('translator');
  const { provider: classifierProvider, model: classifierModel } = await resolveProvider('classifier');

  // Chunk the content if it's too large
  const chunks = chunkText(changedText, MAX_INPUT_TOKENS_PER_CHUNK);
  const totalChunks = chunks.length;

  if (totalChunks > 1) {
    logger.info({ sourceName, totalChunks, totalChars: changedText.length },
      `Content too large for single translation — splitting into ${totalChunks} chunks`);
  }

  const allRules: TranslatedRule[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastResponse: LLMResponse | null = null;
  const seenRuleKeys = new Set(existingRuleKeys);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks[i];
    const chunkLabel = totalChunks > 1 ? ` (chunk ${i + 1}/${totalChunks})` : '';

    logger.info({ sourceName, chunk: i + 1, totalChunks, chunkChars: chunk.length },
      `Translating${chunkLabel}...`);

    // Summarize large chunks first to reduce tokens (90% reduction)
    let processedChunk = chunk;
    if (chunk.length > SUMMARIZE_THRESHOLD) {
      logger.info({ sourceName, chunk: i + 1, originalChars: chunk.length },
        'Summarizing chunk before translation to reduce tokens...');
      try {
        const summary = await classifierProvider.generate(
          SUMMARIZE_PROMPT,
          chunk,
          classifierModel, // Use classifier (Haiku) for summarization — cheap
        );
        if (summary.content.length > 200) { // Sanity check — summary should have content
          processedChunk = summary.content;
          totalTokensIn += summary.tokensIn;
          totalTokensOut += summary.tokensOut;
          logger.info({
            sourceName, chunk: i + 1,
            originalChars: chunk.length, summaryChars: processedChunk.length,
            reduction: `${Math.round((1 - processedChunk.length / chunk.length) * 100)}%`,
          }, 'Chunk summarized');
          // Brief delay between summarize and translate calls
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message }, 'Summarization failed — using raw text');
      }
    }

    // Build prompt for this chunk (using summarized text if available)
    const userPrompt = buildTranslatorPrompt(
      sourceName + chunkLabel,
      jurisdiction,
      processedChunk,
      Array.from(seenRuleKeys),
      ontologyContext,
    );

    // Translate with parse retries
    const result = await translateChunk(provider, userPrompt, translatorModel);

    totalTokensIn += result.llmResponse.tokensIn;
    totalTokensOut += result.llmResponse.tokensOut;
    lastResponse = result.llmResponse;

    // Deduplicate rules across chunks
    for (const rule of result.rules) {
      if (!seenRuleKeys.has(rule.ruleKey)) {
        seenRuleKeys.add(rule.ruleKey);
        allRules.push(rule);
      } else {
        logger.debug({ ruleKey: rule.ruleKey }, 'Duplicate rule key across chunks — skipping');
      }
    }

    // Inter-chunk delay to avoid rate limits (skip after last chunk)
    if (i < totalChunks - 1) {
      await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY));
    }
  }

  if (!lastResponse) {
    throw new Error('No LLM response received — zero chunks processed');
  }

  logger.info({
    sourceName,
    totalRules: allRules.length,
    chunksProcessed: totalChunks,
    totalTokensIn,
    totalTokensOut,
  }, `Translation complete — ${allRules.length} rules from ${totalChunks} chunk(s)`);

  return {
    rules: allRules,
    llmResponse: {
      content: `[${totalChunks} chunks merged]`,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      model: lastResponse.model,
      provider: lastResponse.provider,
    },
    chunksProcessed: totalChunks,
  };
}

/**
 * Translate a single chunk with JSON parse retry logic.
 */
async function translateChunk(
  provider: LLMProvider,
  userPrompt: string,
  model: string,
): Promise<{ rules: TranslatedRule[]; llmResponse: LLMResponse }> {
  for (let attempt = 1; attempt <= MAX_PARSE_RETRIES; attempt++) {
    const llmResponse = await provider.generate(
      TRANSLATOR_SYSTEM_PROMPT,
      userPrompt,
      model,
    );

    // Parse JSON from response
    let parsed: unknown;
    try {
      const jsonStr = llmResponse.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      logger.warn({ attempt, content: llmResponse.content.slice(0, 200) }, 'Translator returned invalid JSON');
      if (attempt === MAX_PARSE_RETRIES) {
        throw new Error('Translator failed to produce valid JSON after retries');
      }
      continue;
    }

    // Validate against schema
    const validated = llmPolicyArraySchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn({ attempt, errors: validated.error.issues.slice(0, 3) }, 'Translator output validation failed');
      if (attempt === MAX_PARSE_RETRIES) {
        throw new Error(`Translator output validation failed: ${validated.error.message}`);
      }
      continue;
    }

    return { rules: validated.data, llmResponse };
  }

  throw new Error('Translator chunk failed after all retries');
}
