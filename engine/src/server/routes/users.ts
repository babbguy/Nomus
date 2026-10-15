import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { users, organizations } from '../../db/schema.js';
import { requireSession } from '../middleware/auth.js';
import { actorOf, safeJson, safeParseInt } from '../utils.js';
import { invitationMessage, makeTemporaryPassword, sendInvitationEmail } from '../../services/invitations.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { applyNewMemberGrants } from '../../cpg/rbac/seed.js';
import { revokeAllGrantsInOrg } from '../../cpg/rbac/grants.js';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  orgId: z.string().uuid(),
  password: z.string().min(8).optional(),
  role: z.enum(['platform_admin', 'member']).default('member'),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['platform_admin', 'member']).optional(),
  isActive: z.boolean().optional(),
  orgId: z.string().uuid().optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).optional(),
});

export const userRoutes = new Hono<AppEnv>();

userRoutes.use('*', requireSession('platform_admin'));

// List all users (with optional org filter)
userRoutes.get('/', (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(safeParseInt(c.req.query('limit'), 100), 1), 500);
  const offset = Math.max(safeParseInt(c.req.query('offset'), 0), 0);
  const orgFilter = c.req.query('orgId');

  const conditions = orgFilter ? eq(users.orgId, orgFilter) : undefined;

  const allUsers = db.select({
    id: users.id,
    orgId: users.orgId,
    email: users.email,
    name: users.name,
    role: users.role,
    authProvider: users.authProvider,
    mustChangePassword: users.mustChangePassword,
    isActive: users.isActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users)
    .where(conditions)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  // Attach org names
  const orgIds = [...new Set(allUsers.map((u) => u.orgId))];
  const orgs = orgIds.length > 0
    ? db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
        .from(organizations).all()
    : [];
  const orgMap = new Map(orgs.map((o) => [o.id, o]));

  const enriched = allUsers.map((u) => ({
    ...u,
    orgName: orgMap.get(u.orgId)?.name ?? 'Unknown',
    orgSlug: orgMap.get(u.orgId)?.slug ?? '',
  }));

  // total: every matching user (count is this page).
  const total = db.select({ n: sql<number>`count(*)` }).from(users).where(conditions).get()?.n ?? enriched.length;
  return c.json({ count: enriched.length, total, users: enriched });
});

// Create / invite user
userRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  const db = getDb();

  // Check email uniqueness
  const existing = db.select({ id: users.id }).from(users)
    .where(eq(users.email, parsed.data.email.toLowerCase().trim()))
    .get();
  if (existing) return c.json({ error: 'Email already in use' }, 409);

  // Verify org exists
  const org = db.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.id, parsed.data.orgId)).get();
  if (!org) return c.json({ error: 'Organization not found' }, 404);

  const { tempPassword, passwordHash } = await makeTemporaryPassword(parsed.data.password);
  const now = new Date().toISOString();

  const user = {
    id: randomUUID(),
    orgId: parsed.data.orgId,
    email: parsed.data.email.toLowerCase().trim(),
    passwordHash,
    name: parsed.data.name,
    role: parsed.data.role,
    authProvider: 'local',
    mustChangePassword: true, // Force password change on first login
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  // The user and their CPG grants (Developer; Org Admin when the org has no
  // active Org Admin) are written atomically. Platform admins get no grants.
  rawSqlite(db).transaction(() => {
    db.insert(users).values(user).run();
    applyNewMemberGrants(db, user.orgId, user.id, actorOf(c));
  })();

  // Send invitation email (non-blocking)
  const orgInfo = db.select({ name: organizations.name }).from(organizations)
    .where(eq(organizations.id, parsed.data.orgId)).get();
  sendInvitationEmail({ email: user.email, tempPassword, orgName: orgInfo?.name ?? null });

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tempPassword,
    message: invitationMessage(),
  }, 201);
});

// Get user detail
userRoutes.get('/:id', (c) => {
  const db = getDb();
  const user = db.select({
    id: users.id,
    orgId: users.orgId,
    email: users.email,
    name: users.name,
    role: users.role,
    authProvider: users.authProvider,
    isActive: users.isActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users)
    .where(eq(users.id, c.req.param('id')))
    .get();

  if (!user) return c.json({ error: 'User not found' }, 404);

  const org = db.select({ name: organizations.name, slug: organizations.slug })
    .from(organizations).where(eq(organizations.id, user.orgId)).get();

  return c.json({ ...user, org });
});

// Edit user
userRoutes.patch('/:id', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  const db = getDb();

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.name) updates.name = parsed.data.name;
  if (parsed.data.role) updates.role = parsed.data.role;
  if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;
  if (parsed.data.orgId) {
    // Verify the target org exists and is active before reassigning the user.
    // (without this, a typo silently breaks login.)
    const targetOrg = db.select({ id: organizations.id, isActive: organizations.isActive })
      .from(organizations)
      .where(eq(organizations.id, parsed.data.orgId))
      .get();
    if (!targetOrg) return c.json({ error: 'Target organization not found' }, 400);
    if (!targetOrg.isActive) return c.json({ error: 'Target organization is inactive' }, 400);
    updates.orgId = parsed.data.orgId;
  }

  const userId = c.req.param('id');
  const before = db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).get();
  if (!before) return c.json({ error: 'User not found' }, 404);

  // Moving a user to another org revokes every CPG grant in the old org and
  // applies the new-member rule in the new one, atomically with the move.
  const moved = parsed.data.orgId !== undefined && parsed.data.orgId !== before.orgId;
  const actor = actorOf(c);
  const changes = rawSqlite(db).transaction(() => {
    const result = db.update(users).set(updates).where(eq(users.id, userId)).run();
    if (result.changes > 0 && moved) {
      revokeAllGrantsInOrg(db, before.orgId, userId, actor, 'user moved');
      applyNewMemberGrants(db, parsed.data.orgId!, userId, actor);
    }
    return result.changes;
  })();

  if (changes === 0) return c.json({ error: 'User not found' }, 404);
  return c.json({ message: 'User updated' });
});

// Deactivate user
userRoutes.delete('/:id', (c) => {
  const db = getDb();
  const result = db.update(users)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(users.id, c.req.param('id'))).run();

  if (result.changes === 0) return c.json({ error: 'User not found' }, 404);
  return c.json({ message: 'User deactivated' });
});

// Admin reset password
userRoutes.post('/:id/reset-password', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  const db = getDb();

  const newPassword = parsed.data.password || `nomus-${randomUUID().slice(0, 8)}`;
  const passwordHash = await bcrypt.hash(newPassword, 12);

  const result = db.update(users)
    .set({ passwordHash, mustChangePassword: true, updatedAt: new Date().toISOString() })
    .where(eq(users.id, c.req.param('id'))).run();

  if (result.changes === 0) return c.json({ error: 'User not found' }, 404);
  return c.json({ message: 'Password reset — user must change it on next login', newPassword });
});
