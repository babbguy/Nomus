/**
 * One repository, one identity (design spec §2.2): every route that takes a
 * repository canonicalises it with canonicalRepo(), so `github.com/owner/name`,
 * a remote URL and any casing name the same repository as `owner/name`, with
 * the same case, decisions, standing exceptions and CI runs. Repository
 * patterns drop a leading `github.com/` host the same way.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  findingsStatusResponseSchema, fingerprintOf, prClosedResponseSchema, requestReviewResponseSchema, type CaseStatus,
} from '@nomus/scanner/corporate';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import {
  caseListResponseSchema, ciRunListResponseSchema, exceptionListResponseSchema, proposalDetailResponseSchema, teamResponseSchema,
} from '../../../cpg/contracts.js';
import { caseFixtures } from '../../../cpg/__fixtures__/case-fixtures.js';
import { call, makeKey, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
const SHORT = 'example-org/policy-app';
const LONG = 'github.com/example-org/policy-app';
const REMOTE = 'https://github.com/Example-Org/Policy-App.git';
const BRANCH = 'feat/identity';
const RATIONALE = 'The legacy client is retired with the next platform release.';
const code = 'legacy_identity(client);';
const FINDING = {
  fingerprint: fingerprintOf(code, 'corp.no-openai', 1), policyKey: 'corp.no-openai', policyVersion: 1,
  filePath: 'src/legacy/identity.ts', startLine: 2, endLine: 2, language: 'typescript' as const, snippet: code,
};
let owner: TestUser;
let dev: TestUser;
let ai: TestUser;
let legal: TestUser;
let approver: TestUser;
let ciKey: string;
let kase: CaseStatus;

const post = (user: TestUser, path: string, body: unknown) => call(app, 'POST', `/api/v1/cpg${path}`, { cookie: user.cookie, body });
const get = (user: TestUser, path: string) => call(app, 'GET', `/api/v1/cpg${path}`, { cookie: user.cookie });
const requestReview = (repo: string) => post(dev, '/cases/request-review', {
  repo, branch: BRANCH, headSha: null, bundleHash: 'b'.repeat(64), findings: [FINDING],
  justifications: [{ fingerprint: FINDING.fingerprint, body: 'Kept until the gateway client replaces it.' }],
});
const findingStatus = async (repo: string) =>
  findingsStatusResponseSchema.parse((await post(dev, '/findings/status', { repo, branch: BRANCH, fingerprints: [FINDING.fingerprint] })).json).items[0].status;

async function grant(user: TestUser, roleKey: string) {
  const roleId = ((await get(owner, '/roles')).json.items as Array<{ id: string; key: string }>).find((r) => r.key === roleKey)!.id;
  expect((await post(owner, `/users/${user.id}/grants`, { roleId, scopeType: 'org' })).status).toBe(201);
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  const orgId = makeOrg('Identity');
  [owner, dev, ai, legal, approver] = [makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId)];
  for (const [u, role] of [[ai, 'case_reviewer'], [legal, 'case_reviewer'], [legal, 'exception_approver'], [approver, 'exception_approver']] as const) await grant(u, role);
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  const aiBoard = insertBoard(orgId, 'ai');
  const legalBoard = insertBoard(orgId, 'legal');
  for (const [board, u] of [[aiBoard, ai], [legalBoard, legal]] as const) expect((await post(owner, `/boards/${board}/members`, { userId: u.id })).status).toBe(201);
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard, legalBoard]);
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
  ciKey = makeKey(orgId, null, ['read:policies', 'evaluate'], 'ci').key;
});

describe('one repository, one identity', () => {
  it('request-review, by-branch and the case list: the long form, a remote URL and the short form are one case', async () => {
    const opened = await requestReview(LONG);
    expect(opened.status, opened.text).toBe(201);
    kase = requestReviewResponseSchema.parse(opened.json).case;
    expect(kase.repo).toBe(SHORT);
    const again = requestReviewResponseSchema.parse((await requestReview(SHORT)).json);
    expect([again.created, again.case.id]).toEqual([false, kase.id]);

    for (const repo of [SHORT, LONG, REMOTE]) {
      const q = `repo=${encodeURIComponent(repo)}`;
      expect((await get(dev, `/cases/by-branch?${q}&branch=${BRANCH}`)).json.case?.id, repo).toBe(kase.id);
      expect(caseListResponseSchema.parse((await get(dev, `/cases?${q}`)).json).items.map((c) => c.id), repo).toEqual([kase.id]);
    }
    expect((await get(dev, '/cases/by-branch?repo=https%3A%2F%2Fgithub.com%2Fexample-org&branch=main')).json.code).toBe('invalid_input');
  });

  it('proposals: a standing pattern given with the github.com host is stored canonical and excepts the finding under every form', async () => {
    expect((await post(approver, '/proposals', {
      scope: 'standing', pattern: { repos: ['github.com/**'], paths: ['src/**'], policyKey: 'corp.no-openai', policyVersion: 1 },
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), rationale: RATIONALE,
    })).json.code).toBe('invalid_input');
    const proposed = await post(approver, '/proposals', {
      scope: 'standing', pattern: { repos: [LONG], paths: ['src/legacy/**'], policyKey: 'corp.no-openai', policyVersion: 1 },
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), rationale: RATIONALE,
    });
    expect(proposed.status, proposed.text).toBe(201);
    const p = proposalDetailResponseSchema.parse(proposed.json);
    expect(p.pattern?.repos).toEqual([SHORT]);
    expect((await post(ai, `/proposals/${p.id}/votes`, { vote: 'approve' })).json.proposalStatus).toBe('pending');
    expect((await post(legal, `/proposals/${p.id}/votes`, { vote: 'approve' })).json.proposalStatus).toBe('finalized');

    for (const repo of [SHORT, LONG, REMOTE]) {
      expect(await findingStatus(repo), repo).toBe('excepted');
      const listed = exceptionListResponseSchema.parse((await get(dev, `/exceptions?repo=${encodeURIComponent(repo)}`)).json).items;
      expect(listed.map((x) => x.proposalId), repo).toEqual([p.id]);
    }
  });

  it('CI evaluate, the run list and pr-closed with the long form act on the case and decisions of the short form', async () => {
    const bundleHash = (await call(app, 'GET', '/api/v1/cpg/bundle', { bearer: ciKey })).json.bundleHash as string;
    const res = await call(app, 'POST', '/api/v1/cpg/ci/evaluate', {
      bearer: ciKey,
      body: { repo: LONG, branch: BRANCH, prNumber: 4, headSha: 'c'.repeat(40), eventName: 'pull_request', bundleHash, scannedFileCount: 3, findings: [FINDING] },
    });
    expect(res.status, res.text).toBe(200);
    expect([res.json.verdict, res.json.caseId, res.json.findings[0].status, JSON.parse(res.json.signedPayload).repo]).toEqual(['pass', kase.id, 'excepted', SHORT]);
    for (const repo of [SHORT, LONG]) {
      const runs = ciRunListResponseSchema.parse((await get(owner, `/ci/runs?repo=${encodeURIComponent(repo)}`)).json).items;
      expect(runs.map((r) => [r.id, r.repo]), repo).toEqual([[res.json.runId, SHORT]]);
    }

    const closed = await call(app, 'POST', '/api/v1/cpg/ci/pr-closed', { bearer: ciKey, body: { repo: LONG, branch: BRANCH, prNumber: 4, merged: true } });
    expect(prClosedResponseSchema.parse(closed.json)).toEqual({ caseId: kase.id, closed: true });
  });

  it('team repository patterns drop the github.com host, so the two forms are one pattern', async () => {
    const team = await post(owner, '/teams', { key: 'apps', name: 'Apps', repoPatterns: ['github.com/example-org/*'] });
    expect(team.status, team.text).toBe(201);
    expect(teamResponseSchema.parse(team.json).repoPatterns).toEqual(['example-org/*']);
    expect((await post(owner, '/teams', { key: 'twice', name: 'Twice', repoPatterns: ['github.com/example-org/*', 'example-org/*'] })).json.code).toBe('invalid_input');
    expect((await post(owner, '/teams', { key: 'nowhere', name: 'Nowhere', repoPatterns: ['github.com/*'] })).json.code).toBe('invalid_input');
  });
});
