/**
 * The dashboard's policy registry pages (Phase 2b) read the engine through
 * dashboard/src/api/cpg-schemas.ts. This test drives the whole authoring and
 * approval workflow the pages offer, on the real app and database, and parses
 * every response with the DASHBOARD's schemas, so a drift between the two
 * sides fails here. The LLM provider is stubbed from phrases of the policy
 * text, as in registry-routes.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runMigrations } from '../../../db/migrate.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import { call, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

vi.mock('../../../llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../llm/provider.js')>();
  return {
    ...actual,
    isLlmProviderConfigured: () => true,
    generateWithFallback: async (_role: string, _system: string, user: string) => {
      const content = /gpt-4-32k/.test(user)
        ? JSON.stringify({
          expressible: true, suggestedKey: 'corp.no-gpt-4-32k', title: 'Do not use gpt-4-32k', suggestedTier: 'review-required',
          rule: { schemaVersion: 1, match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] }, files: { include: ['**/*'] }, message: 'The gpt-4-32k model is retired for new code.' },
          rationale: 'A line pattern decides it.', limitations: ['Literal mentions only.'],
        })
        : /well designed/.test(user)
          ? JSON.stringify({ expressible: false, reason: 'Requires a judgement about design quality, which a deterministic rule cannot make.' })
          : '{}';
      return { content, tokensIn: 10, tokensOut: 10, model: 'stub', provider: 'openai' };
    },
  };
});

type Schema = { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
let d: Record<string, Schema & ((...a: unknown[]) => Schema)>;
const app = createApp();
let owner: TestUser;
let author: TestUser;
let approver: TestUser;
let boardId: string;

const MODEL = "export const model = 'gpt-4-32k';\n";
const OK = "export const model = 'gpt-4o';\n";
const examples = { violating: [{ path: 'src/models.ts', code: MODEL }], compliant: [{ path: 'src/ok.ts', code: OK }] };

function expectParsed(schema: Schema, body: unknown, what: string) {
  const parsed = schema.safeParse(body);
  expect(parsed.success, `${what}: ${JSON.stringify(parsed.error)}`).toBe(true);
}

async function grant(user: TestUser, roleKey: string) {
  const roles = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie });
  const roleId = (roles.json.items as Array<{ id: string; key: string }>).find((r) => r.key === roleKey)!.id;
  expect((await call(app, 'POST', `/api/v1/cpg/users/${user.id}/grants`, { cookie: owner.cookie, body: { roleId, scopeType: 'org' } })).status).toBe(201);
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  d = await import(pathToFileURL(resolve(__dirname, '../../../../../dashboard/src/api/cpg-schemas.ts')).href);
  const orgId = makeOrg('DashRegistry');
  owner = makeUser(orgId);
  author = makeUser(orgId);
  approver = makeUser(orgId);
  await grant(author, 'policy_author');
  await grant(author, 'policy_approver'); // four-eyes must hold by identity, not by a missing permission
  await grant(approver, 'policy_approver');
  const board = await call(app, 'POST', '/api/v1/cpg/boards', { cookie: owner.cookie, body: { key: 'ai-review', name: 'AI Review Board', kind: 'ai' } });
  expect(board.status).toBe(201);
  boardId = board.json.id;
});

describe('dashboard schemas over the policy registry workflow', () => {
  it('compile outcomes the authoring page shows (compiled, unexpressible, schema, examples)', async () => {
    const compiled = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'No new code may reference the retired gpt-4-32k model.', examples } });
    expect([compiled.status, compiled.json.status]).toEqual([201, 'compiled']);
    expectParsed(d.compileRecordSchema, compiled.json, 'compiled');
    const taste = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'Every AI integration must be well designed.', examples } });
    expect(taste.json.status).toBe('rejected_unexpressible');
    expectParsed(d.compileRecordSchema, taste.json, 'unexpressible');
    const unknown = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'Quarterly reviews happen on the first Monday.', examples } });
    expect(unknown.json.status).toBe('rejected_schema');
    expectParsed(d.compileRecordSchema, unknown.json, 'schema');
    const mismatch = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'No new code may reference the retired gpt-4-32k model.', examples: { violating: [{ path: 'src/a.ts', code: OK }], compliant: [] } } });
    expect(mismatch.json.status).toBe('rejected_examples');
    expectParsed(d.compileRecordSchema, mismatch.json, 'examples');
    const readBack = await call(app, 'GET', `/api/v1/cpg/compile/${compiled.json.id}`, { cookie: approver.cookie });
    expectParsed(d.compileRecordSchema, readBack.json, 'GET /compile/:id');
  });

  it('propose, refuse the author, approve, then a new version with an edited rule, withdraw, retire', async () => {
    const c1 = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'No new code may reference the retired gpt-4-32k model.', examples } });
    const p = await call(app, 'POST', '/api/v1/cpg/policies', {
      cookie: author.cookie,
      body: { compileRecordId: c1.json.id, policyKey: 'corp.no-gpt-4-32k', title: 'Do not use gpt-4-32k', tier: 'review-required', owningBoardIds: [boardId], graceDays: 14 },
    });
    expect(p.status).toBe(201);
    expectParsed(d.policyDetailSchema, p.json, 'POST /policies');
    const policyId = p.json.policy.policyId as string;
    const pending = p.json.policy.pendingVersionId as string;

    const self = await call(app, 'POST', `/api/v1/cpg/policy-versions/${pending}/votes`, { cookie: author.cookie, body: { vote: 'approve' } });
    expect([self.status, self.json.code]).toEqual([403, 'self_approval_forbidden']);
    const vote = await call(app, 'POST', `/api/v1/cpg/policy-versions/${pending}/votes`, { cookie: approver.cookie, body: { vote: 'approve', comment: 'ok' } });
    expect(vote.json.versionState).toBe('active');
    expectParsed(d.voteResultSchema, vote.json, 'vote');

    const detail = await call(app, 'GET', `/api/v1/cpg/policies/${policyId}`, { cookie: approver.cookie });
    expectParsed(d.policyDetailSchema, detail.json, 'GET /policies/:id');
    expect(detail.json.policy.inGracePeriod).toBe(true);
    expect(detail.json.policy.pendingVersionKind).toBeNull();
    expect(detail.json.versions[0].signature).toEqual(expect.any(String));
    const list = await call(app, 'GET', '/api/v1/cpg/policies', { cookie: approver.cookie });
    expectParsed(d.listOf(d.policyHeadSchema), list.json, 'GET /policies');

    // A new version with an edited rule (the authoring page's rule editor) and an enforce-from date.
    const c2 = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'No new code may reference the retired gpt-4-32k model.', policyId, examples } });
    const edited = { ...c2.json.compiledRule, message: 'gpt-4-32k is retired: use an approved model instead.' };
    const enforceFrom = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const v2 = await call(app, 'POST', `/api/v1/cpg/policies/${policyId}/versions`, {
      cookie: author.cookie,
      body: { compileRecordId: c2.json.id, title: 'Do not use gpt-4-32k', tier: 'prohibited', owningBoardIds: [boardId], rule: edited, enforceFrom },
    });
    expect(v2.status).toBe(201);
    expectParsed(d.policyDetailSchema, v2.json, 'POST /policies/:id/versions');
    expect(v2.json.policy.pendingVersionKind).toBe('define');
    const pendingV2 = v2.json.versions.find((v: { status: string }) => v.status === 'pending');
    expect([pendingV2.editedFromCompile, pendingV2.enforceFromRequested]).toEqual([true, enforceFrom]);
    const proposed = v2.json.events.find((e: { event: string; version: number }) => e.event === 'proposed' && e.version === 2);
    expect(proposed.details.ruleDiff).toEqual([{ path: 'message', before: 'The gpt-4-32k model is retired for new code.', after: 'gpt-4-32k is retired: use an approved model instead.' }]);
    const withdrawn = await call(app, 'POST', `/api/v1/cpg/policy-versions/${pendingV2.id}/withdraw`, { cookie: author.cookie, body: {} });
    expectParsed(d.policyDetailSchema, withdrawn.json, 'withdraw');

    const retire = await call(app, 'POST', `/api/v1/cpg/policies/${policyId}/retire`, { cookie: author.cookie, body: { reason: 'Model removed everywhere.' } });
    expectParsed(d.policyDetailSchema, retire.json, 'retire');
    expect([retire.json.policy.state, retire.json.policy.pendingVersionKind]).toEqual(['active', 'retire']);
    const heads = await call(app, 'GET', '/api/v1/cpg/policies', { cookie: approver.cookie });
    expect(heads.json.items.find((h: { policyId: string }) => h.policyId === policyId).pendingVersionKind).toBe('retire');
    const retired = await call(app, 'POST', `/api/v1/cpg/policy-versions/${retire.json.policy.pendingVersionId}/votes`, { cookie: approver.cookie, body: { vote: 'approve' } });
    expect(retired.json.versionState).toBe('retired');
    const after = await call(app, 'GET', `/api/v1/cpg/policies/${policyId}`, { cookie: approver.cookie });
    expectParsed(d.policyDetailSchema, after.json, 'retired detail');
    expect(after.json.versions.map((v: { status: string }) => v.status)).toEqual(['superseded', 'withdrawn', 'retired']);
  });

  it('the error envelopes the pages turn into messages', async () => {
    const c = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'No new code may reference the retired gpt-4-32k model.', examples } });
    const bad = await call(app, 'POST', '/api/v1/cpg/policies', {
      cookie: author.cookie,
      body: { compileRecordId: c.json.id, policyKey: 'corp.bad-rule', title: 'Bad rule', tier: 'advisory', owningBoardIds: [boardId], rule: { ...c.json.compiledRule, match: { all: [{ kind: 'sdk_call', sdks: ['not-an-sdk'] }] } } },
    });
    expect([bad.status, bad.json.code]).toEqual([422, 'rule_validation_failed']);
    expect(Array.isArray(bad.json.details.reasons) && bad.json.details.reasons.length > 0).toBe(true);
    const missed = await call(app, 'POST', '/api/v1/cpg/policies', {
      cookie: author.cookie,
      body: { compileRecordId: c.json.id, policyKey: 'corp.missed', title: 'Missed', tier: 'advisory', owningBoardIds: [boardId], rule: { ...c.json.compiledRule, match: { ...c.json.compiledRule.match, all: [{ kind: 'line_regex', pattern: { source: 'claude-1', flags: '' } }] } } },
    });
    expect([missed.status, missed.json.code]).toEqual([422, 'rule_examples_failed']);
    expectParsed(d.exampleResultSchema, missed.json.details.exampleResults[0], 'details.exampleResults[0]');
  });
});
