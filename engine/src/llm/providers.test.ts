/**
 * Default models and the request each provider sends for them: current
 * models refuse parameters older ones accepted (a non-default temperature on
 * Claude 4.7 and later, max_tokens and temperature on OpenAI reasoning
 * models), so the request shape is pinned per model family.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));

vi.mock('./provider.js', () => ({
  resolveApiKey: () => 'test-key',
  invalidateSettingsCache: vi.fn(),
}));

import { anthropicProvider, acceptsTemperature as anthropicAcceptsTemperature } from './anthropic.js';
import { openaiProvider, acceptsTemperature as openaiAcceptsTemperature } from './openai.js';
import { getModelPricing } from './pricing.js';
import { env } from '../config/env.js';

beforeEach(() => {
  anthropicCreate.mockReset().mockResolvedValue({
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'OK' }],
    usage: { input_tokens: 12, output_tokens: 3 },
  });
  openaiCreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: 'OK' } }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
});

describe('default models', () => {
  it('defaults both roles to Anthropic claude-haiku-5-5', () => {
    const config = env();
    expect(config.NOMUS_LLM_CLASSIFIER_PROVIDER).toBe('anthropic');
    expect(config.NOMUS_LLM_CLASSIFIER_MODEL).toBe('claude-haiku-5-5');
    expect(config.NOMUS_LLM_TRANSLATOR_PROVIDER).toBe('anthropic');
    expect(config.NOMUS_LLM_TRANSLATOR_MODEL).toBe('claude-haiku-5-5');
  });

  it('prices each provider default at its own rate, not a provider fallback', () => {
    expect(getModelPricing('claude-haiku-5-5', 'anthropic')).toEqual({ inputPer1M: 0.10, outputPer1M: 0.50 });
    expect(getModelPricing('gemini-3.8-flash', 'google')).toEqual({ inputPer1M: 0.75, outputPer1M: 3.75 });
    expect(getModelPricing('gpt-6-luna', 'openai')).toEqual({ inputPer1M: 0.10, outputPer1M: 0.50 });
  });
});

describe('Anthropic request', () => {
  it.each([
    ['claude-haiku-5-5', false],
    ['claude-sonnet-5-5', false],
    ['claude-opus-5-5', false],
    ['claude-fable-5-1', false],
    ['claude-opus-4-7', false],
    ['claude-opus-4-8', false],
    ['claude-sonnet-4-6', true],
    ['claude-opus-4-6', true],
    ['claude-haiku-4-5', true],
    ['claude-haiku-4-5-20251001', true],
    ['claude-sonnet-4-5-20250929', true],
    ['claude-sonnet-4-20250514', true],
    ['claude-3-5-haiku-20241022', true],
    ['claude-3-haiku-20240307', true],
    ['claude-mythos-preview', false],
    ['some-unknown-model', false],
  ])('%s accepts temperature: %s', (model, expected) => {
    expect(anthropicAcceptsTemperature(model)).toBe(expected);
  });

  it('sends no temperature to the default model and reads the text block after thinking', async () => {
    const res = await anthropicProvider.generate('system', 'user', 'claude-haiku-5-5');
    const body = anthropicCreate.mock.calls[0][0];
    expect(body).not.toHaveProperty('temperature');
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16384, system: 'system' });
    expect(res).toEqual({ content: 'OK', tokensIn: 12, tokensOut: 3, model: 'claude-haiku-5-5', provider: 'anthropic' });
  });

  it('keeps temperature 0 for an older model that accepts it', async () => {
    await anthropicProvider.generate('system', 'user', 'claude-haiku-4-5-20251001');
    expect(anthropicCreate.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });
});

describe('OpenAI request', () => {
  it.each([
    ['gpt-6-luna', false],
    ['gpt-6.1-sol', false],
    ['gpt-6-astra', false],
    ['o3-mini', false],
    ['gpt-5', false],
    ['gpt-4o-mini', true],
    ['gpt-4o-mini-2024-07-18', true],
    ['gpt-4o', true],
    ['gpt-4.1', true],
    ['gpt-4-turbo', true],
    ['gpt-4', true],
    ['gpt-3.5-turbo', true],
    ['ft:gpt-4o-mini:acme::abc123', true],
  ])('%s accepts temperature: %s', (model, expected) => {
    expect(openaiAcceptsTemperature(model)).toBe(expected);
  });

  it('sends max_completion_tokens and no temperature or max_tokens to the default model', async () => {
    const res = await openaiProvider.generate('system', 'user', 'gpt-6-luna');
    const body = openaiCreate.mock.calls[0][0];
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 16384 });
    expect(res).toEqual({ content: 'OK', tokensIn: 12, tokensOut: 3, model: 'gpt-6-luna', provider: 'openai' });
  });

  it('keeps temperature 0 for an older model that accepts it', async () => {
    await openaiProvider.generate('system', 'user', 'gpt-4o-mini');
    expect(openaiCreate.mock.calls[0][0]).toMatchObject({ temperature: 0, max_completion_tokens: 16384 });
  });
});
