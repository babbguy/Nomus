/**
 * /api/v1/cpg boards, quorum, compile, policy log, bundle and export routes
 * (E19 to E39) on the real app and a real database. Every success response
 * is parsed with its zod contract. The LLM provider is stubbed the way the
 * release gate's fake answers: from phrases of the policy text.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { verifyCorporateBundle } from '@nomus/scanner/corporate';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { seedDatabase } from '../../../db/seed.js';
import { getPublicKey, initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import {
  boardMemberResponseSchema, boardResponseSchema, compileRecordResponseSchema, listOf, policyDetailResponseSchema,
  policyExportResponseSchema, policyHeadResponseSchema, quorumVersionResponseSchema, quorumVersionSummarySchema, voteResponseSchema,
} from '../../../cpg/contracts.js';
import { SEED_QUORUM_CONFIG } from '../../../cpg/quorum/schema.js';
import { contentHashOf, cpgVerify, exportSignedText, quorumSignedText } from '../../../cpg/policies/signing.js';
import { call, makeKey, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

const llmCalls: Array<{ system: string; user: string }> = [];
vi.mock('../../../llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../llm/provider.js')>();
  return {
    ...actual,
    isLlmProviderConfigured: () => true,
    generateWithFallback: async (_role: string, system: string, user: string) => {
      llmCalls.push({ system, user });
      const content = /direct OpenAI/.test(user)
        ? JSON.stringify({
          expressible: true, suggestedKey: 'corp.no-direct-openai', title: 'No direct OpenAI calls', suggestedTier: 'prohibited',
          rule: { schemaVersion: 1, match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] }, files: { include: ['**/*'], exclude: ['src/llm/gateway/**'] }, message: 'Call OpenAI only through the approved LLM gateway.' },
          rationale: 'r', limitations: [],
        })
        : /well designed/.test(user)
          ? JSON.stringify({ expressible: false, reason: 'Requires a judgement about design quality, which a deterministic rule cannot make.' })
          : '{}';
      return { content, tokensIn: 10, tokensOut: 10, model: 'stub', provider: 'openai' };
    },
  };
});

const app = createApp();
let orgId: string;
let owner: TestUser; // Org Admin
let author: TestUser;
let approver: TestUser;
let dev: TestUser;
let auditor: TestUser;
let outsider: TestUser;
let aiBoardId: string;
let legalBoardId: string;

const CODE = "import OpenAI from 'openai';\nconst client = new OpenAI();\nexport const ask = (q: string) => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: q }] });\n";
const compileBody = (plainText = 'Do not call direct OpenAI APIs; use the approved LLM gateway.') => ({
  plainText,
  examples: { violating: [{ path: 'src/app/chat.ts', code: CODE }], compliant: [{ path: 'src/llm/gateway/client.ts', code: CODE }] },
});

async function grant(user: TestUser, roleKey: string) {
  const roles = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie });
  const roleId = (roles.json.items as Array<{ id: string; key: string }>).find((r) => r.key === roleKey)!.id;
  const res = await call(app, 'POST', `/api/v1/cpg/users/${user.id}/grants`, { cookie: owner.cookie, body: { roleId, scopeType: 'org' } });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Registry');
  owner = makeUser(orgId);
  author = makeUser(orgId);
  approver = makeUser(orgId);
  dev = makeUser(orgId);
  auditor = makeUser(orgId);
  outsider = makeUser(makeOrg('Elsewhere'));
  await grant(author, 'policy_author');
  await grant(approver, 'policy_approver');
  await grant(auditor, 'auditor');
});

describe('E19–E24 boards', () => {
  it('Org Admin creates boards (201); a Developer cannot (403); keys are unique (409)', async () => {
    const ai = await call(app, 'POST', '/api/v1/cpg/boards', { cookie: owner.cookie, body: { key: 'ai', name: 'AI Review Board', kind: 'ai' } });
    expect(ai.status).toBe(201);
    aiBoardId = boardResponseSchema.parse(ai.json).id;
    const legal = await call(app, 'POST', '/api/v1/cpg/boards', { cookie: owner.cookie, body: { key: 'legal', name: 'Legal Board', kind: 'legal', description: 'Contracts and privacy' } });
    legalBoardId = boardResponseSchema.parse(legal.json).id;
    const devTry = await call(app, 'POST', '/api/v1/cpg/boards', { cookie: dev.cookie, body: { key: 'dev', name: 'Dev', kind: 'custom' } });
    expect([devTry.status, devTry.json.code, devTry.json.details.permission]).toEqual([403, 'forbidden', 'boards.manage']);
    const dup = await call(app, 'POST', '/api/v1/cpg/boards', { cookie: owner.cookie, body: { key: 'ai', name: 'Again', kind: 'ai' } });
    expect([dup.status, dup.json.code]).toEqual([409, 'board_key_taken']);
    const badKind = await call(app, 'POST', '/api/v1/cpg/boards', { cookie: owner.cookie, body: { key: 'fin', name: 'Finance', kind: 'finance' } });
    expect([badKind.status, badKind.json.code]).toEqual([400, 'invalid_input']);
  });

  it('members: add (201), refuse duplicates (409) and other-org users (404), remove; /cpg/me lists the boards', async () => {
    const add = await call(app, 'POST', `/api/v1/cpg/boards/${aiBoardId}/members`, { cookie: owner.cookie, body: { userId: approver.id } });
    expect(add.status).toBe(201);
    expect(boardMemberResponseSchema.parse(add.json)).toMatchObject({ boardId: aiBoardId, userId: approver.id, removedAt: null });
    expect((await call(app, 'POST', `/api/v1/cpg/boards/${aiBoardId}/members`, { cookie: owner.cookie, body: { userId: approver.id } })).json.code).toBe('already_member');
    expect((await call(app, 'POST', `/api/v1/cpg/boards/${aiBoardId}/members`, { cookie: owner.cookie, body: { userId: outsider.id } })).status).toBe(404);
    await call(app, 'POST', `/api/v1/cpg/boards/${legalBoardId}/members`, { cookie: owner.cookie, body: { userId: dev.id } });
    const me = await call(app, 'GET', '/api/v1/cpg/me', { cookie: approver.cookie });
    expect(me.json.boards).toEqual([{ id: aiBoardId, name: 'AI Review Board' }]);
    const removed = await call(app, 'POST', `/api/v1/cpg/boards/${legalBoardId}/members/${dev.id}/remove`, { cookie: owner.cookie, body: {} });
    expect(boardMemberResponseSchema.parse(removed.json).removedAt).not.toBeNull();
    expect((await call(app, 'POST', `/api/v1/cpg/boards/${legalBoardId}/members/${dev.id}/remove`, { cookie: owner.cookie, body: {} })).status).toBe(404);
  });

  it('GET lists boards: members for boards.manage holders only; user-bound keys can read', async () => {
    const asOwner = listOf(boardResponseSchema).parse((await call(app, 'GET', '/api/v1/cpg/boards', { cookie: owner.cookie })).json);
    expect(asOwner.items.find((b) => b.id === aiBoardId)?.members?.map((m) => m.userId)).toEqual([approver.id]);
    const asDev = listOf(boardResponseSchema).parse((await call(app, 'GET', '/api/v1/cpg/boards', { cookie: dev.cookie })).json);
    expect(asDev.items.every((b) => b.members === null)).toBe(true);
    const uk = makeKey(orgId, dev.id);
    expect((await call(app, 'GET', '/api/v1/cpg/boards', { bearer: uk.key })).status).toBe(200);
    const renamed = await call(app, 'PATCH', `/api/v1/cpg/boards/${legalBoardId}`, { cookie: owner.cookie, body: { name: 'Legal and Privacy Board' } });
    expect(boardResponseSchema.parse(renamed.json).name).toBe('Legal and Privacy Board');
  });
});

describe('E25–E28 quorum', () => {
  it('GET returns the signed seed (version 1)', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/quorum', { cookie: dev.cookie });
    const q = quorumVersionResponseSchema.parse(res.json);
    expect([q.version, q.createdBy]).toEqual([1, 'system:seed']);
    expect(q.config).toEqual(SEED_QUORUM_CONFIG);
    expect(cpgVerify(quorumSignedText({ orgId, ...q }), q.signature)).toBe(true);
  });

  it('PUT creates version 2 (201); Developer 403; prohibited bulk 400; unknown policy and board 422', async () => {
    const config = { ...SEED_QUORUM_CONFIG, gracePeriod: { newPolicyDefaultDays: 7, newVersionDefaultDays: 0 } };
    const v2 = await call(app, 'PUT', '/api/v1/cpg/quorum', { cookie: owner.cookie, body: { config, changeNote: 'Shorter grace' } });
    expect(v2.status).toBe(201);
    expect(quorumVersionResponseSchema.parse(v2.json).version).toBe(2);
    expect((await call(app, 'PUT', '/api/v1/cpg/quorum', { cookie: dev.cookie, body: { config, changeNote: 'x' } })).status).toBe(403);
    const bulk = JSON.parse(JSON.stringify(config));
    bulk.tiers.prohibited.bulk = { ...bulk.tiers['review-required'].bulk };
    const r = await call(app, 'PUT', '/api/v1/cpg/quorum', { cookie: owner.cookie, body: { config: bulk, changeNote: 'Allow bulk' } });
    expect([r.status, r.json.code]).toEqual([400, 'invalid_input']);
    const unknownPolicy = await call(app, 'PUT', '/api/v1/cpg/quorum', { cookie: owner.cookie, body: { config: { ...config, policyOverrides: { [randomUUID()]: {} } }, changeNote: 'x' } });
    expect([unknownPolicy.status, unknownPolicy.json.code]).toEqual([422, 'unknown_policy']);
    const extra = JSON.parse(JSON.stringify(config));
    extra.tiers['review-required'].snippet.extraBoardIds = [randomUUID()];
    const unknownBoard = await call(app, 'PUT', '/api/v1/cpg/quorum', { cookie: owner.cookie, body: { config: extra, changeNote: 'x' } });
    expect([unknownBoard.status, unknownBoard.json.code]).toEqual([422, 'unknown_board']);
  });

  it('history: Auditor reads versions (E27, E28); Developer cannot', async () => {
    const list = listOf(quorumVersionSummarySchema).parse((await call(app, 'GET', '/api/v1/cpg/quorum/versions', { cookie: auditor.cookie })).json);
    expect(list.items.map((v) => v.version)).toEqual([1, 2]);
    expect(quorumVersionResponseSchema.parse((await call(app, 'GET', '/api/v1/cpg/quorum/versions/2', { cookie: owner.cookie })).json).changeNote).toBe('Shorter grace');
    expect((await call(app, 'GET', '/api/v1/cpg/quorum/versions/9', { cookie: auditor.cookie })).status).toBe(404);
    expect((await call(app, 'GET', '/api/v1/cpg/quorum/versions', { cookie: dev.cookie })).status).toBe(403);
  });
});

let compiledId: string;
let policyId: string;
let versionId: string;

describe('E29–E30 compile', () => {
  it('compiled, rejected_unexpressible and rejected_schema all answer 201 with the record', async () => {
    const ok = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: compileBody() });
    expect(ok.status).toBe(201);
    const rec = compileRecordResponseSchema.parse(ok.json);
    expect(rec.status).toBe('compiled');
    compiledId = rec.id;
    const unexpressible = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: compileBody('Every AI feature must be well designed and pleasant.') });
    expect([unexpressible.status, compileRecordResponseSchema.parse(unexpressible.json).status]).toEqual([201, 'rejected_unexpressible']);
    const schema = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: compileBody('Something the model will not recognise at all.') });
    expect(compileRecordResponseSchema.parse(schema.json).status).toBe('rejected_schema');
    expect(llmCalls.every((c) => !c.user.includes('chat.completions.create') && !c.system.includes('client.chat'))).toBe(true);
  });

  it('a Developer cannot compile; an approver can read the record; another org cannot', async () => {
    expect((await call(app, 'POST', '/api/v1/cpg/compile', { cookie: dev.cookie, body: compileBody() })).status).toBe(403);
    const read = await call(app, 'GET', `/api/v1/cpg/compile/${compiledId}`, { cookie: approver.cookie });
    expect(compileRecordResponseSchema.parse(read.json).id).toBe(compiledId);
    expect((await call(app, 'GET', `/api/v1/cpg/compile/${compiledId}`, { cookie: dev.cookie })).status).toBe(403);
    expect((await call(app, 'GET', `/api/v1/cpg/compile/${compiledId}`, { cookie: outsider.cookie })).status).toBe(403);
    const missingExamples = await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { plainText: 'Do not call direct OpenAI APIs anywhere.', examples: { violating: [] } } });
    expect([missingExamples.status, missingExamples.json.code]).toEqual([400, 'invalid_input']);
  });
});

describe('E31–E37 the policy log', () => {
  it('the author proposes (201); their own vote is 403 self_approval_forbidden; the approver activates it', async () => {
    const res = await call(app, 'POST', '/api/v1/cpg/policies', { cookie: author.cookie, body: {
      compileRecordId: compiledId, policyKey: 'corp.no-direct-openai', title: 'No direct OpenAI calls', tier: 'prohibited',
      owningBoardIds: [aiBoardId, legalBoardId], graceDays: 0,
    } });
    expect(res.status).toBe(201);
    const detail = policyDetailResponseSchema.parse(res.json);
    policyId = detail.policy.policyId;
    versionId = detail.versions[0].id;
    expect(detail.policy).toMatchObject({ state: 'proposed', pendingVersion: 1, policyKey: 'corp.no-direct-openai' });

    const own = await call(app, 'POST', `/api/v1/cpg/policy-versions/${versionId}/votes`, { cookie: author.cookie, body: { vote: 'approve' } });
    // The author holds policy.author only, so the permission check answers first; grant approve to prove four-eyes.
    expect(own.status).toBe(403);
    await grant(author, 'policy_approver');
    const ownAgain = await call(app, 'POST', `/api/v1/cpg/policy-versions/${versionId}/votes`, { cookie: author.cookie, body: { vote: 'approve' } });
    expect([ownAgain.status, ownAgain.json.code]).toEqual([403, 'self_approval_forbidden']);
    expect((await call(app, 'POST', `/api/v1/cpg/policy-versions/${versionId}/votes`, { cookie: dev.cookie, body: { vote: 'approve' } })).status).toBe(403);

    const vote = await call(app, 'POST', `/api/v1/cpg/policy-versions/${versionId}/votes`, { cookie: approver.cookie, body: { vote: 'approve', comment: 'Matches the gateway standard.' } });
    expect(vote.status).toBe(201);
    expect(voteResponseSchema.parse(vote.json).versionState).toBe('active');
    const again = await call(app, 'POST', `/api/v1/cpg/policy-versions/${versionId}/votes`, { cookie: approver.cookie, body: { vote: 'approve' } });
    expect([again.status, again.json.code]).toEqual([409, 'proposal_not_pending']);
  });

  it('list (E31) and detail (E33) for any policy reader, including a user-bound key; other orgs get 404', async () => {
    const list = listOf(policyHeadResponseSchema).parse((await call(app, 'GET', '/api/v1/cpg/policies?state=active', { cookie: dev.cookie })).json);
    expect(list.items.map((p) => p.policyKey)).toEqual(['corp.no-direct-openai']);
    expect((await call(app, 'GET', '/api/v1/cpg/policies?state=bogus', { cookie: dev.cookie })).status).toBe(400);
    const uk = makeKey(orgId, dev.id);
    const detail = policyDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/policies/${policyId}`, { bearer: uk.key })).json);
    expect(detail.votes.map((v) => [v.voterUserId, v.vote])).toEqual([[approver.id, 'approve']]);
    expect(detail.events.map((e) => e.event)).toEqual(['proposed', 'approved', 'activated']);
    expect((await call(app, 'GET', `/api/v1/cpg/policies/${policyId}`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await call(app, 'GET', `/api/v1/cpg/policies/${randomUUID()}`, { cookie: dev.cookie })).status).toBe(404);
  });

  it('a new version (E34), withdrawn only by its author (E37); retirement (E35); a board in use cannot be archived (E22)', async () => {
    const rec = compileRecordResponseSchema.parse((await call(app, 'POST', '/api/v1/cpg/compile', { cookie: author.cookie, body: { ...compileBody(), policyId } })).json);
    const v2 = await call(app, 'POST', `/api/v1/cpg/policies/${policyId}/versions`, { cookie: author.cookie, body: { compileRecordId: rec.id, title: 'No direct OpenAI calls (v2)', tier: 'prohibited', owningBoardIds: [aiBoardId] } });
    expect(v2.status).toBe(201);
    const pendingId = policyDetailResponseSchema.parse(v2.json).policy.pendingVersionId!;
    expect((await call(app, 'POST', `/api/v1/cpg/policy-versions/${pendingId}/withdraw`, { cookie: approver.cookie, body: {} })).status).toBe(403);
    const withdrawn = await call(app, 'POST', `/api/v1/cpg/policy-versions/${pendingId}/withdraw`, { cookie: author.cookie, body: {} });
    expect(policyDetailResponseSchema.parse(withdrawn.json).versions.map((v) => v.status)).toEqual(['active', 'withdrawn']);

    const archive = await call(app, 'POST', `/api/v1/cpg/boards/${aiBoardId}/archive`, { cookie: owner.cookie, body: {} });
    expect([archive.status, archive.json.code, archive.json.details.policyKeys]).toEqual([409, 'board_in_use', ['corp.no-direct-openai']]);

    const retire = await call(app, 'POST', `/api/v1/cpg/policies/${policyId}/retire`, { cookie: author.cookie, body: { reason: 'Replaced by the gateway allow-list' } });
    expect(retire.status).toBe(201);
    expect(policyDetailResponseSchema.parse(retire.json).versions.at(-1)).toMatchObject({ kind: 'retire', status: 'pending' });
  });
});

describe('E38 bundle', () => {
  it('org keys, user-bound keys and sessions read it; ETag answers 304; disabled until the org enables CPG', async () => {
    const orgKey = makeKey(orgId, null, ['read:policies']);
    const first = await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: orgKey.key });
    expect(first.status).toBe(200);
    expect(verifyCorporateBundle(first.json, getPublicKey())).toMatchObject({ enabled: false, policies: [] });
    const etag = first.headers.get('etag')!;
    const same = await app.request('http://localhost/api/v1/cpg/bundle', { headers: { Authorization: `Bearer ${orgKey.key}`, 'If-None-Match': etag } });
    expect(same.status).toBe(304);

    expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
    const enabled = await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: orgKey.key });
    expect(enabled.headers.get('etag')).not.toBe(etag);
    const bundle = verifyCorporateBundle(enabled.json, getPublicKey());
    expect(bundle.enabled).toBe(true);
    expect(bundle.policies.map((p) => [p.policyKey, p.tier, p.owningBoards.map((b) => b.name).sort()])).toEqual([['corp.no-direct-openai', 'prohibited', ['AI Review Board', 'Legal and Privacy Board']]]);
    expect((await call(app, 'GET', '/api/v1/cpg/bundle', { cookie: dev.cookie })).status).toBe(200);
    expect((await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: makeKey(orgId, dev.id).key })).status).toBe(200);
    expect((await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: makeKey(orgId, null, ['evaluate']).key })).status).toBe(403);
    expect((await call(app, 'GET', '/api/v1/cpg/bundle')).status).toBe(401);
  });

  it('activation invalidates the cached bundle', async () => {
    const orgKey = makeKey(orgId, null, ['read:policies']);
    const before = await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: orgKey.key });
    const detail = policyDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/policies/${policyId}`, { cookie: dev.cookie })).json);
    const retireId = detail.policy.pendingVersionId!;
    expect(voteResponseSchema.parse((await call(app, 'POST', `/api/v1/cpg/policy-versions/${retireId}/votes`, { cookie: approver.cookie, body: { vote: 'approve' } })).json).versionState).toBe('retired');
    const after = await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: orgKey.key });
    expect(before.json.policies).toHaveLength(1);
    expect(after.json.policies).toHaveLength(0);
    expect(after.json.bundleHash).not.toBe(before.json.bundleHash);
  });
});

describe('E39 export', () => {
  it('the Auditor exports a signed log that verifies offline; a Developer cannot', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/policies/export?format=json', { cookie: auditor.cookie });
    expect(res.status).toBe(200);
    const exp = policyExportResponseSchema.parse(res.json);
    expect(contentHashOf(res.json.content)).toBe(exp.contentHash);
    expect(cpgVerify(exportSignedText(exp), exp.signature)).toBe(true);
    expect(cpgVerify(exportSignedText({ ...exp, contentHash: '0'.repeat(64) }), exp.signature)).toBe(false);
    expect(exp.content.policies[0].events.map((e) => e.event)).toContain('retired');
    expect(exp.content.quorumVersions.map((q) => q.version)).toEqual([1, 2]);
    expect((await call(app, 'GET', '/api/v1/cpg/policies/export', { cookie: dev.cookie })).status).toBe(403);
    expect((await call(app, 'GET', '/api/v1/cpg/policies/export?format=csv', { cookie: auditor.cookie })).status).toBe(400);
  });
});

describe('authentication on the new routes', () => {
  it('401 without credentials; org keys get 403 user_identity_required on user routes', async () => {
    for (const [method, path] of [['GET', '/api/v1/cpg/boards'], ['GET', '/api/v1/cpg/quorum'], ['GET', '/api/v1/cpg/policies'], ['POST', '/api/v1/cpg/compile'], ['GET', '/api/v1/cpg/policies/export']]) {
      expect((await call(app, method, path)).status, path).toBe(401);
    }
    const orgKey = makeKey(orgId, null);
    const r = await call(app, 'GET', '/api/v1/cpg/policies', { bearer: orgKey.key });
    expect([r.status, r.json.code]).toEqual([403, 'user_identity_required']);
  });
});
