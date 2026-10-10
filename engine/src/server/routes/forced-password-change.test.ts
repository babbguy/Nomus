/**
 * A user invited with a temporary password (mustChangePassword = true) may only
 * use /auth/me, /auth/force-change-password and /auth/logout until the password
 * is changed. Every other session-backed route answers 403 password_change_required,
 * so the temporary credential cannot mint API keys or extension tokens.
 *
 * Real DB, real sessions, real app.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys } from '../../core/signing.js';
import { apiKeys, organizations, sessions, users } from '../../db/schema.js';
import { setState } from '../../core/state-store.js';
import { createApp } from '../app.js';

const app = createApp();

function makeOrg() {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(organizations).values({
    id, name: `Temp Org ${id.slice(0, 6)}`, slug: `temp-${id.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

function makeUser(orgId: string, mustChangePassword: boolean) {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(users).values({
    id, orgId, email: `${id}@example.test`, passwordHash: 'x-not-a-real-hash', name: `User ${id.slice(0, 4)}`,
    role: 'member', authProvider: 'local', mustChangePassword, isActive: true, createdAt: now, updatedAt: now,
  }).run();
  const token = randomBytes(32).toString('hex');
  getDb().insert(sessions).values({
    id: randomUUID(), userId: id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: now,
  }).run();
  return { id, orgId, cookie: `nomus_session=${token}` };
}

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`http://localhost${path}`, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

let temp: ReturnType<typeof makeUser>;
let normal: ReturnType<typeof makeUser>;

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  const orgId = makeOrg();
  temp = makeUser(orgId, true);
  normal = makeUser(orgId, false);
});

describe('temporary-password session', () => {
  it('cannot read the org', async () => {
    const r = await call('GET', '/api/v1/org', { cookie: temp.cookie });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('password_change_required');
  });

  it('cannot mint an API key', async () => {
    const r = await call('POST', '/api/v1/org/api-keys', {
      cookie: temp.cookie, body: { label: 'durable', scopes: ['read:policies'] },
    });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('password_change_required');
    expect(getDb().select().from(apiKeys).where(eq(apiKeys.orgId, temp.orgId)).all()).toHaveLength(0);
  });

  it('cannot complete the VS Code device sign-in', async () => {
    const state = randomUUID();
    setState('device_auth_pending', state, 'vscode://example-ext/callback', 60_000);
    const r = await call('GET', `/api/v1/auth/device/callback?device_state=${state}`, { cookie: temp.cookie });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('password_change_required');
    expect(r.headers.get('location')).toBeNull();
  });

  it('cannot use PATCH /auth/profile', async () => {
    const r = await call('PATCH', '/api/v1/auth/profile', { cookie: temp.cookie, body: { name: 'Renamed' } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('password_change_required');
    const row = getDb().select().from(users).where(eq(users.id, temp.id)).get();
    expect(row?.name).not.toBe('Renamed');
  });

  it('can still call /auth/me, then change the password and use the API', async () => {
    const me = await call('GET', '/api/v1/auth/me', { cookie: temp.cookie });
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword).toBe(true);

    const changed = await call('POST', '/api/v1/auth/force-change-password', {
      cookie: temp.cookie, body: { password: 'a-brand-new-password' },
    });
    expect(changed.status).toBe(200);

    const org = await call('GET', '/api/v1/org', { cookie: temp.cookie });
    expect(org.status).toBe(200);
  });

  it('can log out while the change is pending', async () => {
    const pending = makeUser(temp.orgId, true);
    const r = await call('POST', '/api/v1/auth/logout', { cookie: pending.cookie });
    expect(r.status).toBe(200);
  });
});

describe('normal session', () => {
  it('is unaffected', async () => {
    expect((await call('GET', '/api/v1/org', { cookie: normal.cookie })).status).toBe(200);
    expect((await call('PATCH', '/api/v1/auth/profile', { cookie: normal.cookie, body: { name: 'Fine' } })).status).toBe(200);
  });
});

describe('temporary-password session on the CPG routes (/api/v1/cpg/*)', () => {
  // One route from every CPG route file. The block fires in
  // requireSessionOrApiKey, before any permission check.
  const cpgRoutes: Array<[string, string, unknown]> = [
    ['GET', '/api/v1/cpg/me', undefined], // me.ts
    ['GET', '/api/v1/cpg/roles', undefined], // rbac.ts
    ['POST', '/api/v1/cpg/users', { email: 'blocked@gate.example.org', name: 'Blocked' }], // rbac.ts (write)
    ['GET', '/api/v1/cpg/settings', undefined], // settings.ts
    ['PATCH', '/api/v1/cpg/settings', { enabled: true }], // settings.ts (write)
    ['GET', '/api/v1/cpg/audit', undefined], // audit.ts
    ['GET', '/api/v1/cpg/boards', undefined], // boards.ts
    ['POST', '/api/v1/cpg/boards', { key: 'blocked', name: 'Blocked', kind: 'custom' }], // boards.ts (write)
    ['GET', '/api/v1/cpg/quorum', undefined], // quorum.ts
    ['GET', '/api/v1/cpg/policies', undefined], // policies.ts
    ['POST', '/api/v1/cpg/compile', { plainText: 'Blocked before any permission check.', examples: { violating: [{ path: 'a.ts', code: 'x' }] } }], // policies.ts (write)
    ['GET', '/api/v1/cpg/bundle', undefined], // bundle.ts
  ];

  for (const [method, path, body] of cpgRoutes) {
    it(`${method} ${path} → 403 password_change_required`, async () => {
      const pending = makeUser(temp.orgId, true);
      const r = await call(method, path, { cookie: pending.cookie, body });
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('password_change_required');
    });
  }

  it('the same session reaches /cpg/me once the password is changed', async () => {
    const pending = makeUser(temp.orgId, true);
    expect((await call('GET', '/api/v1/cpg/me', { cookie: pending.cookie })).status).toBe(403);
    expect((await call('POST', '/api/v1/auth/force-change-password', { cookie: pending.cookie, body: { password: 'another-new-password' } })).status).toBe(200);
    expect((await call('GET', '/api/v1/cpg/me', { cookie: pending.cookie })).status).toBe(200);
  });
});
