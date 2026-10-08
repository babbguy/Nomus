import { resolveProvider } from '../llm/provider.js';
import type { LLMResponse } from '../llm/provider.js';
import { CLASSIFIER_SYSTEM_PROMPT, buildClassifierPrompt } from '../llm/prompts/classifier.js';
import { llmClassifierOutputSchema } from '@nomus/shared';
import { logger } from '../logger.js';

export interface ClassificationResult {
  classification: 'material' | 'typo' | 'formatting';
  confidence: number;
  summary: string;
  llmResponse: LLMResponse;
}

/** Max chars to send to classifier (Haiku is cheap but still has limits) */
const MAX_CLASSIFIER_INPUT_CHARS = 50000;

/**
 * Step 2: Cheap Shredder.
 * Uses a cheap/fast LLM to classify whether a detected change is material or trivial.
 *
 * Production-hardened:
 * - Truncates oversized input to stay within token limits
 * - Graceful fallback to "material" on any parse/validation failure
 * - Rate limit retry handled at the LLM provider level
 */
export async function classifyChange(
  sourceName: string,
  jurisdiction: string,
  changedSections: string[],
): Promise<ClassificationResult> {
  const { provider, model } = await resolveProvider('classifier');

  // Truncate if too large — classifier just needs enough to determine material vs typo
  let sections = changedSections;
  const totalChars = changedSections.join('\n').length;
  if (totalChars > MAX_CLASSIFIER_INPUT_CHARS) {
    logger.info({ sourceName, totalChars, max: MAX_CLASSIFIER_INPUT_CHARS },
      'Truncating classifier input to stay within limits');
    // Take first N sections that fit
    let accumulated = 0;
    sections = [];
    for (const section of changedSections) {
      if (accumulated + section.length > MAX_CLASSIFIER_INPUT_CHARS) break;
      sections.push(section);
      accumulated += section.length;
    }
    // If even the first section is too large, truncate it
    if (sections.length === 0 && changedSections.length > 0) {
      sections = [changedSections[0].slice(0, MAX_CLASSIFIER_INPUT_CHARS)];
    }
  }

  const userPrompt = buildClassifierPrompt(sourceName, jurisdiction, sections);

  const llmResponse = await provider.generate(
    CLASSIFIER_SYSTEM_PROMPT,
    userPrompt,
    model,
  );

  // Parse and validate the response
  let parsed: unknown;
  try {
    const jsonStr = llmResponse.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    logger.error({ content: llmResponse.content.slice(0, 200) }, 'Classifier returned invalid JSON');
    // Default to material for safety (never miss a real change)
    return {
      classification: 'material',
      confidence: 0.5,
      summary: 'Failed to parse classifier response — defaulting to material for safety',
      llmResponse,
    };
  }

  const validated = llmClassifierOutputSchema.safeParse(parsed);
  if (!validated.success) {
    logger.error({ parsed, errors: validated.error.issues }, 'Classifier output validation failed');
    return {
      classification: 'material',
      confidence: 0.5,
      summary: 'Classifier output validation failed — defaulting to material for safety',
      llmResponse,
    };
  }

  return {
    ...validated.data,
    llmResponse,
  };
}
