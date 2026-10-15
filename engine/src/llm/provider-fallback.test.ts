/**
 * When the primary provider fails, the fallback provider runs its own model
 * (never the primary's, which it would reject) with the request shape that
 * model needs. The real providers run here with their SDKs mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
  googleGenerate: vi.fn(),
  googleGetModel: vi.fn(),
  config: {} as Record<string, string | undefined>,
  settings: new Map<string, string>(),
  warn: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.anthropicCreate }; } }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: h.openaiCreate } }; } }));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(opts: unknown) { return h.googleGetModel(opts); }
  },
}));
vi.mock('../config/env.js', () => ({ env: () => h.config }));
vi.mock('../db/client.js', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ all: () => [...h.settings].map(([key, value]) => ({ key, value })) }) }) }),
}));
vi.mock('../core/crypto.js', () => ({ decryptFromStorage: (v: string) => v }));
vi.mock('../logger.js', () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { generateWithFallback, invalidateSettingsCache, DEFAULT_MODELS, type ProviderName } from './provider.js';

const NAMES: ProviderName[] = ['anthropic', 'google', 'openai'];
/** A model each provider can be configured with for a role, different from its default. */
const PRIMARY_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-5-5',
  google: 'gemini-2.5-pro',
  openai: 'gpt-4o-mini',
};
const pairs = NAMES.flatMap((primary) => NAMES.filter((f) => f !== primary).map((fallback) => [primary, fallback] as const));

const sentModel = (name: ProviderName): string | undefined => {
  if (name === 'anthropic') return h.anthropicCreate.mock.calls.at(-1)?.[0]?.model;
  if (name === 'openai') return h.openaiCreate.mock.calls.at(-1)?.[0]?.model;
  return h.googleGetModel.mock.calls.at(-1)?.[0]?.model;
};
const callCount = (name: ProviderName) =>
  ({ anthropic: h.anthropicCreate, openai: h.openaiCreate, google: h.googleGetModel })[name].mock.calls.length;

beforeEach(() => {
  invalidateSettingsCache();
  h.settings.clear();
  h.warn.mockReset();
  h.config = {
    NOMUS_ANTHROPIC_API_KEY: 'k-anthropic',
    NOMUS_GOOGLE_AI_KEY: 'k-google',
    NOMUS_LLM_CLASSIFIER_PROVIDER: 'anthropic',
    NOMUS_LLM_CLASSIFIER_MODEL: 'claude-haiku-5-5',
    NOMUS_LLM_TRANSLATOR_PROVIDER: 'anthropic',
    NOMUS_LLM_TRANSLATOR_MODEL: 'claude-haiku-5-5',
    NOMUS_LLM_FALLBACK_PROVIDER: 'none',
  };
  process.env.NOMUS_OPENAI_API_KEY = 'k-openai';
  h.anthropicCreate.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } });
  h.openaiCreate.mockReset().mockResolvedValue({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  h.googleGenerate.mockReset().mockResolvedValue({ response: { text: () => 'OK', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } });
  h.googleGetModel.mockReset().mockImplementation(() => ({ generateContent: h.googleGenerate }));
});

/** Make `primary` the provider of both roles (with its own model) and fail every call to it. */
function setup(primary: ProviderName, fallback: ProviderName | 'none', source: 'env' | 'settings' = 'env') {
  const down = Object.assign(new Error('primary is down'), { status: 400 });
  if (primary === 'anthropic') h.anthropicCreate.mockRejectedValue(down);
  else if (primary === 'openai') h.openaiCreate.mockRejectedValue(down);
  else h.googleGenerate.mockRejectedValue(down);
  for (const role of ['classifier', 'translator']) {
    if (source === 'env') {
      h.config[`NOMUS_LLM_${role.toUpperCase()}_PROVIDER`] = primary;
      h.config[`NOMUS_LLM_${role.toUpperCase()}_MODEL`] = PRIMARY_MODEL[primary];
    } else {
      h.settings.set(`llm.${role}.provider`, primary);
      h.settings.set(`llm.${role}.model`, PRIMARY_MODEL[primary]);
    }
  }
  if (source === 'env') h.config.NOMUS_LLM_FALLBACK_PROVIDER = fallback;
  else h.settings.set('llm.fallback.provider', fallback);
  invalidateSettingsCache();
}

describe.each(['classifier', 'translator'] as const)('fallback model, %s role', (role) => {
  describe.each(pairs)('%s -> %s', (primary, fallback) => {
    it.each(['env', 'settings'] as const)('sends the fallback its own default model (configured by %s)', async (source) => {
      setup(primary, fallback, source);
      const res = await generateWithFallback(role, 'system', 'user');
      expect(callCount(primary)).toBe(1);
      expect(sentModel(primary)).toBe(PRIMARY_MODEL[primary]);
      expect(sentModel(fallback)).toBe(DEFAULT_MODELS[fallback]);
      expect(res).toMatchObject({ provider: fallback, model: DEFAULT_MODELS[fallback] });
    });
  });
});

describe('fallback request shape follows the fallback model', () => {
  it('Anthropic primary -> OpenAI fallback: max_completion_tokens, no temperature, no max_tokens', async () => {
    setup('anthropic', 'openai');
    await generateWithFallback('classifier', 'system', 'user');
    const body = h.openaiCreate.mock.calls[0][0];
    expect(body).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 16384 });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('OpenAI primary -> Anthropic fallback: max_tokens and no temperature for the current default model', async () => {
    setup('openai', 'anthropic');
    await generateWithFallback('classifier', 'system', 'user');
    const body = h.anthropicCreate.mock.calls[0][0];
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16384 });
    expect(body).not.toHaveProperty('temperature');
  });
});

describe('fallback that cannot run', () => {
  it('skips a fallback with no API key, warns, and rethrows the primary error', async () => {
    setup('anthropic', 'openai');
    delete process.env.NOMUS_OPENAI_API_KEY;
    await expect(generateWithFallback('classifier', 'system', 'user')).rejects.toThrow('primary is down');
    expect(callCount('openai')).toBe(0);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fallback: 'openai' }),
      expect.stringContaining('skipped: no API key'),
    );
  });

  it('uses an API key saved in the dashboard settings', async () => {
    setup('anthropic', 'openai');
    delete process.env.NOMUS_OPENAI_API_KEY;
    h.settings.set('llm.apiKeys.openai', 'stored-key');
    invalidateSettingsCache();
    await generateWithFallback('classifier', 'system', 'user');
    expect(sentModel('openai')).toBe('gpt-6-luna');
  });

  it('ignores an unknown fallback provider, warns, and rethrows the primary error', async () => {
    setup('anthropic', 'none');
    h.settings.set('llm.fallback.provider', 'constructor');
    invalidateSettingsCache();
    await expect(generateWithFallback('classifier', 'system', 'user')).rejects.toThrow('primary is down');
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ fallback: 'constructor' }), expect.stringContaining('Unknown fallback provider'));
  });

  it('makes no fallback call when the primary succeeds', async () => {
    h.config.NOMUS_LLM_FALLBACK_PROVIDER = 'google';
    await generateWithFallback('classifier', 'system', 'user');
    expect(callCount('google')).toBe(0);
  });
});
