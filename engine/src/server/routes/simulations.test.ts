// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Predictive simulations list.
 *
 * End-to-end audit: GET /simulations served impactDetails and
 * remediationRoadmap as JSON strings, so expanding a simulation on the
 * Simulations page crashed (.map on '[]'); per-system costs were computed
 * with float division.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { aiBomSystems, apiKeys, organizations, regulatorySignals } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { simulationRoutes } from './simulations.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/simulations', simulationRoutes);
const KEY = 'nk_test_simulations_key_0000000000';
let signalId = '';
const EMPTY_KEY = 'nk_test_simulations_empty_key_000000';

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Sim Org', slug: `sim-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'sim', scopes: JSON.stringify(['read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
  db.insert(aiBomSystems).values({
    id: randomUUID(), orgId, name: 'OpenAI (acme/app)', description: '', systemType: 'model', provider: 'OpenAI', modelName: '', version: '',
    purpose: 'chat', capabilities: '[]', dataFlows: '[]', jurisdictions: JSON.stringify(['EU']), riskClassification: 'limited',
    regulatoryTags: '[]', deploymentType: 'development', detectedFrom: 'scanner', scanFindingIds: '[]', isActive: true, metadata: '{}', createdAt: now, updatedAt: now,
  }).run();
  const emptyOrgId = randomUUID();
  db.insert(organizations).values({ id: emptyOrgId, name: 'Empty Sim Org', slug: `sim-${emptyOrgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId: emptyOrgId, keyHash: createHash('sha256').update(EMPTY_KEY).digest('hex'), keyPrefix: EMPTY_KEY.slice(0, 12),
    label: 'sim empty', scopes: JSON.stringify(['read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
  signalId = randomUUID();
  db.insert(regulatorySignals).values({
    id: signalId, title: 'EU AI Act amendment', jurisdiction: 'EU', stage: 'draft', likelihoodPercent: 70,
    summary: 'Draft amendment', detectedAt: now, createdAt: now, updatedAt: now,
  }).run();
});

describe('GET /api/v1/simulations', () => {
  it('lists simulations with parsed impact details and integer-exact costs', async () => {
    const run = await app.request('/api/v1/simulations/run', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalId }),
    });
    expect(run.status).toBe(201);

    const body = await (await app.request('/api/v1/simulations', { headers: { Authorization: `Bearer ${KEY}` } })).json() as any;
    const sim = body.simulations[0];
    expect(Array.isArray(sim.impactDetails)).toBe(true);
    expect(Array.isArray(sim.remediationRoadmap)).toBe(true);
    expect(sim.impactDetails[0]).toMatchObject({ impact: 'medium', estimatedCost: '1500.00000000' });
    expect(typeof sim.impactDetails[0].reason).toBe('string');
    expect(sim.estimatedRemediationCost).toBe('1500.00000000');
  });
});

describe('POST /api/v1/simulations/run', () => {
  const run = (key: string) => app.request('/api/v1/simulations/run', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ signalId }),
  });

  it('an organization with no systems gets the same response shape, including overallRiskLevel', async () => {
    const empty = await run(EMPTY_KEY);
    expect(empty.status).toBe(201);
    const emptyBody = await empty.json() as any;
    expect(emptyBody).toMatchObject({
      status: 'completed', systemsAnalyzed: 0, systemsImpacted: 0,
      overallRiskLevel: 'none', estimatedRemediationCost: '0.00000000',
    });

    const withSystems = await (await run(KEY)).json() as any;
    expect(Object.keys(emptyBody).sort()).toEqual(Object.keys(withSystems).sort());

    // The response agrees with what is stored and served by GET /:id.
    const stored = await (await app.request(`/api/v1/simulations/${emptyBody.id}`, { headers: { Authorization: `Bearer ${EMPTY_KEY}` } })).json() as any;
    expect(stored.overallRiskLevel).toBe(emptyBody.overallRiskLevel);
    expect(stored.estimatedRemediationCost).toBe(emptyBody.estimatedRemediationCost);
  });
});
