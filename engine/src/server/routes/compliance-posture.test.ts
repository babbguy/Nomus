// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/v1/compliance/score with uploaded scan findings.
 *
 * End-to-end audit: per-jurisdiction and per-category scores joined findings
 * to rules on rule_id, which uploads never set, so every finding landed in
 * "unknown"/"uncategorized" and EU, US-FED, ... all showed 100 next to an
 * overall score of 0. The Posture page also read factor and AI-system fields
 * the API does not serve (pinned here as the contract it renders).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { seedRulesFromOntology } from '../../db/seed-rules.js';
import { apiKeys, organizations } from '../../db/schema.js';
import { initSigningKeys } from '../../core/signing.js';
import { computeCurrentStateHash } from '../../core/state-hasher.js';
import type { AppEnv } from '../app.js';
import { compliancePostureRoutes } from './compliance-posture.js';
import { scanRoutes } from './scan.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/compliance', compliancePostureRoutes);
app.route('/api/v1/scan', scanRoutes);
const KEY = 'nk_test_posture_key_00000000000000';

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  seedRulesFromOntology();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({
    id: orgId, name: 'Posture Org', slug: `posture-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'posture', scopes: JSON.stringify(['evaluate', 'read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json() as Promise<any>;
};

describe('GET /api/v1/compliance/score', () => {
  it('attributes uploaded findings to their rule\'s jurisdiction and category', async () => {
    await call('POST', '/api/v1/scan/findings', {
      repo: 'acme/posture',
      findings: [
        { file: 'a.py', line: 1, ruleKey: 'eu_ai_act.art50.1.chatbot_disclosure', severity: 'high' },
        { file: 'b.py', line: 1, ruleKey: 'hipaa.164_502.phi_in_ai_pipeline', severity: 'critical' },
      ],
    });
    const score = await call('GET', '/api/v1/compliance/score');

    expect(score.scoresByJurisdiction.unknown).toBeUndefined();
    expect(score.scoresByJurisdiction.EU).toBe(97);
    expect(score.scoresByJurisdiction['US-FED']).toBe(95);
    expect(score.scoresByCategory.uncategorized).toBeUndefined();
    expect(score.scoresByCategory.transparency).toBeLessThan(100);
  });

  it('serves the fields the Posture page renders', async () => {
    const score = await call('GET', '/api/v1/compliance/score');
    expect(typeof score.aiBomSystemCount).toBe('number');
    expect(typeof score.computedAt).toBe('string');
    expect(score.factorsNegative.length).toBeGreaterThan(0);
    for (const f of [...score.factorsNegative, ...score.factorsPositive]) {
      expect(typeof f.description).toBe('string');
      expect(typeof f.impact).toBe('number');
    }
    expect(score.policyStateHash).toBe(computeCurrentStateHash().hash);
  });
});
