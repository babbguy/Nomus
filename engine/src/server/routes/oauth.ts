import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { randomUUID, createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { users, sessions } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import {
  setState,
  hasState,
  deleteState,
  countState,
  ensureEphemeralTable,
} from '../../core/state-store.js';
import { OAUTH_STATE_TTL_MS, OAUTH_MAX_PENDING_STATES } from './oauth-constants.js';

export const oauthRoutes = new Hono();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'nomus_session';

// Persistent CSRF / device-state store. Mirrors github-oauth.ts so OAuth
// round trips survive a process restart and work in multi-instance
// deployments.
const CSRF_NAMESPACE = 'oauth_csrf_google';
const DEVICE_STATE_NAMESPACE = 'oauth_device_state_google';

// ─── Google OAuth ─────────────────────────────────────────────

oauthRoutes.get('/google', (c) => {
  const config = env();
  if (!config.NOMUS_GOOGLE_CLIENT_ID) return c.json({ error: 'Google OAuth not configured' }, 503);

  ensureEphemeralTable();
  if (countState(CSRF_NAMESPACE) >= OAUTH_MAX_PENDING_STATES) {
    return c.json({ error: 'Too many pending auth requests. Try again later.' }, 429);
  }

  const state = randomUUID();
  setState(CSRF_NAMESPACE, state, '1', OAUTH_STATE_TTL_MS);

  // Pass device_state (string!) through to the callback by storing it under a
  // separate namespace keyed off the same `state`. The previous Map<string,
  // number> couldn't represent this safely.
  const deviceState = c.req.query('device_state');
  if (deviceState) setState(DEVICE_STATE_NAMESPACE, state, deviceState, OAUTH_STATE_TTL_MS);

  const apiOrigin = env().NOMUS_CORS_ORIGIN;
  const params = new URLSearchParams({
    client_id: config.NOMUS_GOOGLE_CLIENT_ID,
    redirect_uri: `${apiOrigin}/api/v1/auth/oauth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

oauthRoutes.get('/google/callback', async (c) => {
  const config = env();
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state || !hasState(CSRF_NAMESPACE, state)) {
    return c.redirect(`${config.NOMUS_CORS_ORIGIN}/login?error=google_auth_failed`);
  }
  // Single-use: consume the state immediately.
  deleteState(CSRF_NAMESPACE, state);
  // Device state is consumed-and-forgotten too — it isn't currently surfaced
  // to the rest of the flow, but cleaning up keeps the table from growing.
  deleteState(DEVICE_STATE_NAMESPACE, state);

  const apiOrigin = env().NOMUS_CORS_ORIGIN;

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.NOMUS_GOOGLE_CLIENT_ID!,
      client_secret: config.NOMUS_GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${apiOrigin}/api/v1/auth/oauth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json() as { access_token?: string; id_token?: string; error?: string };
  if (!tokens.access_token) {
    logger.error({ error: tokens.error }, 'Google OAuth token exchange failed');
    return c.redirect(`${config.NOMUS_CORS_ORIGIN}/login?error=google_auth_failed`);
  }

  // Get user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await userRes.json() as { id: string; email: string; name: string; picture?: string };

  return await loginOrCreateUser(c, {
    provider: 'google',
    providerId: profile.id,
    email: profile.email,
    name: profile.name,
  });
});


// ─── Shared login/create logic ────────────────────────────────

async function loginOrCreateUser(
  c: any,
  profile: { provider: string; providerId: string; email: string; name: string },
) {
  const config = env();
  const db = getDb();

  // Find existing user by provider ID or email
  let user = db.select().from(users)
    .where(and(eq(users.authProvider, profile.provider), eq(users.providerId, profile.providerId)))
    .get();

  if (!user) {
    user = db.select().from(users)
      .where(eq(users.email, profile.email.toLowerCase()))
      .get();
  }

  if (user) {
    if (!user.isActive) {
      return c.redirect(`${config.NOMUS_CORS_ORIGIN}/login?error=account_disabled`);
    }
    // Link OAuth provider to existing local account
    if (user.authProvider === 'local') {
      db.update(users).set({
        authProvider: profile.provider,
        providerId: profile.providerId,
        mustChangePassword: false, // OAuth satisfies password change requirement
        updatedAt: new Date().toISOString(),
      }).where(eq(users.id, user.id)).run();
    }
  } else {
    // New OAuth user — must already be invited (has an existing account)
    // We don't allow self-registration via OAuth; they must be created by admin first
    return c.redirect(`${config.NOMUS_CORS_ORIGIN}/login?error=no_account`);
  }

  // Create session
  const token = randomUUID();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  db.insert(sessions).values({
    id: randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  }).run();

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NOMUS_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  const redirectTo = user.role === 'platform_admin' ? '/admin/dashboard' : '/dashboard';
  return c.redirect(`${config.NOMUS_CORS_ORIGIN}${redirectTo}`);
}

