// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * The compliance score is cached for 30 s, but every surface that shows it
 * (Posture, dashboard, badge, GitHub Action, VS Code) must reflect a change
 * the moment it is made. For each input of the score this reads the score
 * (filling the cache), makes the change, and reads it again immediately: the
 * new value must be there with no wait.
 *
 * Found by the release gate: after a regulation upload and two new AI systems
 * the Posture page still showed the old rule and AI-system counts while
 * /compliance/score, read moments later, showed the new ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { apiKeys, organizations, githubAppInstallations } from '../../db/schema.js';
import { initSigningKeys } from '../../core/signing.js';
import type { Finding } from '@nomus/scanner';
import type { AppEnv } from '../app.js';
import { compliancePostureRoutes } from './compliance-posture.js';
import { adminRuleRoutes } from './admin-rules.js';
import { adminRoutes } from './admin.js';
import { sourceRoutes } from './sources.js';
import { aiBomRoutes } from './ai-bom.js';
import { benchmarkRoutes } from './benchmarks.js';
import { tenantRoutes } from './tenants.js';
import { persistScanFindings } from './github.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/compliance', compliancePostureRoutes);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/admin/rules', adminRuleRoutes);
app.route('/api/v1/sources', sourceRoutes);
app.route('/api/v1/ai-bom', aiBomRoutes);
app.route('/api/v1/benchmarks', benchmarkRoutes);
app.route('/api/v1/tenants', tenantRoutes);

const KEY = 'nk_test_freshness_key_0000000000';
let orgId = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const score = async () => (await call('GET', '/api/v1/compliance/score')).json;

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

async function newSource(jurisdiction = 'ZZ') {
  const res = await call('POST', '/api/v1/sources', {
    name: `Freshness Source ${uniq()}`, jurisdiction, url: 'https://example.com/reg',
  });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

async function newRule(sourceId: string) {
  const res = await call('POST', '/api/v1/admin/rules', {
    sourceId,
    ruleKey: `zz.freshness.rule_${uniq()}`,
    category: 'transparency',
    conditions: { action: `act_${uniq()}` },
    effect: 'deny',
    severity: 'high',
    humanSummary: 'Providers must disclose that content is AI generated.',
    legalReference: 'Test Act s.5',
    effectiveDate: '2025-06-01',
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { id: string };
}

async function newSystem(overrides: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/v1/ai-bom', {
    name: `System ${uniq()}`, systemType: 'model', riskClassification: 'unclassified', ...overrides,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { id: string };
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  const db = getDb();
  orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({
    id: orgId, name: 'Freshness Org', slug: `fresh-${orgId.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'freshness', scopes: JSON.stringify(['evaluate', 'read:policies', 'admin']), rateLimitRpm: 100000,
    isActive: true, createdAt: now,
  }).run();
});

describe('compliance score is never served stale after an input changes', () => {
  it('rule create: rulesActive and policyStateHash move at once', async () => {
    const sourceId = await newSource();
    const before = await score(); // fills the cache
    await newRule(sourceId);
    const after = await score();
    expect(after.rulesActive).toBe(before.rulesActive + 1);
    expect(after.policyStateHash).not.toBe(before.policyStateHash);
  });

  it('rule revoke and reactivate: rulesActive moves at once', async () => {
    const rule = await newRule(await newSource());
    const before = await score();
    expect((await call('POST', `/api/v1/admin/rules/${rule.id}/retire`, {})).status).toBe(200);
    const retired = await score();
    expect(retired.rulesActive).toBe(before.rulesActive - 1);
    expect((await call('POST', `/api/v1/admin/rules/${rule.id}/reactivate`, {})).status).toBe(200);
    expect((await score()).rulesActive).toBe(before.rulesActive);
  });

  it('rule edit: the new content hash is served at once', async () => {
    const rule = await newRule(await newSource());
    const before = await score();
    const res = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { humanSummary: 'Changed wording of the obligation.' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await score()).policyStateHash).not.toBe(before.policyStateHash);
  });

  it('admin approve of a pending rule: rulesActive moves at once', async () => {
    const rule = await newRule(await newSource());
    await call('POST', `/api/v1/admin/rules/${rule.id}/retire`, {});
    const before = await score();
    expect((await call('POST', `/api/v1/admin/rules/${rule.id}/approve`)).status).toBe(200);
    expect((await score()).rulesActive).toBe(before.rulesActive + 1);
  });

  it('admin reject of a pending rule: rulesActive moves at once', async () => {
    const rule = await newRule(await newSource());
    const before = await score();
    expect((await call('POST', `/api/v1/admin/rules/${rule.id}/reject`)).status).toBe(200);
    expect((await score()).rulesActive).toBe(before.rulesActive - 1);
  });

  it('AI-BOM system create: aiBomSystemCount and the unclassified factor move at once', async () => {
    const before = await score();
    await newSystem();
    await newSystem();
    const after = await score();
    expect(after.aiBomSystemCount).toBe(before.aiBomSystemCount + 2);
    expect(after.overallScore).toBe(before.overallScore - 4);
  });

  it('AI-BOM system update: the risk tier is served at once', async () => {
    const sys = await newSystem();
    const before = await score();
    expect((await call('PATCH', `/api/v1/ai-bom/${sys.id}`, { riskClassification: 'high' })).status).toBe(200);
    const after = await score();
    expect(after.highRiskSystems).toBe(before.highRiskSystems + 1);
    expect(after.overallScore).toBe(before.overallScore + 2); // no longer unclassified
  });

  it('AI-BOM system delete: aiBomSystemCount drops at once', async () => {
    const sys = await newSystem();
    const before = await score();
    expect((await call('DELETE', `/api/v1/ai-bom/${sys.id}`)).status).toBe(200);
    expect((await score()).aiBomSystemCount).toBe(before.aiBomSystemCount - 1);
  });

  it('benchmark run completed: benchmarkScore and the bonus are served at once', async () => {
    const before = await score();
    expect(before.benchmarkScore).toBeNull();
    const run = await call('POST', '/api/v1/benchmarks/run', { modelName: 'm', provider: 'p' });
    expect(run.status).toBe(201);
    const done = await call('PATCH', `/api/v1/benchmarks/runs/${run.json.id}/results`, { overallScore: 95 });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const after = await score();
    expect(after.benchmarkScore).toBe(95);
    expect(after.factorsPositive.some((f: any) => f.category === 'benchmarks')).toBe(true);
  });

  it('GitHub App findings: openFindings moves at once', async () => {
    getDb().insert(githubAppInstallations).values({
      id: randomUUID(), installationId: 424242, orgId, accountLogin: 'acme', accountType: 'Organization',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    const before = await score();
    const finding = {
      file: 'src/a.py', line: 3, sdk: 'openai', detectorSource: 'import-detector', evidence: 'import openai',
      rule: {
        ruleKey: 'eu_ai_act.art50.1.chatbot_disclosure', severity: 'high', effect: 'flag',
        humanSummary: 'Disclose AI interaction', legalReference: 'EU AI Act Art. 50',
      },
    } as unknown as Finding;
    await persistScanFindings(424242, 'acme/app', 7, 'abc123', [finding]);
    const after = await score();
    expect(after.openFindings).toBe(before.openFindings + 1);
    expect(after.factorsNegative.some((f: any) => f.category === 'scan_findings')).toBe(true);
  });

  it('org jurisdiction change: rulesApplicable is served at once', async () => {
    await newRule(await newSource('ZZ'));
    const before = await score();
    expect(before.rulesApplicable).toBe(before.rulesActive); // no jurisdiction filter yet
    const res = await call('PATCH', `/api/v1/tenants/${orgId}`, { jurisdictionAccess: ['ZZ'] });
    expect(res.status).toBe(200);
    const after = await score();
    expect(after.rulesApplicable).toBeGreaterThan(0);
    expect(after.rulesApplicable).toBeLessThan(before.rulesApplicable);
  });
});
