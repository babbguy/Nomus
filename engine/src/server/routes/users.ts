import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { users, organizations } from '../../db/schema.js';
import { requireSession } from '../middleware/auth.js';
import { env } from '../../config/env.js';
import { safeJson, safeParseInt } from '../utils.js';
import { logger } from '../../logger.js';
import { getResendApiKey } from '../../services/notifications.js';

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

  const tempPassword = parsed.data.password || `nomus-${randomUUID().slice(0, 8)}`;
  const passwordHash = await bcrypt.hash(tempPassword, 12);
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

  db.insert(users).values(user).run();

  // Send invitation email (non-blocking)
  const config = env();
  const appUrl = config.NOMUS_CORS_ORIGIN;
  const orgInfo = db.select({ name: organizations.name }).from(organizations)
    .where(eq(organizations.id, parsed.data.orgId)).get();

  if (getResendApiKey()) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getResendApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.NOMUS_FROM_EMAIL,
        to: user.email,
        subject: `You've been invited to Nomus — ${orgInfo?.name ?? 'Your Organization'}`,
        html: `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h2 style="color:#0a0b0f;">Welcome to Nomus</h2>
          <p style="color:#374151;font-size:15px;">You've been invited to <strong>${orgInfo?.name ?? 'your organization'}</strong> on Nomus, the AI regulatory applicability engine.</p>
          <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Your login credentials:</p>
            <p style="margin:0 0 4px;font-size:14px;"><strong>Email:</strong> ${user.email}</p>
            <p style="margin:0;font-size:14px;"><strong>Temporary Password:</strong> ${tempPassword}</p>
          </div>
          <p style="color:#374151;font-size:15px;">You'll be asked to create a new password when you first sign in. You can also sign in with Google or GitHub.</p>
          <a href="${appUrl}/login" style="display:inline-block;padding:12px 24px;background:#00e5a0;color:#0a0b0f;text-decoration:none;border-radius:8px;font-weight:600;margin-top:8px;">Sign In to Nomus</a>
          <p style="color:#9ca3af;font-size:11px;margin-top:24px;">Nomus — Regulatory monitoring, not legal advice.</p>
        </div>`,
      }),
    }).catch((err) => {
      logger.error({ error: (err as Error).message }, 'Failed to send invitation email');
    });
  } else {
    // SECURITY: never log the temp password — this branch fires whenever
    // NOMUS_RESEND_API_KEY is unset, which can happen in production.
    logger.info({ email: user.email }, 'Invitation email not sent (no email provider configured); temp password returned in API response only');
  }

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tempPassword,
    message: getResendApiKey()
      ? 'User created; an invitation email is being sent. They must set a new password on first login.'
      : 'User created. No email provider is configured, so share the temporary password with them directly. They must set a new password on first login.',
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

  const result = db.update(users).set(updates)
    .where(eq(users.id, c.req.param('id'))).run();

  if (result.changes === 0) return c.json({ error: 'User not found' }, 404);
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
