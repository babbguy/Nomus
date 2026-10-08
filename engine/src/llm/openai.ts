import OpenAI from 'openai';
import type { LLMProvider, LLMResponse } from './provider.js';
import { resolveApiKey } from './provider.js';
import { logger } from '../logger.js';

let _client: OpenAI | null = null;
let _lastKey: string | null = null;

function getClient(): OpenAI {
  const apiKey = resolveApiKey('llm.apiKeys.openai', process.env.NOMUS_OPENAI_API_KEY);
  if (!apiKey) throw new Error('OpenAI API key not configured');
  if (_client && _lastKey === apiKey) return _client;
  _client = new OpenAI({ apiKey });
  _lastKey = apiKey;
  return _client;
}

const MAX_RETRIES = 5;
const BASE_DELAY = 2000;
const MAX_DELAY = 60000;

export const openaiProvider: LLMProvider = {
  async generate(systemPrompt: string, userMessage: string, model: string): Promise<LLMResponse> {
    const client = getClient();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 16384,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        });

        const content = response.choices[0]?.message?.content ?? '';

        return {
          content,
          tokensIn: response.usage?.prompt_tokens ?? 0,
          tokensOut: response.usage?.completion_tokens ?? 0,
          model,
          provider: 'openai',
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const status = (err as { status?: number }).status;
        const isRetryable = status === 429 || (status && status >= 500);

        if (!isRetryable || attempt === MAX_RETRIES) {
          throw lastError;
        }

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
        }, `OpenAI request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${Math.round(delay / 1000)}s`);

        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('OpenAI request failed after all retries');
  },
};
