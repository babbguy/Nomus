// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/v1/scout/items status filter.
 *
 * End-to-end audit: the status filter ran after LIMIT, on the newest rows of
 * every status, so the review queue listed 9 of 879 pending items.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations, scoutFeeds, scoutItems } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { scoutRoutes } from './scout.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/scout', scoutRoutes);
const KEY = 'nk_test_scout_items_key_0000000000';

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString();
  db.insert(organizations).values({
    id: orgId, name: 'Scout Org', slug: `scout-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: iso(0), updatedAt: iso(0),
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'scout', scopes: JSON.stringify(['admin']), rateLimitRpm: 100000, isActive: true, createdAt: iso(0),
  }).run();
  const feedId = randomUUID();
  db.insert(scoutFeeds).values({ id: feedId, name: 'f', url: 'https://example.gov/f', feedType: 'rss', createdAt: iso(0), updatedAt: iso(0) }).run();
  // 5 older pending items, then 120 newer rejected ones.
  for (let i = 0; i < 5; i++) {
    db.insert(scoutItems).values({ id: randomUUID(), feedId, title: `pending ${i}`, url: `https://example.gov/p${i}`, status: 'pending', discoveredAt: iso(i) }).run();
  }
  for (let i = 0; i < 120; i++) {
    db.insert(scoutItems).values({ id: randomUUID(), feedId, title: `rejected ${i}`, url: `https://example.gov/r${i}`, status: 'rejected', discoveredAt: iso(1000 + i) }).run();
  }
});

describe('GET /api/v1/scout/items', () => {
  it('filters by status before applying the limit, and reports the total', async () => {
    const res = await app.request('/api/v1/scout/items?status=pending&limit=100', { headers: { Authorization: `Bearer ${KEY}` } });
    const body = await res.json() as { count: number; total: number; items: Array<{ status: string }> };
    expect(body.count).toBe(5);
    expect(body.total).toBe(5);
    expect(body.items.every((i) => i.status === 'pending')).toBe(true);

    const rejected = await (await app.request('/api/v1/scout/items?status=rejected&limit=100', { headers: { Authorization: `Bearer ${KEY}` } })).json() as { count: number; total: number };
    expect(rejected.count).toBe(100);
    expect(rejected.total).toBe(120);
  });
});

describe('DELETE /api/v1/scout/feeds/:id', () => {
  it('deletes a feed and its unpromoted items, but keeps a feed that produced signals', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const plain = randomUUID();
    const productive = randomUUID();
    for (const id of [plain, productive]) {
      db.insert(scoutFeeds).values({ id, name: `feed ${id.slice(0, 4)}`, url: `https://example.gov/${id}`, feedType: 'rss', createdAt: now, updatedAt: now }).run();
    }
    db.insert(scoutItems).values({ id: randomUUID(), feedId: plain, title: 'x', url: 'https://example.gov/x1', status: 'rejected', discoveredAt: now }).run();
    db.insert(scoutItems).values({ id: randomUUID(), feedId: productive, title: 'y', url: 'https://example.gov/y1', status: 'accepted', discoveredAt: now }).run();

    const del = (id: string) => app.request(`/api/v1/scout/feeds/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` } });
    expect((await del(plain)).status).toBe(200);
    expect(db.select().from(scoutFeeds).all().some((f) => f.id === plain)).toBe(false);
    expect((await del(productive)).status).toBe(409);
  });
});
