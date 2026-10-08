import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider, LLMResponse } from './provider.js';
import { resolveApiKey } from './provider.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let _client: GoogleGenerativeAI | null = null;
let _lastKey: string | null = null;

function getClient(): GoogleGenerativeAI {
  const apiKey = resolveApiKey('llm.apiKeys.google', env().NOMUS_GOOGLE_AI_KEY);
  if (!apiKey) throw new Error('NOMUS_GOOGLE_AI_KEY not configured');
  if (_client && _lastKey === apiKey) return _client;
  _client = new GoogleGenerativeAI(apiKey);
  _lastKey = apiKey;
  return _client;
}

const MAX_RETRIES = 5;
const BASE_DELAY = 2000;
const MAX_DELAY = 60000;

export const googleProvider: LLMProvider = {
  async generate(systemPrompt: string, userMessage: string, model: string): Promise<LLMResponse> {
    const client = getClient();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const genModel = client.getGenerativeModel({
          model,
          systemInstruction: systemPrompt,
        });

        const result = await genModel.generateContent(userMessage);
        const response = result.response;
        const content = response.text();
        const usage = response.usageMetadata;

        return {
          content,
          tokensIn: usage?.promptTokenCount ?? 0,
          tokensOut: usage?.candidatesTokenCount ?? 0,
          model,
          provider: 'google',
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message.toLowerCase();
        const isRetryable = msg.includes('429') || msg.includes('rate') || msg.includes('quota')
          || msg.includes('500') || msg.includes('503') || msg.includes('overloaded');

        if (!isRetryable || attempt === MAX_RETRIES) {
          throw lastError;
        }

        const delay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 1000, MAX_DELAY);

        logger.warn({
          attempt,
          delay: Math.round(delay),
          model,
          error: lastError.message.slice(0, 200),
        }, `Google LLM request failed (attempt ${attempt}/${MAX_RETRIES}), retrying`);

        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('Google LLM request failed after all retries');
  },
};
