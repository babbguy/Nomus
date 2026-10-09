/**
 * Standing exceptions, revocation and the daily sweep (E54, E57, E58, E60,
 * design spec §7) on the real app and a real database: the expiry bound, the
 * quorum with exception.approve, resolution to `excepted`, teams resolved at
 * match time, the self-approval ban for every covered case, revocation (once,
 * signed, immutable) and the sweep's idempotent notices and case moves.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { fingerprintOf, findingsStatusResponseSchema, requestReviewResponseSchema } from '@nomus/scanner/corporate';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import { exceptionListResponseSchema, proposalDetailResponseSchema, revocationResponseSchema } from '../../../cpg/contracts.js';
import { listAuditEventsByAction } from '../../../cpg/audit/log.js';
import { cpgVerify } from '../../../cpg/policies/signing.js';
import { EXPIRY_ACTION, sweepDecisions } from '../../../cpg/decisions/sweep.js';
import { caseFixtures } from '../../../cpg/__fixtures__/case-fixtures.js';
import { call, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
const REPO = 'gate.example.org/team/app';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const RATIONALE = 'The legacy client is retired with the next platform release.';
let orgId: string;
let owner: TestUser;
let dev: TestUser; // opens the cases
let ai: TestUser; // case_reviewer, AI board
let legal: TestUser; // case_reviewer and exception_approver, Legal board
let approver: TestUser; // exception_approver, proposes and revokes

const finding = (tag: string, key: string, filePath: string) => {
  const code = `legacy_${tag}(client);`;
  return { fingerprint: fingerprintOf(code, key, 1), policyKey: key, policyVersion: 1, filePath, startLine: 2, endLine: 2, language: 'typescript' as const, snippet: code };
};
type Finding = ReturnType<typeof finding>;

async function openCase(branch: string, findings: Finding[]) {
  const res = await call(app, 'POST', '/api/v1/cpg/cases/request-review', {
    cookie: dev.cookie,
    body: { repo: REPO, branch, headSha: null, bundleHash: 'b'.repeat(64), findings, justifications: findings.map((f) => ({ fingerprint: f.fingerprint, body: 'Kept until the gateway client replaces it.' })) },
  });
  expect(res.status).toBe(201);
  return requestReviewResponseSchema.parse(res.json).case;
}

const post = (user: TestUser, path: string, body: unknown) => call(app, 'POST', `/api/v1/cpg${path}`, { cookie: user.cookie, body });
const pattern = (paths: string[], extra: Record<string, unknown> = {}) => ({ repos: [REPO], paths, policyKey: 'corp.no-openai', policyVersion: 1, ...extra });
const proposeStanding = (p: Record<string, unknown>, days = 30, user = approver) => post(user, '/proposals', { scope: 'standing', pattern: p, expiresAt: inDays(days), rationale: RATIONALE });
const vote = (user: TestUser, id: string) => post(user, `/proposals/${id}/votes`, { vote: 'approve' });
const caseState = async (id: string) => (await call(app, 'GET', `/api/v1/cpg/cases/${id}`, { cookie: dev.cookie })).json.case.state as string;
const status = async (branch: string, f: Finding) => findingsStatusResponseSchema.parse((await post(dev, '/findings/status', { repo: REPO, branch, fingerprints: [f.fingerprint] })).json).items[0];

/** A finalized standing exception: proposed by `approver`, approved by both boards. */
async function finalized(p: Record<string, unknown>): Promise<string> {
  const id = (await proposeStanding(p)).json.id as string;
  expect((await vote(ai, id)).json.proposalStatus).toBe('pending');
  const done = await vote(legal, id);
  expect(done.json.proposalStatus).toBe('finalized');
  return done.json.decisionIds[0] as string;
}

async function grant(user: TestUser, roleKey: string) {
  const roleId = ((await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie })).json.items as Array<{ id: string; key: string }>).find((r) => r.key === roleKey)!.id;
  expect((await post(owner, `/users/${user.id}/grants`, { roleId, scopeType: 'org' })).status).toBe(201);
}

let legalBoard: string;
beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Exceptions');
  [owner, dev, ai, legal, approver] = [makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId)];
  for (const [u, role] of [[ai, 'case_reviewer'], [legal, 'case_reviewer'], [legal, 'exception_approver'], [approver, 'exception_approver']] as const) await grant(u, role);
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  const aiBoard = insertBoard(orgId, 'ai');
  legalBoard = insertBoard(orgId, 'legal');
  for (const [board, u] of [[aiBoard, ai], [legalBoard, legal]] as const) expect((await post(owner, `/boards/${board}/members`, { userId: u.id })).status).toBe(201);
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard, legalBoard]);
  insertPolicy(orgId, 'corp.no-pii', 'review-required', [legalBoard]);
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
});

describe('standing exceptions', () => {
  const LEGACY = finding('a', 'corp.no-openai', 'src/legacy/a.ts');
  let caseId: string;
  let exceptionId: string;

  it('expiry beyond the maximum is 422; a valid one needs both boards and exception.approve, then excepts the finding', async () => {
    caseId = (await openCase('feat/legacy', [LEGACY])).id;
    expect((await proposeStanding(pattern(['src/legacy/**']), 120)).json.code).toBe('expiry_out_of_range');
    expect((await proposeStanding(pattern(['src/legacy/**'], { repos: ['**'] }))).json.code).toBe('org_wide_pattern_forbidden');
    expect((await proposeStanding(pattern(['src/[a]/**']))).json.code).toBe('invalid_glob');
    expect((await proposeStanding(pattern(['src/legacy/**']), 30, dev)).status).toBe(403);

    const created = await proposeStanding(pattern(['src/legacy/**']));
    const p = proposalDetailResponseSchema.parse(created.json);
    expect([created.status, p.status, p.votes.length, p.required.approvals, p.required.boardCoverage, p.required.requiredPermission, p.pattern?.paths])
      .toEqual([201, 'pending', 0, 2, 'all_owning', 'exception.approve', ['src/legacy/**']]);
    expect((await status('feat/legacy', LEGACY)).status).toBe('needs_review');
    expect((await vote(ai, p.id)).json.proposalStatus).toBe('pending');
    const done = await vote(legal, p.id);
    exceptionId = done.json.decisionIds[0];
    const s = await status('feat/legacy', LEGACY);
    expect([done.json.proposalStatus, s.status, s.blocking, s.exceptionDecisionId, s.decisionId]).toEqual(['finalized', 'excepted', false, exceptionId, null]);
    expect(await caseState(caseId)).toBe('decided');

    const d = (await call(app, 'GET', `/api/v1/cpg/decisions/${exceptionId}`, { cookie: owner.cookie })).json;
    expect([d.scope, d.repo, d.fingerprint, d.signatureValid, JSON.parse(d.signedPayload).pattern.paths]).toEqual(['standing', null, null, true, ['src/legacy/**']]);
    const list = (q: string) => call(app, 'GET', `/api/v1/cpg/exceptions${q}`, { cookie: dev.cookie }).then((r) => exceptionListResponseSchema.parse(r.json).items.map((x) => [x.id, x.status]));
    expect(await list(`?active=true&repo=${REPO}`)).toEqual([[exceptionId, 'active']]);
    expect(await list('?repo=gate.example.org/team/other')).toEqual([]);
  });

  it('a finding outside the pattern, or of a fingerprint the branch case does not hold, is not excepted', async () => {
    const NEW = finding('b', 'corp.no-openai', 'src/new/b.ts');
    await openCase('feat/new', [NEW]);
    expect((await status('feat/new', NEW)).status).toBe('needs_review');
    expect((await status('feat/none', LEGACY)).status).toBe('needs_review');
  });

  it('revocation: once, signed and immutable; the finding returns to needs_review and the case leaves decided', async () => {
    expect((await post(dev, `/decisions/${exceptionId}/revoke`, { reason: 'No longer needed here.' })).status).toBe(403);
    const res = await post(approver, `/decisions/${exceptionId}/revoke`, { reason: 'The legacy client was removed.' });
    const r = revocationResponseSchema.parse(res.json);
    expect([res.status, cpgVerify(r.signedPayload, r.signature), JSON.parse(r.signedPayload).decisionId]).toEqual([201, true, exceptionId]);
    expect((await status('feat/legacy', LEGACY)).status).toBe('needs_review');
    expect(await caseState(caseId)).toBe('in_review');
    const again = await post(approver, `/decisions/${exceptionId}/revoke`, { reason: 'The legacy client was removed.' });
    expect([again.status, again.json.code]).toEqual([409, 'already_revoked']);
    const sqlite = rawSqlite(getDb());
    for (const sql of ["UPDATE cpg_revocations SET reason = 'Edited after the fact.' WHERE id = ?", 'DELETE FROM cpg_revocations WHERE id = ?']) {
      expect(() => sqlite.prepare(sql).run(r.id)).toThrow(/append-only/);
    }
    const listed = exceptionListResponseSchema.parse((await call(app, 'GET', '/api/v1/cpg/exceptions', { cookie: dev.cookie })).json).items;
    expect(listed.find((x) => x.id === exceptionId)?.status).toBe('revoked');
  });

  it('teams are resolved at match time: archiving the team ends the cover', async () => {
    const TEAM = finding('c', 'corp.no-openai', 'src/team/c.ts');
    await openCase('feat/team', [TEAM]);
    const team = await post(owner, '/teams', { key: 'apps', name: 'Apps', repoPatterns: ['gate.example.org/team/*'] });
    await finalized(pattern(['src/team/**'], { repos: [], teamIds: [team.json.id] }));
    expect((await status('feat/team', TEAM)).status).toBe('excepted');
    expect((await call(app, 'PATCH', `/api/v1/cpg/teams/${team.json.id}`, { cookie: owner.cookie, body: { archived: true } })).status).toBe(200);
    expect((await status('feat/team', TEAM)).status).toBe('needs_review');
  });

  it('the opener of a covered case cannot vote; on an exception that covers none of their cases they can', async () => {
    await grant(dev, 'case_reviewer');
    expect((await post(owner, `/boards/${legalBoard}/members`, { userId: dev.id })).status).toBe(201);
    const covering = (await proposeStanding(pattern(['src/legacy/**']))).json.id;
    expect((await vote(dev, covering)).json.code).toBe('self_approval_forbidden');
    const other = (await proposeStanding(pattern(['src/elsewhere/**']))).json.id;
    const view = proposalDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/proposals/${other}`, { cookie: dev.cookie })).json);
    expect(view.viewer).toEqual({ canVote: true, reason: null });
  });
});

describe('the daily sweep', () => {
  const PII = finding('d', 'corp.no-pii', 'app/d.ts');

  it('notices once per threshold, and a case whose approval expired leaves decided', async () => {
    const kase = await openCase('feat/sweep', [PII]);
    const p = await post(legal, '/proposals', { caseId: kase.id, scope: 'snippet', outcome: 'approve', fingerprints: [PII.fingerprint], expiresAt: inDays(3), rationale: RATIONALE });
    const decisionId = p.json.decisionIds[0];
    expect(await caseState(kase.id)).toBe('decided');
    const notices = () => listAuditEventsByAction(getDb(), orgId, EXPIRY_ACTION).filter((e) => e.targetId === decisionId).map((e) => JSON.parse(e.payload).threshold);

    sweepDecisions(getDb());
    sweepDecisions(getDb());
    expect(notices()).toEqual(['7d']);
    expect(await caseState(kase.id)).toBe('decided');

    const later = new Date(Date.now() + 4 * DAY);
    expect(sweepDecisions(getDb(), later).casesMoved).toBeGreaterThanOrEqual(1);
    expect(sweepDecisions(getDb(), later)).toEqual({ notices: 0, casesMoved: 0 });
    expect(notices()).toEqual(['7d', 'expired']);
    expect(await caseState(kase.id)).toBe('in_review');
  });
});
