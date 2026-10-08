// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Ledger publishing toggle.
 *
 * End-to-end audit: ledger.ts called require() inside the ES-module engine,
 * so POST /api/v1/admin/forge/ledger/publish answered 500 and
 * isPublishingEnabled() always returned false (its catch swallowed the
 * ReferenceError): publishing could never be switched on from the dashboard.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { apiKeys, organizations } from '../db/schema.js';
import type { AppEnv } from '../server/app.js';
import { forgeAdminRoutes, ledgerPublicRoutes } from '../server/routes/forge.js';
import { isPublishingEnabled } from './ledger.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/admin/forge', forgeAdminRoutes);
app.route('/api/v1/ledger', ledgerPublicRoutes);
const KEY = 'nk_test_ledger_admin_key_000000000';

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Ledger Org', slug: `ledger-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'admin', scopes: JSON.stringify(['admin']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

describe('ledger publishing', () => {
  it('can be switched on and off by an admin', async () => {
    const on = await app.request('/api/v1/admin/forge/ledger/publish', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(isPublishingEnabled()).toBe(true);

    const off = await app.request('/api/v1/admin/forge/ledger/publish', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(isPublishingEnabled()).toBe(false);
  });

  it('the public ledger bounds its page size', async () => {
    const res = await app.request('/api/v1/ledger?limit=-1&offset=abc');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; ledger: { totalDocuments: number } };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.ledger.totalDocuments).toBe(0);
  });
});
