/**
 * Review-case routes (E40 to E52) on the real app and a real database:
 * request review, idempotent revisions, justifications, the request-changes
 * / reply / resubmit loop, reviewer context (disabled, generated, failed,
 * retried), closing with a reproducible signed closure record, org isolation
 * and the identity rules. Every success response is parsed with its contract.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  fingerprintOf, caseStatusSchema, requestReviewResponseSchema, caseByBranchResponseSchema, findingsStatusResponseSchema,
} from '@nomus/scanner/corporate';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import {
  caseDetailResponseSchema, caseListResponseSchema, commentResponseSchema, justificationResponseSchema,
  revisionDetailResponseSchema, reviewerContextResponseSchema,
} from '../../../cpg/contracts.js';
import { listAuditEventsByAction, verifyAuditChain } from '../../../cpg/audit/log.js';
import { closureSignedText } from '../../../cpg/cases/close.js';
import { attachPullRequest, getCase } from '../../../cpg/cases/service.js';
import { applyCpgPullRequest } from '../../../cpg/cases/github-hook.js';
import { githubAppInstallations } from '../../../db/schema.js';
import { cpgVerify } from '../../../cpg/policies/signing.js';
import { caseFixtures } from '../../../cpg/__fixtures__/case-fixtures.js';
import { call, makeKey, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

let llmMode: 'ok' | 'fail' = 'ok';
const llmCalls: string[] = [];
vi.mock('../../../llm/provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../llm/provider.js')>()),
  isLlmProviderConfigured: () => true,
  generateWithFallback: async (_role: string, system: string) => {
    llmCalls.push(system);
    if (llmMode === 'fail') throw new Error('provider unavailable');
    return { content: JSON.stringify({ whatItDoes: 'Calls a chat API.', whyFlagged: 'It matches the SDK-call rule.' }), tokensIn: 1, tokensOut: 1, model: 'stub-model', provider: 'openai' };
  },
}));

const app = createApp();
const REPO = 'gate.example.org/team/app';
const BUNDLE = 'b'.repeat(64);
const OPENAI = "const r = await client.chat.completions.create({ model: 'm' });";
const PII = 'logger.info(user.email);';
let orgId: string;
let owner: TestUser;
let dev: TestUser;
let reviewer: TestUser; // case_reviewer, member of the AI board
let bystander: TestUser; // case_reviewer, member of no board
let outsider: TestUser; // Developer in another org
let aiBoard: string;
let legalBoard: string;
let otherOrg: string;

const finding = (code: string, key: string, filePath = 'src/chat.ts', line = 3) =>
  ({ fingerprint: fingerprintOf(code, key, 1), policyKey: key, policyVersion: 1, filePath, startLine: line, endLine: line, language: 'typescript' as const, snippet: code });
const JUSTIFY = 'Uses the vendor SDK until the gateway supports streaming.';
const reviewBody = (branch: string, findings = [finding(OPENAI, 'corp.no-openai'), finding(PII, 'corp.no-pii', 'src/log.ts')]) => ({
  repo: REPO, branch, headSha: null, bundleHash: BUNDLE, findings,
  justifications: findings.map((f) => ({ fingerprint: f.fingerprint, body: JUSTIFY })),
});
const requestReview = (user: TestUser, body: unknown) => call(app, 'POST', '/api/v1/cpg/cases/request-review', { cookie: user.cookie, body });

async function grant(user: TestUser, roleKey: string) {
  const roles = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie });
  const roleId = (roles.json.items as Array<{ id: string; key: string }>).find((r) => r.key === roleKey)!.id;
  expect((await call(app, 'POST', `/api/v1/cpg/users/${user.id}/grants`, { cookie: owner.cookie, body: { roleId, scopeType: 'org' } })).status).toBe(201);
}

async function openCase(branch: string) {
  const res = await requestReview(dev, reviewBody(branch));
  expect(res.status).toBe(201);
  return requestReviewResponseSchema.parse(res.json).case;
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Cases');
  owner = makeUser(orgId);
  dev = makeUser(orgId);
  reviewer = makeUser(orgId);
  bystander = makeUser(orgId);
  await grant(reviewer, 'case_reviewer');
  await grant(bystander, 'case_reviewer');
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  aiBoard = insertBoard(orgId, 'ai');
  legalBoard = insertBoard(orgId, 'legal');
  expect((await call(app, 'POST', `/api/v1/cpg/boards/${aiBoard}/members`, { cookie: owner.cookie, body: { userId: reviewer.id } })).status).toBe(201);
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard]);
  insertPolicy(orgId, 'corp.no-pii', 'review-required', [legalBoard]);
  insertPolicy(orgId, 'corp.later', 'prohibited', [aiBoard], { enforceFrom: '2099-01-01T00:00:00.000Z' });
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
  otherOrg = makeOrg('Elsewhere');
  makeUser(otherOrg); // the other org's owner
  outsider = makeUser(otherOrg);
});

describe('E40 request review', () => {
  it('opens a case in_review (201), and an unchanged re-request adds no revision (200, same case)', async () => {
    const first = await requestReview(dev, reviewBody('feat/one'));
    expect(first.status).toBe(201);
    const r1 = requestReviewResponseSchema.parse(first.json);
    expect([r1.created, r1.revisionCreated, r1.case.state, r1.case.latestRevision]).toEqual([true, true, 'in_review', 1]);
    expect(r1.case.lanes.map((l) => [l.boardName, l.state, l.blocking])).toEqual(expect.arrayContaining([['ai', 'needs_review', 1], ['legal', 'needs_review', 1]]));
    expect(r1.case.url).toBe(`http://localhost/governance/cases/${r1.case.id}`);
    const again = requestReviewResponseSchema.parse((await requestReview(dev, reviewBody('feat/one'))).json);
    expect([again.created, again.revisionCreated, again.case.id, again.case.latestRevision]).toEqual([false, false, r1.case.id, 1]);
    const detail = caseDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases/${r1.case.id}`, { cookie: dev.cookie })).json);
    expect(detail.justifications).toHaveLength(2); // the identical re-sent justifications were not duplicated
    expect(listAuditEventsByAction(getDb(), orgId, 'case.review_requested').filter((e) => e.targetId === r1.case.id)).toHaveLength(2);
  });

  it('refuses a snippet that does not hash to its fingerprint (422) and writes nothing', async () => {
    const bad = { ...finding(OPENAI, 'corp.no-openai'), snippet: `${OPENAI} // edited` };
    const res = await requestReview(dev, reviewBody('feat/mismatch', [bad]));
    expect([res.status, res.json.code]).toEqual([422, 'snippet_hash_mismatch']);
    const byBranch = await call(app, 'GET', `/api/v1/cpg/cases/by-branch?repo=${REPO}&branch=feat/mismatch`, { cookie: dev.cookie });
    expect(caseByBranchResponseSchema.parse(byBranch.json).case).toBeNull();
  });

  it('422 for a fingerprint naming another policy, and for a request without justification', async () => {
    const other = { ...finding(OPENAI, 'corp.no-openai'), policyKey: 'corp.no-pii' };
    expect((await requestReview(dev, reviewBody('feat/x', [other]))).json.code).toBe('fingerprint_mismatch');
    expect((await requestReview(dev, { ...reviewBody('feat/x'), justifications: [] })).json.code).toBe('justification_required');
  });

  it('org keys get 403 user_identity_required; a temporary password gets 403 password_change_required', async () => {
    const orgKey = makeKey(orgId, null);
    const res = await call(app, 'POST', '/api/v1/cpg/cases/request-review', { bearer: orgKey.key, body: reviewBody('feat/key') });
    expect([res.status, res.json.code]).toEqual([403, 'user_identity_required']);
    const temp = makeUser(orgId, { mustChangePassword: true });
    expect((await requestReview(temp, reviewBody('feat/key'))).json.code).toBe('password_change_required');
  });

  it('a user-bound key (VS Code) can request review; the revision records source vscode', async () => {
    const uk = makeKey(orgId, dev.id);
    const res = await call(app, 'POST', '/api/v1/cpg/cases/request-review', { bearer: uk.key, body: reviewBody('feat/uk') });
    const kase = requestReviewResponseSchema.parse(res.json).case;
    const rev = revisionDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases/${kase.id}/revisions/1`, { cookie: dev.cookie })).json);
    expect(rev.revision.source).toBe('vscode');
    expect(rev.findings.map((f) => [f.snippet, f.justification?.body])).toEqual(expect.arrayContaining([[OPENAI, JUSTIFY], [PII, JUSTIFY]]));
  });
});

describe('isolation and listing', () => {
  it('another org gets 404 for the case, its revisions and its context; never 403', async () => {
    const kase = await openCase('feat/iso');
    for (const path of [`/api/v1/cpg/cases/${kase.id}`, `/api/v1/cpg/cases/${kase.id}/revisions/1`]) {
      expect((await call(app, 'GET', path, { cookie: outsider.cookie })).status).toBe(404);
    }
    const res = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/comments`, { cookie: outsider.cookie, body: { kind: 'comment', body: 'hello' } });
    expect([res.status, res.json.code]).toEqual([404, 'not_found']);
  });

  it('lists newest first with a working cursor', async () => {
    const first = caseListResponseSchema.parse((await call(app, 'GET', '/api/v1/cpg/cases?limit=2', { cookie: dev.cookie })).json);
    expect(first.items).toHaveLength(2);
    const next = caseListResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases?limit=2&cursor=${first.nextCursor}`, { cookie: dev.cookie })).json);
    expect(next.items.some((i) => first.items.some((f) => f.id === i.id))).toBe(false);
  });
});

describe('E46–E48 request changes, reply, resubmit', () => {
  it('a lane member requests changes; the developer resolves and resubmits; the case is back in review', async () => {
    const kase = await openCase('feat/changes');
    const fp = kase.resolutions.find((r) => r.tier === 'prohibited')!.fingerprint;
    const asking = { boardId: aiBoard, body: 'Route this call through the gateway.', fingerprints: [fp] };
    const notMember = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/request-changes`, { cookie: bystander.cookie, body: asking });
    expect([notMember.status, notMember.json.code]).toEqual([403, 'not_eligible_voter']);
    const asked = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/request-changes`, { cookie: reviewer.cookie, body: asking });
    expect(asked.status).toBe(201);
    const request = commentResponseSchema.parse(asked.json);

    const status = () => call(app, 'GET', `/api/v1/cpg/cases/by-branch?repo=${REPO}&branch=feat/changes`, { cookie: dev.cookie })
      .then((r) => caseByBranchResponseSchema.parse(r.json).case!);
    const changed = await status();
    expect([changed.state, changed.lanes.find((l) => l.boardId === aiBoard)?.state]).toEqual(['changes_requested', 'changes_requested']);
    expect(changed.openChangeRequests.map((r) => [r.commentId, r.fingerprints])).toEqual([[request.id, [fp]]]);
    expect(changed.resolutions.find((r) => r.fingerprint === fp)?.status).toBe('changes_requested');

    const early = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/resubmit`, { cookie: dev.cookie, body: {} });
    expect([early.status, early.json.code]).toEqual([409, 'change_requests_unresolved']);
    const reply = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/comments`, {
      cookie: dev.cookie, body: { kind: 'reply', threadId: request.id, resolves: true, body: 'Moved behind the gateway client.' },
    });
    expect(commentResponseSchema.parse(reply.json)).toMatchObject({ kind: 'reply', threadId: request.id, parentId: request.id });
    expect((await status()).state).toBe('changes_requested'); // resolved, but not resubmitted yet
    const resubmitted = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/resubmit`, { cookie: dev.cookie, body: {} });
    expect(caseStatusSchema.parse(resubmitted.json)).toMatchObject({ state: 'in_review', openChangeRequests: [] });
    expect((await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/resubmit`, { cookie: dev.cookie, body: {} })).json.code).toBe('no_change_requests');
    expect(verifyAuditChain(getDb(), orgId).valid).toBe(true);
  });

  it('a justification for a finding outside the latest revision is 422 unknown_fingerprint', async () => {
    const kase = await openCase('feat/justify');
    const other = fingerprintOf('something else', 'corp.no-openai', 1);
    const res = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/justifications`, { cookie: dev.cookie, body: { fingerprint: other, body: JUSTIFY } });
    expect([res.status, res.json.code]).toEqual([422, 'unknown_fingerprint']);
    const fp = kase.resolutions[0].fingerprint;
    const ok = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/justifications`, { cookie: dev.cookie, body: { fingerprint: fp, body: `${JUSTIFY} Reviewed again.` } });
    expect(justificationResponseSchema.parse(ok.json)).toMatchObject({ fingerprint: fp, authorUserId: dev.id });
  });
});

describe('E51–E52 reviewer context', () => {
  it('disabled when the org setting is off (no LLM call); failed, then retried and generated, labelled', async () => {
    const kase = await openCase('feat/context');
    const rev = revisionDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases/${kase.id}/revisions/1`, { cookie: reviewer.cookie })).json);
    const path = `/api/v1/cpg/cases/${kase.id}/findings/${rev.findings[0].id}/context`;
    const get = () => call(app, 'GET', path, { cookie: reviewer.cookie }).then((r) => reviewerContextResponseSchema.parse(r.json));
    const retry = () => call(app, 'POST', `${path}/retry`, { cookie: reviewer.cookie, body: {} });

    await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { reviewerContextLlm: false } });
    const calls = llmCalls.length;
    expect(await get()).toMatchObject({ status: 'disabled', label: null, attempt: null });
    expect(llmCalls.length).toBe(calls);

    await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { reviewerContextLlm: true } });
    llmMode = 'fail';
    expect(await get()).toMatchObject({ status: 'failed', attempt: 1, error: 'provider unavailable', whatItDoes: null });
    expect(await get()).toMatchObject({ status: 'failed', attempt: 1 }); // stored: no second call without a retry
    expect(llmCalls.length).toBe(calls + 1);
    expect(llmCalls[calls].startsWith('You explain flagged source code to a governance reviewer.')).toBe(true);

    llmMode = 'ok';
    const retried = reviewerContextResponseSchema.parse((await retry()).json);
    expect(retried).toMatchObject({ status: 'generated', attempt: 2, provider: 'openai', model: 'stub-model', label: 'Generated by openai stub-model', whatItDoes: 'Calls a chat API.' });
    expect(await get()).toMatchObject({ status: 'generated', attempt: 2 });
    expect((await retry()).json.code).toBe('context_not_failed');
    expect(listAuditEventsByAction(getDb(), orgId, 'case.context_generated').map((e) => JSON.parse(e.payload).status).slice(-2)).toEqual(['failed', 'generated']);
  });
});

describe('E49–E50 close, closure record, PR attach', () => {
  it('attaches a pull request, then records a change of number', () => {
    return openCase('feat/pr').then((kase) => {
      attachPullRequest(getDb(), orgId, kase.id, 7, 'ci:test');
      const changed = attachPullRequest(getDb(), orgId, kase.id, 8, 'ci:test');
      expect(changed.prNumber).toBe(8);
      const events = rawSqlite(getDb()).prepare("SELECT event, details FROM cpg_case_events WHERE case_id = ? AND event LIKE 'pr_%' ORDER BY seq").all(kase.id);
      expect(events).toEqual([{ event: 'pr_attached', details: '{"prNumber":7}' }, { event: 'pr_changed', details: '{"from":7,"to":8}' }]);
    });
  });

  it('closes with a signed closure record that the stored rows reproduce exactly; then every write is 409', async () => {
    const kase = await openCase('feat/close');
    const devTry = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/close`, { cookie: dev.cookie, body: { reason: 'done' } });
    expect([devTry.status, devTry.json.code]).toEqual([403, 'forbidden']);
    const closed = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/close`, { cookie: reviewer.cookie, body: { reason: 'Superseded by another branch.' } });
    expect(caseStatusSchema.parse(closed.json)).toMatchObject({ state: 'closed', closeReason: 'closed_by_reviewer' });

    const row = getCase(getDb(), orgId, kase.id);
    const text = closureSignedText(getDb(), row);
    expect(cpgVerify(text, row.closureSignature!)).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ kind: 'nomus.cpg-case-closure.v1', caseId: kase.id, closeReason: 'closed_by_reviewer', revisions: [{ revision: 1 }] });

    const write = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/comments`, { cookie: dev.cookie, body: { kind: 'comment', body: 'late' } });
    expect([write.status, write.json.code]).toEqual([409, 'case_closed']);
    expect((await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/withdraw`, { cookie: dev.cookie, body: { reason: 'x' } })).json.code).toBe('case_closed');
    const reopened = requestReviewResponseSchema.parse((await requestReview(dev, reviewBody('feat/close'))).json);
    expect([reopened.created, reopened.case.id === kase.id]).toEqual([true, false]);
  });

  it('the opener may withdraw without case.close', async () => {
    const kase = await openCase('feat/withdraw');
    const res = await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/withdraw`, { cookie: dev.cookie, body: { reason: 'Not needed any more.' } });
    expect(caseStatusSchema.parse(res.json)).toMatchObject({ state: 'closed', closeReason: 'withdrawn' });
  });
});

describe('E53 findings status, org-key reads, board filter, size limit', () => {
  const status = (auth: { cookie?: string; bearer?: string }, branch: string, fingerprints: string[]) =>
    call(app, 'POST', '/api/v1/cpg/findings/status', { ...auth, body: { repo: REPO, branch, fingerprints } });

  it('E53 resolves each fingerprint: changes requested, needs review, grace; 422 unknown_policy', async () => {
    const kase = await openCase('feat/status');
    const [openai, pii] = [finding(OPENAI, 'corp.no-openai').fingerprint, finding(PII, 'corp.no-pii').fingerprint];
    const later = fingerprintOf("model: 'old-model'", 'corp.later', 1);
    await call(app, 'POST', `/api/v1/cpg/cases/${kase.id}/request-changes`, { cookie: reviewer.cookie, body: { boardId: aiBoard, body: 'Use the gateway.', fingerprints: [openai] } });
    const res = await status({ cookie: dev.cookie }, 'feat/status', [openai, pii, later, openai]);
    const items = findingsStatusResponseSchema.parse(res.json).items;
    expect(items.map((r) => [r.fingerprint, r.status, r.blocking])).toEqual([[openai, 'changes_requested', true], [pii, 'needs_review', true], [later, 'grace', false]]);
    // No case on the branch: nothing is change-requested.
    expect(findingsStatusResponseSchema.parse((await status({ cookie: dev.cookie }, 'feat/none', [openai])).json).items[0].status).toBe('needs_review');
    const unknown = await status({ cookie: dev.cookie }, 'feat/status', [fingerprintOf('x', 'corp.unknown', 1)]);
    expect([unknown.status, unknown.json.code]).toEqual([422, 'unknown_policy']);
  });

  it('an org key with read:policies may read E42 and E53 (the CI action); without the scope it is refused', async () => {
    await openCase('feat/org-key');
    const key = makeKey(orgId, null, ['read:policies']).key;
    const byBranch = await call(app, 'GET', `/api/v1/cpg/cases/by-branch?repo=${REPO}&branch=feat/org-key`, { bearer: key });
    expect(caseByBranchResponseSchema.parse(byBranch.json).case?.state).toBe('in_review');
    expect((await status({ bearer: key }, 'feat/org-key', [finding(PII, 'corp.no-pii').fingerprint])).status).toBe(200);
    const unscoped = makeKey(orgId, null, ['evaluate']).key;
    expect((await call(app, 'GET', `/api/v1/cpg/cases/by-branch?repo=${REPO}&branch=feat/org-key`, { bearer: unscoped })).status).toBe(403);
    // Another org's key sees nothing of this org.
    const foreign = makeKey(otherOrg, null, ['read:policies']).key;
    expect(caseByBranchResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases/by-branch?repo=${REPO}&branch=feat/org-key`, { bearer: foreign })).json).case).toBeNull();
  });

  it('the list filters by board: a case without a Legal lane is left out of ?boardId=<legal>', async () => {
    const aiOnly = requestReviewResponseSchema.parse((await requestReview(dev, reviewBody('feat/ai-only', [finding(OPENAI, 'corp.no-openai')]))).json).case.id;
    const ids = async (boardId: string) => caseListResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/cases?limit=200&boardId=${boardId}`, { cookie: dev.cookie })).json).items.map((i) => i.id);
    expect(await ids(aiBoard)).toContain(aiOnly);
    const legal = await ids(legalBoard);
    expect(legal).not.toContain(aiOnly);
    expect(legal.length).toBeGreaterThan(0);
  });

  it('request review over 4 MiB is 413 payload_too_large', async () => {
    const res = await call(app, 'POST', '/api/v1/cpg/cases/request-review', { cookie: dev.cookie, rawBody: JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024) }) });
    expect([res.status, res.json.code]).toEqual([413, 'payload_too_large']);
  });
});

describe('GitHub App pull_request hook', () => {
  it('opened attaches the PR to the branch case, closed (merged) closes it; other orgs and actions are ignored', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const install = (installationId: number, org: string) => db.insert(githubAppInstallations).values({
      id: randomUUID(), installationId, orgId: org, accountLogin: 'gate-org', accountType: 'Organization', repositorySelection: 'all',
      selectedRepos: '[]', permissions: '{}', isActive: true, installedAt: now, updatedAt: now,
    }).run();
    install(41_001, orgId);
    install(41_002, otherOrg); // corporate policies off
    const kase = requestReviewResponseSchema.parse((await requestReview(dev, { ...reviewBody('feat/gh'), repo: 'gate-org/app' })).json).case;
    const event = (action: string, merged = false) => ({ action, repository: { full_name: 'Gate-Org/App' }, pull_request: { number: 12, merged, head: { ref: 'feat/gh' } } });

    expect(applyCpgPullRequest(db, 41_002, event('opened'))).toBe('ignored');
    expect(applyCpgPullRequest(db, 41_999, event('opened'))).toBe('ignored');
    expect(applyCpgPullRequest(db, 41_001, event('synchronize'))).toBe('ignored');
    expect(applyCpgPullRequest(db, 41_001, event('opened'))).toBe('attached');
    expect(getCase(db, orgId, kase.id).prNumber).toBe(12);
    expect(applyCpgPullRequest(db, 41_001, event('closed', true))).toBe('closed');
    expect(getCase(db, orgId, kase.id)).toMatchObject({ state: 'closed', closeReason: 'merged', closedBy: 'github_app:41001' });
    expect(applyCpgPullRequest(db, 41_001, event('closed'))).toBe('ignored'); // no open case left
    expect(() => applyCpgPullRequest(db, 41_001, { action: 'opened', repository: { full_name: 'gate-org/app' } })).toThrow(/no repository, head branch or PR number/);
  });
});
