import { Hono, type Context, type Next } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { users, sessions, organizations, passwordResetTokens } from '../../db/schema.js';
import { safeJson } from '../utils.js';
import { passwordChangeRequiredResponse } from '../middleware/auth.js';
import { logger } from '../../logger.js';
import { getResendApiKey, resendEndpoint } from '../../services/notifications.js';

export const authRoutes = new Hono();

const SESSION_COOKIE = 'nomus_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── IP-based rate limiting for auth endpoints ──────────────────
// NOTE: x-forwarded-for is only trustworthy behind a trusted reverse proxy
// (e.g., nginx) that overwrites the header. Without a proxy, clients can
// spoof this header. We include the socket remote address as a fallback.
const _authAttempts = new Map<string, { count: number; resetAt: number }>();

function authRateLimit(maxPerMinute: number) {
  return async (c: Context, next: Next) => {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const realIp = c.req.header('x-real-ip');
    const remoteAddr = (c.req.raw as { socket?: { remoteAddress?: string } })?.socket?.remoteAddress ?? '';
    const ip = forwarded || realIp || remoteAddr || 'unknown';
    const now = Date.now();
    let entry = _authAttempts.get(ip);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + 60_000 };
      _authAttempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxPerMinute) {
      return c.json({ error: 'Too many requests. Try again later.' }, 429);
    }
    // Cleanup stale entries every 1000 requests
    if (_authAttempts.size > 1000) {
      for (const [key, val] of _authAttempts) {
        if (val.resetAt < now) _authAttempts.delete(key);
      }
    }
    await next();
  };
}

// POST /api/v1/auth/login
authRoutes.post('/login', authRateLimit(10), async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const { email, password } = body as { email: string; password: string };

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  const db = getDb();
  const loginStart = Date.now();
  const MIN_LOGIN_MS = 200; // constant-time floor to prevent user enumeration

  const user = db.select().from(users)
    .where(and(eq(users.email, email.toLowerCase().trim()), eq(users.isActive, true)))
    .get();

  if (!user || !user.passwordHash) {
    // Hash a dummy value to consume similar time as a real comparison
    await bcrypt.hash('dummy-timing-pad', 12);
    const elapsed = Date.now() - loginStart;
    if (elapsed < MIN_LOGIN_MS) await new Promise((r) => setTimeout(r, MIN_LOGIN_MS - elapsed));
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const elapsed = Date.now() - loginStart;
    if (elapsed < MIN_LOGIN_MS) await new Promise((r) => setTimeout(r, MIN_LOGIN_MS - elapsed));
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // Create session
  const token = randomUUID();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  db.insert(sessions).values({
    id: randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  }).run();

  // Set httponly cookie
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NOMUS_ENV?.toLowerCase() === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  // Get org info
  const org = db.select().from(organizations)
    .where(eq(organizations.id, user.orgId))
    .get();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    },
    org: org ? {
      id: org.id,
      name: org.name,
      slug: org.slug,
    } : null,
  });
});

// POST /api/v1/auth/force-change-password — for first-time users
authRoutes.post('/force-change-password', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: 'Not authenticated' }, 401);

  const db = getDb();
  const tHash = createHash('sha256').update(token).digest('hex');
  const session = db.select().from(sessions).where(eq(sessions.tokenHash, tHash)).get();
  if (!session || new Date(session.expiresAt) < new Date()) {
    return c.json({ error: 'Session expired' }, 401);
  }

  // Require isActive — an admin can deactivate a user mid-session and the
  // password-change flow must respect that.
  const user = db.select().from(users)
    .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
    .get();
  if (!user) return c.json({ error: 'User not found' }, 401);
  if (!user.mustChangePassword) return c.json({ error: 'Password change not required' }, 400);

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const { password } = body as { password: string };
  if (!password || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  db.update(users).set({
    passwordHash,
    mustChangePassword: false,
    updatedAt: new Date().toISOString(),
  }).where(eq(users.id, user.id)).run();

  return c.json({ message: 'Password changed successfully' });
});

// POST /api/v1/auth/logout
authRoutes.post('/logout', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const db = getDb();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ message: 'Logged out' });
});

// GET /api/v1/auth/me
authRoutes.get('/me', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const db = getDb();
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const session = db.select().from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .get();

  if (!session || new Date(session.expiresAt) < new Date()) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ error: 'Session expired' }, 401);
  }

  const user = db.select().from(users)
    .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
    .get();

  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  const org = db.select().from(organizations)
    .where(eq(organizations.id, user.orgId))
    .get();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    },
    org: org ? {
      id: org.id,
      name: org.name,
      slug: org.slug,
    } : null,
  });
});

// PATCH /api/v1/auth/profile
const profileUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).max(256).optional(),
}).refine(
  // currentPassword is the step-up for an email change as well as a password
  // change; rejecting it without newPassword made changing the email impossible.
  (data) => !(data.newPassword && !data.currentPassword) && !(data.currentPassword && !data.newPassword && !data.email),
  { message: 'Both currentPassword and newPassword are required to change password' },
);

authRoutes.patch('/profile', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: 'Not authenticated' }, 401);

  const db = getDb();
  const tHash = createHash('sha256').update(token).digest('hex');
  const session = db.select().from(sessions).where(eq(sessions.tokenHash, tHash)).get();
  // Match the rest of the codebase: a session row alone is not enough — it must
  // also be unexpired. Without this check an attacker with an old cookie can
  // change the password / email forever.
  if (!session || new Date(session.expiresAt) < new Date()) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  // A temporary-password session may only set a new password through
  // /force-change-password; the profile endpoint would let it change the
  // login email (with the temporary password as step-up) or bypass the flow.
  const sessionUser = db.select().from(users)
    .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
    .get();
  if (!sessionUser) return c.json({ error: 'User not found' }, 401);
  if (sessionUser.mustChangePassword) return passwordChangeRequiredResponse(c);

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.name) updates.name = parsed.data.name;

  // Email and password changes BOTH require currentPassword as a step-up.
  // (prevents account takeover via brief session window where the
  // attacker silently swaps the login email.)
  if (parsed.data.email) {
    if (!parsed.data.currentPassword) {
      return c.json({ error: 'currentPassword is required to change email' }, 400);
    }
    const user = db.select().from(users).where(eq(users.id, session.userId)).get();
    if (!user?.passwordHash) {
      return c.json({ error: 'Cannot change email for OAuth accounts via this endpoint' }, 400);
    }
    const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!valid) return c.json({ error: 'Current password is incorrect' }, 400);
    // Stored lowercased: login looks the address up lowercased, so a mixed-case
    // address saved here could never sign in.
    const newEmail = parsed.data.email.toLowerCase().trim();
    const existing = db.select().from(users).where(eq(users.email, newEmail)).get();
    if (existing && existing.id !== session.userId) return c.json({ error: 'Email already in use' }, 409);
    updates.email = newEmail;
  }

  if (parsed.data.currentPassword && parsed.data.newPassword) {
    const user = db.select().from(users).where(eq(users.id, session.userId)).get();
    if (!user?.passwordHash) return c.json({ error: 'Cannot change password for OAuth accounts' }, 400);
    const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!valid) return c.json({ error: 'Current password is incorrect' }, 400);
    updates.passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  }

  db.update(users).set(updates).where(eq(users.id, session.userId)).run();
  return c.json({ message: 'Profile updated' });
});

// POST /api/v1/auth/forgot-password
authRoutes.post('/forgot-password', authRateLimit(3), async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const { email } = body as { email: string };
  if (!email) return c.json({ error: 'Email required' }, 400);

  const db = getDb();
  const user = db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).get();
  if (!user) return c.json({ message: 'If that email exists, a reset link has been sent.' });

  const resetToken = randomUUID();
  const rtHash = createHash('sha256').update(resetToken).digest('hex');

  db.insert(passwordResetTokens).values({
    id: randomUUID(),
    userId: user.id,
    tokenHash: rtHash,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    used: false,
    createdAt: new Date().toISOString(),
  }).run();

  const config = await import('../../config/env.js').then((m) => m.env());
  const appUrl = config.NOMUS_CORS_ORIGIN;
  const resetUrl = `${appUrl}/reset-password?token=${resetToken}`;

  // Send via Resend if configured, otherwise log to console
  if (getResendApiKey()) {
    try {
      await fetch(resendEndpoint(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getResendApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.NOMUS_FROM_EMAIL,
          to: email,
          subject: 'Nomus — Reset Your Password',
          html: `<p>You requested a password reset for your Nomus account.</p>
                 <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#00e5a0;color:#0a0b0f;text-decoration:none;border-radius:8px;font-weight:600;">Reset Password</a></p>
                 <p style="color:#6b7280;font-size:13px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
                 <p style="color:#6b7280;font-size:11px;">Nomus — Regulatory monitoring, not legal advice.</p>`,
        }),
      });
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Resend email failed');
    }
  } else {
    logger.debug(`[DEV] Password reset link generated for ${email}`);
  }

  return c.json({ message: 'If that email exists, a reset link has been sent.' });
});

// POST /api/v1/auth/reset-password
authRoutes.post('/reset-password', authRateLimit(5), async (c) => {
  const { data: resetBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const { token, password } = resetBody as { token: string; password: string };
  if (!token || !password) return c.json({ error: 'Token and password required' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);

  const db = getDb();
  const rtHash = createHash('sha256').update(token).digest('hex');
  const record = db.select().from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.tokenHash, rtHash), eq(passwordResetTokens.used, false)))
    .get();

  if (!record || new Date(record.expiresAt) < new Date()) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  // Block deactivated users from completing a password reset, even with a
  // valid token issued before deactivation.
  const targetUser = db.select({ isActive: users.isActive }).from(users)
    .where(eq(users.id, record.userId)).get();
  if (!targetUser || !targetUser.isActive) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  const pwHash = await bcrypt.hash(password, 12);
  db.update(users).set({ passwordHash: pwHash, updatedAt: new Date().toISOString() })
    .where(eq(users.id, record.userId)).run();
  // Invalidate ALL pending reset tokens for this user (prevent reuse of earlier tokens)
  db.update(passwordResetTokens).set({ used: true })
    .where(eq(passwordResetTokens.userId, record.userId)).run();

  // Invalidate all existing sessions for this user (security: stolen session protection)
  db.delete(sessions).where(eq(sessions.userId, record.userId)).run();

  return c.json({ message: 'Password reset successfully. You can now login.' });
});
