// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/v1/ai-bom/generate from real scan findings.
 *
 * End-to-end audit: a healthcare chatbot whose findings included HIPAA
 * "deny" and EU AI Act Art. 50 obligations was inventoried as risk "minimal",
 * with an empty provider and no jurisdictions, because the SDK name was
 * treated as the system's capability.
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
import type { AppEnv } from '../app.js';
import { aiBomRoutes } from './ai-bom.js';
import { scanRoutes } from './scan.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/ai-bom', aiBomRoutes);
app.route('/api/v1/scan', scanRoutes);

const KEY = 'nk_test_ai_bom_generate_key_00000';

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  seedRulesFromOntology();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(organizations).values({
    id: orgId, name: 'BOM Org', slug: `bom-${orgId.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId,
    keyHash: createHash('sha256').update(KEY).digest('hex'),
    keyPrefix: KEY.slice(0, 12), label: 'bom test',
    scopes: JSON.stringify(['evaluate']), rateLimitRpm: 100000, isActive: true, createdAt: now,
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

describe('POST /api/v1/ai-bom/generate', () => {
  it('builds one system per repository and provider, classified from its obligations', async () => {
    const up = await call('POST', '/api/v1/scan/findings', {
      repo: 'acme/health-bot',
      findings: [
        { file: 'app/chatbot.py', line: 16, ruleKey: 'eu_ai_act.art50.1.chatbot_disclosure', severity: 'high', sdk: 'openai' },
        { file: 'app/chatbot.py', line: 11, ruleKey: 'hipaa.164_502.phi_in_ai_pipeline', severity: 'critical', sdk: 'openai' },
        { file: 'src/chat.ts', line: 19, ruleKey: 'gdpr.art5.pii_in_ai_pipeline', severity: 'high', sdk: '@anthropic-ai/sdk' },
        { file: 'app/triage.py', line: 7, ruleKey: 'gdpr.art5.pii_in_source', severity: 'medium', sdk: 'anthropic' },
      ],
    });
    expect(up.status).toBe(201);

    const gen = await call('POST', '/api/v1/ai-bom/generate');
    expect(gen.status).toBe(201);
    expect(gen.json).toMatchObject({ created: 2, updated: 0, totalGroups: 2 });

    const list = await call('GET', '/api/v1/ai-bom');
    const openai = list.json.systems.find((s: any) => s.name === 'OpenAI (acme/health-bot)');
    const anthropic = list.json.systems.find((s: any) => s.name === 'Anthropic (acme/health-bot)');
    expect(openai).toMatchObject({ provider: 'OpenAI', systemType: 'model', riskClassification: 'limited' });
    expect(openai.jurisdictions).toEqual(['EU', 'US-FED']);
    expect(openai.regulatoryTags).toEqual(['eu_ai_act', 'hipaa']);
    // @anthropic-ai/sdk (TS) and anthropic (Python) are one provider.
    expect(anthropic.capabilities).toEqual(['@anthropic-ai/sdk', 'anthropic']);
    expect(anthropic.riskClassification).toBe('minimal');
  });

  it('regenerating refreshes systems and keeps a risk tier a person set', async () => {
    const list = await call('GET', '/api/v1/ai-bom');
    const anthropic = list.json.systems.find((s: any) => s.name === 'Anthropic (acme/health-bot)');
    await call('PATCH', `/api/v1/ai-bom/${anthropic.id}`, { riskClassification: 'high' });

    await call('POST', '/api/v1/scan/findings', {
      repo: 'acme/health-bot',
      findings: [{ file: 'src/hr.ts', line: 3, ruleKey: 'eu_ai_act.annex_iii.4.employment', severity: 'high', sdk: 'openai' }],
    });
    const gen = await call('POST', '/api/v1/ai-bom/generate');
    expect(gen.json).toMatchObject({ created: 0, updated: 2 });

    const after = (await call('GET', '/api/v1/ai-bom')).json.systems;
    const openai = after.find((s: any) => s.name === 'OpenAI (acme/health-bot)');
    expect(openai.riskClassification).toBe('high');
    expect(openai.euAiActCategory).toBe('employment_workers');
    expect(after.find((s: any) => s.id === anthropic.id).riskClassification).toBe('high');
  });
});
