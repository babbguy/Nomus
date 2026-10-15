/**
 * Snippet and bulk proposals, votes and decisions (E54 to E57, E59) on the
 * real app and a real database: quorum across boards, the config version a
 * decision records when the config changes mid-proposal, the signed payload,
 * the self-approval ban in code and in the database, bulk homogeneity and the
 * bulk-on-prohibited CHECK, vetoes, rejections, expiry revalidation, the case
 * reaching `decided`, and org isolation. Every success response is parsed
 * with its contract.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { fingerprintOf, findingsStatusResponseSchema, requestReviewResponseSchema } from '@nomus/scanner/corporate';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import { castVoteResponseSchema, decisionResponseSchema, proposalDetailResponseSchema, proposalListResponseSchema } from '../../../cpg/contracts.js';
import { listAuditEventsByAction, verifyAuditChain } from '../../../cpg/audit/log.js';
import { cpgVerify } from '../../../cpg/policies/signing.js';
import { caseFixtures } from '../../../cpg/__fixtures__/case-fixtures.js';
import { call, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
const REPO = 'gate.example.org/team/app';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const RATIONALE = 'The vendor SDK call is reviewed and accepted for this release.';
let orgId: string;
let owner: TestUser;
let dev: TestUser; // opens the cases (Developer)
let ai: TestUser; // case_reviewer, AI board
let legal: TestUser; // case_reviewer, Legal board
let justifier: TestUser; // case_reviewer, Legal board, and writes a justification in the shared case
let outsider: TestUser; // Developer in another org

const finding = (code: string, key: string, filePath = 'src/chat.ts') =>
  ({ fingerprint: fingerprintOf(code, key, 1), policyKey: key, policyVersion: 1, filePath, startLine: 3, endLine: 3, language: 'typescript' as const, snippet: code });
/** A distinct finding per test: decisions bind (repo, fingerprint), so tests must not share one. */
const f = (key: string, tag: string) => finding(`call_${tag.replace(/-/g, '_')}(client);`, key, `src/${tag}.ts`);
const [OPENAI, OPENAI2] = [f('corp.no-openai', 'quorum'), f('corp.no-openai', 'dup')];
const [OPENAI_S, PII_S] = [f('corp.no-openai', 'self'), f('corp.no-pii', 'self')];
const [OPENAI_B1, OPENAI_B2] = [f('corp.no-openai', 'bulk-1'), f('corp.no-openai', 'bulk-2')];
const [PII, PII2, LOGS] = [f('corp.no-pii', 'bulk-1'), f('corp.no-pii', 'bulk-2'), f('corp.no-logs', 'bulk')];
const LOGS_R = f('corp.no-logs', 'reject');
const OPENAI_V = f('corp.no-openai', 'veto');
const [OPENAI_E, PII_E, ADVISORY] = [f('corp.no-openai', 'eligible'), f('corp.no-pii', 'eligible'), f('corp.advice', 'eligible')];
const OPENAI_X = f('corp.no-openai', 'expiry');
const PII_I = f('corp.no-pii', 'isolation');

async function openCase(branch: string, findings: Array<ReturnType<typeof finding>>) {
  const res = await call(app, 'POST', '/api/v1/cpg/cases/request-review', {
    cookie: dev.cookie,
    body: { repo: REPO, branch, headSha: null, bundleHash: 'b'.repeat(64), findings, justifications: findings.map((f) => ({ fingerprint: f.fingerprint, body: 'Needed until the gateway client supports streaming.' })) },
  });
  expect(res.status).toBe(201);
  return requestReviewResponseSchema.parse(res.json).case;
}

const propose = (user: TestUser, body: Record<string, unknown>) => call(app, 'POST', '/api/v1/cpg/proposals', { cookie: user.cookie, body: { rationale: RATIONALE, ...body } });
const vote = (user: TestUser, id: string, v: 'approve' | 'reject') => call(app, 'POST', `/api/v1/cpg/proposals/${id}/votes`, { cookie: user.cookie, body: { vote: v } });
const approveSnippet = (caseId: string, fd: ReturnType<typeof finding>, days = 30) => ({ caseId, scope: 'snippet', outcome: 'approve', fingerprints: [fd.fingerprint], expiresAt: inDays(days) });
const status = async (branch: string, fd: ReturnType<typeof finding>) => findingsStatusResponseSchema.parse((await call(app, 'POST', '/api/v1/cpg/findings/status', {
  cookie: dev.cookie, body: { repo: REPO, branch, fingerprints: [fd.fingerprint] },
})).json).items[0];

async function grant(user: TestUser, roleKey: string) {
  const roles = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie });
  const roleId = (roles.json.items as Array<{ id: string; key: string }>).find((r) => r.key === roleKey)!.id;
  expect((await call(app, 'POST', `/api/v1/cpg/users/${user.id}/grants`, { cookie: owner.cookie, body: { roleId, scopeType: 'org' } })).status).toBe(201);
}

async function putQuorum(edit: (config: any) => void) {
  const current = (await call(app, 'GET', '/api/v1/cpg/quorum', { cookie: owner.cookie })).json;
  edit(current.config);
  const res = await call(app, 'PUT', '/api/v1/cpg/quorum', { cookie: owner.cookie, body: { config: current.config, changeNote: 'Test change' } });
  expect(res.status).toBe(201);
  return res.json.version as number;
}

function sqliteCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Approvals');
  owner = makeUser(orgId);
  dev = makeUser(orgId);
  ai = makeUser(orgId);
  legal = makeUser(orgId);
  justifier = makeUser(orgId);
  for (const u of [ai, legal, justifier]) await grant(u, 'case_reviewer');
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  const aiBoard = insertBoard(orgId, 'ai');
  const legalBoard = insertBoard(orgId, 'legal');
  for (const [board, u] of [[aiBoard, ai], [legalBoard, legal], [legalBoard, justifier]] as const) {
    expect((await call(app, 'POST', `/api/v1/cpg/boards/${board}/members`, { cookie: owner.cookie, body: { userId: u.id } })).status).toBe(201);
  }
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard, legalBoard]);
  insertPolicy(orgId, 'corp.no-pii', 'review-required', [legalBoard]);
  insertPolicy(orgId, 'corp.no-logs', 'review-required', [legalBoard]);
  insertPolicy(orgId, 'corp.advice', 'advisory', [legalBoard]);
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
  const otherOrg = makeOrg('Elsewhere');
  makeUser(otherOrg);
  outsider = makeUser(otherOrg);
});

describe('prohibited snippet: two boards, quorum version at finalization, signed decision', () => {
  it('pending at 1 of 2, finalized by the second board under the config then in force', async () => {
    const kase = await openCase('feat/quorum', [OPENAI]);
    const created = await propose(ai, approveSnippet(kase.id, OPENAI));
    expect(created.status).toBe(201);
    const p = proposalDetailResponseSchema.parse(created.json);
    expect([p.status, p.votes.length, p.required.approvals, p.required.boardCoverage, p.decisionIds]).toEqual(['pending', 1, 2, 'all_owning', []]);
    expect((await status('feat/quorum', OPENAI)).status).toBe('pending');

    const v3 = await putQuorum((cfg) => { cfg.proposalLapseDays = 29; });
    expect(v3).toBeGreaterThan(p.quorumConfigVersionAtCreation);
    const voted = castVoteResponseSchema.parse((await vote(legal, p.id, 'approve')).json);
    expect([voted.proposalStatus, voted.decisionIds.length]).toEqual(['finalized', 1]);

    const d = decisionResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/decisions/${voted.decisionIds[0]}`, { cookie: dev.cookie })).json);
    expect([d.quorumConfigVersion, d.signatureValid, d.outcome, d.scope, d.batchId]).toEqual([v3, true, 'approve', 'snippet', null]);
    expect(JSON.parse(d.signedPayload)).toEqual({
      kind: 'nomus.cpg-decision.v1', id: d.id, orgId, proposalId: p.id, caseId: kase.id, scope: 'snippet', outcome: 'approve',
      repo: REPO, fingerprint: OPENAI.fingerprint, pattern: null, policyKey: 'corp.no-openai', policyVersion: 1,
      policyActivationSignatureSha256: createHash('sha256').update('sig').digest('hex'), expiresAt: p.requestedExpiresAt,
      approverUserIds: [ai.id, legal.id].sort(), quorumConfigVersion: v3, quorumConfigHash: d.quorumConfigHash, finalizedAt: d.finalizedAt,
    });
    expect(cpgVerify(d.signedPayload.replace('"approve"', '"reject"'), d.signature)).toBe(false);
    const after = proposalDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/proposals/${p.id}`, { cookie: dev.cookie })).json);
    expect([after.status, after.quorumConfigVersionAtCreation, after.viewer]).toEqual(['finalized', p.quorumConfigVersionAtCreation, { canVote: false, reason: 'proposal_not_pending' }]);

    const s = await status('feat/quorum', OPENAI);
    expect([s.status, s.blocking, s.decisionId, s.expiresAt]).toEqual(['approved', false, d.id, d.expiresAt]);
    const detail = (await call(app, 'GET', `/api/v1/cpg/cases/${kase.id}`, { cookie: dev.cookie })).json;
    expect(detail.case.state).toBe('decided');
    expect(detail.case.lanes.every((l: { state: string }) => l.state === 'decided')).toBe(true);
    expect(listAuditEventsByAction(getDb(), orgId, 'decision.recorded').some((e) => e.targetId === d.id)).toBe(true);
    expect(verifyAuditChain(getDb(), orgId).valid).toBe(true);
  });

  it('a second vote is 409 already_voted; a vote on a finalized proposal is 409 proposal_not_pending', async () => {
    const kase = await openCase('feat/dup', [OPENAI2]);
    const p = (await propose(ai, approveSnippet(kase.id, OPENAI2))).json;
    expect([(await vote(ai, p.id, 'approve')).json.code]).toEqual(['already_voted']);
    expect((await vote(legal, p.id, 'approve')).status).toBe(201);
    expect((await vote(justifier, p.id, 'approve')).json.code).toBe('proposal_not_pending');
  });
});

describe('self-approval is forbidden in code and by the database', () => {
  let caseId: string;
  let proposalId: string;

  beforeAll(async () => {
    caseId = (await openCase('feat/self', [OPENAI_S, PII_S])).id;
    // justifier holds case.review and sits on the Legal board, and justifies a finding of this case.
    const j = await call(app, 'POST', `/api/v1/cpg/cases/${caseId}/justifications`, { cookie: justifier.cookie, body: { fingerprint: PII_S.fingerprint, body: 'The log line is redacted downstream by the collector.' } });
    expect(j.status).toBe(201);
    proposalId = (await propose(ai, approveSnippet(caseId, OPENAI_S))).json.id;
  });

  it('a justification author with case.review: voting and proposing are 403 self_approval_forbidden', async () => {
    const res = await vote(justifier, proposalId, 'approve');
    expect([res.status, res.json.code]).toEqual([403, 'self_approval_forbidden']);
    expect((await propose(justifier, { caseId, scope: 'snippet', outcome: 'reject', fingerprints: [PII_S.fingerprint] })).json.code).toBe('self_approval_forbidden');
    const view = proposalDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/proposals/${proposalId}`, { cookie: justifier.cookie })).json);
    expect([view.votes.length, view.viewer]).toEqual([1, { canVote: false, reason: 'self_approval_forbidden' }]);
  });

  it('the opener, as a case reviewer on the board, is refused too', async () => {
    await grant(dev, 'case_reviewer');
    expect((await vote(dev, proposalId, 'approve')).json.code).toBe('self_approval_forbidden');
  });

  it('the trigger refuses a direct vote by the opener, a justification author and a revision creator', () => {
    const sqlite = rawSqlite(getDb());
    const now = new Date().toISOString();
    const reviser = makeUser(orgId);
    sqlite.prepare(`INSERT INTO cpg_case_revisions (id, case_id, org_id, revision, source, bundle_hash, findings_digest, added_count, carried_count, resolved_count, created_by, created_at)
      VALUES (?, ?, ?, 99, 'ci', ?, ?, 0, 0, 0, ?, ?)`).run(randomUUID(), caseId, orgId, 'a'.repeat(64), 'a'.repeat(64), `user:${reviser.id}`, now);
    const insertVote = (userId: string) => () => sqlite.prepare(`INSERT INTO cpg_votes (id, proposal_id, org_id, voter_user_id, vote, boards_at_vote, permissions_at_vote, created_at)
      VALUES (?, ?, ?, ?, 'approve', '[]', '[]', ?)`).run(randomUUID(), proposalId, orgId, userId, now);
    for (const u of [dev, justifier, reviser]) {
      expect(sqliteCode(insertVote(u.id))).toMatch(/^SQLITE_CONSTRAINT_TRIGGER: cpg_votes: self-approval is forbidden/);
    }
  });
});

describe('scopes: bulk homogeneity, bulk on prohibited, rejection, veto, eligibility', () => {
  it('bulk on a prohibited policy is 422 scope_not_allowed, and the database CHECK refuses it too', async () => {
    const kase = await openCase('feat/bulk-prohibited', [OPENAI_B1, OPENAI_B2]);
    const res = await propose(legal, { caseId: kase.id, scope: 'bulk', outcome: 'approve', fingerprints: [OPENAI_B1.fingerprint, OPENAI_B2.fingerprint], expiresAt: inDays(30) });
    expect([res.status, res.json.code]).toEqual([422, 'scope_not_allowed']);

    const sqlite = rawSqlite(getDb());
    const v = sqlite.prepare("SELECT id, policy_id FROM cpg_policy_versions WHERE org_id = ? AND tier = 'prohibited'").get(orgId) as { id: string; policy_id: string };
    const now = new Date().toISOString();
    const insert = () => sqlite.prepare(`INSERT INTO cpg_proposals (id, org_id, case_id, scope, outcome, policy_id, policy_version_id, policy_key, policy_version, tier,
      fingerprints, requested_expires_at, rationale, required, quorum_config_version_at_creation, proposer_user_id, created_at, lapses_at)
      VALUES (?, ?, ?, 'bulk', 'approve', ?, ?, 'corp.no-openai', 1, 'prohibited', ?, ?, ?, '{}', 1, ?, ?, ?)`)
      .run(randomUUID(), orgId, kase.id, v.policy_id, v.id, JSON.stringify([OPENAI_B1.fingerprint, OPENAI_B2.fingerprint]), inDays(30), RATIONALE, legal.id, now, inDays(30));
    expect(sqliteCode(insert)).toMatch(/^SQLITE_CONSTRAINT_CHECK: CHECK constraint failed: scope <> 'bulk' OR tier <> 'prohibited'/);
  });

  it('a bulk proposal must be one policy version (422 bulk_mixed_policies); a homogeneous one writes one decision per finding', async () => {
    const kase = await openCase('feat/bulk', [PII, PII2, LOGS]);
    const mixed = await propose(legal, { caseId: kase.id, scope: 'bulk', outcome: 'approve', fingerprints: [PII.fingerprint, LOGS.fingerprint], expiresAt: inDays(30) });
    expect([mixed.status, mixed.json.code]).toEqual([422, 'bulk_mixed_policies']);
    const bulk = proposalDetailResponseSchema.parse((await propose(legal, { caseId: kase.id, scope: 'bulk', outcome: 'approve', fingerprints: [PII.fingerprint, PII2.fingerprint], expiresAt: inDays(30) })).json);
    expect([bulk.status, bulk.decisionIds.length]).toEqual(['finalized', 2]);
    const decisions = await Promise.all(bulk.decisionIds.map(async (id) => decisionResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/decisions/${id}`, { cookie: dev.cookie })).json)));
    expect(decisions.map((d) => [d.scope, d.batchId, d.signatureValid]).sort()).toEqual([['bulk', bulk.id, true], ['bulk', bulk.id, true]]);
    expect(decisions.map((d) => d.fingerprint).sort()).toEqual([PII.fingerprint, PII2.fingerprint].sort());
    expect(listAuditEventsByAction(getDb(), orgId, 'decision.recorded').filter((e) => bulk.decisionIds.includes(e.targetId!))).toHaveLength(2);
  });

  it('a rejection by one eligible proposer is final at once, never expires and blocks', async () => {
    const kase = await openCase('feat/reject', [LOGS_R]);
    const p = proposalDetailResponseSchema.parse((await propose(legal, { caseId: kase.id, scope: 'snippet', outcome: 'reject', fingerprints: [LOGS_R.fingerprint] })).json);
    expect([p.status, p.requestedExpiresAt]).toEqual(['finalized', null]);
    const s = await status('feat/reject', LOGS_R);
    expect([s.status, s.blocking, s.decisionId, s.expiresAt]).toEqual(['rejected', true, p.decisionIds[0], null]);
    expect((await propose(legal, { caseId: kase.id, scope: 'snippet', outcome: 'reject', fingerprints: [LOGS_R.fingerprint], expiresAt: inDays(5) })).json.code).toBe('invalid_input');
  });

  it('one eligible reject vote vetoes an approval: no decision, the finding is undecided again', async () => {
    const kase = await openCase('feat/veto', [OPENAI_V]);
    const p = (await propose(ai, approveSnippet(kase.id, OPENAI_V))).json;
    const vetoed = castVoteResponseSchema.parse((await vote(legal, p.id, 'reject')).json);
    expect([vetoed.proposalStatus, vetoed.decisionIds]).toEqual(['vetoed', []]);
    expect((await status('feat/veto', OPENAI_V)).status).toBe('needs_review');
    const list = proposalListResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/proposals?caseId=${kase.id}&status=vetoed`, { cookie: dev.cookie })).json);
    expect(list.items.map((i) => i.id)).toEqual([p.id]);
  });

  it('eligibility, pending overlap, advisory and cross-org refusals', async () => {
    const kase = await openCase('feat/eligible', [OPENAI_E, PII_E, ADVISORY]);
    const stranger = makeUser(orgId);
    await grant(stranger, 'case_reviewer');
    expect((await propose(stranger, approveSnippet(kase.id, PII_E))).json.code).toBe('not_eligible_voter');
    expect((await propose(dev, approveSnippet(kase.id, PII_E))).json.code).toBe('self_approval_forbidden');
    expect((await propose(legal, approveSnippet(kase.id, ADVISORY))).json.code).toBe('advisory_needs_no_decision');
    expect((await propose(ai, approveSnippet(kase.id, OPENAI_E))).status).toBe(201);
    const overlap = await propose(legal, approveSnippet(kase.id, OPENAI_E));
    expect([overlap.status, overlap.json.code]).toEqual([409, 'proposal_pending']);
    expect((await call(app, 'GET', `/api/v1/cpg/proposals?caseId=${kase.id}`, { cookie: outsider.cookie })).status).toBe(404);
  });
});

describe('expiry (D5, §4.3 step 6)', () => {
  it('beyond the maximum is 422 expiry_out_of_range; a maximum lowered mid-proposal invalidates it at finalization', async () => {
    const kase = await openCase('feat/expiry', [OPENAI_X]);
    const tooLong = await propose(ai, approveSnippet(kase.id, OPENAI_X, 120));
    expect([tooLong.status, tooLong.json.code]).toEqual([422, 'expiry_out_of_range']);
    const p = (await propose(ai, approveSnippet(kase.id, OPENAI_X, 80))).json;
    await putQuorum((cfg) => { cfg.tiers.prohibited.snippet.maxExpiryDays = 60; cfg.tiers.prohibited.snippet.defaultExpiryDays = 30; });
    const res = castVoteResponseSchema.parse((await vote(legal, p.id, 'approve')).json);
    expect([res.proposalStatus, res.decisionIds]).toEqual(['invalidated', []]);
    const view = proposalDetailResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/proposals/${p.id}`, { cookie: dev.cookie })).json);
    expect(view.invalidation?.reason).toBe('expiry_out_of_range');
  });
});

describe('org isolation and identity', () => {
  it('another org gets 404 for a proposal and a decision; a vote from it is 404', async () => {
    const kase = await openCase('feat/iso', [PII_I]);
    const p = (await propose(legal, approveSnippet(kase.id, PII_I))).json;
    expect((await call(app, 'GET', `/api/v1/cpg/proposals/${p.id}`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await call(app, 'GET', `/api/v1/cpg/decisions/${p.decisionIds[0]}`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await vote(outsider, p.id, 'approve')).status).toBe(404);
  });
});
