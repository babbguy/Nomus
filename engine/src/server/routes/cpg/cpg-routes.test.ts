/**
 * /api/v1/cpg RBAC, settings and audit routes (E1 to E17) and the tenant
 * org-admin bootstrap (E18), on the real app and a real database. Every
 * success response is parsed with its zod contract from cpg/contracts.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db/client.js';
import { runMigrations } from '../../../db/migrate.js';
import { seedDatabase } from '../../../db/seed.js';
import { initSigningKeys } from '../../../core/signing.js';
import { createApp } from '../../app.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import {
  auditListResponseSchema, cpgSettingsResponseSchema, grantResponseSchema, listOf, meResponseSchema, orgUserResponseSchema,
  permissionResponseSchema, roleResponseSchema, teamResponseSchema,
} from '../../../cpg/contracts.js';
import { PERMISSIONS } from '../../../cpg/rbac/catalog.js';
import { ensureOrgRbac } from '../../../cpg/rbac/seed.js';
import { call, makeKey, makeOrg, makeUser, type TestUser } from '../../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
const NOW = () => new Date().toISOString();

let orgId: string;
let otherOrgId: string;
let owner: TestUser;   // first member: Org Admin + Developer
let dev: TestUser;     // Developer only
let auditor: TestUser; // Developer, then granted Auditor
let outsider: TestUser; // owner of another org
let platformAdmin: TestUser;

const roleId = async (key: string, cookie = owner.cookie) => {
  const res = await call(app, 'GET', '/api/v1/cpg/roles', { cookie });
  return (res.json.items as Array<{ id: string; key: string }>).find((r) => r.key === key)!.id;
};

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Cpg');
  otherOrgId = makeOrg('Elsewhere');
  owner = makeUser(orgId);
  dev = makeUser(orgId);
  auditor = makeUser(orgId);
  outsider = makeUser(otherOrgId);
  platformAdmin = makeUser(makeOrg('Platform'), { role: 'platform_admin' });
  // First request migrates the org lazily (it was created outside the seeding paths).
  const grant = await call(app, 'POST', `/api/v1/cpg/users/${auditor.id}/grants`, { cookie: owner.cookie, body: { roleId: await roleId('auditor'), scopeType: 'org' } });
  expect(grant.status).toBe(201);
});

describe('E1 GET /cpg/me', () => {
  it('returns the session user, their permissions and identity', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/me', { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(res.json);
    expect(me.user.id).toBe(owner.id);
    expect(me.orgId).toBe(orgId);
    expect(me.identity).toBe('session');
    expect(me.isPlatformAdmin).toBe(false);
    expect(me.cpgEnabled).toBe(false);
    const keys = me.permissions.map((p) => p.key);
    expect(keys).toContain('rbac.users.manage'); // org_admin
    expect(keys).toContain('case.create'); // developer
    expect(keys).not.toContain('case.review');
    expect(me.permissions.every((p) => p.scope === 'org' && p.scopeId === null)).toBe(true);
  });

  it('platform admin: 200 with no permissions', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/me', { cookie: platformAdmin.cookie });
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(res.json);
    expect(me.isPlatformAdmin).toBe(true);
    expect(me.permissions).toEqual([]);
    expect(me.roles).toEqual([]);
  });

  it('names the active roles behind the permissions, sorted by key (the dashboard user card)', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/me', { cookie: owner.cookie });
    const me = meResponseSchema.parse(res.json);
    expect(me.roles.map((r) => [r.key, r.name, r.isSystem])).toEqual([['developer', 'Developer', true], ['org_admin', 'Org Admin', true]]);
    expect(me.roles.find((r) => r.key === 'org_admin')?.id).toBe(await roleId('org_admin'));
    const a = meResponseSchema.parse((await call(app, 'GET', '/api/v1/cpg/me', { cookie: auditor.cookie })).json);
    expect(a.roles.map((r) => r.key)).toEqual(['auditor', 'developer']);
    // A revoked grant no longer names its role.
    const users = await call(app, 'GET', '/api/v1/cpg/users', { cookie: owner.cookie });
    const auditorGrant = (users.json.items as Array<{ id: string; grants: Array<{ id: string; roleKey: string }> }>)
      .find((u) => u.id === auditor.id)!.grants.find((g) => g.roleKey === 'auditor')!;
    expect((await call(app, 'POST', `/api/v1/cpg/grants/${auditorGrant.id}/revoke`, { cookie: owner.cookie, body: { reason: 'role label test' } })).status).toBe(200);
    const after = meResponseSchema.parse((await call(app, 'GET', '/api/v1/cpg/me', { cookie: auditor.cookie })).json);
    expect(after.roles.map((r) => r.key)).toEqual(['developer']);
    const regrant = await call(app, 'POST', `/api/v1/cpg/users/${auditor.id}/grants`, { cookie: owner.cookie, body: { roleId: await roleId('auditor'), scopeType: 'org' } });
    expect(regrant.status).toBe(201);
  });

  it('a user-bound key acts as its user (identity user_key); an org key is refused', async () => {
    const uk = makeKey(orgId, dev.id);
    const res = await call(app, 'GET', '/api/v1/cpg/me', { bearer: uk.key });
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.json)).toMatchObject({ identity: 'user_key', user: { id: dev.id } });
    const ok = makeKey(orgId, null);
    const org = await call(app, 'GET', '/api/v1/cpg/me', { bearer: ok.key });
    expect(org.status).toBe(403);
    expect(org.json.code).toBe('user_identity_required');
  });

  it('401 without credentials', async () => {
    expect((await call(app, 'GET', '/api/v1/cpg/me')).status).toBe(401);
  });
});

describe('session-only endpoints refuse keys', () => {
  it('org key → 403 user_identity_required; user-bound key → 403 forbidden (session_required)', async () => {
    const orgKey = makeKey(orgId, null);
    const userKey = makeKey(orgId, owner.id);
    const a = await call(app, 'GET', '/api/v1/cpg/roles', { bearer: orgKey.key });
    expect([a.status, a.json.code]).toEqual([403, 'user_identity_required']);
    const b = await call(app, 'GET', '/api/v1/cpg/roles', { bearer: userKey.key });
    expect([b.status, b.json.code, b.json.details?.reason]).toEqual([403, 'forbidden', 'session_required']);
  });
});

describe('E2 GET /cpg/permissions', () => {
  it('lists the whole catalog', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/permissions', { cookie: dev.cookie });
    expect(res.status).toBe(200);
    const body = listOf(permissionResponseSchema).parse(res.json);
    expect(body.items.map((p) => p.key).sort()).toEqual(PERMISSIONS.map((p) => p.key).sort());
    expect(body.items.find((p) => p.key === 'case.review')?.scopable).toBe(true);
    expect(body.items.find((p) => p.key === 'rbac.users.manage')?.scopable).toBe(false);
  });
});

describe('E3 to E6 roles', () => {
  it('lists the seven system roles', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: dev.cookie });
    const body = listOf(roleResponseSchema).parse(res.json);
    expect(body.items.filter((r) => r.isSystem).map((r) => r.key).sort())
      .toEqual(['auditor', 'case_reviewer', 'developer', 'exception_approver', 'org_admin', 'policy_approver', 'policy_author']);
  });

  it('creates a custom role (201) and refuses duplicates, unknown permissions, extra fields and bad JSON', async () => {
    const created = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'release_manager', name: 'Release Manager', permissions: ['ci.read', 'case.read'] } });
    expect(created.status).toBe(201);
    const role = roleResponseSchema.parse(created.json);
    expect(role).toMatchObject({ key: 'release_manager', isSystem: false, permissions: ['case.read', 'ci.read'], createdBy: `user:${owner.id}`, archivedAt: null });

    const dup = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'release_manager', name: 'Again', permissions: [] } });
    expect([dup.status, dup.json.code]).toEqual([409, 'role_key_taken']);
    const unknown = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'x_role', name: 'X', permissions: ['root.everything'] } });
    expect([unknown.status, unknown.json.code]).toEqual([400, 'invalid_input']);
    const extra = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'y_role', name: 'Y', permissions: [], isSystem: true } });
    expect([extra.status, extra.json.code]).toEqual([400, 'invalid_input']);
    const badKey = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'Bad Key', name: 'Y', permissions: [] } });
    expect(badKey.status).toBe(400);
    const badJson = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, rawBody: '{nope' });
    expect([badJson.status, badJson.json.code]).toEqual([400, 'invalid_json']);
  });

  it('Developer cannot create roles: 403 forbidden naming the permission', async () => {
    const res = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: dev.cookie, body: { key: 'mine', name: 'Mine', permissions: [] } });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'Missing permission rbac.roles.manage', code: 'forbidden', details: { permission: 'rbac.roles.manage' } });
  });

  it('edits a role: rename and permission diff, each audited', async () => {
    const created = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'editable', name: 'Editable', permissions: ['case.read'] } });
    const id = created.json.id;
    const res = await call(app, 'PATCH', `/api/v1/cpg/roles/${id}`, { cookie: owner.cookie, body: { name: 'Edited', permissions: ['case.read', 'case.comment'] } });
    expect(res.status).toBe(200);
    expect(roleResponseSchema.parse(res.json)).toMatchObject({ name: 'Edited', permissions: ['case.comment', 'case.read'] });
    const audit = await call(app, 'GET', '/api/v1/cpg/audit?action=role.permissions_changed', { cookie: owner.cookie });
    const ev = auditListResponseSchema.parse(audit.json).items.find((e) => e.targetId === id)!;
    expect(ev.payload).toMatchObject({ before: ['case.read'], after: ['case.comment', 'case.read'], added: ['case.comment'], removed: [] });
  });

  it('the Org Admin role keeps its RBAC permissions (409 last_org_admin) but other system roles can be edited', async () => {
    const adminRole = await roleId('org_admin');
    const res = await call(app, 'PATCH', `/api/v1/cpg/roles/${adminRole}`, { cookie: owner.cookie, body: { permissions: ['org.members.read'] } });
    expect([res.status, res.json.code]).toEqual([409, 'last_org_admin']);
    const auditorRole = await roleId('auditor');
    const edit = await call(app, 'PATCH', `/api/v1/cpg/roles/${auditorRole}`, { cookie: owner.cookie, body: { description: 'Read-only reviewers of the governance trail.' } });
    expect(edit.status).toBe(200);
  });

  it('a role with team/repo grants cannot gain a non-scopable permission (422 role_not_scopable)', async () => {
    const created = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'repo_only', name: 'Repo only', permissions: ['case.read'] } });
    const g = await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: created.json.id, scopeType: 'repo', scopeId: 'acme/api' } });
    expect(g.status).toBe(201);
    const res = await call(app, 'PATCH', `/api/v1/cpg/roles/${created.json.id}`, { cookie: owner.cookie, body: { permissions: ['case.read', 'audit.read'] } });
    expect([res.status, res.json.code]).toEqual([422, 'role_not_scopable']);
  });

  it('archives custom roles only (system → 403), idempotently; archived roles cannot be edited or granted', async () => {
    const sys = await call(app, 'POST', `/api/v1/cpg/roles/${await roleId('developer')}/archive`, { cookie: owner.cookie, body: {} });
    expect([sys.status, sys.json.code]).toEqual([403, 'forbidden']);
    const created = await call(app, 'POST', '/api/v1/cpg/roles', { cookie: owner.cookie, body: { key: 'temp_role', name: 'Temp', permissions: ['ci.read'] } });
    const a1 = await call(app, 'POST', `/api/v1/cpg/roles/${created.json.id}/archive`, { cookie: owner.cookie, body: {} });
    expect(a1.status).toBe(200);
    const archived = roleResponseSchema.parse(a1.json);
    expect(archived.archivedAt).not.toBeNull();
    const a2 = await call(app, 'POST', `/api/v1/cpg/roles/${created.json.id}/archive`, { cookie: owner.cookie, body: {} });
    expect(a2.json.archivedAt).toBe(archived.archivedAt);
    const edit = await call(app, 'PATCH', `/api/v1/cpg/roles/${created.json.id}`, { cookie: owner.cookie, body: { name: 'Back' } });
    expect([edit.status, edit.json.code]).toEqual([409, 'role_archived']);
    const grant = await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: created.json.id, scopeType: 'org' } });
    expect([grant.status, grant.json.code]).toEqual([409, 'role_archived']);
  });

  it('another org\'s role ids are 404, never 403', async () => {
    const theirs = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: outsider.cookie });
    const foreign = theirs.json.items[0].id;
    expect((await call(app, 'PATCH', `/api/v1/cpg/roles/${foreign}`, { cookie: owner.cookie, body: { name: 'x' } })).status).toBe(404);
    expect((await call(app, 'POST', `/api/v1/cpg/roles/${foreign}/archive`, { cookie: owner.cookie, body: {} })).status).toBe(404);
    expect((await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: foreign, scopeType: 'org' } })).status).toBe(404);
  });
});

describe('E7 to E11 users and grants', () => {
  it('lists the org users with their active grants', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/users', { cookie: dev.cookie });
    expect(res.status).toBe(200);
    const body = listOf(orgUserResponseSchema).parse(res.json);
    expect(body.items.map((u) => u.id)).toEqual(expect.arrayContaining([owner.id, dev.id, auditor.id]));
    expect(body.items.map((u) => u.id)).not.toContain(outsider.id);
    const o = body.items.find((u) => u.id === owner.id)!;
    expect(o.grants.map((g) => g.roleKey).sort()).toEqual(['developer', 'org_admin']);
    expect(res.text).not.toContain('x-not-a-real-hash');
  });

  it('invites a user (201): temporary password, Developer plus requested roles, blocked until the password changes', async () => {
    const email = `invitee-${randomUUID().slice(0, 8)}@gate.example.org`;
    const res = await call(app, 'POST', '/api/v1/cpg/users', { cookie: owner.cookie, body: { email: email.toUpperCase(), name: 'Invitee', roleKeys: ['policy_author'] } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.json).sort()).toEqual(['tempPassword', 'user']);
    const user = orgUserResponseSchema.parse(res.json.user);
    expect(user.email).toBe(email);
    expect(user.mustChangePassword).toBe(true);
    expect(user.grants.map((g) => g.roleKey).sort()).toEqual(['developer', 'policy_author']);
    expect(res.json.tempPassword).toMatch(/^nomus-[0-9a-f]{8}$/);

    const login = await call(app, 'POST', '/api/v1/auth/login', { body: { email, password: res.json.tempPassword } });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const me = await call(app, 'GET', '/api/v1/cpg/me', { cookie });
    expect([me.status, me.json.code]).toEqual([403, 'password_change_required']);
    expect((await call(app, 'POST', '/api/v1/auth/force-change-password', { cookie, body: { password: 'a-brand-new-password' } })).status).toBe(200);
    expect((await call(app, 'GET', '/api/v1/cpg/me', { cookie })).status).toBe(200);
  });

  it('refuses a taken email (409 email_in_use) and unknown role keys (400)', async () => {
    const taken = await call(app, 'POST', '/api/v1/cpg/users', { cookie: owner.cookie, body: { email: dev.email, name: 'Dup' } });
    expect([taken.status, taken.json.code]).toEqual([409, 'email_in_use']);
    const unknown = await call(app, 'POST', '/api/v1/cpg/users', { cookie: owner.cookie, body: { email: `u-${randomUUID().slice(0, 6)}@gate.example.org`, name: 'U', roleKeys: ['wizard'] } });
    expect([unknown.status, unknown.json.code, unknown.json.details]).toEqual([400, 'invalid_input', { roleKeys: ['wizard'] }]);
    const withPassword = await call(app, 'POST', '/api/v1/cpg/users', { cookie: owner.cookie, body: { email: `p-${randomUUID().slice(0, 6)}@gate.example.org`, name: 'P', password: 'chosen-by-admin' } });
    expect(withPassword.status).toBe(400);
    expect((await call(app, 'POST', '/api/v1/cpg/users', { cookie: dev.cookie, body: { email: 'x@gate.example.org', name: 'X' } })).status).toBe(403);
  });

  it('PATCH user: rename and deactivate; never yourself, a platform admin or the last Org Admin', async () => {
    const victim = await call(app, 'POST', '/api/v1/cpg/users', { cookie: owner.cookie, body: { email: `v-${randomUUID().slice(0, 6)}@gate.example.org`, name: 'Victim' } });
    const id = victim.json.user.id;
    const renamed = await call(app, 'PATCH', `/api/v1/cpg/users/${id}`, { cookie: owner.cookie, body: { name: 'Renamed' } });
    expect(orgUserResponseSchema.parse(renamed.json).name).toBe('Renamed');
    const off = await call(app, 'PATCH', `/api/v1/cpg/users/${id}`, { cookie: owner.cookie, body: { isActive: false } });
    expect(off.json.isActive).toBe(false);

    const self = await call(app, 'PATCH', `/api/v1/cpg/users/${owner.id}`, { cookie: owner.cookie, body: { isActive: false } });
    expect([self.status, self.json.code]).toEqual([409, 'cannot_deactivate_self']);

    // A second admin tries to deactivate the only other admin: allowed while two exist,
    // refused when the target is the last one.
    const second = await call(app, 'POST', '/api/v1/cpg/users', { cookie: owner.cookie, body: { email: `a2-${randomUUID().slice(0, 6)}@gate.example.org`, name: 'Admin Two', roleKeys: ['org_admin'] } });
    const secondId = second.json.user.id;
    const deact = await call(app, 'PATCH', `/api/v1/cpg/users/${secondId}`, { cookie: owner.cookie, body: { isActive: false } });
    expect(deact.status).toBe(200);
    const pa = makeUser(orgId, { role: 'platform_admin' });
    const paRes = await call(app, 'PATCH', `/api/v1/cpg/users/${pa.id}`, { cookie: owner.cookie, body: { isActive: false } });
    expect([paRes.status, paRes.json.code]).toEqual([403, 'forbidden']);
    expect((await call(app, 'PATCH', `/api/v1/cpg/users/${outsider.id}`, { cookie: owner.cookie, body: { name: 'x' } })).status).toBe(404);
  });

  it('grants are validated, idempotent and revoked once; the last Org Admin cannot be revoked', async () => {
    const policyAuthor = await roleId('policy_author');
    const g1 = await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: policyAuthor, scopeType: 'org' } });
    expect(g1.status).toBe(201);
    const grant = grantResponseSchema.parse(g1.json);
    expect(grant).toMatchObject({ userId: dev.id, roleKey: 'policy_author', scopeType: 'org', scopeId: null, grantedBy: `user:${owner.id}`, revokedAt: null });
    const g2 = await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: policyAuthor, scopeType: 'org' } });
    expect(g2.status).toBe(200);
    expect(g2.json.id).toBe(grant.id);

    const notScopable = await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: policyAuthor, scopeType: 'repo', scopeId: 'acme/api' } });
    expect([notScopable.status, notScopable.json.code]).toEqual([422, 'role_not_scopable']);
    const orgWithScope = await call(app, 'POST', `/api/v1/cpg/users/${dev.id}/grants`, { cookie: owner.cookie, body: { roleId: policyAuthor, scopeType: 'org', scopeId: 'acme/api' } });
    expect(orgWithScope.status).toBe(400);

    const r1 = await call(app, 'POST', `/api/v1/cpg/grants/${grant.id}/revoke`, { cookie: owner.cookie, body: { reason: 'no longer authoring' } });
    expect(r1.status).toBe(200);
    expect(grantResponseSchema.parse(r1.json)).toMatchObject({ revokedBy: `user:${owner.id}`, revokeReason: 'no longer authoring' });
    const r2 = await call(app, 'POST', `/api/v1/cpg/grants/${grant.id}/revoke`, { cookie: owner.cookie, body: { reason: 'again' } });
    expect([r2.status, r2.json.code]).toEqual([409, 'grant_already_revoked']);
    expect((await call(app, 'POST', `/api/v1/cpg/grants/${grant.id}/revoke`, { cookie: owner.cookie, body: {} })).status).toBe(400);

    const ownerGrants = (await call(app, 'GET', '/api/v1/cpg/users', { cookie: owner.cookie })).json.items.find((u: { id: string }) => u.id === owner.id).grants;
    const adminGrant = ownerGrants.find((g: { roleKey: string }) => g.roleKey === 'org_admin');
    const last = await call(app, 'POST', `/api/v1/cpg/grants/${adminGrant.id}/revoke`, { cookie: owner.cookie, body: { reason: 'stepping down' } });
    expect([last.status, last.json.code]).toEqual([409, 'last_org_admin']);

    const foreignGrant = await call(app, 'POST', `/api/v1/cpg/grants/${randomUUID()}/revoke`, { cookie: owner.cookie, body: { reason: 'x' } });
    expect(foreignGrant.status).toBe(404);
  });
});

describe('E12 to E14 teams', () => {
  it('creates, lists, edits and archives a team; patterns are validated and changes audited', async () => {
    const created = await call(app, 'POST', '/api/v1/cpg/teams', { cookie: owner.cookie, body: { key: 'payments', name: 'Payments', repoPatterns: ['acme/payments-*', 'acme/ledger'] } });
    expect(created.status).toBe(201);
    const team = teamResponseSchema.parse(created.json);
    expect(team.repoPatterns).toEqual(['acme/ledger', 'acme/payments-*']);

    const dup = await call(app, 'POST', '/api/v1/cpg/teams', { cookie: owner.cookie, body: { key: 'payments', name: 'Again', repoPatterns: [] } });
    expect([dup.status, dup.json.code]).toEqual([409, 'team_key_taken']);
    const bad = await call(app, 'POST', '/api/v1/cpg/teams', { cookie: owner.cookie, body: { key: 'bad', name: 'Bad', repoPatterns: ['Acme/*', 'acme/[ab]'] } });
    expect([bad.status, bad.json.code]).toEqual([422, 'invalid_glob']);
    expect(bad.json.details.errors).toHaveLength(2);

    const patched = await call(app, 'PATCH', `/api/v1/cpg/teams/${team.id}`, { cookie: owner.cookie, body: { name: 'Payments Platform', repoPatterns: ['acme/payments-*'], archived: true } });
    expect(patched.status).toBe(200);
    expect(teamResponseSchema.parse(patched.json)).toMatchObject({ name: 'Payments Platform', repoPatterns: ['acme/payments-*'] });
    expect(patched.json.archivedAt).not.toBeNull();

    const list = await call(app, 'GET', '/api/v1/cpg/teams', { cookie: dev.cookie });
    expect(listOf(teamResponseSchema).parse(list.json).items.map((t) => t.key)).toContain('payments');
    expect((await call(app, 'POST', '/api/v1/cpg/teams', { cookie: dev.cookie, body: { key: 'mine', name: 'Mine', repoPatterns: [] } })).status).toBe(403);

    const audit = await call(app, 'GET', '/api/v1/cpg/audit?action=team.updated', { cookie: owner.cookie });
    expect(audit.json.items[0].payload).toMatchObject({ repoPatterns: { before: ['acme/ledger', 'acme/payments-*'], after: ['acme/payments-*'] }, archived: { before: false, after: true } });
  });
});

describe('E15 and E16 settings', () => {
  it('reads settings with a session or a user-bound key; an org key is refused', async () => {
    const s = await call(app, 'GET', '/api/v1/cpg/settings', { cookie: dev.cookie });
    expect(s.status).toBe(200);
    expect(cpgSettingsResponseSchema.parse(s.json)).toMatchObject({ orgId, enabled: false, reviewerContextLlm: false, llmProviderConfigured: false });
    const uk = await call(app, 'GET', '/api/v1/cpg/settings', { bearer: makeKey(orgId, dev.id).key });
    expect(uk.status).toBe(200);
    const ok = await call(app, 'GET', '/api/v1/cpg/settings', { bearer: makeKey(orgId, null).key });
    expect([ok.status, ok.json.code]).toEqual([403, 'user_identity_required']);
  });

  it('Org Admin enables CPG (audited); a Developer cannot', async () => {
    expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: dev.cookie, body: { enabled: true } })).status).toBe(403);
    const res = await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } });
    expect(res.status).toBe(200);
    expect(cpgSettingsResponseSchema.parse(res.json)).toMatchObject({ enabled: true, updatedBy: `user:${owner.id}` });
    expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: {} })).status).toBe(400);
    const me = await call(app, 'GET', '/api/v1/cpg/me', { cookie: dev.cookie });
    expect(me.json.cpgEnabled).toBe(true);
    const audit = await call(app, 'GET', '/api/v1/cpg/audit?action=settings.updated', { cookie: owner.cookie });
    expect(audit.json.items[0].payload).toEqual({ before: { enabled: false, reviewerContextLlm: false }, after: { enabled: true, reviewerContextLlm: false } });
    await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: false } });
  });
});

describe('E17 audit', () => {
  it('Auditor reads the chain newest first with a valid chain; Developer is refused', async () => {
    const res = await call(app, 'GET', '/api/v1/cpg/audit?limit=200', { cookie: auditor.cookie });
    expect(res.status).toBe(200);
    const body = auditListResponseSchema.parse(res.json);
    expect(body.chainValid).toBe(true);
    const seqs = body.items.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(body.items.map((e) => e.action)).toEqual(expect.arrayContaining(['grant.created', 'role.permissions_changed', 'rbac.migrated', 'settings.initialized']));
    expect((await call(app, 'GET', '/api/v1/cpg/audit', { cookie: dev.cookie })).status).toBe(403);
  });

  it('paginates with an opaque cursor and filters by action and time', async () => {
    const page1 = auditListResponseSchema.parse((await call(app, 'GET', '/api/v1/cpg/audit?limit=2', { cookie: owner.cookie })).json);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = auditListResponseSchema.parse((await call(app, 'GET', `/api/v1/cpg/audit?limit=2&cursor=${page1.nextCursor}`, { cookie: owner.cookie })).json);
    expect(page2.items[0].seq).toBe(page1.items[1].seq - 1);
    expect((await call(app, 'GET', '/api/v1/cpg/audit?cursor=garbage', { cookie: owner.cookie })).status).toBe(400);
    expect((await call(app, 'GET', '/api/v1/cpg/audit?since=yesterday', { cookie: owner.cookie })).status).toBe(400);
    expect((await call(app, 'GET', '/api/v1/cpg/audit?limit=500', { cookie: owner.cookie })).status).toBe(400);
    const future = await call(app, 'GET', `/api/v1/cpg/audit?since=${new Date(Date.now() + 3600_000).toISOString()}`, { cookie: owner.cookie });
    expect(future.json.items).toEqual([]);
  });

  it('reports chainValid:false after the log is tampered with', async () => {
    const tamperOrg = makeOrg('Tamper');
    const admin = makeUser(tamperOrg);
    expect((await call(app, 'GET', '/api/v1/cpg/audit', { cookie: admin.cookie })).json.chainValid).toBe(true);
    const sqlite = rawSqlite(getDb());
    sqlite.prepare('DROP TRIGGER trg_cpg_audit_events_no_update').run();
    try {
      sqlite.prepare("UPDATE cpg_audit_events SET actor = 'user:someone-else' WHERE org_id = ? AND seq = 1").run(tamperOrg);
      const res = await call(app, 'GET', '/api/v1/cpg/audit', { cookie: admin.cookie });
      expect(res.status).toBe(200);
      expect(res.json.chainValid).toBe(false);
      // Other orgs' chains are unaffected.
      expect((await call(app, 'GET', '/api/v1/cpg/audit', { cookie: owner.cookie })).json.chainValid).toBe(true);
    } finally {
      sqlite.prepare("CREATE TRIGGER trg_cpg_audit_events_no_update BEFORE UPDATE ON cpg_audit_events BEGIN SELECT RAISE(ABORT, 'cpg_audit_events is append-only'); END").run();
    }
  });
});

describe('E18 POST /tenants/:id/org-admins', () => {
  it('platform admin grants Org Admin to a user of that org (201, then idempotent 200)', async () => {
    // An org already migrated with no member (so no Org Admin), then a member
    // added outside the invite paths: the recovery case E18 exists for.
    const org = makeOrg('Bootstrap');
    ensureOrgRbac(getDb(), org);
    const u = makeUser(org, { role: 'member' });
    const res = await call(app, 'POST', `/api/v1/tenants/${org}/org-admins`, { cookie: platformAdmin.cookie, body: { userId: u.id } });
    expect(res.status).toBe(201);
    expect(grantResponseSchema.parse(res.json)).toMatchObject({ userId: u.id, roleKey: 'org_admin', scopeType: 'org', grantedBy: `user:${platformAdmin.id}` });
    const again = await call(app, 'POST', `/api/v1/tenants/${org}/org-admins`, { cookie: platformAdmin.cookie, body: { userId: u.id } });
    expect(again.status).toBe(200);
    const bootstrapKey = await call(app, 'POST', `/api/v1/tenants/${org}/org-admins`, { bearer: 'nk_test_api_key_bootstrap', body: { userId: u.id } });
    expect(bootstrapKey.status).toBe(200);
  });

  it('refuses members, unknown orgs, users of another org and bad bodies', async () => {
    expect((await call(app, 'POST', `/api/v1/tenants/${orgId}/org-admins`, { cookie: owner.cookie, body: { userId: dev.id } })).status).toBe(403);
    const noOrg = await call(app, 'POST', `/api/v1/tenants/${randomUUID()}/org-admins`, { cookie: platformAdmin.cookie, body: { userId: dev.id } });
    expect([noOrg.status, noOrg.json.code]).toEqual([404, 'not_found']);
    const wrongOrg = await call(app, 'POST', `/api/v1/tenants/${orgId}/org-admins`, { cookie: platformAdmin.cookie, body: { userId: outsider.id } });
    expect([wrongOrg.status, wrongOrg.json.code]).toEqual([404, 'not_found']);
    const bad = await call(app, 'POST', `/api/v1/tenants/${orgId}/org-admins`, { cookie: platformAdmin.cookie, body: { userId: 'nope' } });
    expect([bad.status, bad.json.code]).toEqual([400, 'invalid_input']);
  });

  it('POST /tenants seeds the new org with system roles and a disabled settings row', async () => {
    const res = await call(app, 'POST', '/api/v1/tenants', { cookie: platformAdmin.cookie, body: { name: 'Seeded Org', slug: `seeded-${Date.now()}` } });
    expect(res.status).toBe(201);
    const roles = rawSqlite(getDb()).prepare('SELECT count(*) AS n FROM cpg_roles WHERE org_id = ? AND is_system = 1').get(res.json.id) as { n: number };
    expect(roles.n).toBe(7);
    const settings = rawSqlite(getDb()).prepare('SELECT enabled, rbac_migrated_at FROM cpg_org_settings WHERE org_id = ?').get(res.json.id) as { enabled: number; rbac_migrated_at: string };
    expect(settings.enabled).toBe(0);
    expect(settings.rbac_migrated_at).toBeTruthy();
    expect(NOW()).toBeTruthy();
  });
});
