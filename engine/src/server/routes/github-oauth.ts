import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { users, sessions } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { setState, hasState, deleteState, countState, ensureEphemeralTable } from '../../core/state-store.js';

import { OAUTH_STATE_TTL_MS, OAUTH_MAX_PENDING_STATES } from './oauth-constants.js';

export const githubOAuthRoutes = new Hono<AppEnv>();

const CSRF_NAMESPACE = 'oauth_csrf';

/**
 * Initiate GitHub OAuth flow.
 * Redirects to GitHub authorize URL with CSRF state.
 */
githubOAuthRoutes.get('/', (c) => {
  const config = env();
  const clientId = config.NOMUS_GITHUB_CLIENT_ID;

  if (!clientId) {
    return c.json({ error: 'GitHub OAuth not configured' }, 503);
  }

  // Ensure table exists (idempotent)
  ensureEphemeralTable();

  // Check for rate limiting on pending auth requests
  if (countState(CSRF_NAMESPACE) >= OAUTH_MAX_PENDING_STATES) {
    return c.json({ error: 'Too many pending auth requests. Try again later.' }, 429);
  }

  const state = randomUUID();
  setState(CSRF_NAMESPACE, state, '1', OAUTH_STATE_TTL_MS);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${config.NOMUS_CORS_ORIGIN}/api/v1/auth/github/callback`,
    scope: 'read:user user:email',
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

/**
 * GitHub OAuth callback.
 * Exchanges code for token, fetches user profile, creates/links account, starts session.
 */
githubOAuthRoutes.get('/callback', async (c) => {
  const config = env();
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.json({ error: 'Missing code or state parameter' }, 400);
  }

  // Validate CSRF state (check + delete atomically)
  if (!hasState(CSRF_NAMESPACE, state)) {
    return c.json({ error: 'Invalid or expired state' }, 400);
  }
  deleteState(CSRF_NAMESPACE, state);

  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.NOMUS_GITHUB_CLIENT_ID,
      client_secret: config.NOMUS_GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    logger.error({ error: tokenData.error }, 'GitHub OAuth token exchange failed');
    return c.json({ error: 'Failed to authenticate with GitHub' }, 400);
  }

  // Fetch user profile
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  const ghUser = await userResponse.json() as { id: number; login: string; email: string | null; name: string | null };

  // Fetch email if not public
  let email = ghUser.email;
  if (!email) {
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    const emails = await emailsResponse.json() as { email: string; primary: boolean; verified: boolean }[];
    const primary = emails.find((e) => e.primary && e.verified);
    email = primary?.email ?? emails[0]?.email ?? `${ghUser.login}@github.noreply`;
  }

  // Find existing user. We do NOT self-register via OAuth — accounts must
  // be provisioned by an admin first. Mirrors the Google OAuth policy in
  // oauth.ts.
  const db = getDb();
  const user = db.select().from(users).where(eq(users.email, email)).get();

  if (!user) {
    logger.warn({ email, githubLogin: ghUser.login }, 'GitHub OAuth login rejected — no matching account');
    return c.redirect(`${config.NOMUS_CORS_ORIGIN}/login?error=no_account`);
  }

  if (!user.isActive) {
    return c.redirect(`${config.NOMUS_CORS_ORIGIN}/login?error=account_disabled`);
  }

  // Create session
  const sessionToken = randomUUID();
  const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
  const SESSION_TTL_S = 7 * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + SESSION_TTL_S * 1000).toISOString();

  db.insert(sessions).values({
    id: randomUUID(),
    userId: user.id,
    tokenHash: sessionHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  }).run();

  // Use the cookie helper so the Secure attribute is honored in production —
  // the previous direct Set-Cookie header was missing it.
  setCookie(c, 'nomus_session', sessionToken, {
    httpOnly: true,
    secure: config.NOMUS_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_S,
  });

  return c.redirect(config.NOMUS_CORS_ORIGIN);
});
