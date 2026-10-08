import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { platformSettings } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { invalidateSettingsCache, type ProviderName } from '../../llm/provider.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { safeJson } from '../utils.js';
import { encryptForStorage, decryptFromStorage } from '../../core/crypto.js';

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.use('*', requireSessionOrApiKey('admin'));

const PROVIDER_NAMES: ProviderName[] = ['anthropic', 'google', 'openai'];

// Helper to get a setting from DB, falling back to env default
function getSetting(db: ReturnType<typeof getDb>, key: string, fallback: string): string {
  const row = db.select().from(platformSettings).where(eq(platformSettings.key, key)).get();
  return row?.value ?? fallback;
}

function upsert(db: ReturnType<typeof getDb>, key: string, value: string) {
  const now = new Date().toISOString();
  const existing = db.select().from(platformSettings).where(eq(platformSettings.key, key)).get();
  if (existing) {
    db.update(platformSettings).set({ value, updatedAt: now }).where(eq(platformSettings.key, key)).run();
  } else {
    db.insert(platformSettings).values({ key, value, updatedAt: now }).run();
  }
}

// ─── GET /api/v1/settings/llm ────────────────────────────────

settingsRoutes.get('/llm', (c) => {
  const db = getDb();
  const config = env();

  return c.json({
    classifier: {
      provider: getSetting(db, 'llm.classifier.provider', config.NOMUS_LLM_CLASSIFIER_PROVIDER),
      model: getSetting(db, 'llm.classifier.model', config.NOMUS_LLM_CLASSIFIER_MODEL),
    },
    translator: {
      provider: getSetting(db, 'llm.translator.provider', config.NOMUS_LLM_TRANSLATOR_PROVIDER),
      model: getSetting(db, 'llm.translator.model', config.NOMUS_LLM_TRANSLATOR_MODEL),
    },
    fallback: {
      provider: getSetting(db, 'llm.fallback.provider', config.NOMUS_LLM_FALLBACK_PROVIDER ?? 'none'),
    },
    apiKeys: {
      anthropic: maskKey(getDecryptedApiKey(db, 'llm.apiKeys.anthropic', config.NOMUS_ANTHROPIC_API_KEY ?? '')),
      google: maskKey(getDecryptedApiKey(db, 'llm.apiKeys.google', config.NOMUS_GOOGLE_AI_KEY ?? '')),
      openai: maskKey(getDecryptedApiKey(db, 'llm.apiKeys.openai', config.NOMUS_OPENAI_API_KEY ?? '')),
    },
    providers: PROVIDER_NAMES,
  });
});

// ─── PUT /api/v1/settings/llm ────────────────────────────────

const updateLLMSchema = z.object({
  classifier: z.object({
    provider: z.enum(['anthropic', 'google', 'openai']),
    model: z.string().min(1),
  }).optional(),
  translator: z.object({
    provider: z.enum(['anthropic', 'google', 'openai']),
    model: z.string().min(1),
  }).optional(),
  fallback: z.object({
    provider: z.enum(['anthropic', 'google', 'openai', 'none']),
  }).optional(),
});

settingsRoutes.put('/llm', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateLLMSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const db = getDb();
  const { classifier, translator, fallback } = parsed.data;

  if (classifier) {
    upsert(db, 'llm.classifier.provider', classifier.provider);
    upsert(db, 'llm.classifier.model', classifier.model);
  }
  if (translator) {
    upsert(db, 'llm.translator.provider', translator.provider);
    upsert(db, 'llm.translator.model', translator.model);
  }
  if (fallback) {
    upsert(db, 'llm.fallback.provider', fallback.provider);
  }

  invalidateSettingsCache();
  logger.info({ classifier, translator, fallback }, 'LLM settings updated');

  return c.json({ ok: true });
});

// ─── PUT /api/v1/settings/llm/api-keys ───────────────────────

const apiKeysSchema = z.object({
  anthropic: z.string().optional(),
  google: z.string().optional(),
  openai: z.string().optional(),
});

settingsRoutes.put('/llm/api-keys', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = apiKeysSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input' }, 400);

  const db = getDb();
  for (const [provider, key] of Object.entries(parsed.data)) {
    if (key !== undefined && key !== '') {
      upsert(db, `llm.apiKeys.${provider}`, encryptForStorage(key));
    }
  }

  invalidateSettingsCache();
  logger.info('LLM API keys updated');

  return c.json({ ok: true });
});

// ─── POST /api/v1/settings/llm/test ──────────────────────────

const testSchema = z.object({
  provider: z.enum(['anthropic', 'google', 'openai']),
  model: z.string().min(1),
});

settingsRoutes.post('/llm/test', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input' }, 400);

  const { provider: providerName, model } = parsed.data;

  try {
    // Dynamically import the provider
    let provider;
    if (providerName === 'anthropic') {
      const { anthropicProvider } = await import('../../llm/anthropic.js');
      provider = anthropicProvider;
    } else if (providerName === 'google') {
      const { googleProvider } = await import('../../llm/google.js');
      provider = googleProvider;
    } else {
      const { openaiProvider } = await import('../../llm/openai.js');
      provider = openaiProvider;
    }

    const result = await provider.generate(
      'You are a test assistant. Reply with exactly: OK',
      'Test connection. Reply with exactly: OK',
      model,
    );

    return c.json({
      ok: true,
      response: result.content.slice(0, 50),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.model,
      provider: result.provider,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg.slice(0, 300) }, 400);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCOUT API KEYS (Government Legislative APIs)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── GET /api/v1/settings/scout-api-keys ─────────────────────

settingsRoutes.get('/scout-api-keys', (c) => {
  const db = getDb();
  const config = env();

  return c.json({
    congressGov: maskKey(getDecryptedApiKey(db, 'scout.apiKeys.congressGov', config.NOMUS_CONGRESS_GOV_API_KEY)),
    // Federal Register, UK Parliament, EUR-Lex do not require API keys
    configured: {
      congressGov: !!getDecryptedApiKey(db, 'scout.apiKeys.congressGov', config.NOMUS_CONGRESS_GOV_API_KEY) &&
        getDecryptedApiKey(db, 'scout.apiKeys.congressGov', config.NOMUS_CONGRESS_GOV_API_KEY) !== 'DEMO_KEY',
    },
    providers: [
      { id: 'congressGov', name: 'Congress.gov', required: true, signupUrl: 'https://api.congress.gov/sign-up/', description: 'US federal bills and legislation tracking' },
      { id: 'federalRegister', name: 'Federal Register', required: false, description: 'US rulemaking — no API key needed' },
      { id: 'ukParliament', name: 'UK Parliament', required: false, description: 'UK bills and debates — no API key needed' },
      { id: 'eurlex', name: 'EUR-Lex', required: false, description: 'EU legislation search — no API key needed' },
    ],
  });
});

// ─── PUT /api/v1/settings/scout-api-keys ─────────────────────

const scoutApiKeysSchema = z.object({
  congressGov: z.string().min(1).optional(),
});

settingsRoutes.put('/scout-api-keys', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = scoutApiKeysSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const db = getDb();
  if (parsed.data.congressGov) {
    upsert(db, 'scout.apiKeys.congressGov', encryptForStorage(parsed.data.congressGov));
  }

  logger.info('Scout API keys updated');
  return c.json({ ok: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NOTIFICATION SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { sendEmail, sendPush, sendSlack, invalidateNotificationCache } from '../../services/notifications.js';

// ─── GET /api/v1/settings/notifications ──────────────────────

settingsRoutes.get('/notifications', (c) => {
  const db = getDb();
  const config = env();

  const resendKey = getDecryptedApiKey(db, 'notification.apiKeys.resend', config.NOMUS_RESEND_API_KEY ?? '');

  return c.json({
    email: {
      enabled: getSetting(db, 'notification.email.enabled', 'false'),
      recipients: JSON.parse(getSetting(db, 'notification.email.recipients', '[]')),
      resendKeyConfigured: !!resendKey,
      resendKeyMasked: maskKey(resendKey),
    },
    push: {
      enabled: getSetting(db, 'notification.push.enabled', 'false'),
      topics: (() => { try { return JSON.parse(getSetting(db, 'notification.push.topics', '[]')); } catch { return []; } })(),
      ntfyUrl: getSetting(db, 'notification.ntfy.url', config.NOMUS_NTFY_URL ?? 'https://ntfy.sh'),
    },
    slack: {
      configured: !!(getSetting(db, 'notification.slack.webhook_url', '') || config.NOMUS_SLACK_WEBHOOK_URL),
    },
    events: {
      pipeline_success: getSetting(db, 'notification.on.pipeline_success', 'email'),
      pipeline_error: getSetting(db, 'notification.on.pipeline_error', 'email+sms'),
      scout_review: getSetting(db, 'notification.on.scout_review', 'email'),
      scout_signal: getSetting(db, 'notification.on.scout_signal', 'email+sms'),
    },
  });
});

// ─── PUT /api/v1/settings/notifications ──────────────────────

const updateNotificationsSchema = z.object({
  email: z.object({
    enabled: z.enum(['true', 'false']),
    recipients: z.array(z.string().email()),
    resendApiKey: z.string().optional(),
  }).optional(),
  push: z.object({
    enabled: z.enum(['true', 'false']),
    topics: z.array(z.string().min(1)),
    ntfyUrl: z.string().optional(),
    ntfyToken: z.string().optional(),
  }).optional(),
  slack: z.object({
    webhook_url: z.string().url().optional().or(z.literal('')),
  }).optional(),
  events: z.object({
    pipeline_success: z.enum(['email+sms', 'email', 'sms', 'none']),
    pipeline_error: z.enum(['email+sms', 'email', 'sms', 'none']),
    scout_review: z.enum(['email+sms', 'email', 'sms', 'none']),
    scout_signal: z.enum(['email+sms', 'email', 'sms', 'none']),
  }).optional(),
});

settingsRoutes.put('/notifications', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateNotificationsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  const db = getDb();
  const { email, events } = parsed.data;

  if (email) {
    upsert(db, 'notification.email.enabled', email.enabled);
    upsert(db, 'notification.email.recipients', JSON.stringify(email.recipients));
    if (email.resendApiKey) {
      upsert(db, 'notification.apiKeys.resend', encryptForStorage(email.resendApiKey));
    }
  }
  const { push, slack } = parsed.data;
  if (push) {
    upsert(db, 'notification.push.enabled', push.enabled);
    upsert(db, 'notification.push.topics', JSON.stringify(push.topics));
    if (push.ntfyUrl) upsert(db, 'notification.ntfy.url', push.ntfyUrl);
    if (push.ntfyToken) upsert(db, 'notification.ntfy.token', push.ntfyToken);
  }
  if (slack) {
    if (slack.webhook_url !== undefined) upsert(db, 'notification.slack.webhook_url', slack.webhook_url);
  }
  if (events) {
    upsert(db, 'notification.on.pipeline_success', events.pipeline_success);
    upsert(db, 'notification.on.pipeline_error', events.pipeline_error);
    upsert(db, 'notification.on.scout_review', events.scout_review);
    upsert(db, 'notification.on.scout_signal', events.scout_signal);
  }

  invalidateNotificationCache();
  logger.info('Notification settings updated');
  return c.json({ ok: true });
});

// ─── POST /api/v1/settings/notifications/test ────────────────

settingsRoutes.post('/notifications/test', async (c) => {
  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const channel = (rawBody as Record<string, any>).channel as string;
  const results: Record<string, boolean> = {};

  if (channel === 'email' || channel === 'both') {
    const db = getDb();
    const recipients = JSON.parse(getSetting(db, 'notification.email.recipients', '[]'));
    if (recipients.length === 0) return c.json({ ok: false, error: 'No email recipients configured' }, 400);
    results.email = await sendEmail(recipients, 'Nomus: Test Notification',
      '<p>This is a test notification from Nomus.</p><p>If you received this, email notifications are working.</p>');
  }

  if (channel === 'sms' || channel === 'push' || channel === 'both') {
    const db = getDb();
    const topics = (() => { try { return JSON.parse(getSetting(db, 'notification.push.topics', '[]')); } catch { return []; } })() as string[];
    if (topics.length === 0) return c.json({ ok: false, error: 'No push notification topics configured' }, 400);
    results.push = await sendPush(topics, 'Nomus: Test Notification', 'Push notifications are working.');
  }

  if (channel === 'slack' || channel === 'both') {
    results.slack = await sendSlack('This is a test notification from Nomus. Slack integration is working.');
  }

  const ok = Object.values(results).every(Boolean);
  return c.json({ ok, results });
});

// ─── Helpers ─────────────────────────────────────────────────

function maskKey(key: string): string {
  if (!key || key.length < 8) return key ? '••••••••' : '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/** Read an API key from DB, decrypting if needed, with env fallback */
function getDecryptedApiKey(db: ReturnType<typeof getDb>, key: string, fallback: string): string {
  const stored = getSetting(db, key, '');
  if (!stored) return fallback;
  try {
    return decryptFromStorage(stored);
  } catch {
    // Legacy unencrypted value or corrupted — return as-is
    return stored;
  }
}
