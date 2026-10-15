/**
 * The policy registry on a real database (design spec §4, §8.5, §8.6):
 * quorum versioning, four-eyes approval, activation and the grace period,
 * rejection, withdrawal, lapse, retirement, the heads projection, and the
 * signed bundle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJson, verifyCorporateBundle, bundleHashOf } from '@nomus/scanner/corporate';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgPolicyHeads } from '../../db/schema-cpg.js';
import { canonicalJSON } from '../../core/policy-compiler.js';
import { getPublicKey, initSigningKeys } from '../../core/signing.js';
import type { LLMResponse } from '../../llm/provider.js';
import { makeOrg, makeUser, type TestUser } from '../__fixtures__/rbac-fixtures.js';
import { ensureOrgRbac } from '../rbac/seed.js';
import { createBoard } from '../boards/service.js';
import { createQuorumVersion, currentQuorum, listQuorumVersions } from '../quorum/store.js';
import { quorumConfigSchema, SEED_QUORUM_CONFIG } from '../quorum/schema.js';
import { compilePolicy, compileRequestSchema } from './compile.js';
import {
  castVote, computeEnforceFrom, getHead, jsonDiff, proposeRetirement, proposeVersion, rebuildHeads, withdrawVersion,
} from './service.js';
import { serializePolicyDetail } from './serialize.js';
import { activationSignedText, cpgVerify, quorumSignedText } from './signing.js';
import { getCorporateBundle, invalidateCorporateBundle } from '../bundle/build.js';
import { cpgOrgSettings } from '../../db/schema-cpg.js';
import { eq } from 'drizzle-orm';

let orgId: string;
let author: TestUser;
let approver: TestUser;
let approver2: TestUser;
let requester: TestUser;
let aiBoard: string;
let legalBoard: string;
const DAY = 86_400_000;

const RULE = {
  schemaVersion: 1,
  match: { all: [{ kind: 'line_regex', pattern: { source: 'forbidden-model-x', flags: '' } }] },
  files: { include: ['**/*'] },
  message: 'Do not use the forbidden model in any service.',
};
const reply = (key: string): LLMResponse => ({
  content: JSON.stringify({ expressible: true, suggestedKey: key, title: 'No forbidden model', suggestedTier: 'review-required', rule: RULE, rationale: 'A model string is a literal.', limitations: [] }),
  tokensIn: 1, tokensOut: 1, model: 'stub', provider: 'openai',
});

async function compiled(by: TestUser, key = 'corp.no-forbidden-model'): Promise<string> {
  const row = await compilePolicy(getDb(), {
    orgId, actor: `user:${by.id}`,
    request: compileRequestSchema.parse({
      plainText: 'Do not use the forbidden model anywhere in our code.',
      examples: { violating: [{ path: 'src/a.ts', code: "const m = 'forbidden-model-x';\n" }], compliant: [{ path: 'src/b.ts', code: "const m = 'allowed-model';\n" }] },
    }),
  }, async () => reply(key));
  expect(row.status).toBe('compiled');
  return row.id;
}

async function propose(key: string, opts: { by?: TestUser; compiledBy?: TestUser; graceDays?: number; enforceFrom?: string; tier?: 'advisory' | 'review-required' | 'prohibited'; policyId?: string } = {}) {
  const by = opts.by ?? author;
  const compileRecordId = await compiled(opts.compiledBy ?? by, key);
  return proposeVersion(getDb(), {
    orgId, actorUserId: by.id, policyId: opts.policyId, policyKey: opts.policyId ? undefined : key, compileRecordId,
    title: `Policy ${key}`, tier: opts.tier ?? 'review-required', owningBoardIds: [legalBoard, aiBoard], graceDays: opts.graceDays, enforceFrom: opts.enforceFrom,
  });
}

function expectCpgError(fn: () => unknown, status: number, code: string) {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  expect(caught, code).toMatchObject({ status, code });
}
async function expectCpgErrorAsync(p: Promise<unknown>, status: number, code: string) {
  await expect(p).rejects.toMatchObject({ status, code });
}

beforeAll(() => {
  runMigrations();
  initSigningKeys();
  orgId = makeOrg('Registry');
  author = makeUser(orgId);
  approver = makeUser(orgId);
  approver2 = makeUser(orgId);
  requester = makeUser(orgId);
  ensureOrgRbac(getDb(), orgId);
  aiBoard = createBoard(getDb(), orgId, { key: 'ai', name: 'AI Review Board', kind: 'ai' }, 'user:test').id;
  legalBoard = createBoard(getDb(), orgId, { key: 'legal', name: 'Legal Board', kind: 'legal' }, 'user:test').id;
  getDb().update(cpgOrgSettings).set({ enabled: true }).where(eq(cpgOrgSettings.orgId, orgId)).run();
});

describe('quorum configuration (spec §4)', () => {
  it('the seed validates and is version 1, signed by the instance key', () => {
    expect(quorumConfigSchema.parse(SEED_QUORUM_CONFIG)).toEqual(SEED_QUORUM_CONFIG);
    const v1 = currentQuorum(getDb(), orgId);
    expect([v1.version, v1.createdBy]).toEqual([1, 'system:seed']);
    expect(v1.config).toEqual(SEED_QUORUM_CONFIG);
    expect(cpgVerify(quorumSignedText(v1), v1.signature)).toBe(true);
  });

  it('bulk on the prohibited tier cannot be enabled (the schema has no slot for it)', () => {
    const cfg = JSON.parse(JSON.stringify(SEED_QUORUM_CONFIG));
    cfg.tiers.prohibited.bulk = { ...cfg.tiers['review-required'].bulk };
    expect(quorumConfigSchema.safeParse(cfg).success).toBe(false);
    const selfApproval = { ...SEED_QUORUM_CONFIG, policyApproval: { approvals: 1, allowAuthor: true } };
    expect(quorumConfigSchema.safeParse(selfApproval).success).toBe(false);
  });

  it('a change is a new signed version; versions are append-only', () => {
    const cfg = { ...SEED_QUORUM_CONFIG, proposalLapseDays: 45 };
    const v2 = createQuorumVersion(getDb(), orgId, cfg, 'Longer proposal window', `user:${author.id}`);
    expect(v2.version).toBe(2);
    expect(cpgVerify(quorumSignedText(v2), v2.signature)).toBe(true);
    expect(cpgVerify(quorumSignedText({ ...v2, version: 3 }), v2.signature)).toBe(false);
    expect(listQuorumVersions(getDb(), orgId).map((v) => v.version)).toEqual([1, 2]);
    expect(() => rawSqlite(getDb()).prepare('UPDATE cpg_quorum_config_versions SET change_note = ? WHERE org_id = ?').run('x', orgId)).toThrow(/append-only/);
    expect(() => createQuorumVersion(getDb(), orgId, cfg, 'by a key', 'apikey:x')).toThrow();
    // Back to the seed values (a rollback is also a new version).
    expect(createQuorumVersion(getDb(), orgId, SEED_QUORUM_CONFIG, 'Roll back', `user:${author.id}`).version).toBe(3);
  });
});

describe('four-eyes approval (spec §8.5)', () => {
  it('the author cannot approve their own proposal (403 self_approval_forbidden), in code', async () => {
    const { versionId } = await propose('corp.four-eyes-author');
    expectCpgError(() => castVote(getDb(), { orgId, voterUserId: author.id, versionId, vote: 'approve', comment: '' }), 403, 'self_approval_forbidden');
  });

  it('the compile requester cannot approve a version someone else proposed from their compile', async () => {
    const { versionId } = await propose('corp.four-eyes-requester', { by: author, compiledBy: requester });
    expectCpgError(() => castVote(getDb(), { orgId, voterUserId: requester.id, versionId, vote: 'approve', comment: '' }), 403, 'self_approval_forbidden');
  });

  it('and the database refuses the same votes when the code check is bypassed', async () => {
    const { versionId } = await propose('corp.four-eyes-trigger', { by: author, compiledBy: requester });
    const insert = (voter: string) => () => rawSqlite(getDb()).prepare(
      "INSERT INTO cpg_policy_approvals (id, version_id, org_id, voter_user_id, vote, quorum_config_version, created_at) VALUES (?, ?, ?, ?, 'approve', 1, ?)",
    ).run(randomUUID(), versionId, orgId, voter, new Date().toISOString());
    expect(insert(author.id)).toThrow(/self-approval is forbidden/);
    expect(insert(requester.id)).toThrow(/self-approval is forbidden/);
  });

  it('a second vote by the same approver is 409 already_voted', async () => {
    const cfg = { ...SEED_QUORUM_CONFIG, policyApproval: { approvals: 2 } };
    createQuorumVersion(getDb(), orgId, cfg, 'Two approvers', `user:${author.id}`);
    const { versionId } = await propose('corp.two-approvers');
    expect(castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'approve', comment: '' }).status).toBe('pending');
    expectCpgError(() => castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'approve', comment: '' }), 409, 'already_voted');
    expect(castVote(getDb(), { orgId, voterUserId: approver2.id, versionId, vote: 'approve', comment: 'ok' }).status).toBe('active');
    createQuorumVersion(getDb(), orgId, SEED_QUORUM_CONFIG, 'One approver', `user:${author.id}`);
  });
});

describe('activation, grace period and supersede (spec §8.5)', () => {
  it('computeEnforceFrom: requested date wins unless already past; else activation + grace days', () => {
    const at = '2026-10-08T09:00:00.000Z';
    expect(computeEnforceFrom(at, 14, null)).toBe('2026-10-22T09:00:00.000Z');
    expect(computeEnforceFrom(at, 0, null)).toBe(at);
    expect(computeEnforceFrom(at, 14, '2026-11-01T00:00:00.000Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(computeEnforceFrom(at, 14, '2026-10-01T00:00:00.000Z')).toBe(at);
  });

  it('a new policy defaults to 14 days of grace; the activation is signed; a new version defaults to 0 and supersedes', async () => {
    const { policyId, versionId } = await propose('corp.grace');
    expect(getHead(getDb(), policyId)).toMatchObject({ state: 'proposed', pendingVersionId: versionId });
    const before = Date.now();
    expect(castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'approve', comment: '' }).status).toBe('active');
    const head = getHead(getDb(), policyId);
    expect(head).toMatchObject({ state: 'active', activeVersionId: versionId, activeVersion: 1, pendingVersionId: null });
    const grace = Date.parse(head.enforceFrom!) - before;
    expect(grace).toBeGreaterThanOrEqual(14 * DAY - 5_000);
    expect(grace).toBeLessThanOrEqual(14 * DAY + 5_000);

    const detail = serializePolicyDetail(getDb(), orgId, policyId);
    const v1 = detail.versions[0];
    expect(v1.status).toBe('active');
    expect(detail.policy.inGracePeriod).toBe(true);
    const payload = activationSignedText(orgId, {
      policyId, policyKey: 'corp.grace', version: 1, title: v1.title, tier: v1.tier, owningBoards: v1.owningBoards,
      enforceFrom: v1.enforceFrom!, activatedAt: v1.activatedAt!, ruleHash: v1.ruleHash!,
    });
    expect(cpgVerify(payload, v1.signature!)).toBe(true);
    expect(v1.owningBoards.map((b) => b.id)).toEqual([aiBoard, legalBoard].sort());

    const { versionId: v2Id } = await propose('corp.grace', { policyId });
    expect(getHead(getDb(), policyId).state).toBe('active'); // still enforcing v1 while v2 is pending
    castVote(getDb(), { orgId, voterUserId: approver.id, versionId: v2Id, vote: 'approve', comment: '' });
    const after = serializePolicyDetail(getDb(), orgId, policyId);
    expect(after.versions.map((v) => [v.version, v.status])).toEqual([[1, 'superseded'], [2, 'active']]);
    expect(Math.abs(Date.parse(after.versions[1].enforceFrom!) - Date.parse(after.versions[1].activatedAt!))).toBe(0);
    expect(after.events.filter((e) => e.event === 'superseded').map((e) => e.details.supersededBy)).toEqual([v2Id]);
  });

  it('an explicit enforceFrom is honoured', async () => {
    const when = new Date(Date.now() + 30 * DAY).toISOString();
    const { policyId, versionId } = await propose('corp.dated', { enforceFrom: when });
    castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'approve', comment: '' });
    expect(getHead(getDb(), policyId).enforceFrom).toBe(when);
    await expectCpgErrorAsync(propose('corp.past', { enforceFrom: new Date(Date.now() - DAY).toISOString() }), 422, 'enforce_from_in_past');
  });
});

describe('reject, withdraw, lapse, retire', () => {
  it('one reject rejects the version; the policy returns to draft', async () => {
    const { policyId, versionId } = await propose('corp.rejected');
    expect(castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'reject', comment: 'too broad' }).status).toBe('rejected');
    expect(getHead(getDb(), policyId)).toMatchObject({ state: 'draft', pendingVersionId: null });
    expectCpgError(() => castVote(getDb(), { orgId, voterUserId: approver2.id, versionId, vote: 'approve', comment: '' }), 409, 'proposal_not_pending');
  });

  it('only the author withdraws; one pending version per policy', async () => {
    const { policyId, versionId } = await propose('corp.withdrawn');
    await expectCpgErrorAsync(propose('corp.withdrawn', { policyId }), 409, 'version_pending');
    expectCpgError(() => withdrawVersion(getDb(), { orgId, actorUserId: approver.id, versionId }), 403, 'forbidden');
    withdrawVersion(getDb(), { orgId, actorUserId: author.id, versionId });
    expect(getHead(getDb(), policyId)).toMatchObject({ state: 'draft', pendingVersionId: null });
  });

  it('a lapsed proposal expires instead of taking a vote', async () => {
    const { policyId, versionId } = await propose('corp.lapsed');
    // The proposal cannot be back-dated (append-only), so evaluate with a clock 31 days ahead (lapse: 30).
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * DAY;
    try {
      expect(castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'approve', comment: '' })).toMatchObject({ voteId: null, status: 'expired' });
    } finally {
      Date.now = realNow;
    }
    expect(getHead(getDb(), policyId)).toMatchObject({ state: 'draft', pendingVersionId: null });
    expect(serializePolicyDetail(getDb(), orgId, policyId).versions[0].status).toBe('expired');
  });

  it('retirement goes through four-eyes too and removes the policy from the bundle', async () => {
    const { policyId, versionId } = await propose('corp.retiring', { graceDays: 0 });
    castVote(getDb(), { orgId, voterUserId: approver.id, versionId, vote: 'approve', comment: '' });
    invalidateCorporateBundle(orgId, 'test');
    expect(getCorporateBundle(getDb(), orgId).bundle.policies.map((p) => p.policyKey)).toContain('corp.retiring');
    const { versionId: retireId } = proposeRetirement(getDb(), { orgId, actorUserId: author.id, policyId, reason: 'Superseded by the gateway policy' });
    expectCpgError(() => castVote(getDb(), { orgId, voterUserId: author.id, versionId: retireId, vote: 'approve', comment: '' }), 403, 'self_approval_forbidden');
    expect(castVote(getDb(), { orgId, voterUserId: approver.id, versionId: retireId, vote: 'approve', comment: '' }).status).toBe('retired');
    expect(getHead(getDb(), policyId).state).toBe('retired');
    invalidateCorporateBundle(orgId, 'test');
    expect(getCorporateBundle(getDb(), orgId).bundle.policies.map((p) => p.policyKey)).not.toContain('corp.retiring');
    await expectCpgErrorAsync(propose('corp.retiring', { policyId }), 409, 'policy_retired');
  });
});

describe('proposal validation', () => {
  it('refuses unsuccessful or reused compile records, taken keys, unknown boards and invalid edited rules', async () => {
    const id = await compiled(author, 'corp.reuse');
    await proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.reuse', compileRecordId: id, title: 'Reuse', tier: 'advisory', owningBoardIds: [aiBoard] });
    await expectCpgErrorAsync(proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.reuse-2', compileRecordId: id, title: 'Reuse', tier: 'advisory', owningBoardIds: [aiBoard] }), 409, 'compile_record_used');
    await expectCpgErrorAsync(propose('corp.reuse'), 409, 'policy_key_taken');
    await expectCpgErrorAsync(proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.boards', compileRecordId: await compiled(author), title: 'Boards', tier: 'advisory', owningBoardIds: [randomUUID()] }), 422, 'unknown_board');

    const failed = await compilePolicy(getDb(), { orgId, actor: `user:${author.id}`, request: compileRequestSchema.parse({ plainText: 'Everything must be well designed and tasteful.', examples: { violating: [{ path: 'a.ts', code: 'x' }] } }) },
      async () => ({ content: JSON.stringify({ expressible: false, reason: 'Requires a judgement about design quality.' }), tokensIn: 1, tokensOut: 1, model: 's', provider: 'openai' }));
    await expectCpgErrorAsync(proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.unexpressible', compileRecordId: failed.id, title: 'Taste', tier: 'advisory', owningBoardIds: [aiBoard] }), 422, 'compile_not_successful');

    const unsafe = { ...RULE, match: { all: [{ kind: 'line_regex', pattern: { source: '(x+)+y', flags: '' } }] } };
    await expectCpgErrorAsync(proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.edited-unsafe', compileRecordId: await compiled(author), title: 'Edited', tier: 'advisory', owningBoardIds: [aiBoard], rule: unsafe }), 422, 'rule_validation_failed');
    const missesExamples = { ...RULE, match: { all: [{ kind: 'line_regex', pattern: { source: 'some-other-model', flags: '' } }] } };
    await expectCpgErrorAsync(proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.edited-misses', compileRecordId: await compiled(author), title: 'Edited', tier: 'advisory', owningBoardIds: [aiBoard], rule: missesExamples }), 422, 'rule_examples_failed');
  });

  it('an edited rule that still passes the examples is stored with the diff', async () => {
    const edited = { ...RULE, files: { include: ['src/**'] } };
    const { policyId } = await proposeVersion(getDb(), { orgId, actorUserId: author.id, policyKey: 'corp.edited-ok', compileRecordId: await compiled(author), title: 'Edited', tier: 'advisory', owningBoardIds: [aiBoard], rule: edited });
    const d = serializePolicyDetail(getDb(), orgId, policyId);
    expect(d.versions[0].editedFromCompile).toBe(true);
    expect(d.events[0].details.ruleDiff).toEqual([{ path: 'files.include[0]', before: '**/*', after: 'src/**' }]);
    expect(jsonDiff({ a: [1, 2] }, { a: [1] })).toEqual([{ path: 'a', before: [1, 2], after: [1] }]);
  });
});

describe('heads projection', () => {
  it('rebuilding the heads from the append-only log reproduces the stored projection', () => {
    const stored = getDb().select().from(cpgPolicyHeads).where(eq(cpgPolicyHeads.orgId, orgId)).all()
      .map(({ updatedAt: _u, ...h }) => h).sort((a, b) => a.policyId.localeCompare(b.policyId));
    const rebuilt = rebuildHeads(getDb(), orgId).sort((a, b) => a.policyId.localeCompare(b.policyId));
    expect(stored.length).toBeGreaterThan(8);
    expect(rebuilt).toEqual(stored);
  });
});

describe('the signed bundle (spec §8.6)', () => {
  it('verifies offline against the instance key: signature, canonical hash, every activation signature', () => {
    invalidateCorporateBundle(orgId, 'test');
    const { bundle, etag } = getCorporateBundle(getDb(), orgId);
    expect(bundle.enabled).toBe(true);
    expect(bundle.policies.length).toBeGreaterThan(2);
    expect(bundle.policies.map((p) => p.policyKey)).toEqual([...bundle.policies.map((p) => p.policyKey)].sort());
    expect(bundle.bundleHash).toBe(bundleHashOf(bundle.policies));
    expect(verifyCorporateBundle(JSON.parse(JSON.stringify(bundle)), getPublicKey()).bundleHash).toBe(bundle.bundleHash);
    expect(etag).toBe(`"${bundle.bundleHash}.on"`);
    // Cached until something changes.
    expect(getCorporateBundle(getDb(), orgId).bundle.generatedAt).toBe(bundle.generatedAt);
  });

  it('a disabled org gets enabled:false and no policies, still signed', () => {
    const other = makeOrg('Disabled');
    ensureOrgRbac(getDb(), other);
    const { bundle, etag } = getCorporateBundle(getDb(), other);
    expect([bundle.enabled, bundle.policies.length]).toEqual([false, 0]);
    expect(verifyCorporateBundle(bundle, getPublicKey()).enabled).toBe(false);
    expect(etag.endsWith('.off"')).toBe(true);
  });

  it('the scanner and engine canonical JSON are byte-identical', () => {
    const sample = { z: 1, a: { y: [3, { c: null, b: 'é' }], x: true }, m: 'ü ' };
    expect(canonicalJson(sample)).toBe(canonicalJSON(sample));
  });
});
