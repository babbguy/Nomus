import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fx from '../test/cpg-fixtures';

// The axios instance is replaced; every call is recorded and answered from `reply`.
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let reply: unknown = null;
vi.mock('./client', () => {
  const respond = (method: string) => (url: string, body?: unknown) => {
    calls.push({ method, url, body });
    return Promise.resolve({ data: reply });
  };
  return { default: { get: respond('GET'), post: respond('POST'), patch: respond('PATCH'), put: respond('PUT') } };
});

const cpg = await import('./cpg');

beforeEach(() => {
  calls.length = 0;
  reply = null;
});

describe('cpg API client: requests', () => {
  it('reads the RBAC lists from their endpoints and unwraps items', async () => {
    reply = { items: fx.users };
    expect(await cpg.listOrgUsers()).toEqual(fx.users);
    reply = { items: fx.roles };
    expect(await cpg.listRoles()).toEqual(fx.roles);
    reply = { items: fx.teams };
    expect(await cpg.listTeams()).toEqual(fx.teams);
    reply = { items: fx.permissions };
    expect(await cpg.listPermissions()).toEqual(fx.permissions);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /cpg/users', 'GET /cpg/roles', 'GET /cpg/teams', 'GET /cpg/permissions']);
  });

  it('GET /cpg/me and GET /cpg/settings', async () => {
    reply = fx.me();
    expect((await cpg.getCpgMe()).user.email).toBe('owner@example.org');
    reply = fx.settings;
    expect(await cpg.getCpgSettings()).toEqual(fx.settings);
    expect(calls.map((c) => c.url)).toEqual(['/cpg/me', '/cpg/settings']);
  });

  it('an org-scoped grant sends no scopeId; team and repo grants send it', async () => {
    reply = fx.users[0].grants[0];
    await cpg.createGrant(fx.DEV_ID, { roleId: fx.ROLE_DEV_ID, scopeType: 'org', scopeId: 'ignored' });
    await cpg.createGrant(fx.DEV_ID, { roleId: fx.ROLE_CUSTOM_ID, scopeType: 'team', scopeId: fx.TEAM_ID });
    await cpg.createGrant(fx.DEV_ID, { roleId: fx.ROLE_CUSTOM_ID, scopeType: 'repo', scopeId: 'example-org/api' });
    expect(calls).toEqual([
      { method: 'POST', url: `/cpg/users/${fx.DEV_ID}/grants`, body: { roleId: fx.ROLE_DEV_ID, scopeType: 'org' } },
      { method: 'POST', url: `/cpg/users/${fx.DEV_ID}/grants`, body: { roleId: fx.ROLE_CUSTOM_ID, scopeType: 'team', scopeId: fx.TEAM_ID } },
      { method: 'POST', url: `/cpg/users/${fx.DEV_ID}/grants`, body: { roleId: fx.ROLE_CUSTOM_ID, scopeType: 'repo', scopeId: 'example-org/api' } },
    ]);
  });

  it('write calls use the documented methods, paths and bodies', async () => {
    reply = fx.roles[2];
    await cpg.createRole({ key: 'repo_reader', name: 'Repo Reader', permissions: ['case.read'] });
    await cpg.updateRole(fx.ROLE_CUSTOM_ID, { permissions: ['case.read', 'case.comment'] });
    await cpg.archiveRole(fx.ROLE_CUSTOM_ID);
    reply = { user: fx.users[1], tempPassword: 'temp-value' };
    await cpg.inviteOrgUser({ email: 'dev@example.org', name: 'Dev Two', roleKeys: ['auditor'] });
    reply = fx.users[1];
    await cpg.updateOrgUser(fx.DEV_ID, { isActive: false });
    reply = { ...fx.users[1].grants[0], revokedAt: '2026-10-08T13:00:00.000Z', revokedBy: `user:${fx.OWNER_ID}`, revokeReason: 'left the team' };
    await cpg.revokeGrant(fx.users[1].grants[0].id, 'left the team');
    reply = fx.teams[0];
    await cpg.createTeam({ key: 'payments', name: 'Payments', repoPatterns: ['example-org/payments-*'] });
    await cpg.updateTeam(fx.TEAM_ID, { archived: true });
    reply = fx.settings;
    await cpg.updateCpgSettings({ reviewerContextLlm: false });
    expect(calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`)).toEqual([
      'POST /cpg/roles {"key":"repo_reader","name":"Repo Reader","permissions":["case.read"]}',
      `PATCH /cpg/roles/${fx.ROLE_CUSTOM_ID} {"permissions":["case.read","case.comment"]}`,
      `POST /cpg/roles/${fx.ROLE_CUSTOM_ID}/archive {}`,
      'POST /cpg/users {"email":"dev@example.org","name":"Dev Two","roleKeys":["auditor"]}',
      `PATCH /cpg/users/${fx.DEV_ID} {"isActive":false}`,
      `POST /cpg/grants/${fx.users[1].grants[0].id}/revoke {"reason":"left the team"}`,
      'POST /cpg/teams {"key":"payments","name":"Payments","repoPatterns":["example-org/payments-*"]}',
      `PATCH /cpg/teams/${fx.TEAM_ID} {"archived":true}`,
      'PATCH /cpg/settings {"reviewerContextLlm":false}',
    ]);
  });

  it('builds the audit query string, including the opaque cursor', async () => {
    reply = { items: fx.auditEvents, nextCursor: 'c2VxOjE', chainValid: true };
    const page = await cpg.listAuditEvents({ action: 'grant.created', since: '2026-10-01T00:00:00.000Z', cursor: 'c2VxOjM', limit: 50 });
    expect(calls[0].url).toBe('/cpg/audit?action=grant.created&since=2026-10-01T00%3A00%3A00.000Z&cursor=c2VxOjM&limit=50');
    expect(page.chainValid).toBe(true);
    expect(page.nextCursor).toBe('c2VxOjE');
    expect(cpg.auditQueryString({})).toBe('');
  });
});

describe('cpg API client: response contracts', () => {
  it('rejects a response missing a field, naming the endpoint and the field', async () => {
    const { chainValid: _drop, ...rest } = { items: fx.auditEvents, nextCursor: null, chainValid: true };
    reply = rest;
    await expect(cpg.listAuditEvents()).rejects.toThrow(/Unexpected response from GET \/cpg\/audit \(chainValid/);
  });

  it('rejects a timestamp that is not ISO-8601 UTC', async () => {
    reply = { ...fx.settings, updatedAt: '10/08/2026' };
    await expect(cpg.getCpgSettings()).rejects.toBeInstanceOf(cpg.CpgContractError);
  });

  it('rejects an id that is not a UUID, and unexpected fields', async () => {
    reply = { items: [{ ...fx.teams[0], id: '50b16273849546a79fb8203142536475' }] };
    await expect(cpg.listTeams()).rejects.toThrow(/items\.0\.id/);
    reply = { ...fx.me(), extra: true };
    await expect(cpg.getCpgMe()).rejects.toThrow(/GET \/cpg\/me/);
  });

  it('rejects a grant with an unknown scope type', async () => {
    reply = { ...fx.users[0].grants[0], scopeType: 'board' };
    await expect(cpg.createGrant(fx.OWNER_ID, { roleId: fx.ROLE_DEV_ID, scopeType: 'org' })).rejects.toThrow(/scopeType/);
  });

  it('accepts every fixture shaped like the documented responses', () => {
    expect(() => cpg.meSchema.parse(fx.me())).not.toThrow();
    expect(() => cpg.listOf(cpg.orgUserSchema).parse({ items: fx.users })).not.toThrow();
    expect(() => cpg.listOf(cpg.roleSchema).parse({ items: fx.roles })).not.toThrow();
    expect(() => cpg.auditListSchema.parse({ items: fx.auditEvents, nextCursor: null, chainValid: false })).not.toThrow();
  });
});

describe('cpg API client: boards, quorum, compile and the policy log (E19–E37)', () => {
  it('board reads and writes use the documented methods, paths and bodies', async () => {
    reply = { items: fx.boards };
    expect(await cpg.listBoards()).toEqual(fx.boards);
    reply = fx.boards[1];
    await cpg.createBoard({ key: 'legal', name: 'Legal Board', kind: 'legal' });
    await cpg.updateBoard(fx.BOARD_LEGAL_ID, { description: 'Contracts and privacy' });
    await cpg.archiveBoard(fx.BOARD_LEGAL_ID);
    reply = fx.boards[0].members[0];
    await cpg.addBoardMember(fx.BOARD_AI_ID, fx.APPROVER_ID);
    await cpg.removeBoardMember(fx.BOARD_AI_ID, fx.APPROVER_ID);
    expect(calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`)).toEqual([
      'GET /cpg/boards undefined',
      'POST /cpg/boards {"key":"legal","name":"Legal Board","kind":"legal"}',
      `PATCH /cpg/boards/${fx.BOARD_LEGAL_ID} {"description":"Contracts and privacy"}`,
      `POST /cpg/boards/${fx.BOARD_LEGAL_ID}/archive {}`,
      `POST /cpg/boards/${fx.BOARD_AI_ID}/members {"userId":"${fx.APPROVER_ID}"}`,
      `POST /cpg/boards/${fx.BOARD_AI_ID}/members/${fx.APPROVER_ID}/remove {}`,
    ]);
  });

  it('quorum: read, history, one version, and a new version with its change note', async () => {
    reply = fx.quorumVersion;
    expect((await cpg.getQuorum()).version).toBe(2);
    await cpg.putQuorum(fx.quorumConfig, 'Longer proposal window');
    await cpg.getQuorumVersion(1);
    reply = { items: [{ version: 1, configHash: 'f'.repeat(64), changeNote: '', createdAt: '2026-10-08T12:00:00.000Z', createdBy: 'system:seed' }] };
    expect((await cpg.listQuorumVersions())[0].createdBy).toBe('system:seed');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /cpg/quorum', 'PUT /cpg/quorum', 'GET /cpg/quorum/versions/1', 'GET /cpg/quorum/versions']);
    expect(calls[1].body).toEqual({ config: fx.quorumConfig, changeNote: 'Longer proposal window' });
  });

  it('compile sends policyId only for a new version; examples go to the engine as given', async () => {
    reply = fx.compiledRecord;
    const examples = { violating: [{ path: 'src/a.ts', code: 'x' }], compliant: [] };
    await cpg.compilePolicy({ plainText: 'No new code may reference gpt-4-32k anywhere.', examples });
    await cpg.compilePolicy({ plainText: 'No new code may reference gpt-4-32k anywhere.', policyId: fx.POLICY_ID, examples });
    await cpg.getCompileRecord(fx.COMPILE_V2_ID);
    expect(calls[0].body).toEqual({ plainText: 'No new code may reference gpt-4-32k anywhere.', examples });
    expect(calls[1].body).toEqual({ plainText: 'No new code may reference gpt-4-32k anywhere.', policyId: fx.POLICY_ID, examples });
    expect(calls[2].url).toBe(`/cpg/compile/${fx.COMPILE_V2_ID}`);
  });

  it('propose sends graceDays or enforceFrom (never both), an edited rule only when given, and the key only for a new policy', async () => {
    reply = fx.policyDetail;
    const base = { compileRecordId: fx.COMPILE_V2_ID, title: 'Do not use gpt-4-32k', tier: 'prohibited' as const, owningBoardIds: [fx.BOARD_AI_ID] };
    await cpg.proposePolicy({ ...base, policyKey: 'corp.no-gpt-4-32k', graceDays: 0, enforceFrom: '2026-12-01T00:00:00.000Z' });
    await cpg.proposePolicyVersion(fx.POLICY_ID, { ...base, enforceFrom: '2026-12-01T00:00:00.000Z', rule: fx.sdkRule });
    await cpg.proposeRetirement(fx.POLICY_ID, 'Model fully removed');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /cpg/policies', `POST /cpg/policies/${fx.POLICY_ID}/versions`, `POST /cpg/policies/${fx.POLICY_ID}/retire`]);
    expect(calls[0].body).toEqual({ ...base, graceDays: 0, policyKey: 'corp.no-gpt-4-32k' });
    expect(calls[1].body).toEqual({ ...base, rule: fx.sdkRule, enforceFrom: '2026-12-01T00:00:00.000Z' });
    expect(calls[2].body).toEqual({ reason: 'Model fully removed' });
  });

  it('votes, withdrawals and the policy log', async () => {
    reply = { vote: { ...fx.policyDetail.votes[0], versionId: fx.V2_ID }, versionState: 'active' };
    expect((await cpg.voteOnVersion(fx.V2_ID, 'approve', '  ok  ')).versionState).toBe('active');
    await cpg.voteOnVersion(fx.V2_ID, 'reject', '   ');
    reply = fx.policyDetail;
    await cpg.withdrawVersion(fx.V2_ID);
    await cpg.getPolicy(fx.POLICY_ID);
    reply = { items: [fx.policyHead] };
    await cpg.listPolicies();
    await cpg.listPolicies('proposed');
    expect(calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`)).toEqual([
      `POST /cpg/policy-versions/${fx.V2_ID}/votes {"vote":"approve","comment":"ok"}`,
      `POST /cpg/policy-versions/${fx.V2_ID}/votes {"vote":"reject"}`,
      `POST /cpg/policy-versions/${fx.V2_ID}/withdraw {}`,
      `GET /cpg/policies/${fx.POLICY_ID} undefined`,
      'GET /cpg/policies undefined',
      'GET /cpg/policies?state=proposed undefined',
    ]);
  });

  it('accepts the Phase 2 fixtures and refuses drift', async () => {
    expect(() => cpg.listOf(cpg.boardSchema).parse({ items: fx.boards })).not.toThrow();
    expect(() => cpg.compileRecordSchema.parse(fx.compiledRecord)).not.toThrow();
    expect(() => cpg.compileRecordSchema.parse(fx.unexpressibleRecord)).not.toThrow();
    expect(() => cpg.compileRecordSchema.parse(fx.examplesRecord)).not.toThrow();
    expect(() => cpg.policyDetailSchema.parse(fx.policyDetail)).not.toThrow();
    expect(() => cpg.quorumVersionSchema.parse(fx.quorumVersion)).not.toThrow();
    reply = { ...fx.policyHead, inGracePeriod: 'yes' };
    reply = { items: [reply] };
    await expect(cpg.listPolicies()).rejects.toThrow(/GET \/cpg\/policies \(items\.0\.inGracePeriod/);
    reply = { ...fx.quorumVersion, config: { ...fx.quorumConfig, tiers: { ...fx.quorumConfig.tiers, prohibited: { ...fx.quorumConfig.tiers.prohibited, bulk: fx.quorumConfig.tiers['review-required'].bulk } } } };
    await expect(cpg.getQuorum()).rejects.toBeInstanceOf(cpg.CpgContractError);
    reply = { ...fx.compiledRecord, status: 'maybe' };
    await expect(cpg.getCompileRecord(fx.COMPILE_V2_ID)).rejects.toThrow(/status/);
  });
});
