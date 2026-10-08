// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/v1/simulate against the real seeded rule corpus.
 *
 * Every scanner surface (CLI, GitHub Action, VS Code extension, MCP server)
 * turns detected capabilities into obligations through this endpoint. The
 * end-to-end audit found that a rule's region condition alone made it fire,
 * so a healthcare chatbot scanned for EU + US-FED "triggered" every EU AI Act
 * Annex III high-risk category (biometrics, migration, justice ...), FERPA
 * (education) and GLBA (finance): 241 findings, 38 of them critical. These
 * tests pin the corrected semantics: every declared condition must hold.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { seedRulesFromOntology } from '../../db/seed-rules.js';
import { seedGlbaRules } from '../../db/seed-glba-rules.js';
import { seedFerpaRules } from '../../db/seed-ferpa-rules.js';
import { seedSoc2Rules } from '../../db/seed-soc2-rules.js';
import { seedTrismRules } from '../../db/seed-trism-rules.js';
import { apiKeys, organizations } from '../../db/schema.js';
import { initSigningKeys } from '../../core/signing.js';
import { matchRuleToProfile, normalizeSector, effectiveDataTypes } from '../../core/applicability.js';
import type { AppEnv } from '../app.js';
import { simulateRoutes } from './simulate.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/simulate', simulateRoutes);

const KEY = 'nk_test_simulate_key_000000000000';

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  seedRulesFromOntology();
  const db = getDb();
  seedGlbaRules(db);
  seedFerpaRules(db);
  seedSoc2Rules(db);
  seedTrismRules(db);

  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({
    id: orgId, name: 'Simulate Test Org', slug: `sim-${orgId.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId,
    keyHash: createHash('sha256').update(KEY).digest('hex'),
    keyPrefix: KEY.slice(0, 12), label: 'simulate test',
    scopes: JSON.stringify(['evaluate']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

async function simulate(body: Record<string, unknown>) {
  const res = await app.request('/api/v1/simulate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    markets: Record<string, { triggered: number; rules: Array<{ ruleKey: string; matchedOn: string[] }> }>;
    totalRulesTriggered: number;
  }>;
}

const keysOf = (r: Awaited<ReturnType<typeof simulate>>, market: string) =>
  r.markets[market].rules.map((x) => x.ruleKey);

// The capabilities the scanner reports for a healthcare chatbot that sends PHI to an LLM.
const HEALTHCARE_CHATBOT = {
  capabilities: [
    'text_generation', 'contains_pii', 'handles_pii', 'pii_in_ai_call',
    'contains_phi', 'handles_phi', 'phi_in_ai_call', 'ai_user_interaction', 'generates_ai_content',
  ],
  dataTypes: [],
  targetMarkets: ['EU', 'US-FED'],
  sector: 'healthcare',
};

describe('POST /api/v1/simulate — applicability semantics', () => {
  it('a region match alone never triggers a rule', async () => {
    const r = await simulate(HEALTHCARE_CHATBOT);
    const eu = keysOf(r, 'EU');
    // Annex III categories need their own high-risk capability.
    for (const k of eu) expect(k).not.toMatch(/^eu_ai_act\.annex_iii\./);
    for (const rule of r.markets.EU.rules) {
      expect(rule.matchedOn.some((m) => m.startsWith('capability:'))).toBe(true);
    }
  });

  it('finds the obligations a healthcare chatbot really has', async () => {
    const r = await simulate(HEALTHCARE_CHATBOT);
    expect(keysOf(r, 'EU')).toContain('eu_ai_act.art50.1.chatbot_disclosure');
    // PHI implies health data even though the config declared no data types.
    expect(keysOf(r, 'US-FED')).toContain('hipaa.164_502.phi_in_ai_pipeline');
  });

  it('sector-scoped rules do not fire for another sector', async () => {
    const r = await simulate(HEALTHCARE_CHATBOT);
    const us = keysOf(r, 'US-FED');
    expect(us.some((k) => k.startsWith('ferpa.'))).toBe(false); // education
    expect(us.some((k) => k.startsWith('glba.'))).toBe(false);  // finance
  });

  it('sector-scoped rules fire for their sector, accepting the documented "fintech" alias', async () => {
    const r = await simulate({
      capabilities: ['text_generation', 'contains_pii', 'sends_to_third_party'],
      targetMarkets: ['US-FED'],
      sector: 'fintech',
    });
    expect(keysOf(r, 'US-FED')).toContain('glba.314_4.info_security_program');
  });

  it('a capability the corpus has no specific rule for triggers only the generic AI-inventory rules', async () => {
    const r = await simulate({ capabilities: ['translation'], targetMarkets: ['EU'] });
    for (const rule of r.markets.EU.rules) {
      expect(rule.matchedOn).toEqual(['capability: ai_operation']);
    }
  });
});

describe('core/applicability', () => {
  const profile = { capabilities: ['text_generation'], dataTypes: [], market: 'US-FED' };

  it('requires every condition', () => {
    expect(matchRuleToProfile({ action: 'text_generation', region: 'US-FED' }, '["all"]', profile))
      .toEqual(['capability: text_generation', 'region: US-FED']);
    expect(matchRuleToProfile({ action: 'logs_pii', region: 'US-FED' }, '["all"]', profile)).toBeNull();
    expect(matchRuleToProfile({ action: 'text_generation', sector: 'finance' }, '["all"]', profile)).toBeNull();
  });

  it('does not substring-match actions', () => {
    expect(matchRuleToProfile({ action: 'high_risk_biometric' }, null, { ...profile, capabilities: ['biometric'] })).toBeNull();
  });

  it('excludes rules scoped to other industries once a sector is known', () => {
    expect(matchRuleToProfile({ action: 'text_generation' }, '["finance"]', { ...profile, sector: 'healthcare' })).toBeNull();
    expect(matchRuleToProfile({ action: 'text_generation' }, '["finance"]', { ...profile, sector: 'fintech' })).not.toBeNull();
  });

  it('normalizes aliases and implied data types', () => {
    expect(normalizeSector('FinTech')).toBe('finance');
    expect(effectiveDataTypes(['phi_in_ai_call'], ['pii'])).toEqual(['personal_data', 'health']);
  });

  it('treats ai_operation as satisfied by any capability and empty conditions as general', () => {
    expect(matchRuleToProfile({ action: 'ai_operation' }, null, profile)).toEqual(['capability: ai_operation']);
    expect(matchRuleToProfile({}, null, profile)).toEqual(['general_applicability']);
  });
});
