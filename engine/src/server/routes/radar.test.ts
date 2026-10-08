// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * PATCH /api/v1/radar/:id as Radar Manage sends it.
 *
 * End-to-end audit: a changed jurisdiction was dropped (the schema had no
 * such field) while the save reported success, and Source URL / Expected
 * Date could never be cleared.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations, regulatorySignals } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { radarRoutes } from './radar.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/radar', radarRoutes);
const KEY = 'nk_test_radar_admin_key_0000000000';
const signalId = randomUUID();

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Radar Admin', slug: `radar-admin-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'admin', scopes: JSON.stringify(['read:policies', 'admin']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
  db.insert(regulatorySignals).values({
    id: signalId, title: 'Draft AI bill', jurisdiction: 'EU', stage: 'draft', likelihoodPercent: 40, summary: 'A draft AI bill.',
    sourceUrl: 'https://example.gov/bill', expectedEffectiveDate: '2027-01-01', detectedAt: now, createdAt: now, updatedAt: now,
  }).run();
});

describe('PATCH /api/v1/radar/:id', () => {
  it('updates the jurisdiction and clears optional fields sent as null', async () => {
    const res = await app.request(`/api/v1/radar/${signalId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Draft AI bill', jurisdiction: 'US-CA', sourceUrl: null, expectedEffectiveDate: null }),
    });
    expect(res.status).toBe(200);
    const row = getDb().select().from(regulatorySignals).where(eq(regulatorySignals.id, signalId)).get()!;
    expect(row.jurisdiction).toBe('US-CA');
    expect(row.sourceUrl).toBeNull();
    expect(row.expectedEffectiveDate).toBeNull();
  });
});
