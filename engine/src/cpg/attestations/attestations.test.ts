/**
 * Corporate policy records in attestations (design spec §13, §16.8) on the
 * real app and a real database: what the manifest selects at the attestation
 * instant, refusals that leave no receipt, the bundleVersion 2 export and its
 * offline verification, the tamper matrix, revocation after the attestation,
 * the public summary and the T36 binding trigger.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { fingerprintOf } from '@nomus/scanner/corporate';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys, getPublicKey } from '../../core/signing.js';
import { createApp } from '../../server/app.js';
import { closeCase } from '../cases/close.js';
import { caseFixtures } from '../__fixtures__/case-fixtures.js';
import { call, makeOrg, makeUser, type TestUser } from '../__fixtures__/rbac-fixtures.js';
import { verifyEvidenceBundle } from './verify.js';

const app = createApp();
const REPO = 'gate.example.org/team/app';
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const RATIONALE = 'Kept until the gateway client replaces it next release.';
const EVAL = { action: 'ai_user_interaction', jurisdiction: 'EU', context: { region: 'EU' } };
let orgId: string;
let owner: TestUser;
let dev: TestUser;
let ai: TestUser;
let legal: TestUser;
let approver: TestUser;
let caseId: string;
let approvalId: string;
let rejectId: string;
let exceptionId: string;

const finding = (tag: string, key: string, filePath: string) => {
  const code = `send_${tag}(client);`;
  return { fingerprint: fingerprintOf(code, key, 1), policyKey: key, policyVersion: 1, filePath, startLine: 2, endLine: 2, language: 'typescript' as const, snippet: code };
};
const post = (user: TestUser, path: string, body: unknown) => call(app, 'POST', path, { cookie: user.cookie, body });
const evaluate = (governance?: Record<string, unknown>) => post(owner, '/api/v1/evaluate', governance ? { ...EVAL, governance } : EVAL);
const exportJson = async (id: string) => (await call(app, 'GET', `/api/v1/attestations/${id}/export?format=json`, { cookie: owner.cookie })).json;
const receiptCount = () => (rawSqlite(getDb()).prepare('SELECT count(*) AS n FROM attestation_receipts').get() as { n: number }).n;

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Attest');
  [owner, dev, ai, legal, approver] = [makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId)];
  const roles = (await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie })).json.items as Array<{ id: string; key: string }>;
  for (const [u, key] of [[ai, 'case_reviewer'], [legal, 'case_reviewer'], [legal, 'exception_approver'], [approver, 'exception_approver']] as const) {
    expect((await post(owner, `/api/v1/cpg/users/${u.id}/grants`, { roleId: roles.find((r) => r.key === key)!.id, scopeType: 'org' })).status).toBe(201);
  }
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  const [aiBoard, legalBoard] = [insertBoard(orgId, 'ai'), insertBoard(orgId, 'legal')];
  for (const [board, u] of [[aiBoard, ai], [legalBoard, legal]] as const) expect((await post(owner, `/api/v1/cpg/boards/${board}/members`, { userId: u.id })).status).toBe(201);
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard, legalBoard]);
  insertPolicy(orgId, 'corp.no-pii', 'review-required', [legalBoard]);

  // Attestations before governance is enabled: the extra is refused.
  const before = receiptCount();
  const off = await evaluate({ repo: REPO });
  expect([off.status, off.json.code, receiptCount()]).toEqual([403, 'cpg_disabled', before]);
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);

  // One case: an approved and a rejected PII finding; then a standing exception for src/legacy/**.
  const [ok, bad] = [finding('ok', 'corp.no-pii', 'src/a.ts'), finding('bad', 'corp.no-pii', 'src/b.ts')];
  const opened = await post(dev, '/api/v1/cpg/cases/request-review', {
    repo: REPO, branch: 'feat/x', headSha: null, bundleHash: 'b'.repeat(64), findings: [ok, bad],
    justifications: [ok, bad].map((f) => ({ fingerprint: f.fingerprint, body: 'Needed until the redaction service ships.' })),
  });
  caseId = opened.json.case.id;
  const approve = await post(legal, '/api/v1/cpg/proposals', { caseId, scope: 'snippet', outcome: 'approve', fingerprints: [ok.fingerprint], expiresAt: inDays(30), rationale: RATIONALE });
  const reject = await post(legal, '/api/v1/cpg/proposals', { caseId, scope: 'snippet', outcome: 'reject', fingerprints: [bad.fingerprint], rationale: RATIONALE });
  [approvalId, rejectId] = [approve.json.decisionIds[0], reject.json.decisionIds[0]];
  const standing = await post(approver, '/api/v1/cpg/proposals', {
    scope: 'standing', expiresAt: inDays(30), rationale: RATIONALE, pattern: { repos: [REPO], paths: ['src/legacy/**'], policyKey: 'corp.no-openai', policyVersion: 1 },
  });
  await post(ai, `/api/v1/cpg/proposals/${standing.json.id}/votes`, { vote: 'approve' });
  exceptionId = (await post(legal, `/api/v1/cpg/proposals/${standing.json.id}/votes`, { vote: 'approve' })).json.decisionIds[0];
  expect([approvalId, rejectId, exceptionId].every(Boolean)).toBe(true);
});

describe('refusals leave no receipt', () => {
  it('an open case is 409, another repository is 422, an unknown case is 404, a bad repo is 400', async () => {
    const before = receiptCount();
    expect((await evaluate({ repo: REPO, caseId })).json.code).toBe('case_open');
    expect((await evaluate({ repo: 'gate.example.org/team/other', caseId })).json.code).toBe('case_repo_mismatch');
    expect((await evaluate({ repo: REPO, caseId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await evaluate({ repo: 'not a repo' })).status).toBe(400);
    expect(receiptCount()).toBe(before);
  });
});

describe('an attestation with governance', () => {
  let id: string;
  let bundle: any;
  const spki = () => getPublicKey();

  beforeAll(async () => {
    closeCase(getDb(), { orgId, caseId, reason: 'merged', note: 'merged', actor: 'test' });
    const res = await evaluate({ repo: REPO, branch: 'main', caseId });
    expect([res.status, res.json.governance]).toEqual([200, { manifest: true, itemCount: 3 }]);
    id = res.json.id;
    bundle = await exportJson(id);
  });

  it('lists the active approval, the standing exception and the closure, sorted; never the rejection', () => {
    const manifest = JSON.parse(bundle.corporateGovernance.manifest.signedPayloadCanonicalJson);
    expect(manifest).toMatchObject({ kind: 'nomus.cpg-attestation-manifest.v1', attestationId: id, orgId, evaluatedAt: bundle.attestation.evaluatedAt, repo: REPO, branch: 'main' });
    const expected = [...[approvalId, exceptionId].sort().map((x) => `decision:${x}`), `case_closure:${caseId}`].sort();
    expect(manifest.items.map((i: any) => `${i.type}:${i.id}`)).toEqual(expected);
    expect(bundle.corporateGovernance.items.map((i: any) => i.statusAtGeneration).sort()).toEqual(['active', 'active', 'final']);
    expect(JSON.stringify(manifest)).not.toContain(rejectId);
  });

  it('exports bundleVersion 2 with every v1 key unchanged, and verifies offline with the published key', async () => {
    expect(bundle.bundleVersion).toBe(2);
    expect(Object.keys(bundle)).toEqual(['bundleType', 'bundleVersion', 'generatedAt', 'attestation', 'verification', 'citedRules', 'corpus', 'corporateGovernance', '_disclaimer']);
    expect(verifyEvidenceBundle(bundle, spki())).toEqual({ ok: true, reasons: [] });
    const html = (await call(app, 'GET', `/api/v1/attestations/${id}/export?format=html`, { cookie: owner.cookie })).text;
    expect(html).toContain('5. Corporate policy exceptions (3)');
    expect(html).not.toContain('send_ok');
  });

  it('rejects tampering', () => {
    const decision = (b: any) => b.corporateGovernance.items.find((i: any) => i.type === 'decision');
    const { privateKey } = generateKeyPairSync('ed25519');
    const cases: Record<string, (b: any) => void> = {
      'a decision expiresAt edited': (b) => { decision(b).signedPayloadCanonicalJson = decision(b).signedPayloadCanonicalJson.replace(/"expiresAt":"[^"]+"/, '"expiresAt":"2099-01-01T00:00:00.000Z"'); },
      'an item dropped': (b) => { b.corporateGovernance.items.pop(); },
      'the manifest attestationId swapped': (b) => { b.corporateGovernance.manifest.signedPayloadCanonicalJson = b.corporateGovernance.manifest.signedPayloadCanonicalJson.replace(id, caseId); },
      'a decision re-signed with another key': (b) => { decision(b).signature = sign(null, Buffer.from(decision(b).signedPayloadCanonicalJson), privateKey).toString('base64'); },
      'governance removed but bundleVersion kept': (b) => { delete b.corporateGovernance; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const b = structuredClone(bundle);
      mutate(b);
      expect(verifyEvidenceBundle(b, spki()).ok, name).toBe(false);
    }
  });

  it('a revocation after the attestation marks the item revoked, and the bundle still verifies; later attestations omit it', async () => {
    expect((await post(approver, `/api/v1/cpg/decisions/${exceptionId}/revoke`, { reason: 'The legacy client is gone.' })).status).toBe(201);
    const after = await exportJson(id);
    const item = after.corporateGovernance.items.find((i: any) => i.id === exceptionId);
    expect([item.statusAtGeneration, JSON.parse(item.revocation.signedPayloadCanonicalJson).decisionId]).toEqual(['revoked', exceptionId]);
    expect(verifyEvidenceBundle(after, spki()).ok).toBe(true);
    expect((await evaluate({ repo: REPO })).json.governance).toEqual({ manifest: true, itemCount: 1 });
  });

  it('the public verify page and the list show counts only', async () => {
    const pub = (await call(app, 'GET', `/api/v1/verify/${id}`)).json;
    expect(pub.corporateGovernance).toEqual({ manifestSignatureValid: true, exceptions: 2, revokedSince: 1, caseClosures: 1, ciRuns: 0 });
    const list = (await call(app, 'GET', '/api/v1/attestations?limit=50', { cookie: owner.cookie })).json.attestations as any[];
    expect(list.find((a) => a.id === id).corporateGovernance).toEqual({ exceptions: 2, caseClosures: 1, ciRuns: 0 });
  });

  it('the T36 trigger binds a manifest to its attestation org and instant', async () => {
    const sqlite = rawSqlite(getDb());
    const plain = sqlite.prepare('SELECT id, org_id, evaluated_at FROM attestation_receipts WHERE id = ?').get((await evaluate()).json.id) as { id: string; org_id: string; evaluated_at: string };
    const insert = (org: string, at: string) => () => sqlite.prepare(`INSERT INTO cpg_attestation_manifests (attestation_id, org_id, repo, evaluated_at, bundle_hash, signed_payload, signature, created_at)
      VALUES (?, ?, ?, ?, ?, '{}', 's', ?)`).run(plain.id, org, REPO, at, 'a'.repeat(64), at);
    expect(insert(plain.org_id, '2020-01-01T00:00:00.000Z')).toThrow(/match its attestation/);
    expect(insert(makeOrg('Other'), plain.evaluated_at)).toThrow(/match its attestation/);
  });
});

describe('without governance', () => {
  it('the response, the list row and the export are exactly the v1.1.0 shape', async () => {
    const res = await evaluate();
    expect(res.json).not.toHaveProperty('governance');
    const bundle = await exportJson(res.json.id);
    expect([bundle.bundleVersion, Object.keys(bundle)]).toEqual([1, ['bundleType', 'bundleVersion', 'generatedAt', 'attestation', 'verification', 'citedRules', 'corpus', '_disclaimer']]);
    expect((await call(app, 'GET', `/api/v1/verify/${res.json.id}`)).json).not.toHaveProperty('corporateGovernance');
    const list = (await call(app, 'GET', '/api/v1/attestations?limit=50', { cookie: owner.cookie })).json.attestations as any[];
    expect(list.find((a) => a.id === res.json.id)).not.toHaveProperty('corporateGovernance');
  });
});
