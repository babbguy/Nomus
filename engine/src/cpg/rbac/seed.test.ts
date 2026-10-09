/**
 * RBAC seeding and the one-time migration of v1.1.0 users (design spec §3.5):
 * owner selection (ties, inactive members, no members), idempotence, Org
 * Admin edits kept, platform admins untouched, the first-org-owner rule on
 * POST /api/v1/users, a user moved between orgs, and the D1 default for
 * reviewer-context generation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys } from '../../core/signing.js';
import { platformSettings, users } from '../../db/schema.js';
import { cpgAuditEvents, cpgRolePermissions, cpgRoles } from '../../db/schema-cpg.js';
import { invalidateSettingsCache } from '../../llm/provider.js';
import { createApp } from '../../server/app.js';
import { listAuditEventsByAction, verifyAuditChain } from '../audit/log.js';
import { SYSTEM_ROLES } from './catalog.js';
import { getRoleByKey, listUserGrants, rolePermissionKeys } from './grants.js';
import { MIGRATION_ACTOR, ensureOrgRbac, getOrgSettings, seedCpgRbac, selectOwner } from './seed.js';
import { call, makeOrg, makeUser, nextIso } from '../__fixtures__/rbac-fixtures.js';

const db = () => getDb();
const app = createApp();
let adminCookie: string;

function roleKeysOf(orgId: string, userId: string): string[] {
  return listUserGrants(db(), orgId, userId)
    .map((g) => db().select({ key: cpgRoles.key }).from(cpgRoles).where(eq(cpgRoles.id, g.roleId)).get()!.key)
    .sort();
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  const adminOrg = makeOrg('Admin');
  adminCookie = makeUser(adminOrg, { role: 'platform_admin' }).cookie;
});

describe('per-org seeding', () => {
  it('creates the seven system roles with the §3.2 permission sets, and a disabled settings row', () => {
    const orgId = makeOrg('Seeded');
    ensureOrgRbac(db(), orgId);
    for (const def of SYSTEM_ROLES) {
      const role = getRoleByKey(db(), orgId, def.key)!;
      expect(role.isSystem, def.key).toBe(true);
      expect(rolePermissionKeys(db(), role.id)).toEqual([...def.permissions].sort());
    }
    const settings = getOrgSettings(db(), orgId)!;
    expect(settings.enabled).toBe(false);
    expect(settings.rbacMigratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(verifyAuditChain(db(), orgId).valid).toBe(true);
  });

  it('Org Admin holds no approval permission (brief: approves nothing implicitly)', () => {
    const admin = SYSTEM_ROLES.find((r) => r.key === 'org_admin')!;
    for (const p of ['case.review', 'policy.approve', 'exception.approve', 'policy.author', 'case.create']) {
      expect(admin.permissions).not.toContain(p);
    }
  });
});

describe('owner selection and the one-time migration', () => {
  it('picks the earliest active member; ties on created_at go to the lowest id', () => {
    const orgId = makeOrg('Ties');
    const ts = nextIso();
    const b = makeUser(orgId, { id: 'bbbbbbbb-0000-4000-8000-000000000000', createdAt: ts });
    const a = makeUser(orgId, { id: 'aaaaaaaa-0000-4000-8000-000000000000', createdAt: ts });
    const later = makeUser(orgId);
    expect(selectOwner(db(), orgId)?.id).toBe(a.id);
    ensureOrgRbac(db(), orgId);
    expect(roleKeysOf(orgId, a.id)).toEqual(['developer', 'org_admin']);
    expect(roleKeysOf(orgId, b.id)).toEqual(['developer']);
    expect(roleKeysOf(orgId, later.id)).toEqual(['developer']);
    const grants = listUserGrants(db(), orgId, a.id);
    expect(grants.every((g) => g.grantedBy === MIGRATION_ACTOR && g.scopeType === 'org')).toBe(true);
    const migrated = listAuditEventsByAction(db(), orgId, 'rbac.migrated');
    expect(migrated).toHaveLength(1);
    expect(JSON.parse(migrated[0].payload)).toEqual({ ownerUserId: a.id, developerCount: 3 });
  });

  it('skips an earlier inactive member in favour of the earliest active one', () => {
    const orgId = makeOrg('Inactive');
    const gone = makeUser(orgId, { isActive: false });
    const active = makeUser(orgId);
    ensureOrgRbac(db(), orgId);
    expect(roleKeysOf(orgId, active.id)).toEqual(['developer', 'org_admin']);
    expect(roleKeysOf(orgId, gone.id)).toEqual(['developer']);
  });

  it('falls back to the earliest inactive member when no member is active', () => {
    const orgId = makeOrg('AllInactive');
    const first = makeUser(orgId, { isActive: false });
    const second = makeUser(orgId, { isActive: false });
    ensureOrgRbac(db(), orgId);
    expect(roleKeysOf(orgId, first.id)).toEqual(['developer', 'org_admin']);
    expect(roleKeysOf(orgId, second.id)).toEqual(['developer']);
  });

  it('an org with no members gets roles and settings but no owner', () => {
    const orgId = makeOrg('Empty');
    const admin = makeUser(orgId, { role: 'platform_admin' });
    ensureOrgRbac(db(), orgId);
    expect(roleKeysOf(orgId, admin.id)).toEqual([]);
    const migrated = listAuditEventsByAction(db(), orgId, 'rbac.migrated');
    expect(JSON.parse(migrated[0].payload)).toEqual({ ownerUserId: null, developerCount: 0 });
  });

  it('platform admins get nothing', () => {
    const orgId = makeOrg('Mixed');
    const admin = makeUser(orgId, { role: 'platform_admin' });
    const member = makeUser(orgId);
    ensureOrgRbac(db(), orgId);
    expect(roleKeysOf(orgId, admin.id)).toEqual([]);
    expect(roleKeysOf(orgId, member.id)).toEqual(['developer', 'org_admin']);
  });

  it('is idempotent: re-running seeds nothing twice and never re-migrates', () => {
    const orgId = makeOrg('Idem');
    const owner = makeUser(orgId);
    ensureOrgRbac(db(), orgId);
    const eventsBefore = db().select().from(cpgAuditEvents).where(eq(cpgAuditEvents.orgId, orgId)).all().length;
    const rolesBefore = db().select().from(cpgRoles).where(eq(cpgRoles.orgId, orgId)).all().length;
    // A member added later by direct insert is not swept up by a re-run: the migration is one-time.
    const late = makeUser(orgId);
    expect(ensureOrgRbac(db(), orgId)).toEqual({ migrated: false });
    seedCpgRbac(db());
    runMigrations();
    expect(db().select().from(cpgAuditEvents).where(eq(cpgAuditEvents.orgId, orgId)).all().length).toBe(eventsBefore);
    expect(db().select().from(cpgRoles).where(eq(cpgRoles.orgId, orgId)).all().length).toBe(rolesBefore);
    expect(roleKeysOf(orgId, owner.id)).toEqual(['developer', 'org_admin']);
    expect(roleKeysOf(orgId, late.id)).toEqual([]);
  });

  it('keeps an Org Admin\'s edits to a system role across restarts', () => {
    const orgId = makeOrg('Edits');
    ensureOrgRbac(db(), orgId);
    const developer = getRoleByKey(db(), orgId, 'developer')!;
    db().delete(cpgRolePermissions).where(eq(cpgRolePermissions.roleId, developer.id)).run();
    db().insert(cpgRolePermissions).values({ roleId: developer.id, permissionKey: 'policy.read' }).run();
    seedCpgRbac(db());
    runMigrations();
    expect(rolePermissionKeys(db(), developer.id)).toEqual(['policy.read']);
  });
});

describe('reviewer-context default (owner decision D1)', () => {
  it('is off when no LLM provider is configured, on when one is', () => {
    const before = makeOrg('NoLlm');
    ensureOrgRbac(db(), before);
    expect(getOrgSettings(db(), before)!.reviewerContextLlm).toBe(false);

    // The default translator provider is anthropic; give it a key through settings.
    db().insert(platformSettings).values({ key: 'llm.apiKeys.anthropic', value: 'sk-test-only', updatedAt: new Date().toISOString() }).run();
    invalidateSettingsCache();
    try {
      const after = makeOrg('WithLlm');
      ensureOrgRbac(db(), after);
      expect(getOrgSettings(db(), after)!.reviewerContextLlm).toBe(true);
    } finally {
      db().delete(platformSettings).where(eq(platformSettings.key, 'llm.apiKeys.anthropic')).run();
      invalidateSettingsCache();
    }
  });
});

describe('POST /api/v1/users and PATCH /api/v1/users/:id side effects', () => {
  it('the first member of an org with no Org Admin becomes Org Admin and Developer; the next only Developer', async () => {
    // Created through POST /tenants, which seeds roles and settings with the org.
    const org = await call(app, 'POST', '/api/v1/tenants', { cookie: adminCookie, body: { name: 'Fresh Org', slug: `fresh-${Date.now()}` } });
    expect(org.status).toBe(201);
    const orgId = org.json.id as string;
    expect(getOrgSettings(db(), orgId)?.rbacMigratedAt).toBeTruthy();
    const first = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email: `first-${orgId}@gate.example.org`, name: 'First', orgId, role: 'member' } });
    expect(first.status).toBe(201);
    const second = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email: `second-${orgId}@gate.example.org`, name: 'Second', orgId, role: 'member' } });
    expect(second.status).toBe(201);
    expect(roleKeysOf(orgId, first.json.id)).toEqual(['developer', 'org_admin']);
    expect(roleKeysOf(orgId, second.json.id)).toEqual(['developer']);
    const grants = listUserGrants(db(), orgId, first.json.id);
    expect(grants.every((g) => g.grantedBy.startsWith('user:'))).toBe(true);
  });

  it('a platform admin created with POST /users gets no grants', async () => {
    const orgId = makeOrg('Platform');
    const res = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email: `pa-${orgId}@gate.example.org`, name: 'PA', orgId, role: 'platform_admin' } });
    expect(res.status).toBe(201);
    expect(roleKeysOf(orgId, res.json.id)).toEqual([]);
  });

  it('an org whose Org Admin was deactivated: the next new member becomes Org Admin', async () => {
    const orgId = makeOrg('Recover');
    const first = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email: `r1-${orgId}@gate.example.org`, name: 'R1', orgId } });
    db().update(users).set({ isActive: false }).where(eq(users.id, first.json.id)).run();
    const next = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email: `r2-${orgId}@gate.example.org`, name: 'R2', orgId } });
    expect(roleKeysOf(orgId, next.json.id)).toEqual(['developer', 'org_admin']);
  });

  it('moving a user revokes every grant in the old org and applies the new-member rule in the new one', async () => {
    const from = makeOrg('From');
    const to = makeOrg('To');
    const created = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email: `mover-${from}@gate.example.org`, name: 'Mover', orgId: from } });
    expect(roleKeysOf(from, created.json.id)).toEqual(['developer', 'org_admin']);
    const moved = await call(app, 'PATCH', `/api/v1/users/${created.json.id}`, { cookie: adminCookie, body: { orgId: to } });
    expect(moved.status).toBe(200);
    expect(roleKeysOf(from, created.json.id)).toEqual([]);
    const revoked = listUserGrants(db(), from, created.json.id, true);
    expect(revoked.length).toBe(2);
    expect(revoked.every((g) => g.revokeReason === 'user moved' && g.revokedAt)).toBe(true);
    expect(roleKeysOf(to, created.json.id)).toEqual(['developer', 'org_admin']);
    expect(verifyAuditChain(db(), from).valid).toBe(true);
    expect(verifyAuditChain(db(), to).valid).toBe(true);
  });

  it('a failed user insert writes no grants (one transaction)', async () => {
    const orgId = makeOrg('Dup');
    const email = `dup-${orgId}@gate.example.org`;
    await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email, name: 'A', orgId } });
    const again = await call(app, 'POST', '/api/v1/users', { cookie: adminCookie, body: { email, name: 'B', orgId } });
    expect(again.status).toBe(409);
    const all = db().select().from(users).where(eq(users.orgId, orgId)).all();
    expect(all).toHaveLength(1);
  });
});
