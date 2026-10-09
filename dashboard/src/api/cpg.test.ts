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
  return { default: { get: respond('GET'), post: respond('POST'), patch: respond('PATCH') } };
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
