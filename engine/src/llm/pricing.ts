/**
 * LLM Token Pricing Table
 *
 * All costs are in dollars per 1 million tokens.
 * Each entry is the model's base (standard tier, shortest prompt) rate. The
 * default models (claude-haiku-5-5, gemini-3.8-flash, gpt-6-luna) and the
 * other current Claude models were checked against the providers' pricing
 * pages in October 2026; the others are the rates when they were added.
 * Fallback to conservative estimates for unknown models.
 */

interface ModelPricing {
  inputPer1M: number;  // $ per 1M input tokens
  outputPer1M: number; // $ per 1M output tokens
}

// ─── Pricing Database ────────────────────────────────────────────

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-haiku-5-5':           { inputPer1M: 0.10,  outputPer1M: 0.50 },  // prompts up to 100K tokens
  'claude-opus-4-6':            { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-sonnet-4-6':          { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001':  { inputPer1M: 1.00,  outputPer1M: 5.00 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-3-5-haiku-20241022':  { inputPer1M: 0.80,  outputPer1M: 4.00 },
  'claude-3-haiku-20240307':    { inputPer1M: 0.25,  outputPer1M: 1.25 },

  // Google
  'gemini-3.8-flash':           { inputPer1M: 0.75,  outputPer1M: 3.75 },  // until 2026-12-31; 1.50 / 7.50 from 2027-01-01
  'gemini-2.0-flash':           { inputPer1M: 0.10,  outputPer1M: 0.40 },
  'gemini-2.0-flash-lite':      { inputPer1M: 0.075, outputPer1M: 0.30 },
  'gemini-1.5-flash':           { inputPer1M: 0.075, outputPer1M: 0.30 },
  'gemini-1.5-pro':             { inputPer1M: 1.25,  outputPer1M: 5.00 },
  'gemini-2.5-pro':             { inputPer1M: 1.25,  outputPer1M: 10.00 },

  // OpenAI
  'gpt-6-luna':                 { inputPer1M: 0.10,  outputPer1M: 0.50 },  // prompts up to 272K tokens
  'gpt-4o':                     { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'gpt-4o-mini':                { inputPer1M: 0.15,  outputPer1M: 0.60 },
  'gpt-4-turbo':                { inputPer1M: 10.00, outputPer1M: 30.00 },
  'gpt-4':                      { inputPer1M: 30.00, outputPer1M: 60.00 },
  'gpt-3.5-turbo':              { inputPer1M: 0.50,  outputPer1M: 1.50 },
  'o1':                         { inputPer1M: 15.00, outputPer1M: 60.00 },
  'o1-mini':                    { inputPer1M: 3.00,  outputPer1M: 12.00 },
  'o3-mini':                    { inputPer1M: 1.10,  outputPer1M: 4.40 },
};

// Provider-level fallbacks for unknown models
const PROVIDER_FALLBACK: Record<string, ModelPricing> = {
  anthropic: { inputPer1M: 3.00,  outputPer1M: 15.00 },  // Assume Sonnet-tier
  google:    { inputPer1M: 0.50,  outputPer1M: 2.00 },   // Assume mid-range
  openai:    { inputPer1M: 2.50,  outputPer1M: 10.00 },  // Assume GPT-4o
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 1.00, outputPer1M: 5.00 };

// ─── Public API ──────────────────────────────────────────────────

/**
 * Look up pricing for a specific model, with provider-level fallback.
 */
export function getModelPricing(model: string, provider?: string): ModelPricing {
  // Exact model match
  const exact = MODEL_PRICING[model];
  if (exact) return exact;

  // Partial match (handle model versions like "claude-3-haiku-20240307-v2")
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) {
      return pricing;
    }
  }

  // Provider-level fallback
  if (provider) {
    const fallback = PROVIDER_FALLBACK[provider];
    if (fallback) return fallback;
  }

  return DEFAULT_PRICING;
}

/**
 * Calculate cost in integer cents from token counts and model info.
 * Uses NUMERIC-safe integer arithmetic — never returns fractional cents.
 *
 * Formula: cost_cents = ceil((tokensIn * inputRate + tokensOut * outputRate) / 1_000_000 * 100)
 */
export function calculateCostCents(
  tokensIn: number,
  tokensOut: number,
  model: string,
  provider?: string,
): number {
  const pricing = getModelPricing(model, provider);

  // Compute cost in microdollars (millionths of a dollar) to avoid float issues
  // inputPer1M * 100 = cents per 1M tokens
  // (tokens * centsPerM) / 1_000_000 = cost in cents
  const inputCostMicro = tokensIn * pricing.inputPer1M * 100;
  const outputCostMicro = tokensOut * pricing.outputPer1M * 100;
  const totalCents = (inputCostMicro + outputCostMicro) / 1_000_000;

  return Math.ceil(totalCents);
}
