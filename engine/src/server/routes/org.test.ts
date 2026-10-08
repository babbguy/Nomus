/**
 * Self-service organization routes (/api/v1/org): a signed-in member manages
 * their own org profile and API keys and sees who else is in the org.
 *
 * Real DB, real sessions (cookie + hashed token rows), real app. A key created
 * through the route is used against the key-authenticated policy and evaluate
 * routes to prove it verifies exactly like an admin-minted key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys } from '../../core/signing.js';
import { apiKeys, organizations, sessions, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { createApp } from '../app.js';

const app = createApp();

function makeOrg(label: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(organizations).values({
    id, name: `${label} ${id.slice(0, 6)}`, slug: `${label.toLowerCase()}-${id.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

/** Create a user in orgId and a live session; returns the cookie header. */
function makeUser(orgId: string, role: 'member' | 'platform_admin' = 'member') {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(users).values({
    id, orgId, email: `${id}@example.test`, passwordHash: 'x-not-a-real-hash', name: `User ${id.slice(0, 4)}`,
    role, authProvider: 'local', mustChangePassword: false, isActive: true, createdAt: now, updatedAt: now,
  }).run();
  const token = randomBytes(32).toString('hex');
  getDb().insert(sessions).values({
    id: randomUUID(), userId: id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: now,
  }).run();
  return { id, cookie: `nomus_session=${token}` };
}

async function call(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`http://localhost${path}`, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

let orgA: string;
let orgB: string;
let memberA: { id: string; cookie: string };
let memberA2: { id: string; cookie: string };
let memberB: { id: string; cookie: string };

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgA = makeOrg('Acme');
  orgB = makeOrg('Other');
  memberA = makeUser(orgA);
  memberA2 = makeUser(orgA);
  memberB = makeUser(orgB);
});

describe('authentication', () => {
  it('returns 401 for every /org route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/org'],
      ['PATCH', '/api/v1/org'],
      ['GET', '/api/v1/org/api-keys'],
      ['POST', '/api/v1/org/api-keys'],
      ['DELETE', `/api/v1/org/api-keys/${randomUUID()}`],
      ['GET', '/api/v1/org/members'],
    ] as const) {
      const res = await call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('does not accept an API key in place of a session', async () => {
    const created = await call('POST', '/api/v1/org/api-keys', {
      cookie: memberA.cookie, body: { label: 'bootstrap', scopes: ['read:policies'] },
    });
    expect(created.status).toBe(201);
    const res = await call('GET', '/api/v1/org', { bearer: created.json.key });
    expect(res.status).toBe(401);
  });
});

describe('own organization', () => {
  it('lets a member read their org without secrets', async () => {
    const res = await call('GET', '/api/v1/org', { cookie: memberA.cookie });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(orgA);
    expect(res.json.slug).toMatch(/^acme-/);
    expect(res.json.jurisdictionAccess).toEqual([]);
    expect(Object.keys(res.json).sort()).toEqual([
      'createdAt', 'id', 'industry', 'jurisdictionAccess', 'name', 'showOrgOnPublicVerify', 'slug', 'subIndustry', 'updatedAt',
    ]);
  });

  it('lets a member update the allowed profile fields', async () => {
    const res = await call('PATCH', '/api/v1/org', {
      cookie: memberA.cookie,
      body: { industry: 'healthcare', subIndustry: 'Clinical trials', jurisdictionAccess: ['EU', 'US-FED', 'EU'], showOrgOnPublicVerify: true },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      industry: 'healthcare', subIndustry: 'Clinical trials', jurisdictionAccess: ['EU', 'US-FED'], showOrgOnPublicVerify: true,
    });
    const again = await call('GET', '/api/v1/org', { cookie: memberA.cookie });
    expect(again.json.industry).toBe('healthcare');

    const cleared = await call('PATCH', '/api/v1/org', { cookie: memberA.cookie, body: { subIndustry: '' } });
    expect(cleared.status).toBe(200);
    expect(cleared.json.subIndustry).toBeNull();
  });

  it('rejects platform-level fields with 400 and changes nothing', async () => {
    const before = getDb().select().from(organizations).where(eq(organizations.id, orgA)).get()!;
    for (const body of [
      { name: 'Hijacked' }, { slug: 'hijacked' }, { isActive: false }, { id: randomUUID() },
      { industry: 'finance', name: 'Hijacked' },
    ]) {
      const res = await call('PATCH', '/api/v1/org', { cookie: memberA.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const after = getDb().select().from(organizations).where(eq(organizations.id, orgA)).get()!;
    expect(after.name).toBe(before.name);
    expect(after.slug).toBe(before.slug);
    expect(after.isActive).toBe(true);
    expect(after.industry).toBe(before.industry);
  });

  it('rejects unknown jurisdictions, empty bodies and malformed JSON', async () => {
    expect((await call('PATCH', '/api/v1/org', { cookie: memberA.cookie, body: { jurisdictionAccess: ['ATLANTIS'] } })).status).toBe(400);
    expect((await call('PATCH', '/api/v1/org', { cookie: memberA.cookie, body: {} })).status).toBe(400);
    const raw = await app.request('http://localhost/api/v1/org', {
      method: 'PATCH', headers: { Cookie: memberA.cookie, 'Content-Type': 'application/json' }, body: '{nope',
    });
    expect(raw.status).toBe(400);
  });

  it('only ever shows the org of the session', async () => {
    const other = await call('GET', '/api/v1/org', { cookie: memberB.cookie });
    expect(other.json.id).toBe(orgB);
    expect(other.json.industry).toBeNull();
  });
});

describe('api keys', () => {
  it('creates a key once, and that key authenticates policies and evaluate', async () => {
    const created = await call('POST', '/api/v1/org/api-keys', {
      cookie: memberA.cookie, body: { label: 'CI scanner', scopes: ['read:policies', 'evaluate'] },
    });
    expect(created.status).toBe(201);
    expect(created.json.key).toMatch(/^nk_live_/);
    expect(created.json.prefix).toBe(created.json.key.slice(0, 12));
    expect(created.json.scopes).toEqual(['read:policies', 'evaluate']);
    expect(created.json.rateLimitRpm).toBe(env().NOMUS_RATE_LIMIT_RPM);

    // Stored hashed, scoped to the member's org
    const row = getDb().select().from(apiKeys).where(eq(apiKeys.id, created.json.id)).get()!;
    expect(row.orgId).toBe(orgA);
    expect(row.keyHash).toBe(createHash('sha256').update(created.json.key).digest('hex'));

    const policies = await call('GET', '/api/v1/policies', { bearer: created.json.key });
    expect(policies.status).toBe(200);

    const evaluated = await call('POST', '/api/v1/evaluate', {
      bearer: created.json.key, body: { action: 'publish_generated_content', jurisdiction: 'EU', context: { sector: 'media' } },
    });
    expect(evaluated.status).toBe(200);
    expect(evaluated.json.result).toBeDefined();

    // Not granted the stream scope, so it must not reach stream-gated routes
    const stream = await call('GET', '/api/v1/stream', { bearer: created.json.key });
    expect(stream.status).toBe(403);
  });

  it('never returns the raw key or hash when listing', async () => {
    const created = await call('POST', '/api/v1/org/api-keys', {
      cookie: memberA.cookie, body: { label: 'list-me', scopes: ['read:policies'] },
    });
    const list = await call('GET', '/api/v1/org/api-keys', { cookie: memberA.cookie });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(created.json.key);
    expect(list.text.toLowerCase()).not.toContain('keyhash');
    const item = list.json.keys.find((k: any) => k.id === created.json.id);
    expect(item).toMatchObject({ label: 'list-me', keyPrefix: created.json.prefix, scopes: ['read:policies'], isActive: true, lastUsedAt: null });
    expect(typeof item.createdAt).toBe('string');
  });

  it('rejects the admin scope with 403 and creates nothing', async () => {
    const before = getDb().select().from(apiKeys).where(eq(apiKeys.orgId, orgA)).all().length;
    const res = await call('POST', '/api/v1/org/api-keys', {
      cookie: memberA.cookie, body: { label: 'sneaky', scopes: ['read:policies', 'admin'] },
    });
    expect(res.status).toBe(403);
    expect(getDb().select().from(apiKeys).where(eq(apiKeys.orgId, orgA)).all().length).toBe(before);
  });

  it('validates the body (400)', async () => {
    for (const body of [{}, { label: 'x' }, { label: 'x', scopes: [] }, { label: '', scopes: ['evaluate'] }, { label: 'x', scopes: ['root'] }]) {
      const res = await call('POST', '/api/v1/org/api-keys', { cookie: memberA.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('even a platform admin cannot mint an admin-scoped key here', async () => {
    const admin = makeUser(orgB, 'platform_admin');
    const res = await call('POST', '/api/v1/org/api-keys', {
      cookie: admin.cookie, body: { label: 'admin attempt', scopes: ['admin'] },
    });
    expect(res.status).toBe(403);
  });

  it('keeps keys private to their org: another org cannot list or revoke them (404)', async () => {
    const created = await call('POST', '/api/v1/org/api-keys', {
      cookie: memberA.cookie, body: { label: 'private', scopes: ['read:policies'] },
    });
    const otherList = await call('GET', '/api/v1/org/api-keys', { cookie: memberB.cookie });
    expect(otherList.json.keys.some((k: any) => k.id === created.json.id)).toBe(false);

    const del = await call('DELETE', `/api/v1/org/api-keys/${created.json.id}`, { cookie: memberB.cookie });
    expect(del.status).toBe(404);
    // still works
    expect((await call('GET', '/api/v1/policies', { bearer: created.json.key })).status).toBe(200);

    const missing = await call('DELETE', `/api/v1/org/api-keys/${randomUUID()}`, { cookie: memberA.cookie });
    expect(missing.status).toBe(404);
  });

  it('revokes a key: it stops authenticating and is marked inactive', async () => {
    const created = await call('POST', '/api/v1/org/api-keys', {
      cookie: memberA2.cookie, body: { label: 'revoke-me', scopes: ['read:policies'] },
    });
    expect((await call('GET', '/api/v1/policies', { bearer: created.json.key })).status).toBe(200);

    const del = await call('DELETE', `/api/v1/org/api-keys/${created.json.id}`, { cookie: memberA2.cookie });
    expect(del.status).toBe(200);
    expect((await call('GET', '/api/v1/policies', { bearer: created.json.key })).status).toBe(401);

    const list = await call('GET', '/api/v1/org/api-keys', { cookie: memberA2.cookie });
    expect(list.json.keys.find((k: any) => k.id === created.json.id).isActive).toBe(false);
  });

  it('enforces NOMUS_MAX_API_KEYS_PER_ORG over active keys', async () => {
    const org = makeOrg('Capped');
    const user = makeUser(org);
    const max = env().NOMUS_MAX_API_KEYS_PER_ORG;
    const now = new Date().toISOString();
    const rows = Array.from({ length: max }, (_, i) => ({
      id: randomUUID(), orgId: org, keyHash: createHash('sha256').update(`filler-${org}-${i}`).digest('hex'),
      keyPrefix: 'nk_live_fill', label: `filler ${i}`, scopes: '["read:policies"]', rateLimitRpm: 60, isActive: true, createdAt: now,
    }));
    getDb().insert(apiKeys).values(rows).run();

    const blocked = await call('POST', '/api/v1/org/api-keys', { cookie: user.cookie, body: { label: 'one too many', scopes: ['evaluate'] } });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error).toContain('limit');

    // Revoking one frees a slot
    const del = await call('DELETE', `/api/v1/org/api-keys/${rows[0].id}`, { cookie: user.cookie });
    expect(del.status).toBe(200);
    const ok = await call('POST', '/api/v1/org/api-keys', { cookie: user.cookie, body: { label: 'fits now', scopes: ['evaluate'] } });
    expect(ok.status).toBe(201);
  });
});

describe('members', () => {
  it('lists only the org of the session, without credentials', async () => {
    const res = await call('GET', '/api/v1/org/members', { cookie: memberA.cookie });
    expect(res.status).toBe(200);
    const ids = res.json.members.map((m: any) => m.id);
    expect(ids).toContain(memberA.id);
    expect(ids).toContain(memberA2.id);
    expect(ids).not.toContain(memberB.id);
    expect(res.json.count).toBe(res.json.members.length);
    for (const m of res.json.members) {
      expect(Object.keys(m).sort()).toEqual(['createdAt', 'email', 'id', 'isActive', 'name', 'role']);
    }
    expect(res.text).not.toContain('x-not-a-real-hash');
  });

  it('keeps the user-management and settings routes platform-admin only', async () => {
    expect((await call('GET', '/api/v1/users', { cookie: memberA.cookie })).status).toBe(403);
    expect((await call('GET', '/api/v1/settings/llm', { cookie: memberA.cookie })).status).toBe(403);
  });
});
