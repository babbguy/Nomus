/**
 * Admin-managed regulations: custom/customized sources, restore-defaults,
 * the source <-> rule deactivation cascade, and rule create/edit/retire.
 *
 * Real DB, real signing, real routes (mounted without the global middleware
 * stack, like the other route tests). What is verified end to end: edited rules
 * pass the integrity check, retired rules disappear from every policy surface,
 * and the cascade restores exactly the rules it retired.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import {
  apiKeys, organizations, policyEvents, policyRules, regulatorySources,
} from '../../db/schema.js';
import { initSigningKeys } from '../../core/signing.js';
import { verifyRuleSignature } from '../../core/rule-signing.js';
import { verifyIntegrity } from '../../audit/integrity.js';
import { registerClient, removeClient } from '../../sse/manager.js';
import { REGULATORY_SOURCES } from '../../hunter/sources/registry.js';
import type { AppEnv } from '../app.js';
import { sourceRoutes } from './sources.js';
import { adminRuleRoutes } from './admin-rules.js';
import { policyRoutes } from './policies.js';
import { evaluateRoutes } from './evaluate.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/sources', sourceRoutes);
app.route('/api/v1/admin/rules', adminRuleRoutes);
app.route('/api/v1/policies', policyRoutes);
app.route('/api/v1/evaluate', evaluateRoutes);

const ADMIN_KEY = 'nk_test_admin_regulation_key';
const READER_KEY = 'nk_test_reader_regulation_key';

function insertKey(orgId: string, raw: string, scopes: string[]) {
  getDb().insert(apiKeys).values({
    id: randomUUID(),
    orgId,
    keyHash: createHash('sha256').update(raw).digest('hex'),
    keyPrefix: raw.slice(0, 12),
    label: 'test key',
    scopes: JSON.stringify(scopes),
    rateLimitRpm: 100000,
    isActive: true,
    createdAt: new Date().toISOString(),
  }).run();
}

async function call(method: string, path: string, body?: unknown, key: string | null = ADMIN_KEY) {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, json };
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

async function newSource(overrides: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/v1/sources', {
    name: `Test Source ${uniq()}`,
    jurisdiction: 'ZZ',
    url: 'https://example.com/regulation',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json as { id: string; jurisdiction: string; name: string };
}

function ruleBody(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceId,
    ruleKey: `zz.test.rule_${uniq()}`,
    category: 'transparency',
    conditions: { action: `act_${uniq()}` },
    effect: 'deny',
    severity: 'high',
    humanSummary: 'Providers must disclose that content is AI generated.',
    legalReference: 'Test Act s.5',
    effectiveDate: '2025-06-01',
    ...overrides,
  };
}

async function newRule(sourceId: string, overrides: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/v1/admin/rules', ruleBody(sourceId, overrides));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as Record<string, any>;
}

const dbRule = (id: string) => getDb().select().from(policyRules).where(eq(policyRules.id, id)).get()!;
const dbSource = (id: string) => getDb().select().from(regulatorySources).where(eq(regulatorySources.id, id)).get()!;
const activeKeys = async (jurisdiction: string) =>
  ((await call('GET', `/api/v1/policies?jurisdiction=${jurisdiction}`)).json.policies as Array<{ ruleKey: string }>).map((p) => p.ruleKey);

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  const orgId = getDb().select().from(organizations).get()!.id;
  insertKey(orgId, ADMIN_KEY, ['read:policies', 'stream', 'evaluate', 'admin']);
  insertKey(orgId, READER_KEY, ['read:policies', 'evaluate']);
});

// --- Sources -----------------------------------------------------------------

describe('custom sources', () => {
  it('creates a custom source that survives a restart sync and stays active', async () => {
    const created = await call('POST', '/api/v1/sources', {
      name: 'Acme Internal AI Policy',
      jurisdiction: ' us-ma ',
      url: 'https://example.com/acme',
      category: 'internal_policy',
      tier: 3,
      needsHeadless: true,
      scrapeFrequencyHours: 72,
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      origin: 'custom',
      registryKey: null,
      jurisdiction: 'US-MA',
      category: 'internal_policy',
      tier: 3,
      needsHeadless: true,
      scrapeFrequencyHours: 72,
      isActive: true,
    });

    await seedDatabase();
    await seedDatabase();
    expect(dbSource(created.json.id)).toMatchObject({ origin: 'custom', isActive: true, tier: 3 });
  });

  it('accepts a brand-new jurisdiction code and rejects malformed ones', async () => {
    expect((await call('POST', '/api/v1/sources', { name: `S ${uniq()}`, jurisdiction: 'XK', url: 'https://example.com/x' })).status).toBe(201);
    for (const jurisdiction of ['', 'has space', 'a'.repeat(17), 'bad_code', 'drop;table']) {
      const res = await call('POST', '/api/v1/sources', { name: `S ${uniq()}`, jurisdiction, url: 'https://example.com/x' });
      expect(res.status, jurisdiction).toBe(400);
    }
  });

  it('rejects SSRF urls on create and update, and duplicate names', async () => {
    const bad = await call('POST', '/api/v1/sources', { name: `S ${uniq()}`, jurisdiction: 'ZZ', url: 'http://169.254.169.254/latest' });
    expect(bad.status).toBe(400);

    const s = await newSource({ name: 'Dup Name Source' });
    const dup = await call('POST', '/api/v1/sources', { name: 'dup name source', jurisdiction: 'ZZ', url: 'https://example.com/y' });
    expect(dup.status).toBe(409);

    const patch = await call('PATCH', `/api/v1/sources/${s.id}`, { url: 'http://localhost:8080/internal' });
    expect(patch.status).toBe(400);
    expect(dbSource(s.id).url).toBe('https://example.com/regulation');
  });

  it('edits every editable field of a custom source without changing its origin', async () => {
    const s = await newSource();
    const res = await call('PATCH', `/api/v1/sources/${s.id}`, {
      jurisdiction: 'xy',
      category: 'privacy',
      tier: 4,
      needsHeadless: true,
      name: `${s.name} renamed`,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: s.id, jurisdiction: 'XY', category: 'privacy', tier: 4, needsHeadless: true, origin: 'custom',
    });
    expect(res.json.selectorConfig).toEqual({});
  });

  it('creates an inactive source when the Active box is unchecked', async () => {
    const res = await call('POST', '/api/v1/sources', {
      name: `Inactive Source ${uniq()}`, jurisdiction: 'ZZ', url: 'https://example.com/inactive', isActive: false,
    });
    expect(res.status).toBe(201);
    expect(res.json.isActive).toBe(false);
  });

  it('requires an admin', async () => {
    expect((await call('POST', '/api/v1/sources', { name: 'x', jurisdiction: 'ZZ', url: 'https://example.com' }, null)).status).toBe(401);
    expect((await call('POST', '/api/v1/sources', { name: 'x', jurisdiction: 'ZZ', url: 'https://example.com' }, READER_KEY)).status).toBe(403);
    expect((await call('POST', '/api/v1/sources/abc/restore-defaults', undefined, READER_KEY)).status).toBe(403);
  });
});

describe('built-in sources', () => {
  const entry = REGULATORY_SOURCES.find((s) => s.ingestionMode === 'auto' && s.name === 'EU AI Act')!;
  const builtin = () => getDb().select().from(regulatorySources).where(eq(regulatorySources.name, entry.name)).get()!;

  it('does not customize a built-in when the dashboard re-sends identical values (key order, jurisdiction case)', async () => {
    const row = builtin();
    const config = JSON.parse(row.selectorConfig) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(config).reverse());
    expect(Object.keys(reordered).length).toBeGreaterThan(1);
    const res = await call('PATCH', `/api/v1/sources/${row.id}`, {
      name: row.name,
      jurisdiction: row.jurisdiction.toLowerCase(),
      url: row.url,
      parserType: row.parserType,
      selectorConfig: reordered,
      scrapeFrequencyHours: row.scrapeFrequencyHours,
      ingestionMode: row.ingestionMode,
      category: row.category,
      tier: row.tier,
      needsHeadless: row.needsHeadless,
      isActive: row.isActive,
    });
    expect(res.status).toBe(200);
    expect(res.json.origin).toBe('registry');
  });

  it('becomes customized when a registry-controlled field changes, and survives a restart sync', async () => {
    const row = builtin();
    expect(row.origin).toBe('registry');

    // Re-sending identical values is not a customization.
    const same = await call('PATCH', `/api/v1/sources/${row.id}`, { url: row.url, tier: row.tier ?? undefined });
    expect(same.json.origin).toBe('registry');

    // Operational changes alone are not a customization either.
    const ops = await call('PATCH', `/api/v1/sources/${row.id}`, { scrapeFrequencyHours: 12 });
    expect(ops.json).toMatchObject({ origin: 'registry', scrapeFrequencyHours: 12 });

    const res = await call('PATCH', `/api/v1/sources/${row.id}`, { url: 'https://mirror.example.com/eu-ai-act' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ origin: 'customized', url: 'https://mirror.example.com/eu-ai-act' });

    await seedDatabase();
    expect(builtin()).toMatchObject({ origin: 'customized', url: 'https://mirror.example.com/eu-ai-act', scrapeFrequencyHours: 12 });
  });

  it('restores registry values and hands the row back to the sync', async () => {
    const row = builtin();
    await call('PATCH', `/api/v1/sources/${row.id}`, { name: 'My Renamed AI Act', tier: 4, jurisdiction: 'XY', isActive: false });
    expect(dbSource(row.id).origin).toBe('customized');

    const res = await call('POST', `/api/v1/sources/${row.id}/restore-defaults`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: row.id,
      name: entry.name,
      url: entry.url,
      jurisdiction: entry.jurisdiction,
      tier: entry.tier,
      origin: 'registry',
    });
    // Restore does not touch whether the source is active.
    expect(res.json.isActive).toBe(false);
    await call('PATCH', `/api/v1/sources/${row.id}`, { isActive: true });

    // And it is tracked by the sync again.
    getDb().update(regulatorySources).set({ url: 'https://drift.example.com' }).where(eq(regulatorySources.id, row.id)).run();
    await seedDatabase();
    expect(builtin().url).toBe(entry.url);
  });

  it('returns 404 for an unknown source and 409 for a source with no registry entry', async () => {
    expect((await call('POST', `/api/v1/sources/${randomUUID()}/restore-defaults`)).status).toBe(404);
    const custom = await newSource();
    expect((await call('POST', `/api/v1/sources/${custom.id}/restore-defaults`)).status).toBe(409);
  });
});

describe('source deactivation cascade', () => {
  it('retires the source rules and reactivation restores only those', async () => {
    const source = await newSource();
    const a = await newRule(source.id);
    const b = await newRule(source.id);
    const manual = await newRule(source.id);

    // A rule retired by hand before the source is deactivated must stay retired.
    expect((await call('POST', `/api/v1/admin/rules/${manual.id}/retire`)).status).toBe(200);

    const off = await call('DELETE', `/api/v1/sources/${source.id}`);
    expect(off.status).toBe(200);
    expect(off.json.rulesRetired).toBe(2);
    expect(dbSource(source.id).isActive).toBe(false);
    expect(dbRule(a.id).isActive).toBe(false);
    expect(dbRule(b.id).isActive).toBe(false);
    expect(await activeKeys('ZZ')).not.toContain(a.ruleKey);

    const revoked = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, a.id)).orderBy(desc(policyEvents.sequence)).get()!;
    expect(revoked.eventType).toBe('policy.revoked');
    expect(JSON.parse(revoked.payload).reason).toBe('source_deactivated');

    // Rules of an inactive source cannot be brought back one by one, or added to.
    expect((await call('POST', `/api/v1/admin/rules/${a.id}/reactivate`)).status).toBe(409);
    expect((await call('POST', '/api/v1/admin/rules', ruleBody(source.id))).status).toBe(409);

    const on = await call('PATCH', `/api/v1/sources/${source.id}`, { isActive: true });
    expect(on.status).toBe(200);
    expect(on.json.rulesRestored).toBe(2);
    expect(dbRule(a.id).isActive).toBe(true);
    expect(dbRule(b.id).isActive).toBe(true);
    expect(dbRule(manual.id).isActive).toBe(false);
    expect(verifyIntegrity().corrupted).toEqual([]);
  });

  it('is idempotent and survives restarts', async () => {
    const source = await newSource();
    const r = await newRule(source.id);
    await call('PATCH', `/api/v1/sources/${source.id}`, { isActive: false });
    await call('DELETE', `/api/v1/sources/${source.id}`);
    await seedDatabase();
    expect(dbRule(r.id).isActive).toBe(false);
    expect(dbSource(source.id).isActive).toBe(false);
    await call('PATCH', `/api/v1/sources/${source.id}`, { isActive: true });
    expect(dbRule(r.id).isActive).toBe(true);
  });
});

// --- Rules ------------------------------------------------------------------

describe('create rule', () => {
  it('creates a signed, locked rule that every policy surface serves and that fires in evaluation', async () => {
    const source = await newSource({ jurisdiction: 'ZQ' });
    const warm = (await call('GET', '/api/v1/policies/bundle?jurisdictions=ZQ')).json; // populate the bundle cache
    expect(warm.policies).toEqual([]);
    const hashBefore = (await call('GET', '/api/v1/policies/hash')).json.stateHash;
    const lastSequence = getDb().select().from(policyEvents).orderBy(desc(policyEvents.sequence)).get()!.sequence;

    const body = ruleBody(source.id, {
      ruleKey: 'zq.disclose.generated_content',
      conditions: { action: 'publish_generated_content', sector: 'media' },
      industries: ['media'],
      industryScope: 'sector_specific',
    });
    const res = await call('POST', '/api/v1/admin/rules', body);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      ruleKey: 'zq.disclose.generated_content',
      version: 1,
      jurisdiction: 'ZQ', // defaulted from the source
      isActive: true,
      locked: true,
      industries: ['media'],
      conditions: { action: 'publish_generated_content', sector: 'media' },
    });

    // Signature verifies both directly and through the integrity check.
    expect(verifyRuleSignature(dbRule(res.json.id))).toBe(true);
    const integrity = verifyIntegrity();
    expect(integrity.corrupted).toEqual([]);
    expect(integrity.valid).toBe(integrity.total);

    // Event recorded with the next sequence number.
    const events = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, res.json.id)).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'policy.created', sequence: lastSequence + 1 });
    expect(JSON.parse(events[0].payload)).toMatchObject({ ruleKey: body.ruleKey, version: 1, manual: true });
    expect(events[0].payloadSignature).toBe(dbRule(res.json.id).signature);

    // Served by the list, the (previously cached) bundle and the state hash.
    expect(await activeKeys('ZQ')).toContain(body.ruleKey);
    const bundle = (await call('GET', '/api/v1/policies/bundle?jurisdictions=ZQ')).json;
    expect(bundle.policies.map((p: any) => p.ruleKey)).toEqual([body.ruleKey]);
    expect((await call('GET', '/api/v1/policies/hash')).json.stateHash).not.toBe(hashBefore);

    // And it actually decides evaluations: conditions are matched against the context.
    const hit = await call('POST', '/api/v1/evaluate', {
      action: 'publish_generated_content', jurisdiction: 'ZQ', context: { sector: 'media' },
    });
    expect(hit.status).toBe(200);
    expect(hit.json.result).toBe('non_compliant');
    // INTL rules are evaluated in every market; only the jurisdiction's own rule is under test.
    expect(hit.json.rulesEvaluated.filter((r: any) => r.ruleKey === body.ruleKey))
      .toEqual([expect.objectContaining({ ruleKey: body.ruleKey, matched: true })]);
    const miss = await call('POST', '/api/v1/evaluate', {
      action: 'publish_generated_content', jurisdiction: 'ZQ', context: { sector: 'finance' },
    });
    expect(miss.json.result).toBe('compliant');
  });

  it('rejects invalid input with 400 and details', async () => {
    const source = await newSource();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['bad ruleKey', { ruleKey: 'Has Spaces' }, 'ruleKey'],
      ['short ruleKey', { ruleKey: 'ab' }, 'ruleKey'],
      ['bad effect', { effect: 'explode' }, 'effect'],
      ['bad severity', { severity: 'urgent' }, 'severity'],
      ['bad category', { category: 'vibes' }, 'category'],
      ['empty conditions', { conditions: {} }, 'conditions'],
      ['non-string condition', { conditions: { action: 5 } }, 'conditions'],
      ['empty condition value', { conditions: { action: '' } }, 'conditions'],
      ['array conditions', { conditions: ['a'] }, 'conditions'],
      ['short summary', { humanSummary: 'too short' }, 'humanSummary'],
      ['bad date', { effectiveDate: 'next tuesday' }, 'effectiveDate'],
      ['expires before effective', { effectiveDate: '2025-06-01', expiresAt: '2025-01-01' }, 'expiresAt'],
      ['empty industries', { industries: [] }, 'industries'],
      ['bad jurisdiction', { jurisdiction: 'not valid' }, 'jurisdiction'],
      ['unknown field', { locked: false }, ''],
    ];
    for (const [label, override, field] of cases) {
      const res = await call('POST', '/api/v1/admin/rules', ruleBody(source.id, override));
      expect(res.status, label).toBe(400);
      expect(res.json.error, label).toBe('Invalid input');
      expect(Array.isArray(res.json.details), label).toBe(true);
      if (field) expect(res.json.details.some((d: any) => d.path.includes(field)), label).toBe(true);
    }
    const missing = await call('POST', '/api/v1/admin/rules', {});
    expect(missing.status).toBe(400);
    const notJson = await app.request('/api/v1/admin/rules', {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: '{nope',
    });
    expect(notJson.status).toBe(400);
  });

  it('rejects an unknown source with 400 and a duplicate key with 409', async () => {
    const source = await newSource();
    const unknown = await call('POST', '/api/v1/admin/rules', ruleBody(randomUUID()));
    expect(unknown.status).toBe(400);
    expect(unknown.json.details[0].path).toEqual(['sourceId']);

    const first = await newRule(source.id);
    const dup = await call('POST', '/api/v1/admin/rules', ruleBody(source.id, { ruleKey: first.ruleKey }));
    expect(dup.status).toBe(409);
    // A seeded key is a duplicate too: keys are global.
    const seeded = getDb().select().from(policyRules).where(eq(policyRules.locked, false)).get()!;
    expect((await call('POST', '/api/v1/admin/rules', ruleBody(source.id, { ruleKey: seeded.ruleKey }))).status).toBe(409);
  });

  it('requires an admin', async () => {
    const source = await newSource();
    expect((await call('POST', '/api/v1/admin/rules', ruleBody(source.id), null)).status).toBe(401);
    expect((await call('POST', '/api/v1/admin/rules', ruleBody(source.id), READER_KEY)).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/rules', undefined, READER_KEY)).status).toBe(403);
    expect((await call('PATCH', `/api/v1/admin/rules/${randomUUID()}`, { severity: 'low' }, READER_KEY)).status).toBe(403);
    expect((await call('POST', `/api/v1/admin/rules/${randomUUID()}/retire`, undefined, null)).status).toBe(401);
  });
});

describe('edit rule', () => {
  it('bumps the version, re-signs through signRule and records the change', async () => {
    const source = await newSource({ jurisdiction: 'ZE' });
    const rule = await newRule(source.id, { conditions: { action: 'edit_target' } });
    const hashBefore = (await call('GET', '/api/v1/policies/hash')).json.stateHash;
    await call('GET', '/api/v1/policies/bundle?jurisdictions=ZE'); // cache it

    const res = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, {
      severity: 'critical',
      humanSummary: 'Providers must label synthetic media before publication.',
      conditions: { action: 'edit_target', risk_level: 'high' },
      industries: ['media', 'advertising'],
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: 2, severity: 'critical', locked: true, changed: true });
    expect(res.json.conditions).toEqual({ action: 'edit_target', risk_level: 'high' });
    expect(res.json.signature).not.toBe(rule.signature);

    const row = dbRule(rule.id);
    expect(verifyRuleSignature(row)).toBe(true);
    expect(verifyIntegrity().corrupted).toEqual([]);

    const events = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, rule.id)).orderBy(policyEvents.sequence).all();
    expect(events.map((e) => e.eventType)).toEqual(['policy.created', 'policy.updated']);
    expect(JSON.parse(events[1].payload)).toMatchObject({
      version: 2, previousVersion: 1, manual: true,
      changedFields: expect.arrayContaining(['severity', 'humanSummary', 'conditions', 'industries']),
    });
    expect(events[1].sequence).toBeGreaterThan(events[0].sequence);

    // Bundle (cache invalidated) and hash reflect the edit.
    const bundle = (await call('GET', '/api/v1/policies/bundle?jurisdictions=ZE')).json;
    expect(bundle.policies[0]).toMatchObject({ ruleKey: rule.ruleKey, version: 2, severity: 'critical' });
    expect((await call('GET', '/api/v1/policies/hash')).json.stateHash).not.toBe(hashBefore);

    // History, newest first.
    const detail = await call('GET', `/api/v1/admin/rules/${rule.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.history.map((h: any) => h.eventType)).toEqual(['policy.updated', 'policy.created']);
    expect(detail.json.history[0].payload.version).toBe(2);
    expect(detail.json.sourceName).toBe(source.name);
  });

  it('treats an unchanged edit as a no-op without bumping the version', async () => {
    const source = await newSource();
    const rule = await newRule(source.id);
    const res = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { severity: rule.severity, conditions: rule.conditions });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: 1, changed: false });
  });

  it('validates the patch and the merged result', async () => {
    const source = await newSource();
    const rule = await newRule(source.id, { effectiveDate: '2025-06-01' });
    expect((await call('PATCH', `/api/v1/admin/rules/${rule.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { ruleKey: 'new.key.here' })).status).toBe(400);
    expect((await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { sourceId: randomUUID() })).status).toBe(400);
    expect((await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { effect: 'nope' })).status).toBe(400);
    expect((await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { conditions: { a: 1 } })).status).toBe(400);
    const merged = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { expiresAt: '2024-01-01' });
    expect(merged.status).toBe(400);
    expect(merged.json.details[0].path).toEqual(['expiresAt']);
    expect((await call('PATCH', `/api/v1/admin/rules/${randomUUID()}`, { severity: 'low' })).status).toBe(404);
    expect(dbRule(rule.id).version).toBe(1);
  });

  it('locked:false hands the rule back without a version bump, and only on its own', async () => {
    const source = await newSource();
    const rule = await newRule(source.id);
    expect((await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { locked: false, severity: 'low' })).status).toBe(400);

    const res = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { locked: false });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ locked: false, version: 1, signature: rule.signature });
    expect(verifyIntegrity().corrupted).toEqual([]);
    expect(getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, rule.id)).all()).toHaveLength(1);

    // Editing locks it again.
    const edited = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { severity: 'low' });
    expect(edited.json).toMatchObject({ locked: true, version: 2 });
  });

  it('can edit a seeded rule, which then becomes locked and verifies', async () => {
    const seeded = getDb().select().from(policyRules).where(eq(policyRules.locked, false)).get()!;
    const res = await call('PATCH', `/api/v1/admin/rules/${seeded.id}`, { severity: seeded.severity === 'low' ? 'medium' : 'low' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: seeded.version + 1, locked: true });
    expect(verifyIntegrity().corrupted).toEqual([]);
    getDb().update(policyRules).set({ locked: false }).where(eq(policyRules.id, seeded.id)).run();
  });

  it('refuses to edit a rule whose stored signature does not verify', async () => {
    const source = await newSource();
    const rule = await newRule(source.id);
    getDb().update(policyRules).set({ humanSummary: 'Tampered directly in the database.' }).where(eq(policyRules.id, rule.id)).run();
    const res = await call('PATCH', `/api/v1/admin/rules/${rule.id}`, { severity: 'low' });
    expect(res.status).toBe(409);
    expect(verifyIntegrity().corrupted).toContain(rule.ruleKey);
    getDb().update(policyRules).set({ humanSummary: rule.humanSummary }).where(eq(policyRules.id, rule.id)).run();
    expect(verifyIntegrity().corrupted).toEqual([]);
  });
});

describe('retire and reactivate rule', () => {
  it('removes a retired rule from every policy surface and brings it back on reactivation', async () => {
    const source = await newSource({ jurisdiction: 'ZR' });
    const rule = await newRule(source.id);
    await call('GET', '/api/v1/policies/bundle?jurisdictions=ZR'); // cache it
    const hashActive = (await call('GET', '/api/v1/policies/hash')).json;
    const totalBefore = verifyIntegrity().total;

    const retired = await call('POST', `/api/v1/admin/rules/${rule.id}/retire`);
    expect(retired.status).toBe(200);
    expect(retired.json).toMatchObject({ isActive: false, version: 1, changed: true });
    expect(await activeKeys('ZR')).not.toContain(rule.ruleKey);
    expect((await call('GET', '/api/v1/policies/bundle?jurisdictions=ZR')).json.policies).toEqual([]);
    const hashRetired = (await call('GET', '/api/v1/policies/hash')).json;
    expect(hashRetired.stateHash).not.toBe(hashActive.stateHash);
    expect(hashRetired.ruleCount).toBe(hashActive.ruleCount - 1);
    expect(verifyIntegrity().total).toBe(totalBefore - 1);
    const ev = await call('POST', '/api/v1/evaluate', { action: rule.conditions.action, jurisdiction: 'ZR', context: { probe: 'x' } });
    expect(ev.json.rulesEvaluated.filter((r: any) => r.ruleKey === rule.ruleKey)).toEqual([]);

    const again = await call('POST', `/api/v1/admin/rules/${rule.id}/retire`);
    expect(again.status).toBe(200);
    expect(again.json.changed).toBe(false);

    const back = await call('POST', `/api/v1/admin/rules/${rule.id}/reactivate`);
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ isActive: true, changed: true });
    expect(await activeKeys('ZR')).toContain(rule.ruleKey);
    expect((await call('GET', '/api/v1/policies/bundle?jurisdictions=ZR')).json.policies).toHaveLength(1);
    expect((await call('GET', '/api/v1/policies/hash')).json.stateHash).toBe(hashActive.stateHash);
    expect(verifyIntegrity().corrupted).toEqual([]);

    const types = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, rule.id)).orderBy(policyEvents.sequence).all().map((e) => e.eventType);
    expect(types).toEqual(['policy.created', 'policy.revoked', 'policy.updated']);
  });

  it('returns 404 for an unknown rule', async () => {
    expect((await call('POST', `/api/v1/admin/rules/${randomUUID()}/retire`)).status).toBe(404);
    expect((await call('POST', `/api/v1/admin/rules/${randomUUID()}/reactivate`)).status).toBe(404);
    expect((await call('GET', `/api/v1/admin/rules/${randomUUID()}`)).status).toBe(404);
  });
});

describe('list rules', () => {
  it('filters by source and jurisdiction, hides retired rules by default, and paginates', async () => {
    const source = await newSource({ jurisdiction: 'ZL' });
    const other = await newSource({ jurisdiction: 'ZL' });
    const r1 = await newRule(source.id, { ruleKey: 'zl.list.a_rule' });
    await newRule(source.id, { ruleKey: 'zl.list.b_rule' });
    await newRule(other.id, { ruleKey: 'zl.list.c_rule' });
    await call('POST', `/api/v1/admin/rules/${r1.id}/retire`);

    const active = await call('GET', `/api/v1/admin/rules?sourceId=${source.id}`);
    expect(active.json.rules.map((r: any) => r.ruleKey)).toEqual(['zl.list.b_rule']);
    expect(active.json.rules[0]).toMatchObject({ sourceName: source.name, locked: true });

    const all = await call('GET', `/api/v1/admin/rules?sourceId=${source.id}&includeInactive=true`);
    expect(all.json.rules.map((r: any) => r.ruleKey)).toEqual(['zl.list.a_rule', 'zl.list.b_rule']);
    expect(all.json.total).toBe(2);

    const byJurisdiction = await call('GET', '/api/v1/admin/rules?jurisdiction=ZL');
    expect(byJurisdiction.json.rules.map((r: any) => r.ruleKey)).toEqual(['zl.list.b_rule', 'zl.list.c_rule']);

    const page = await call('GET', '/api/v1/admin/rules?jurisdiction=ZL&includeInactive=true&limit=1&offset=1');
    expect(page.json).toMatchObject({ count: 1, total: 3, limit: 1, offset: 1 });
    expect(page.json.rules[0].ruleKey).toBe('zl.list.b_rule');
  });
});

describe('live notification', () => {
  it('broadcasts rule changes to SSE subscribers', async () => {
    const source = await newSource({ jurisdiction: 'ZS' });
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const controller = { enqueue: (c: Uint8Array) => { chunks.push(decoder.decode(c)); } } as unknown as ReadableStreamDefaultController;
    const clientId = registerClient('sse-test-org', ['ZS'], controller)!;
    try {
      const rule = await newRule(source.id);
      await call('POST', `/api/v1/admin/rules/${rule.id}/retire`);
      const joined = chunks.join('');
      expect(joined).toContain('event: policy.created');
      expect(joined).toContain('event: policy.revoked');
      expect(joined).toContain(rule.ruleKey);
    } finally {
      removeClient(clientId);
    }
  });
});
