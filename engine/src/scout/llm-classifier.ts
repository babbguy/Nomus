import { resolveProvider } from '../llm/provider.js';
import type { LLMResponse } from '../llm/provider.js';
import { logger } from '../logger.js';

export interface ClassifiedItem {
  index: number;
  relevant: boolean;
  confidence: number;
  jurisdiction: string | null;
}

export interface ClassifyBatchResult {
  items: ClassifiedItem[];
  llmResponse: LLMResponse;
}

const SYSTEM_PROMPT = `You are a regulatory intelligence classifier. Your job is to determine whether news items are about AI/technology regulation, policy, or governance.

For each item, determine:
1. Is this about AI regulation, technology policy, algorithmic governance, data protection law, or related regulatory activity? (true/false)
2. Your confidence (0.0 to 1.0)
3. The primary jurisdiction affected (e.g., "EU", "US-FED", "UK", "CA", "AU", "global", or null if not relevant)

Respond with a JSON array. Example:
[
  { "index": 0, "relevant": true, "confidence": 0.92, "jurisdiction": "EU" },
  { "index": 1, "relevant": false, "confidence": 0.85, "jurisdiction": null }
]

Be strict: general tech news, product launches, and opinion pieces without regulatory substance should be marked as not relevant. Focus on actual legislative, regulatory, or policy developments.`;

/**
 * Tier 2: Cheap LLM classification.
 * Batches multiple items into a single Haiku/Flash call for cost efficiency.
 */
export async function classifyBatch(
  items: Array<{ title: string; snippet: string }>,
): Promise<ClassifyBatchResult> {
  const { provider, model } = await resolveProvider('classifier');

  const userPrompt = items.map((item, i) =>
    `[${i}] Title: ${item.title}\nSnippet: ${item.snippet.slice(0, 300)}`
  ).join('\n\n');

  const llmResponse = await provider.generate(
    SYSTEM_PROMPT,
    userPrompt,
    model,
  );

  let parsed: ClassifiedItem[];
  try {
    const jsonStr = llmResponse.content
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const raw: unknown = JSON.parse(jsonStr);
    // Models often wrap the array ({"items": [...]}) — accept that. Any other
    // shape used to throw "parsed.map is not a function", failing the batch
    // so the same items were re-sent (and re-billed) every cycle.
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.values(raw as Record<string, unknown>).find(Array.isArray)
        : undefined;
    if (!list) throw new Error('classifier response is not a JSON array');
    parsed = (list as unknown[]).filter(
      (r): r is ClassifiedItem => !!r && typeof r === 'object' && typeof (r as ClassifiedItem).index === 'number',
    );
  } catch {
    logger.error(
      { content: llmResponse.content.slice(0, 300) },
      'Scout classifier: Failed to parse LLM JSON — marking all as relevant for safety',
    );
    // Default to relevant so we don't miss anything
    parsed = items.map((_, i) => ({
      index: i,
      relevant: true,
      confidence: 0.5,
      jurisdiction: null,
    }));
  }

  // Ensure we have a result for every item
  const resultMap = new Map(parsed.map((r) => [r.index, r]));
  const normalized = items.map((_, i) => resultMap.get(i) ?? {
    index: i,
    relevant: true,
    confidence: 0.5,
    jurisdiction: null,
  });

  return { items: normalized, llmResponse };
}
