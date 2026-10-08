import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { API_KEY_PREFIX_LIVE } from '@nomus/shared';
import { getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { env } from '../config/env.js';

export interface CreateApiKeyInput {
  label: string;
  scopes: string[];
  expiresAt?: string | null;
}

export type CreateApiKeyResult =
  | { ok: true; id: string; key: string; prefix: string; label: string; scopes: string[]; rateLimitRpm: number }
  | { ok: false; error: string };

/** Hash a raw API key the same way the resolver verifies it. */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Key metadata for an org. Never includes the key hash; the raw key is only
 * ever returned by createApiKey. Revoked keys are included (isActive=false).
 */
export function listApiKeys(orgId: string) {
  const rows = getDb().select({
    id: apiKeys.id,
    keyPrefix: apiKeys.keyPrefix,
    label: apiKeys.label,
    scopes: apiKeys.scopes,
    isActive: apiKeys.isActive,
    lastUsedAt: apiKeys.lastUsedAt,
    createdAt: apiKeys.createdAt,
    expiresAt: apiKeys.expiresAt,
  }).from(apiKeys)
    .where(eq(apiKeys.orgId, orgId))
    .all();

  return rows.map((k) => {
    let scopes: unknown;
    try { scopes = JSON.parse(k.scopes); } catch { scopes = []; }
    return { ...k, scopes };
  });
}

/**
 * Generate and store a key for an org, enforcing NOMUS_MAX_API_KEYS_PER_ORG
 * over active keys. The raw key is returned once and never stored.
 */
export function createApiKey(orgId: string, input: CreateApiKeyInput): CreateApiKeyResult {
  const db = getDb();

  const keyCount = db.select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.isActive, true)))
    .all().length;

  const maxApiKeys = env().NOMUS_MAX_API_KEYS_PER_ORG;
  if (keyCount >= maxApiKeys) {
    return { ok: false, error: `API key limit reached (${maxApiKeys})` };
  }

  const rawKey = `${API_KEY_PREFIX_LIVE}${randomBytes(24).toString('base64url')}`;
  const record = {
    id: randomUUID(),
    orgId,
    keyHash: hashApiKey(rawKey),
    keyPrefix: rawKey.slice(0, 12),
    label: input.label,
    scopes: JSON.stringify(input.scopes),
    rateLimitRpm: env().NOMUS_RATE_LIMIT_RPM,
    expiresAt: input.expiresAt ?? null,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.insert(apiKeys).values(record).run();

  return {
    ok: true,
    id: record.id,
    key: rawKey,
    prefix: record.keyPrefix,
    label: record.label,
    scopes: input.scopes,
    rateLimitRpm: record.rateLimitRpm,
  };
}

/** Revoke a key belonging to orgId. Returns false when no such key exists in that org. */
export function revokeApiKey(orgId: string, keyId: string): boolean {
  const result = getDb().update(apiKeys)
    .set({ isActive: false })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
    .run();
  return result.changes > 0;
}
