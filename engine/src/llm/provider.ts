import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { platformSettings } from '../db/schema.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { decryptFromStorage } from '../core/crypto.js';

// ─── Types ───────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'google' | 'openai';

export interface LLMResponse {
  content: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider: ProviderName;
}

export interface LLMProvider {
  generate(systemPrompt: string, userMessage: string, model: string): Promise<LLMResponse>;
}

export interface ResolvedProvider {
  provider: LLMProvider;
  providerName: ProviderName;
  model: string;
  fallback?: LLMProvider;
  fallbackName?: ProviderName;
}

// ─── Settings Cache ──────────────────────────────────────────

let _cache: Map<string, string> | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 60 seconds

function getSettings(): Map<string, string> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  try {
    const db = getDb();
    const rows = db.select().from(platformSettings).all();
    _cache = new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    // DB not ready yet (startup), return empty
    _cache = new Map();
  }
  _cacheTime = now;
  return _cache;
}

/** Force cache refresh (call after settings update) */
export function invalidateSettingsCache(): void {
  _cache = null;
  _cacheTime = 0;
}

function getSetting(key: string): string | undefined {
  return getSettings().get(key);
}

/** Resolve an API key: DB (encrypted) → env fallback */
export function resolveApiKey(dbKey: string, envFallback: string | undefined): string | undefined {
  const stored = getSetting(dbKey);
  if (stored) {
    try {
      return decryptFromStorage(stored);
    } catch {
      return stored;
    }
  }
  return envFallback || undefined;
}

// ─── Provider Registry ───────────────────────────────────────

let _providers: Record<ProviderName, LLMProvider> | null = null;

async function getProviderRegistry(): Promise<Record<ProviderName, LLMProvider>> {
  if (!_providers) {
    // Dynamic import to avoid circular deps and loading all SDKs at startup
    const [anthropicMod, googleMod, openaiMod] = await Promise.all([
      import('./anthropic.js'),
      import('./google.js'),
      import('./openai.js'),
    ]);
    _providers = {
      anthropic: anthropicMod.anthropicProvider,
      google: googleMod.googleProvider,
      openai: openaiMod.openaiProvider,
    };
  }
  return _providers;
}

async function getProviderByName(name: ProviderName): Promise<LLMProvider> {
  return (await getProviderRegistry())[name];
}

// ─── Resolver ────────────────────────────────────────────────

/**
 * Resolve which provider + model to use for a given role.
 * Priority: DB platform_settings → env vars → defaults.
 */
export async function resolveProvider(role: 'classifier' | 'translator'): Promise<ResolvedProvider> {
  const config = env();

  // Read from DB settings first, fall back to env
  const providerName = (getSetting(`llm.${role}.provider`)
    ?? (role === 'classifier' ? config.NOMUS_LLM_CLASSIFIER_PROVIDER : config.NOMUS_LLM_TRANSLATOR_PROVIDER)
  ) as ProviderName;

  const model = getSetting(`llm.${role}.model`)
    ?? (role === 'classifier' ? config.NOMUS_LLM_CLASSIFIER_MODEL : config.NOMUS_LLM_TRANSLATOR_MODEL);

  const fallbackName = (getSetting('llm.fallback.provider')
    ?? config.NOMUS_LLM_FALLBACK_PROVIDER
    ?? 'none'
  );

  const result: ResolvedProvider = {
    provider: await getProviderByName(providerName),
    providerName,
    model,
  };

  if (fallbackName !== 'none' && fallbackName !== providerName) {
    result.fallback = await getProviderByName(fallbackName as ProviderName);
    result.fallbackName = fallbackName as ProviderName;
  }

  return result;
}

// ─── Generate with Fallback ──────────────────────────────────

/**
 * Try the primary provider. If it fails and a fallback is configured, try that.
 */
export async function generateWithFallback(
  role: 'classifier' | 'translator',
  systemPrompt: string,
  userMessage: string,
  modelOverride?: string,
): Promise<LLMResponse> {
  const { provider, providerName, model, fallback, fallbackName } = await resolveProvider(role);
  const useModel = modelOverride ?? model;

  try {
    return await provider.generate(systemPrompt, userMessage, useModel);
  } catch (err) {
    if (!fallback) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ provider: providerName, fallback: fallbackName, error: msg.slice(0, 200) },
      `Primary provider failed, falling back to ${fallbackName}`);

    // Fallback uses its own default model if the primary model isn't compatible
    const fallbackModel = getSetting(`llm.${role}.model`) ?? useModel;
    return await fallback.generate(systemPrompt, userMessage, fallbackModel);
  }
}
