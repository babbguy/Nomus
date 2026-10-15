/**
 * can() scoping matrix (design spec §3.3): org / team / repo grants ×
 * scopable / non-scopable permissions, with and without a repository in the
 * request, plus everything that must switch a grant off (revocation, inactive
 * user, archived role or team, moved user) and platform_admin's lack of
 * implicit permissions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { users } from '../../db/schema.js';
import { cpgRolePermissions, cpgRoles, cpgTeamRepos, cpgTeams } from '../../db/schema-cpg.js';
import { can, loadEffectiveGrants, summarizePermissions, userCan } from './can.js';
import { createGrant, getRoleByKey, insertGrant, revokeGrant } from './grants.js';
import { ensureOrgRbac } from './seed.js';
import { compileGlob, InvalidGlobError, repoPatternError } from '@nomus/scanner/corporate';
import { makeOrg, makeUser } from '../__fixtures__/rbac-fixtures.js';
import { CpgError } from '../errors.js';

const db = () => getDb();
const NOW = () => new Date().toISOString();

function customRole(orgId: string, key: string, permissions: string[]) {
  const id = randomUUID();
  db().insert(cpgRoles).values({ id, orgId, key, name: key, description: '', isSystem: false, createdBy: 'test', createdAt: NOW(), archivedAt: null, archivedBy: null }).run();
  for (const p of permissions) db().insert(cpgRolePermissions).values({ roleId: id, permissionKey: p }).run();
  return db().select().from(cpgRoles).where(eq(cpgRoles.id, id)).get()!;
}

function team(orgId: string, key: string, patterns: string[]) {
  const id = randomUUID();
  db().insert(cpgTeams).values({ id, orgId, key, name: key, createdBy: 'test', createdAt: NOW(), archivedAt: null }).run();
  for (const p of patterns) db().insert(cpgTeamRepos).values({ teamId: id, repoPattern: p, addedBy: 'test', addedAt: NOW() }).run();
  return id;
}

let orgId: string;
let otherOrg: string;

beforeAll(() => {
  runMigrations();
  orgId = makeOrg('Can');
  otherOrg = makeOrg('Other');
  ensureOrgRbac(db(), orgId);
  ensureOrgRbac(db(), otherOrg);
});

describe('org-scoped grants', () => {
  it('confer scopable and non-scopable permissions, with or without a repo', () => {
    const u = makeUser(orgId);
    createGrant(db(), { orgId, userId: u.id, roleId: getRoleByKey(db(), orgId, 'org_admin')!.id, scopeType: 'org', actor: 'test' });
    const actor = { grants: loadEffectiveGrants(db(), orgId, u.id) };
    expect(can(actor, 'rbac.users.manage')).toBe(true); // non-scopable
    expect(can(actor, 'rbac.users.manage', { repo: 'acme/api' })).toBe(true);
    expect(can(actor, 'case.read')).toBe(true); // scopable
    expect(can(actor, 'case.read', { repo: 'acme/api' })).toBe(true);
    expect(can(actor, 'case.review')).toBe(false); // Org Admin approves nothing
    expect(can(actor, 'policy.approve')).toBe(false);
    expect(can(actor, 'exception.approve')).toBe(false);
  });
});

describe('repo-scoped grants', () => {
  it('confer scopable permissions only for that exact repo, never without a repo', () => {
    const u = makeUser(orgId);
    const role = customRole(orgId, 'repo_reviewer', ['case.read', 'case.review']);
    createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'repo', scopeId: 'acme/api', actor: 'test' });
    expect(userCan(db(), orgId, u.id, 'case.review', { repo: 'acme/api' })).toBe(true);
    expect(userCan(db(), orgId, u.id, 'case.review', { repo: 'acme/web' })).toBe(false);
    expect(userCan(db(), orgId, u.id, 'case.review', { repo: 'acme/api-v2' })).toBe(false);
    expect(userCan(db(), orgId, u.id, 'case.review')).toBe(false);
    expect(userCan(db(), orgId, u.id, 'case.close', { repo: 'acme/api' })).toBe(false);
  });

  it('never confer a non-scopable permission, even if one slipped into the role', () => {
    const u = makeUser(orgId);
    const role = customRole(orgId, 'leaky_role', ['case.read', 'org.members.read']);
    // Bypass createGrant's role_not_scopable validation to prove can() itself holds the line.
    insertGrant(db(), { orgId, userId: u.id, role, scopeType: 'repo', scopeId: 'acme/api', actor: 'test' });
    const grants = loadEffectiveGrants(db(), orgId, u.id);
    expect(can({ grants }, 'org.members.read', { repo: 'acme/api' })).toBe(false);
    expect(can({ grants }, 'org.members.read')).toBe(false);
    expect(can({ grants }, 'case.read', { repo: 'acme/api' })).toBe(true);
    expect(summarizePermissions(grants).map((p) => p.key)).toEqual(['case.read']);
  });

  it('createGrant refuses a role with non-scopable permissions at team or repo scope (role_not_scopable)', () => {
    const u = makeUser(orgId);
    const err = (() => {
      try {
        createGrant(db(), { orgId, userId: u.id, roleId: getRoleByKey(db(), orgId, 'case_reviewer')!.id, scopeType: 'repo', scopeId: 'acme/api', actor: 'test' });
        return null;
      } catch (e) { return e as CpgError; }
    })();
    expect(err).toBeInstanceOf(CpgError);
    expect(err!.status).toBe(422);
    expect(err!.code).toBe('role_not_scopable');
  });

  it('createGrant refuses a non-canonical repo id (invalid_repo)', () => {
    const u = makeUser(orgId);
    const role = customRole(orgId, 'repo_reader', ['case.read']);
    for (const scopeId of ['Acme/API', 'acme', '../etc', 'acme/api/x/y']) {
      expect(() => createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'repo', scopeId, actor: 'test' }), scopeId)
        .toThrow(expect.objectContaining({ code: 'invalid_repo' }));
    }
  });

  it('createGrant stores a github.com repo id in its canonical form, so both forms are one grant', () => {
    const u = makeUser(orgId);
    const role = customRole(orgId, 'repo_reader_gh', ['case.read']);
    const long = createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'repo', scopeId: 'github.com/acme/api', actor: 'test' });
    expect([long.created, long.grant.scopeId]).toEqual([true, 'acme/api']);
    const short = createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'repo', scopeId: 'acme/api', actor: 'test' });
    expect([short.created, short.grant.id]).toEqual([false, long.grant.id]);
  });
});

describe('team-scoped grants', () => {
  it('confer scopable permissions for repos matching the team patterns', () => {
    const u = makeUser(orgId);
    const t = team(orgId, 'payments', ['acme/payments-*', 'ghe.example.org/acme/**']);
    const role = customRole(orgId, 'team_reviewer', ['case.read', 'case.review']);
    createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'team', scopeId: t, actor: 'test' });
    expect(userCan(db(), orgId, u.id, 'case.review', { repo: 'acme/payments-api' })).toBe(true);
    expect(userCan(db(), orgId, u.id, 'case.review', { repo: 'ghe.example.org/acme/ledger' })).toBe(true);
    expect(userCan(db(), orgId, u.id, 'case.review', { repo: 'acme/web' })).toBe(false);
    expect(userCan(db(), orgId, u.id, 'case.review')).toBe(false);
  });

  it('follow the team: removing a pattern or archiving the team removes access on the next check', () => {
    const u = makeUser(orgId);
    const t = team(orgId, 'billing', ['acme/billing']);
    const role = customRole(orgId, 'billing_reader', ['case.read']);
    createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'team', scopeId: t, actor: 'test' });
    expect(userCan(db(), orgId, u.id, 'case.read', { repo: 'acme/billing' })).toBe(true);
    db().delete(cpgTeamRepos).where(eq(cpgTeamRepos.teamId, t)).run();
    expect(userCan(db(), orgId, u.id, 'case.read', { repo: 'acme/billing' })).toBe(false);
    db().insert(cpgTeamRepos).values({ teamId: t, repoPattern: 'acme/billing', addedBy: 'test', addedAt: NOW() }).run();
    expect(userCan(db(), orgId, u.id, 'case.read', { repo: 'acme/billing' })).toBe(true);
    db().update(cpgTeams).set({ archivedAt: NOW() }).where(eq(cpgTeams.id, t)).run();
    expect(userCan(db(), orgId, u.id, 'case.read', { repo: 'acme/billing' })).toBe(false);
  });
});

describe('what switches a grant off', () => {
  it('revocation, effective immediately', () => {
    const u = makeUser(orgId);
    const { grant } = createGrant(db(), { orgId, userId: u.id, roleId: getRoleByKey(db(), orgId, 'auditor')!.id, scopeType: 'org', actor: 'test' });
    expect(userCan(db(), orgId, u.id, 'audit.read')).toBe(true);
    revokeGrant(db(), { orgId, grantId: grant.id, actor: 'test', reason: 'left the team' });
    expect(userCan(db(), orgId, u.id, 'audit.read')).toBe(false);
  });

  it('an inactive user', () => {
    const u = makeUser(orgId);
    createGrant(db(), { orgId, userId: u.id, roleId: getRoleByKey(db(), orgId, 'auditor')!.id, scopeType: 'org', actor: 'test' });
    db().update(users).set({ isActive: false }).where(eq(users.id, u.id)).run();
    expect(userCan(db(), orgId, u.id, 'audit.read')).toBe(false);
  });

  it('an archived role', () => {
    const u = makeUser(orgId);
    const role = customRole(orgId, 'temp_auditor', ['audit.read']);
    createGrant(db(), { orgId, userId: u.id, roleId: role.id, scopeType: 'org', actor: 'test' });
    expect(userCan(db(), orgId, u.id, 'audit.read')).toBe(true);
    db().update(cpgRoles).set({ archivedAt: NOW(), archivedBy: 'test' }).where(eq(cpgRoles.id, role.id)).run();
    expect(userCan(db(), orgId, u.id, 'audit.read')).toBe(false);
  });

  it('a user who moved to another org keeps nothing from the old one', () => {
    const u = makeUser(orgId);
    createGrant(db(), { orgId, userId: u.id, roleId: getRoleByKey(db(), orgId, 'auditor')!.id, scopeType: 'org', actor: 'test' });
    db().update(users).set({ orgId: otherOrg }).where(eq(users.id, u.id)).run();
    expect(userCan(db(), orgId, u.id, 'audit.read')).toBe(false);
    expect(userCan(db(), otherOrg, u.id, 'audit.read')).toBe(false);
  });

  it('platform_admin has no implicit permission: can() ignores users.role', () => {
    const admin = makeUser(orgId, { role: 'platform_admin' });
    for (const p of ['org.members.read', 'rbac.users.manage', 'audit.read', 'case.review', 'policy.approve']) {
      expect(userCan(db(), orgId, admin.id, p), p).toBe(false);
    }
  });

  it('grants never cross orgs', () => {
    const u = makeUser(orgId);
    createGrant(db(), { orgId, userId: u.id, roleId: getRoleByKey(db(), orgId, 'auditor')!.id, scopeType: 'org', actor: 'test' });
    expect(userCan(db(), otherOrg, u.id, 'audit.read')).toBe(false);
    expect(() => createGrant(db(), { orgId: otherOrg, userId: u.id, roleId: getRoleByKey(db(), otherOrg, 'auditor')!.id, scopeType: 'org', actor: 'test' }))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('repo glob semantics (§7.1)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['acme/*', 'acme/api', true],
    ['acme/*', 'acme/api/x', false],
    ['acme/*', 'other/api', false],
    ['acme/api-?', 'acme/api-1', true],
    ['acme/api-?', 'acme/api-12', false],
    ['**', 'acme/api', true],
    ['**/api', 'acme/api', true],
    ['**/api', 'host.example/acme/api', true],
    ['acme/**', 'acme', true],
    ['acme/**', 'acme/a/b', true],
    ['host/**/api', 'host/api', true],
    ['host/**/api', 'host/a/b/api', true],
    ['acme/{api,web}', 'acme/web', true],
    ['acme/{api,web}', 'acme/cli', false],
    ['acme/a.b', 'acme/axb', false],
  ];
  for (const [glob, value, expected] of cases) {
    it(`${glob} ${expected ? 'matches' : 'does not match'} ${value}`, () => {
      expect(compileGlob(glob).test(value)).toBe(expected);
    });
  }

  it('rejects unsupported or unsafe globs', () => {
    for (const bad of ['', 'a\\b', './acme', '/acme', '!acme/*', 'acme/[ab]', 'acme/@(a|b)', 'acme/a**', 'acme//x', '{a,{b,c}}', '{a}', `{${'a,'.repeat(10)}a}`, 'x'.repeat(201)]) {
      expect(() => compileGlob(bad), bad).toThrow(InvalidGlobError);
    }
    expect(repoPatternError('Acme/*')).toMatch(/lowercase/);
    expect(repoPatternError('acme/*')).toBeNull();
  });
});
