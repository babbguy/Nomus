// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * One corpus state hash everywhere.
 *
 * End-to-end audit: the admin dashboard's "Integrity Status" showed the
 * stored hash, computed over "ruleKey:version:signature", while
 * GET /api/v1/policies/hash, the bundle, attestations and the MCP provenance
 * stamp hash the sorted signatures — two different values for one corpus.
 * The stored value was also only refreshed every 6 h, so the dashboard showed
 * a stale hash and rule count after every rule change.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';

import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedDatabase } from '../db/seed.js';
import { seedRulesFromOntology } from '../db/seed-rules.js';
import { apiKeys, organizations } from '../db/schema.js';
import { initSigningKeys } from './signing.js';
import { computeAndStoreStateHash } from './state-hasher.js';
import type { AppEnv } from '../server/app.js';
import { policyRoutes } from '../server/routes/policies.js';
import { dashboardRoutes } from '../server/routes/dashboard.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/policies', policyRoutes);
app.route('/api/v1/dashboard', dashboardRoutes);
const KEY = 'nk_test_state_hash_key_00000000000';

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  seedRulesFromOntology();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({
    id: orgId, name: 'Hash Org', slug: `hash-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'hash test', scopes: JSON.stringify(['read:policies', 'admin']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

const get = async (path: string) =>
  (await app.request(path, { headers: { Authorization: `Bearer ${KEY}` } })).json() as Promise<any>;

describe('corpus state hash', () => {
  it('the stored hash equals GET /api/v1/policies/hash and the full bundle hash', async () => {
    const stored = computeAndStoreStateHash();
    const live = await get('/api/v1/policies/hash');
    const bundle = await get('/api/v1/policies/bundle');
    expect(stored.hash).toBe(live.stateHash);
    expect(stored.ruleCount).toBe(live.ruleCount);
    expect(bundle.stateHash).toBe(live.stateHash);
  });

  it('dashboard stats serve the current hash', async () => {
    const stats = await get('/api/v1/dashboard/stats');
    const live = await get('/api/v1/policies/hash');
    expect(stats.currentStateHash.hash).toBe(live.stateHash);
    expect(stats.currentStateHash.ruleCount).toBe(stats.rules);
    expect(stats.totalSources).toBeGreaterThanOrEqual(stats.sources);
  });
});

describe('GET /api/v1/policies totals (Policies page)', () => {
  it('reports the total beside a capped page', async () => {
    const page = await get('/api/v1/policies?limit=5');
    const hash = await get('/api/v1/policies/hash');
    expect(page.count).toBe(5);
    expect(page.total).toBe(hash.ruleCount);
  });

  it('labels each industry with the number of rules its filter returns', async () => {
    const { industries } = await get('/api/v1/policies/industries');
    for (const ind of industries.filter((i: any) => i.name !== 'all')) {
      const filtered = await get(`/api/v1/policies?industry=${ind.name}&limit=1000`);
      expect(ind.matchingRuleCount, ind.name).toBe(filtered.total);
    }
  });
});
