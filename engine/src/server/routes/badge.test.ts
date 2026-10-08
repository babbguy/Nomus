// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Public badge.
 *
 * End-to-end audit: the badge computed its own "score" from the share of
 * compliant attestations (27) while the organization's Posture page showed 0;
 * the embed script linked to /verify/<org slug>, a route that takes an
 * attestation id ("Attestation not found"); the saved badge style was never
 * applied to the SVG.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, badgeConfigs, organizations, scanFindings } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { badgeRoutes } from './badge.js';
import { getComplianceScore } from './compliance-posture.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/badge', badgeRoutes);
const KEY = 'nk_test_badge_key_0000000000000000';
let orgId = '';
const slug = `badge-${Date.now().toString(36)}`;

beforeAll(() => {
  runMigrations();
  const db = getDb();
  orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Badge Org', slug, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'badge', scopes: JSON.stringify(['read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
  db.insert(badgeConfigs).values({ id: randomUUID(), orgId, isPublic: true, style: 'pill', createdAt: now, updatedAt: now } as typeof badgeConfigs.$inferInsert).run();
  // Two open critical findings: the org score is 90.
  for (const k of ['a', 'b']) {
    db.insert(scanFindings).values({
      id: randomUUID(), orgId, repo: 'acme/app', prNumber: null, commitSha: 'x', filePath: `${k}.ts`, lineNumber: 1,
      ruleId: null, ruleKey: `rule.${k}`, severity: 'critical', effect: 'deny', capabilityDetected: 'openai',
      humanSummary: '', suggestion: null, detectorSource: null, legalReference: null, status: 'open', scannedAt: now,
    }).run();
  }
});

describe('badge', () => {
  it('shows the organization compliance score', async () => {
    const expected = Math.round(getComplianceScore(orgId).result.overallScore);
    expect(expected).toBe(90);
    const json = await (await app.request(`/api/v1/badge/${slug}`)).json() as { score: number };
    expect(json.score).toBe(expected);
    const svg = await (await app.request(`/api/v1/badge/${slug}/svg`)).text();
    expect(svg).toContain(`Score: ${expected}`);
  });

  it('applies the configured style', async () => {
    const svg = await (await app.request(`/api/v1/badge/${slug}/svg`)).text();
    expect(svg).toContain('rx="14"');
  });

  it('links the embedded badge to the public transparency page', async () => {
    const js = await (await app.request(`http://localhost/api/v1/badge/${slug}/embed.js`)).text();
    expect(js).toMatch(/\/transparency"/);
    expect(js).not.toContain('/verify/');
  });
});
