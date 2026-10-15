import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResponse } from './provider.js';
import { resolveApiKey, invalidateSettingsCache } from './provider.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let _client: Anthropic | null = null;
let _lastKey: string | null = null;

function getClient(): Anthropic {
  const apiKey = resolveApiKey('llm.apiKeys.anthropic', env().NOMUS_ANTHROPIC_API_KEY);
  if (!apiKey) throw new Error('NOMUS_ANTHROPIC_API_KEY not configured');
  // Recreate client if key changed (e.g. updated via dashboard)
  if (_client && _lastKey === apiKey) return _client;
  _client = new Anthropic({ apiKey });
  _lastKey = apiKey;
  return _client;
}

/** Max retries on rate limit (429) or server error (5xx) */
const MAX_RETRIES = 5;
/** Base delay for exponential backoff (ms) */
const BASE_DELAY = 2000;
/** Maximum delay cap (ms) */
const MAX_DELAY = 60000;
/** Request timeout (ms) */
const REQUEST_TIMEOUT = 120000;

/**
 * Whether `model` accepts a non-default `temperature`. Claude 4.7 and later
 * models reject one with a 400, so it is sent only to the Claude 3 and
 * Claude 4.0 to 4.6 models that still take it. A model this check does not
 * recognise gets no temperature, which every model accepts.
 * https://platform.claude.com/docs/en/about-claude/model-deprecations#api-parameter-deprecations
 */
export function acceptsTemperature(model: string): boolean {
  if (/^claude-3[-.]/.test(model)) return true;
  const m = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major < 4 || (major === 4 && minor <= 6);
}

export const anthropicProvider: LLMProvider = {
  async generate(systemPrompt: string, userMessage: string, model: string): Promise<LLMResponse> {
    const client = getClient();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 16384,
          // Deterministic sampling where the model still allows choosing it.
          ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });

        const textBlock = response.content.find((b) => b.type === 'text');
        const content = textBlock?.text ?? '';

        return {
          content,
          tokensIn: response.usage.input_tokens,
          tokensOut: response.usage.output_tokens,
          model,
          provider: 'anthropic',
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const status = (err as { status?: number }).status;
        const isRetryable = status === 429 || status === 529 || (status && status >= 500);

        if (!isRetryable || attempt === MAX_RETRIES) {
          throw lastError;
        }

        // Parse retry-after header if available, otherwise use exponential backoff
        const retryAfter = (err as { headers?: Record<string, string> }).headers?.['retry-after'];
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 1000, MAX_DELAY);

        logger.warn({
          attempt,
          status,
          delay: Math.round(delay),
          model,
          error: lastError.message.slice(0, 200),
        }, `LLM request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${Math.round(delay / 1000)}s`);

        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('LLM request failed after all retries');
  },
};
