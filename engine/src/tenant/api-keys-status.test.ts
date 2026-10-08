// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * listApiKeys reports each key's effective status. An unrevoked key past its
 * expiry no longer authenticates, but the dashboards showed it as Active
 * (end-to-end audit).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { apiKeys, organizations } from '../db/schema.js';
import { listApiKeys } from './api-keys.js';

const orgId = randomUUID();

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Keys Org', slug: `keys-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  const key = (label: string, isActive: boolean, expiresAt: string | null) => db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: randomUUID(), keyPrefix: 'nk_live_xxxx', label, scopes: '["evaluate"]',
    rateLimitRpm: 600, isActive, expiresAt, createdAt: now,
  }).run();
  key('live', true, '2099-01-01T00:00:00+02:00');
  key('expired', true, '2020-01-01T00:00:00Z');
  key('revoked', false, null);
});

describe('listApiKeys', () => {
  it('reports active, expired and revoked keys', () => {
    const byLabel = Object.fromEntries(listApiKeys(orgId).map((k) => [k.label, k.status]));
    expect(byLabel).toEqual({ live: 'active', expired: 'expired', revoked: 'revoked' });
  });
});
