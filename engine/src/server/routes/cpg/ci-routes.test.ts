/**
 * The CI gate routes (E61 to E63) on the real app and a real database: the
 * server verdict table, case creation and PR attachment from CI, decisions
 * reflected in the verdict, the fixed-everything path moving the case on,
 * the signed verdict verified offline with the published key, pr-closed, and
 * the identity and isolation rules. Every success response is parsed with its
 * contract.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  fingerprintOf, prClosedResponseSchema, requestReviewResponseSchema, verifyCiVerdict, type CiEvaluateResponse,
} from '@nomus/scanner/corporate';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import { caseDetailResponseSchema, ciRunListResponseSchema } from '../../../cpg/contracts.js';
import { listAuditEventsByAction, verifyAuditChain } from '../../../cpg/audit/log.js';
import { closureSignedText } from '../../../cpg/cases/close.js';
import { getCase } from '../../../cpg/cases/service.js';
import { cpgVerify } from '../../../cpg/policies/signing.js';
import { caseFixtures } from '../../../cpg/__fixtures__/case-fixtures.js';
import { call, makeKey, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
const REPO = 'gate.example.org/team/app';
const HEAD = 'a'.repeat(40);
let orgId: string;
let owner: TestUser;
let dev: TestUser;
let reviewer: TestUser; // case_reviewer, member of the AI board
let outsider: TestUser;
let ciKey: string;
let otherOrgKey: string;
let bundleHash: string;
let spki: string;

const finding = (key: string, tag: string) => {
  const code = `call_${tag.replace(/-/g, '_')}(client);`;
  return { fingerprint: fingerprintOf(code, key, 1), policyKey: key, policyVersion: 1, filePath: `src/${tag}.ts`, startLine: 3, endLine: 3, language: 'typescript' as const, snippet: code };
};
type Finding = Omit<ReturnType<typeof finding>, 'snippet'> & { snippet?: string };
const scan = (branch: string, findings: Finding[], over: Record<string, unknown> = {}) => ({
  repo: REPO, branch, prNumber: null, headSha: HEAD, eventName: 'pull_request', bundleHash, scannedFileCount: 5, findings, ...over,
});
const evaluate = (body: unknown, bearer = ciKey) => call(app, 'POST', '/api/v1/cpg/ci/evaluate', { bearer, body });
const prClosed = (body: unknown, bearer = ciKey) => call(app, 'POST', '/api/v1/cpg/ci/pr-closed', { bearer, body });
const runs = (query: string, user = owner) => call(app, 'GET', `/api/v1/cpg/ci/runs?${query}`, { cookie: user.cookie });
const runCount = () => (rawSqlite(getDb()).prepare('SELECT count(*) AS n FROM cpg_ci_runs WHERE org_id = ?').get(orgId) as { n: number }).n;
const caseDetail = async (id: string) => caseDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases/${id}`, { cookie: owner.cookie })).json);

/** Evaluate, expect 200, and verify the signed verdict offline against the published key. */
async function verdict(body: ReturnType<typeof scan>): Promise<CiEvaluateResponse> {
  const res = await evaluate(body);
  expect(res.status, res.text).toBe(200);
  const { repo, branch, prNumber, headSha } = body;
  return verifyCiVerdict(res.json, spki, { orgId, repo, branch, prNumber: prNumber as number | null, headSha, bundleHash });
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
  orgId = makeOrg('CI');
  owner = makeUser(orgId);
  dev = makeUser(orgId);
  reviewer = makeUser(orgId);
  await grant(reviewer, 'case_reviewer');
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  const aiBoard = insertBoard(orgId, 'ai');
  expect((await call(app, 'POST', `/api/v1/cpg/boards/${aiBoard}/members`, { cookie: owner.cookie, body: { userId: reviewer.id } })).status).toBe(201);
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard]);
  insertPolicy(orgId, 'corp.no-pii', 'review-required', [aiBoard]);
  insertPolicy(orgId, 'corp.advice', 'advisory', [aiBoard]);
  insertPolicy(orgId, 'corp.later', 'prohibited', [aiBoard], { enforceFrom: '2099-01-01T00:00:00.000Z' });
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
  ciKey = makeKey(orgId, null, ['read:policies', 'evaluate'], 'ci').key;
  bundleHash = (await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: ciKey })).json.bundleHash;
  spki = (await call(app, 'GET', '/.well-known/nomus-keys')).json.keys[0].spki;
  const otherOrg = makeOrg('Elsewhere');
  makeUser(otherOrg);
  outsider = makeUser(otherOrg);
  otherOrgKey = makeKey(otherOrg, null, ['read:policies', 'evaluate'], 'ci').key;
});

describe('E61 verdicts', () => {
  it('pass without findings: no case, a signed run that verifies offline and only for this scan', async () => {
    const res = await evaluate(scan('feat/clean', []));
    const v = await verdict(scan('feat/clean', []));
    expect([v.verdict, v.caseId, v.caseRef, v.caseUrl, v.reasons, v.counts]).toEqual(['pass', null, null, null, [], { blocking: 0, pending: 0, rejected: 0, approved: 0, excepted: 0, advisory: 0 }]);
    expect(JSON.parse(v.signedPayload)).toEqual({
      kind: 'nomus.cpg-ci-run.v1', runId: v.runId, orgId, repo: REPO, branch: 'feat/clean', prNumber: null, headSha: HEAD, bundleHash,
      verdict: 'pass', counts: v.counts, findingsDigest: expect.stringMatching(/^[0-9a-f]{64}$/), evaluatedAt: v.evaluatedAt,
    });
    const expected = { orgId, repo: REPO, branch: 'feat/clean', prNumber: null, headSha: HEAD, bundleHash };
    expect(() => verifyCiVerdict({ ...res.json, verdict: 'fail', counts: { ...res.json.counts, blocking: 1 } }, spki, expected)).toThrow(/does not match/);
    expect(() => verifyCiVerdict({ ...res.json, signature: v.signature }, spki, expected)).toThrow(/signature does not verify/);
    expect(() => verifyCiVerdict(res.json, spki, { ...expected, headSha: 'b'.repeat(40) })).toThrow(/headSha/);

    const listed = ciRunListResponseSchema.parse((await runs(`repo=${REPO}&sha=${HEAD}`)).json).items.find((r) => r.id === v.runId)!;
    expect([listed.verdict, listed.caseId, listed.signatureValid, listed.signedPayload]).toEqual(['pass', null, true, v.signedPayload]);
  });

  it('fail: blocking findings open a case from CI with the PR attached; advisory and grace never block; a re-run adds no revision', async () => {
    const findings = [finding('corp.no-openai', 'open-1'), finding('corp.no-pii', 'open-2'), finding('corp.advice', 'open-3'), finding('corp.later', 'open-4')];
    const v = await verdict(scan('feat/open', findings, { prNumber: 7 }));
    expect(v.verdict).toBe('fail');
    expect(v.findings.map((f) => [f.filePath, f.status, f.blocking])).toEqual([
      ['src/open-1.ts', 'needs_review', true], ['src/open-2.ts', 'needs_review', true], ['src/open-3.ts', 'advisory', false], ['src/open-4.ts', 'grace', false],
    ]);
    expect(v.counts).toEqual({ blocking: 2, pending: 0, rejected: 0, approved: 0, excepted: 0, advisory: 2 });
    expect(v.reasons).toEqual(['corp.no-openai @ src/open-1.ts:3: needs_review', 'corp.no-pii @ src/open-2.ts:3: needs_review']);
    expect(v.caseUrl).toBe(`http://localhost/governance/cases/${v.caseId}`);
    const detail = await caseDetail(v.caseId!);
    expect([detail.case.state, detail.case.prNumber, detail.openedBy.actor.startsWith('api_key:'), detail.revisions.map((r) => r.source)]).toEqual(['open', 7, true, ['ci']]);
    expect(v.caseRef).toBe(detail.case.ref); // display only: the signed payload stays the v1 shape
    expect(JSON.parse(v.signedPayload)).not.toHaveProperty('caseRef');

    const again = await verdict(scan('feat/open', findings, { prNumber: 7 }));
    expect([again.caseId, (await caseDetail(v.caseId!)).case.latestRevision]).toEqual([v.caseId, 1]);
    const caseRuns = ciRunListResponseSchema.parse((await runs(`caseId=${v.caseId}`, dev)).json).items;
    expect(caseRuns.map((r) => r.id)).toEqual([again.runId, v.runId]);
    expect(listAuditEventsByAction(getDb(), orgId, 'ci.evaluated').filter((e) => [v.runId, again.runId].includes(e.targetId!))).toHaveLength(2);
  });

  it('server decisions decide the verdict, and fixing every blocking finding posts a revision that moves the case on', async () => {
    const [openai, pii] = [finding('corp.no-openai', 'fix-1'), finding('corp.no-pii', 'fix-2')];
    const first = await verdict(scan('feat/fix', [openai, pii]));
    const propose = (fp: Finding, outcome: 'approve' | 'reject') => call(app, 'POST', '/api/v1/cpg/proposals', {
      cookie: reviewer.cookie,
      body: {
        caseId: first.caseId, scope: 'snippet', outcome, fingerprints: [fp.fingerprint], rationale: 'Reviewed by the AI board for this release.',
        ...(outcome === 'approve' ? { expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}),
      },
    });
    expect((await propose(pii, 'reject')).status).toBe(201);
    expect((await propose(openai, 'approve')).status).toBe(201);
    const decided = await verdict(scan('feat/fix', [openai, pii]));
    expect(decided.findings.map((f) => [f.status, f.blocking])).toEqual([['pending', true], ['rejected', true]]);
    expect([decided.verdict, decided.counts.rejected, decided.counts.pending, decided.reasons[1]]).toEqual(['fail', 1, 1, 'corp.no-pii @ src/fix-2.ts:3: rejected']);

    const fixed = await verdict(scan('feat/fix', [], { headSha: 'c'.repeat(40) }));
    expect([fixed.verdict, fixed.caseId]).toEqual(['pass', first.caseId]);
    const detail = await caseDetail(first.caseId!);
    expect([detail.case.state, detail.case.latestRevision, detail.revisions[1].resolvedCount, detail.revisions[1].headSha]).toEqual(['decided', 2, 2, 'c'.repeat(40)]);
  });

  it('refusals: bundle_stale, unknown_fingerprint, snippet_required, fingerprint_mismatch, suspicious_empty_scan; none writes a run', async () => {
    const before = runCount();
    const ok = finding('corp.no-openai', 'refuse');
    const expectCode = async (body: unknown, status: number, code: string) => {
      const res = await evaluate(body);
      expect([res.status, res.json.code], res.text).toEqual([status, code]);
    };
    await expectCode(scan('feat/refuse', [ok], { bundleHash: 'f'.repeat(64) }), 409, 'bundle_stale');
    await expectCode(scan('feat/refuse', [finding('corp.unknown', 'refuse')]), 422, 'unknown_fingerprint');
    const v2 = finding('corp.no-openai', 'refuse');
    await expectCode(scan('feat/refuse', [{ ...v2, fingerprint: v2.fingerprint.replace(/:1$/, ':2'), policyVersion: 2 }]), 422, 'unknown_fingerprint');
    await expectCode(scan('feat/refuse', [{ ...ok, snippet: undefined }]), 422, 'snippet_required');
    await expectCode(scan('feat/refuse', [{ ...ok, snippet: `${ok.snippet} // edited` }]), 422, 'fingerprint_mismatch');
    await expectCode(scan('feat/refuse', [{ ...ok, policyKey: 'corp.no-pii' }]), 422, 'fingerprint_mismatch');
    await expectCode(scan('feat/refuse', [], { scannedFileCount: 0 }), 422, 'suspicious_empty_scan');
    expect(runCount()).toBe(before);
    // A repository that never reported files may scan none; an advisory finding needs no snippet while no case is involved.
    const advisory = { ...finding('corp.advice', 'refuse'), snippet: undefined };
    expect((await verdict(scan('feat/refuse', [advisory], { repo: 'gate.example.org/team/empty', scannedFileCount: 0 }))).verdict).toBe('pass');
  });
});

describe('E62 pr-closed', () => {
  it('a merged PR closes its case as merged; the signed closure record lists the CI runs; the case is then immutable', async () => {
    const v = await verdict(scan('feat/merge', [finding('corp.no-openai', 'merge')], { prNumber: 9 }));
    const res = await prClosed({ repo: REPO, branch: 'feat/merge', prNumber: 9, merged: true, mergeSha: 'd'.repeat(40) });
    expect(prClosedResponseSchema.parse(res.json)).toEqual({ caseId: v.caseId, closed: true });
    const detail = await caseDetail(v.caseId!);
    expect([detail.case.state, detail.case.closeReason, detail.closure?.note, detail.closure?.signatureValid])
      .toEqual(['closed', 'merged', `Pull request #9 was merged as ${'d'.repeat(40)}`, true]);
    expect(detail.closure!.record.ciRunIds).toEqual([v.runId]);
    expect(cpgVerify(closureSignedText(getDb(), getCase(getDb(), orgId, v.caseId!)), detail.closure!.signature)).toBe(true);
    const comment = await call(app, 'POST', `/api/v1/cpg/cases/${v.caseId}/comments`, { cookie: dev.cookie, body: { body: 'Late note.', kind: 'comment' } });
    expect([comment.status, comment.json.code]).toEqual([409, 'case_closed']);
    expect((await prClosed({ repo: REPO, branch: 'feat/merge', prNumber: 9, merged: true })).json).toEqual({ caseId: null, closed: false });
  });

  it('closed unmerged → pr_closed_unmerged; another PR on the case, or no case, closes nothing', async () => {
    const v = await verdict(scan('feat/drop', [finding('corp.no-openai', 'drop')], { prNumber: 10 }));
    expect((await prClosed({ repo: REPO, branch: 'feat/drop', prNumber: 11, merged: false })).json).toEqual({ caseId: null, closed: false });
    expect((await prClosed({ repo: REPO, branch: 'feat/drop', prNumber: 10, merged: false })).json).toEqual({ caseId: v.caseId, closed: true });
    expect((await caseDetail(v.caseId!)).case.closeReason).toBe('pr_closed_unmerged');
    expect((await prClosed({ repo: REPO, branch: 'feat/none', prNumber: 12, merged: true })).json).toEqual({ caseId: null, closed: false });
  });

  it('a case opened from VS Code before the PR existed is attached by CI and closed with it', async () => {
    const f = finding('corp.no-pii', 'vscode');
    const opened = await call(app, 'POST', '/api/v1/cpg/cases/request-review', {
      cookie: dev.cookie,
      body: { repo: REPO, branch: 'feat/vscode', headSha: null, bundleHash, findings: [f], justifications: [{ fingerprint: f.fingerprint, body: 'Needed until the gateway supports this call.' }] },
    });
    const caseId = requestReviewResponseSchema.parse(opened.json).case.id;
    expect((await verdict(scan('feat/vscode', [f], { prNumber: 13 }))).caseId).toBe(caseId);
    expect([(await caseDetail(caseId)).case.prNumber, (await caseDetail(caseId)).case.latestRevision]).toEqual([13, 1]);
    expect((await prClosed({ repo: REPO, branch: 'feat/vscode', prNumber: 13, merged: true })).json).toEqual({ caseId, closed: true });
  });
});

describe('identity and isolation', () => {
  it('evaluate and pr-closed take an org key with the evaluate scope only', async () => {
    const body = scan('feat/auth', []);
    const session = await call(app, 'POST', '/api/v1/cpg/ci/evaluate', { cookie: owner.cookie, body });
    expect([session.status, session.json.details.reason]).toEqual([403, 'org_key_required']);
    expect((await evaluate(body, makeKey(orgId, dev.id).key)).json.details.reason).toBe('org_key_required');
    expect((await evaluate(body, makeKey(orgId, null, ['read:policies']).key)).status).toBe(403);
    expect((await prClosed({ repo: REPO, branch: 'feat/auth', prNumber: 1, merged: true }, makeKey(orgId, dev.id).key)).status).toBe(403);
    expect((await evaluate(body, otherOrgKey)).json.code).toBe('cpg_disabled');
  });

  it('runs are read by users with ci.read; another org gets 404 for a case id, and org keys cannot list', async () => {
    const v = await verdict(scan('feat/iso', [finding('corp.no-openai', 'iso')]));
    expect((await runs(`caseId=${v.caseId}`, outsider)).status).toBe(404);
    const viaKey = await call(app, 'GET', `/api/v1/cpg/ci/runs?caseId=${v.caseId}`, { bearer: ciKey });
    expect([viaKey.status, viaKey.json.code]).toEqual([403, 'user_identity_required']);
    expect(ciRunListResponseSchema.parse((await runs('limit=1', dev)).json).nextCursor).not.toBeNull();
    expect(verifyAuditChain(getDb(), orgId).valid).toBe(true);
  });
});
