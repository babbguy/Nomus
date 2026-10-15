/**
 * User-bound API keys (design spec §3.6) and the VS Code device sign-in.
 *
 * v1.1.0 bug fixed here: /auth/device/token revoked every active
 * "VS Code Extension" key in the org, so a second developer signing in logged
 * the first one out, and the key carried no user. Keys are now bound to their
 * user, and re-signing in replaces only that user's key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys } from '../../core/signing.js';
import { apiKeys, users } from '../../db/schema.js';
import { setState } from '../../core/state-store.js';
import { hashApiKey } from '../../tenant/api-keys.js';
import { resolveApiKey } from '../../tenant/resolver.js';
import { createApp } from '../app.js';
import { call, makeKey, makeOrg, makeUser, type TestUser } from '../../cpg/__fixtures__/rbac-fixtures.js';

const app = createApp();
let orgId: string;
let alice: TestUser;
let bob: TestUser;

/** The full device flow for a signed-in user: callback with the session, then the token exchange. */
async function deviceSignIn(user: TestUser): Promise<string> {
  const state = randomUUID();
  setState('device_auth_pending', state, 'vscode://nomus.nomus/auth-callback', 60_000);
  const cb = await call(app, 'GET', `/api/v1/auth/device/callback?device_state=${state}`, { cookie: user.cookie });
  expect(cb.status).toBe(302);
  const code = new URL(cb.headers.get('location')!.replace('vscode://', 'http://')).searchParams.get('code')!;
  const token = await call(app, 'POST', '/api/v1/auth/device/token', { body: { code } });
  expect(token.status).toBe(200);
  return token.json.apiKey as string;
}

function keyRow(raw: string) {
  return getDb().select().from(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(raw))).get()!;
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Device');
  alice = makeUser(orgId);
  bob = makeUser(orgId);
});

describe('device sign-in mints user-bound keys', () => {
  it('two users in the same org: both keys stay active and each acts as its own user', async () => {
    const aliceKey = await deviceSignIn(alice);
    const bobKey = await deviceSignIn(bob);

    expect(keyRow(aliceKey)).toMatchObject({ userId: alice.id, isActive: true, label: 'VS Code Extension' });
    expect(keyRow(bobKey)).toMatchObject({ userId: bob.id, isActive: true, label: 'VS Code Extension' });
    expect(JSON.parse(keyRow(aliceKey).scopes)).toEqual(['read:policies', 'evaluate', 'stream']);

    for (const [key, user] of [[aliceKey, alice], [bobKey, bob]] as const) {
      expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: key })).status).toBe(200);
      const me = await call(app, 'GET', '/api/v1/cpg/me', { bearer: key });
      expect(me.status).toBe(200);
      expect(me.json).toMatchObject({ identity: 'user_key', user: { id: user.id, email: user.email } });
    }
  });

  it('re-signing in replaces only the same user\'s key', async () => {
    const first = await deviceSignIn(alice);
    const bobKey = await deviceSignIn(bob);
    const second = await deviceSignIn(alice);
    expect(keyRow(first).isActive).toBe(false);
    expect(keyRow(second).isActive).toBe(true);
    expect(keyRow(bobKey).isActive).toBe(true);
    expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: first })).status).toBe(401);
    expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: bobKey })).status).toBe(200);
    const active = getDb().select().from(apiKeys)
      .where(and(eq(apiKeys.userId, alice.id), eq(apiKeys.label, 'VS Code Extension'), eq(apiKeys.isActive, true))).all();
    expect(active).toHaveLength(1);
  });

  it('a pre-upgrade org-level VS Code key keeps working for scanning, and is not revoked by a user sign-in', async () => {
    const legacy = makeKey(orgId, null, ['read:policies', 'evaluate', 'stream'], 'VS Code Extension');
    await deviceSignIn(alice);
    expect(getDb().select().from(apiKeys).where(eq(apiKeys.id, legacy.id)).get()!.isActive).toBe(true);
    expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: legacy.key })).status).toBe(200);
    // It has no user identity, so CPG user endpoints refuse it.
    const me = await call(app, 'GET', '/api/v1/cpg/me', { bearer: legacy.key });
    expect([me.status, me.json.code]).toEqual([403, 'user_identity_required']);
  });

  it('the token step refuses a user deactivated after the code was issued', async () => {
    const carol = makeUser(orgId);
    const state = randomUUID();
    setState('device_auth_pending', state, 'vscode://nomus.nomus/auth-callback', 60_000);
    const cb = await call(app, 'GET', `/api/v1/auth/device/callback?device_state=${state}`, { cookie: carol.cookie });
    const code = new URL(cb.headers.get('location')!.replace('vscode://', 'http://')).searchParams.get('code')!;
    getDb().update(users).set({ isActive: false }).where(eq(users.id, carol.id)).run();
    const token = await call(app, 'POST', '/api/v1/auth/device/token', { body: { code } });
    expect(token.status).toBe(401);
    expect(getDb().select().from(apiKeys).where(eq(apiKeys.userId, carol.id)).all()).toHaveLength(0);
  });
});

describe('user-bound key resolution', () => {
  it('an inactive user\'s key is rejected with 401', async () => {
    const dave = makeUser(orgId);
    const k = makeKey(orgId, dave.id);
    expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: k.key })).status).toBe(200);
    getDb().update(users).set({ isActive: false }).where(eq(users.id, dave.id)).run();
    expect(resolveApiKey(k.key)).toBeNull();
    expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: k.key })).status).toBe(401);
    expect((await call(app, 'POST', '/api/v1/evaluate', { bearer: k.key, body: { action: 'publish_generated_content', jurisdiction: 'EU' } })).status).toBe(401);
  });

  it('a key whose user still has a temporary password gets 403 password_change_required everywhere', async () => {
    const erin = makeUser(orgId, { mustChangePassword: true });
    const k = makeKey(orgId, erin.id);
    expect(resolveApiKey(k.key)).toMatchObject({ userId: erin.id, passwordChangeRequired: true });
    for (const [method, path, body] of [
      ['GET', '/api/v1/policies?limit=1', undefined], // requireAuth
      ['POST', '/api/v1/evaluate', { action: 'publish_generated_content', jurisdiction: 'EU' }], // requireAuth
      ['GET', '/api/v1/cpg/me', undefined], // requireSessionOrApiKey
      ['GET', '/api/v1/cpg/settings', undefined],
    ] as const) {
      const res = await call(app, method, path, { bearer: k.key, body });
      expect([res.status, res.json?.code], path).toEqual([403, 'password_change_required']);
    }
  });

  it('a key whose user moved to another org stops working', async () => {
    const frank = makeUser(orgId);
    const k = makeKey(orgId, frank.id);
    getDb().update(users).set({ orgId: makeOrg('Elsewhere') }).where(eq(users.id, frank.id)).run();
    expect((await call(app, 'GET', '/api/v1/policies?limit=1', { bearer: k.key })).status).toBe(401);
  });

  it('org keys resolve exactly as before: no user, no password check', () => {
    const k = makeKey(orgId, null);
    expect(resolveApiKey(k.key)).toMatchObject({ orgId, userId: null, passwordChangeRequired: false });
  });
});
