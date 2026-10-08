// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/v1/radar/v2/bills.
 *
 * End-to-end audit: the default score range (0-100) was always applied, and a
 * bill that has not been scored yet (NULL) fails every comparison, so unscored
 * bills never appeared and the list total disagreed with "Tracked Bills".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations, trackedBills } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { radarV2Routes } from './radar-v2.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/radar/v2', radarV2Routes);
const KEY = 'nk_test_radar_v2_key_00000000000000';

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Radar Org', slug: `radar-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'radar', scopes: JSON.stringify(['read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
  db.insert(trackedBills).values({ id: randomUUID(), title: 'Scored bill', jurisdiction: 'US-CA', currentStage: 'committee_hearing', passageScore: 62, createdAt: now, updatedAt: now }).run();
  db.insert(trackedBills).values({ id: randomUUID(), title: 'Unscored bill', jurisdiction: 'US-CA', currentStage: 'introduced', passageScore: null, createdAt: now, updatedAt: now }).run();
});

const get = async (q: string) =>
  (await app.request(`/api/v1/radar/v2/bills${q}`, { headers: { Authorization: `Bearer ${KEY}` } })).json() as Promise<any>;

describe('GET /api/v1/radar/v2/bills', () => {
  it('lists unscored bills unless a score range is requested', async () => {
    const all = await get('?jurisdiction=US-CA');
    expect(all.total).toBe(2);
    expect(all.bills.map((b: any) => b.title).sort()).toEqual(['Scored bill', 'Unscored bill']);

    const scored = await get('?jurisdiction=US-CA&minScore=50');
    expect(scored.bills.map((b: any) => b.title)).toEqual(['Scored bill']);
  });

  it('filters by the engine lifecycle stage ids', async () => {
    const r = await get('?stage=committee_hearing');
    expect(r.bills.map((b: any) => b.title)).toEqual(['Scored bill']);
  });
});
