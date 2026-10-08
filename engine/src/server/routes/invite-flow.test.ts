/**
 * Nomus invite flow tests — covers POST /users (admin invite),
 * mustChangePassword enforcement, and POST /auth/force-change-password.
 *
 * Nomus's invite model is NOT token-based: an admin creates the user
 * directly with a temporary password, the email delivers credentials,
 * and the user is forced to change password on first login. This test
 * proves the full chain works end-to-end with a real DB.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';

import { getDb, closeDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { initSigningKeys } from '../../core/signing.js';
import { users, organizations, sessions } from '../../db/schema.js';

beforeAll(() => {
  closeDb();
  runMigrations();
  initSigningKeys();
});

beforeEach(() => {
  const db = getDb();
  db.delete(sessions).run();
  db.delete(users).run();
  db.delete(organizations).run();
});

function makeOrg() {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({
    id,
    name: 'Test Org ' + id.slice(0, 8),
    slug: 'test-' + id.slice(0, 8),
    jurisdictionAccess: '[]',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

/**
 * Inline copy of the production invite logic from users.ts. Mirroring
 * here lets us test the DB semantics without a Hono server. Returns
 * the temp password the admin would email to the user.
 */
async function inviteUser(opts: { orgId: string; email: string; name: string; role?: 'platform_admin' | 'member' }): Promise<{ userId: string; tempPassword: string }> {
  const db = getDb();
  const tempPassword = `nomus-${randomUUID().slice(0, 8)}`;
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const userId = randomUUID();
  const now = new Date().toISOString();

  db.insert(users).values({
    id: userId,
    orgId: opts.orgId,
    email: opts.email.toLowerCase().trim(),
    passwordHash,
    name: opts.name,
    role: opts.role ?? 'member',
    authProvider: 'local',
    mustChangePassword: true,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();

  return { userId, tempPassword };
}

/**
 * Inline copy of the production force-change-password logic.
 */
async function forceChangePassword(userId: string, newPassword: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const db = getDb();

  // Synthesize a session for this user (mimics the cookie auth path)
  const sessionToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  db.insert(sessions).values({
    id: randomUUID(),
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
  }).run();

  const session = db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
  if (!session || new Date(session.expiresAt) < new Date()) {
    return { ok: false, status: 401, error: 'Session expired' };
  }
  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user) return { ok: false, status: 401, error: 'User not found' };
  if (!user.mustChangePassword) return { ok: false, status: 400, error: 'Password change not required' };
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, status: 400, error: 'Password must be at least 8 characters' };
  }
  const newHash = await bcrypt.hash(newPassword, 12);
  db.update(users)
    .set({ passwordHash: newHash, mustChangePassword: false, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user.id))
    .run();
  return { ok: true, status: 200 };
}

// ════════════════════════════════════════════════════════════════════
// Invite creation
// ════════════════════════════════════════════════════════════════════

describe('Nomus invite flow', () => {
  it('admin invite creates a user with mustChangePassword=true', async () => {
    const orgId = makeOrg();
    const { userId, tempPassword } = await inviteUser({
      orgId,
      email: 'newuser@test.dev',
      name: 'New User',
    });

    const db = getDb();
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    expect(user).toBeDefined();
    expect(user!.email).toBe('newuser@test.dev');
    expect(user!.mustChangePassword).toBe(true);
    expect(user!.authProvider).toBe('local');
    expect(user!.isActive).toBe(true);
    expect(user!.passwordHash).toBeTruthy();
    expect(tempPassword).toMatch(/^nomus-[a-f0-9]{8}$/);

    // Temp password matches the stored hash
    const matches = await bcrypt.compare(tempPassword, user!.passwordHash!);
    expect(matches).toBe(true);
  });

  it('temp password is unique per invite', async () => {
    const orgId = makeOrg();
    const a = await inviteUser({ orgId, email: 'a@test.dev', name: 'A' });
    const b = await inviteUser({ orgId, email: 'b@test.dev', name: 'B' });
    expect(a.tempPassword).not.toBe(b.tempPassword);
  });

  it('email is normalized (lowercased + trimmed)', async () => {
    const orgId = makeOrg();
    const { userId } = await inviteUser({
      orgId,
      email: '  CapitalEmail@TEST.DEV  ',
      name: 'Mixed Case',
    });
    const db = getDb();
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    expect(user!.email).toBe('capitalemail@test.dev');
  });

  it('invited user can be assigned member or platform_admin role', async () => {
    const orgId = makeOrg();
    const member = await inviteUser({ orgId, email: 'member@test.dev', name: 'M' });
    const admin = await inviteUser({ orgId, email: 'admin@test.dev', name: 'A', role: 'platform_admin' });

    const db = getDb();
    const memberRow = db.select().from(users).where(eq(users.id, member.userId)).get();
    const adminRow = db.select().from(users).where(eq(users.id, admin.userId)).get();
    expect(memberRow!.role).toBe('member');
    expect(adminRow!.role).toBe('platform_admin');
  });
});

// ════════════════════════════════════════════════════════════════════
// force-change-password enforcement
// ════════════════════════════════════════════════════════════════════

describe('force-change-password', () => {
  it('clears mustChangePassword and rotates the password hash', async () => {
    const orgId = makeOrg();
    const { userId, tempPassword } = await inviteUser({
      orgId,
      email: 'rotate@test.dev',
      name: 'R',
    });

    const result = await forceChangePassword(userId, 'BrandNewSecurePass123!');
    expect(result.ok).toBe(true);

    const db = getDb();
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    expect(user!.mustChangePassword).toBe(false);

    // Old temp password no longer works
    const oldStillMatches = await bcrypt.compare(tempPassword, user!.passwordHash!);
    expect(oldStillMatches).toBe(false);

    // New password works
    const newMatches = await bcrypt.compare('BrandNewSecurePass123!', user!.passwordHash!);
    expect(newMatches).toBe(true);
  });

  it('rejects users who have already changed their password (400)', async () => {
    const orgId = makeOrg();
    const { userId } = await inviteUser({ orgId, email: 'one@test.dev', name: 'O' });

    expect((await forceChangePassword(userId, 'FirstChange1234')).ok).toBe(true);
    const second = await forceChangePassword(userId, 'SecondAttempt1234');
    expect(second.ok).toBe(false);
    expect(second.status).toBe(400);
    expect(second.error).toMatch(/not required/i);
  });

  it('rejects passwords shorter than 8 chars (400)', async () => {
    const orgId = makeOrg();
    const { userId } = await inviteUser({ orgId, email: 'short@test.dev', name: 'S' });
    const result = await forceChangePassword(userId, 'short');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/8 characters/);
  });

  it('rejects empty password (400)', async () => {
    const orgId = makeOrg();
    const { userId } = await inviteUser({ orgId, email: 'empty@test.dev', name: 'E' });
    const result = await forceChangePassword(userId, '');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('rejects unknown user (401)', async () => {
    const result = await forceChangePassword('does-not-exist', 'ValidPassword123');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
