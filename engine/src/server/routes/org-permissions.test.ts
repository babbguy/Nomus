/**
 * /api/v1/org/* under CPG RBAC (design spec §3.8): each self-service route
 * needs its permission; Developers keep the v1.1.0 member abilities through
 * the role's legacy grants, which an Org Admin can remove and restore; a
 * platform_admin session keeps v1.1.0 access (legacy pass) on these routes
 * only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys } from '../../core/signing.js';
import { createApp } from '../app.js';
import { createGrant, getRoleByKey, listUserGrants, revokeGrant } from '../../cpg/rbac/grants.js';
import { call, makeOrg, makeUser, type TestUser } from '../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
let orgId: string;
let owner: TestUser;
let dev: TestUser;
let auditor: TestUser;
let nobody: TestUser;
let platformAdmin: TestUser;

const ROUTES = {
  patchOrg: ['PATCH', '/api/v1/org', { industry: 'healthcare' }],
  listKeys: ['GET', '/api/v1/org/api-keys', undefined],
  createKey: ['POST', '/api/v1/org/api-keys', { label: 'matrix', scopes: ['read:policies'] }],
  members: ['GET', '/api/v1/org/members', undefined],
  getOrg: ['GET', '/api/v1/org', undefined],
} as const;

async function hit(user: TestUser, route: keyof typeof ROUTES) {
  const [method, path, body] = ROUTES[route];
  return call(app, method, path, { cookie: user.cookie, body });
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Matrix');
  owner = makeUser(orgId);
  dev = makeUser(orgId);
  auditor = makeUser(orgId);
  nobody = makeUser(orgId);
  platformAdmin = makeUser(makeOrg('Ops'), { role: 'platform_admin' });
  // First request seeds and migrates the org: owner = Org Admin + Developer, others Developer.
  expect((await hit(owner, 'members')).status).toBe(200);
  const db = getDb();
  createGrant(db, { orgId, userId: auditor.id, roleId: getRoleByKey(db, orgId, 'auditor')!.id, scopeType: 'org', actor: 'test' });
  // auditor: Auditor only. nobody: no grants at all.
  for (const user of [auditor, nobody]) {
    const devGrant = listUserGrants(db, orgId, user.id).find((g) => g.roleId === getRoleByKey(db, orgId, 'developer')!.id)!;
    revokeGrant(db, { orgId, grantId: devGrant.id, actor: 'test', reason: 'matrix setup' });
  }
});

describe('/org permission matrix', () => {
  // [route, owner (Org Admin+Developer), dev (Developer), auditor (Auditor), nobody (no grants)]
  const matrix: Array<[keyof typeof ROUTES, number, number, number, number]> = [
    ['getOrg', 200, 200, 200, 200], // unchanged: any session
    ['patchOrg', 200, 200, 403, 403], // org.profile.update
    ['listKeys', 200, 200, 403, 403], // org.api_keys.manage
    ['createKey', 201, 201, 403, 403],
    ['members', 200, 200, 200, 403], // org.members.read
  ];
  for (const [route, ...expected] of matrix) {
    it(`${route}: Org Admin ${expected[0]}, Developer ${expected[1]}, Auditor ${expected[2]}, no grants ${expected[3]}`, async () => {
      const got = [];
      for (const u of [owner, dev, auditor, nobody]) got.push((await hit(u, route)).status);
      expect(got).toEqual(expected);
    });
  }

  it('a 403 names the missing permission in the CPG error envelope', async () => {
    const res = await hit(nobody, 'members');
    expect(res.json).toEqual({ error: 'Missing permission org.members.read', code: 'forbidden', details: { permission: 'org.members.read' } });
  });

  it('DELETE /org/api-keys/:id needs org.api_keys.manage', async () => {
    const created = await hit(dev, 'createKey');
    expect((await call(app, 'DELETE', `/api/v1/org/api-keys/${created.json.id}`, { cookie: auditor.cookie })).status).toBe(403);
    expect((await call(app, 'DELETE', `/api/v1/org/api-keys/${created.json.id}`, { cookie: dev.cookie })).status).toBe(200);
  });
});

describe('legacy grants on the Developer role', () => {
  it('removing org.api_keys.manage from Developer takes effect immediately, and restoring it brings it back', async () => {
    const roles = await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie });
    const developer = roles.json.items.find((r: { key: string }) => r.key === 'developer');
    const without = developer.permissions.filter((p: string) => p !== 'org.api_keys.manage');
    const cut = await call(app, 'PATCH', `/api/v1/cpg/roles/${developer.id}`, { cookie: owner.cookie, body: { permissions: without } });
    expect(cut.status).toBe(200);
    expect((await hit(dev, 'createKey')).status).toBe(403);
    // The owner still holds it through Org Admin.
    expect((await hit(owner, 'createKey')).status).toBe(201);
    const restored = await call(app, 'PATCH', `/api/v1/cpg/roles/${developer.id}`, { cookie: owner.cookie, body: { permissions: developer.permissions } });
    expect(restored.status).toBe(200);
    expect((await hit(dev, 'createKey')).status).toBe(201);
  });
});

describe('platform_admin', () => {
  it('keeps v1.1.0 access on every /org route (legacy pass)', async () => {
    expect((await hit(platformAdmin, 'getOrg')).status).toBe(200);
    expect((await hit(platformAdmin, 'patchOrg')).status).toBe(200);
    expect((await hit(platformAdmin, 'listKeys')).status).toBe(200);
    expect((await hit(platformAdmin, 'createKey')).status).toBe(201);
    expect((await hit(platformAdmin, 'members')).status).toBe(200);
  });

  it('gets no CPG permission anywhere else', async () => {
    expect((await call(app, 'GET', '/api/v1/cpg/roles', { cookie: platformAdmin.cookie })).status).toBe(403);
    expect((await call(app, 'GET', '/api/v1/cpg/audit', { cookie: platformAdmin.cookie })).status).toBe(403);
    expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: platformAdmin.cookie, body: { enabled: true } })).status).toBe(403);
  });
});
