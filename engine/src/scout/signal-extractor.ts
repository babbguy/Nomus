import { resolveProvider } from '../llm/provider.js';
import type { LLMResponse } from '../llm/provider.js';
import { logger } from '../logger.js';

export interface ExtractedSignal {
  title: string;
  jurisdiction: string;
  stage: 'signal' | 'draft' | 'committee' | 'adopted' | 'active';
  likelihoodPercent: number;
  summary: string;
}

export interface ExtractionResult {
  signal: ExtractedSignal | null;
  llmResponse: LLMResponse;
}

const SYSTEM_PROMPT = `You are a regulatory intelligence analyst. Given a news item about AI/technology regulation, extract structured signal data.

Respond with a JSON object:
{
  "title": "Clean, concise title for the regulatory signal (max 120 chars)",
  "jurisdiction": "EU" | "US-FED" | "US-CA" | "US-NY" | "UK" | "CA" | "AU" | "global" | etc.,
  "stage": "signal" | "draft" | "committee" | "adopted" | "active",
  "likelihoodPercent": 0-100,
  "summary": "2-3 sentence summary of the regulatory development and its implications"
}

Stage guide:
- "signal": Early indication, media reports, political statements, industry lobbying
- "draft": Formal legislative/regulatory text has been drafted or published
- "committee": Under review by legislative/regulatory committee
- "adopted": Voted on and adopted, awaiting implementation
- "active": In force and enforceable

likelihoodPercent: Estimate how likely this regulation will materially impact AI compliance requirements.
- 10-30%: Early signal, may not progress
- 40-60%: Active draft or committee stage, moderate momentum
- 70-85%: Strong legislative momentum or adopted
- 90-100%: Already active or imminent enforcement`;

/**
 * Tier 3: Structured signal extraction.
 * Called only for high-confidence items that pass the classifier.
 */
export async function extractSignal(
  title: string,
  snippet: string,
  hintJurisdiction?: string | null,
): Promise<ExtractionResult> {
  const { provider, model } = await resolveProvider('classifier');

  const userPrompt = `Title: ${title}\nSnippet: ${snippet}${
    hintJurisdiction ? `\nHint jurisdiction: ${hintJurisdiction}` : ''
  }`;

  const llmResponse = await provider.generate(
    SYSTEM_PROMPT,
    userPrompt,
    model,
  );

  try {
    const jsonStr = llmResponse.content
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as ExtractedSignal;

    // Basic validation
    if (!parsed.title || !parsed.jurisdiction || !parsed.stage || !parsed.summary) {
      logger.warn({ parsed }, 'Scout extractor: Missing required fields');
      return { signal: null, llmResponse };
    }

    // Clamp likelihood
    parsed.likelihoodPercent = Math.max(0, Math.min(100, parsed.likelihoodPercent ?? 50));

    return { signal: parsed, llmResponse };
  } catch {
    logger.error(
      { content: llmResponse.content.slice(0, 300) },
      'Scout extractor: Failed to parse LLM response',
    );
    return { signal: null, llmResponse };
  }
}
