// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/v1/evaluate against the seeded rule corpus.
 *
 * End-to-end audit: rules carry a region condition, so a request that named
 * the jurisdiction but did not repeat it as context.region matched nothing and
 * was signed as "compliant" — e.g. PHI sent to an AI model under US-FED, or a
 * chatbot in the EU. The jurisdiction now supplies the region.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { seedRulesFromOntology } from '../../db/seed-rules.js';
import { apiKeys, organizations, policyRules, regulatorySources } from '../../db/schema.js';
import { initSigningKeys } from '../../core/signing.js';
import type { AppEnv } from '../app.js';
import { evaluateRoutes } from './evaluate.js';
import { auditRoutes } from './audit.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/evaluate', evaluateRoutes);
app.route('/api/v1/attestations', auditRoutes);

const KEY = 'nk_test_evaluate_region_key_00000';

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  seedRulesFromOntology();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(organizations).values({
    id: orgId, name: 'Eval Org', slug: `eval-${orgId.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId,
    keyHash: createHash('sha256').update(KEY).digest('hex'),
    keyPrefix: KEY.slice(0, 12), label: 'eval test',
    scopes: JSON.stringify(['evaluate', 'read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

const matched = (j: any) => j.rulesEvaluated.filter((r: any) => r.matched).map((r: any) => r.ruleKey);

describe('POST /api/v1/evaluate — region comes from the jurisdiction', () => {
  it('PHI into an AI call under US-FED is non-compliant without repeating the region', async () => {
    const r = await call('POST', '/api/v1/evaluate', {
      action: 'phi_in_ai_call', jurisdiction: 'US-FED', context: { data_type: 'health' },
    });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe('non_compliant');
    expect(matched(r.json)).toContain('hipaa.164_502.phi_in_ai_pipeline');
  });

  it('accepts the phi data-type alias', async () => {
    const r = await call('POST', '/api/v1/evaluate', {
      action: 'phi_in_ai_call', jurisdiction: 'US-FED', context: { data_type: 'phi' },
    });
    expect(r.json.result).toBe('non_compliant');
  });

  it('an EU chatbot requires disclosure, and the signed context records the region', async () => {
    const r = await call('POST', '/api/v1/evaluate', {
      action: 'ai_user_interaction', jurisdiction: 'EU', context: { sector: 'retail' },
    });
    expect(r.json.result).toBe('requires_review');
    expect(matched(r.json)).toContain('eu_ai_act.art50.1.chatbot_disclosure');

    const att = await call('GET', `/api/v1/attestations/${r.json.id}`);
    expect(att.json.actionContext).toMatchObject({ action: 'ai_user_interaction', region: 'EU', sector: 'retail' });
    const verify = await call('GET', `/api/v1/attestations/${r.json.id}/verify`);
    expect(verify.json.signatureValid).toBe(true);
  });

  it('an explicit context.region is kept as given', async () => {
    const r = await call('POST', '/api/v1/evaluate', {
      action: 'ai_user_interaction', jurisdiction: 'EU', context: { region: 'US-CA' },
    });
    expect(r.json.result).toBe('compliant');
  });
});

describe('POST /api/v1/evaluate — pipeline-extracted rules apply', () => {
  it('a rule with action ai_operation and descriptive who/condition keys matches any AI action in its jurisdiction', async () => {
    const db = getDb();
    const source = db.select().from(regulatorySources).limit(1).get()!;
    const now = new Date().toISOString();
    db.insert(policyRules).values({
      id: randomUUID(), sourceId: source.id, ruleKey: `zz_test.sec_10.no_sharing_${Date.now()}`, version: 1,
      jurisdiction: 'ZZ', category: 'privacy',
      conditions: JSON.stringify({ action: 'ai_operation', region: 'ZZ', who: 'employers', condition: 'applicants in ZZ' }),
      effect: 'deny', severity: 'high', humanSummary: 'Employers may not share applicant videos.',
      legalReference: 'Sec. 10.', effectiveDate: '2020-01-01', signature: 'unsigned-test', createdAt: now, updatedAt: now,
    }).run();
    const r = await call('POST', '/api/v1/evaluate', { action: 'high_risk_employment', jurisdiction: 'ZZ', context: { sector: 'hr' } });
    expect(r.json.result).toBe('non_compliant');
  });
});
