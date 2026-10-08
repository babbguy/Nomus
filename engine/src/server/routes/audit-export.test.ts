// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit Log API.
 *
 * End-to-end audit: the Audit Log cards counted types inside the visible page
 * (at most 200 merged entries), the CSV export silently stopped at 1000 rows,
 * and CSV cells were not protected against spreadsheet formula injection
 * (file paths and summaries come from scanner uploads).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations, scanFindings } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { auditExportRoutes } from './audit-export.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/audit-export', auditExportRoutes);
const KEY = 'nk_test_audit_export_key_000000000';

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = Date.now();
  db.insert(organizations).values({ id: orgId, name: 'Audit Org', slug: `audit-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'audit', scopes: JSON.stringify(['read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: new Date(now).toISOString(),
  }).run();
  for (let i = 0; i < 3; i++) {
    db.insert(scanFindings).values({
      id: randomUUID(), orgId, repo: 'acme/app', prNumber: null, commitSha: 'x',
      filePath: i === 0 ? '=HYPERLINK("http://evil.example","open")' : `src/f${i}.ts`, lineNumber: 1,
      ruleId: null, ruleKey: i === 0 ? '=2+5' : `rule.${i}`, severity: 'high', effect: 'flag', capabilityDetected: 'openai',
      humanSummary: '', suggestion: null, detectorSource: null, legalReference: null, status: 'open',
      scannedAt: new Date(now - i * 1000).toISOString(),
    }).run();
  }
});

const get = (path: string) => app.request(path, { headers: { Authorization: `Bearer ${KEY}` } });

describe('audit export', () => {
  it('reports per-type totals beyond the returned page', async () => {
    const body = await (await get('/api/v1/audit-export?limit=1')).json() as any;
    expect(body.entries).toHaveLength(1);
    expect(body.totals).toEqual({ attestation: 0, scan: 3, score: 0 });
  });

  it('flags a truncated CSV export and neutralises formula cells', async () => {
    const cut = await get('/api/v1/audit-export/csv?limit=2');
    expect(cut.headers.get('X-Nomus-Truncated')).toBe('2');

    const full = await get('/api/v1/audit-export/csv');
    expect(full.headers.get('X-Nomus-Truncated')).toBeNull();
    const csv = await full.text();
    expect(csv.split('\n')).toHaveLength(4);
    expect(csv).not.toMatch(/,=2+5/);
    expect(csv).toContain(`,"'=2+5 in `);
  });
});
