import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { apiKeys, organizations, users } from '../db/schema.js';
import { env } from '../config/env.js';

export interface TenantContext {
  orgId: string;
  apiKeyId: string;
  scopes: string[];
  rateLimitRpm: number;
  jurisdictionAccess: string[];
  maxSseConnections: number;
  /**
   * Set for a user-bound key (VS Code device sign-in): the key acts as this
   * user. Null for org keys.
   */
  userId: string | null;
  /** A user-bound key whose user still holds a temporary password. */
  passwordChangeRequired: boolean;
}

/**
 * Resolve an API key to a full tenant context.
 * Returns null if the key is invalid, expired, or inactive.
 */
export function resolveApiKey(rawKey: string): TenantContext | null {
  if (!rawKey) return null;
  const db = getDb();
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const row = db
    .select({
      keyId: apiKeys.id,
      keyScopes: apiKeys.scopes,
      keyRateLimitRpm: apiKeys.rateLimitRpm,
      keyIsActive: apiKeys.isActive,
      keyExpiresAt: apiKeys.expiresAt,
      keyUserId: apiKeys.userId,
      orgId: organizations.id,
      orgIsActive: organizations.isActive,
      orgJurisdictionAccess: organizations.jurisdictionAccess,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(apiKeys.orgId, organizations.id))
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .get();

  if (!row) return null;
  if (!row.orgIsActive) return null;

  // Check expiration
  if (row.keyExpiresAt && new Date(row.keyExpiresAt) < new Date()) {
    return null;
  }

  // A user-bound key is only as good as its user: an inactive user, or one
  // who has since moved to another org, makes the key invalid (401).
  let passwordChangeRequired = false;
  if (row.keyUserId) {
    const user = db.select({ isActive: users.isActive, orgId: users.orgId, mustChangePassword: users.mustChangePassword })
      .from(users).where(eq(users.id, row.keyUserId)).get();
    if (!user || !user.isActive || user.orgId !== row.orgId) return null;
    passwordChangeRequired = user.mustChangePassword;
  }

  // Update last_used_at (fire-and-forget, non-blocking)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, row.keyId))
    .run();

  return {
    orgId: row.orgId,
    apiKeyId: row.keyId,
    scopes: JSON.parse(row.keyScopes) as string[],
    rateLimitRpm: row.keyRateLimitRpm,
    jurisdictionAccess: JSON.parse(row.orgJurisdictionAccess) as string[],
    maxSseConnections: env().NOMUS_MAX_SSE_CONNECTIONS_PER_ORG,
    userId: row.keyUserId ?? null,
    passwordChangeRequired,
  };
}
