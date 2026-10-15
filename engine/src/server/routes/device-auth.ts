import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { sessions, users, organizations, apiKeys } from '../../db/schema.js';
import { API_KEY_PREFIX_LIVE } from '@nomus/shared';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { safeJson } from '../utils.js';
import { passwordChangeRequiredResponse } from '../middleware/auth.js';
import {
  setState,
  getState,
  deleteState,
  countState,
  ensureEphemeralTable,
} from '../../core/state-store.js';
import {
  DEVICE_AUTH_PENDING_TTL_MS,
  DEVICE_AUTH_CODE_TTL_MS,
  OAUTH_MAX_PENDING_STATES,
} from './oauth-constants.js';

export const deviceAuthRoutes = new Hono();

// Persistent stores keyed by namespace. Replaces the previous in-memory Maps
// so device auth survives a process restart and works across instances.
//
const PENDING_NAMESPACE = 'device_auth_pending';
const CODE_NAMESPACE = 'device_auth_code';

// ─── Step 1: Extension opens this URL in the browser ─────────

deviceAuthRoutes.get('/authorize', (c) => {
  const state = c.req.query('state');
  const callbackUri = c.req.query('callback_uri');

  if (!state || !callbackUri) {
    return c.json({ error: 'Missing state or callback_uri' }, 400);
  }

  // Security: only allow vscode:// scheme to prevent open redirect
  if (!callbackUri.startsWith('vscode://')) {
    return c.json({ error: 'Invalid callback_uri — must use vscode:// scheme' }, 400);
  }

  ensureEphemeralTable();
  if (countState(PENDING_NAMESPACE) >= OAUTH_MAX_PENDING_STATES) {
    return c.json({ error: 'Too many pending auth requests. Try again later.' }, 429);
  }
  setState(PENDING_NAMESPACE, state, callbackUri, DEVICE_AUTH_PENDING_TTL_MS);

  // Redirect to dashboard login with device_state
  const config = env();
  const loginUrl = `${config.NOMUS_CORS_ORIGIN}/login?device_state=${encodeURIComponent(state)}`;
  return c.redirect(loginUrl);
});

// ─── Step 2: Dashboard redirects here after login ────────────

deviceAuthRoutes.get('/callback', (c) => {
  const deviceState = c.req.query('device_state');
  if (!deviceState) {
    return c.json({ error: 'Missing device_state' }, 400);
  }

  // Validate pending state
  const callbackUri = getState(PENDING_NAMESPACE, deviceState);
  if (!callbackUri) {
    return c.json({ error: 'Invalid or expired device_state' }, 400);
  }

  // Validate session cookie (user must be logged in)
  const token = getCookie(c, 'nomus_session');
  if (!token) {
    return c.json({ error: 'Not authenticated — please log in first' }, 401);
  }

  const db = getDb();
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const session = db.select().from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .get();

  if (!session || new Date(session.expiresAt) < new Date()) {
    return c.json({ error: 'Session expired' }, 401);
  }

  const user = db.select().from(users)
    .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
    .get();

  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  // A temporary-password session must not mint an extension API key.
  if (user.mustChangePassword) {
    return passwordChangeRequiredResponse(c);
  }

  // Generate short-lived auth code (60-second TTL, single use)
  const code = randomUUID();
  setState(
    CODE_NAMESPACE,
    code,
    JSON.stringify({ userId: user.id, orgId: user.orgId }),
    DEVICE_AUTH_CODE_TTL_MS,
  );

  // Clean up pending state
  deleteState(PENDING_NAMESPACE, deviceState);

  // Redirect back to VS Code
  const redirectUrl = `${callbackUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(deviceState)}`;
  logger.info({ userId: user.id }, 'Device auth: redirecting to VS Code');
  return c.redirect(redirectUrl);
});

// ─── Step 3: Extension exchanges code for API key ────────────

deviceAuthRoutes.post('/token', async (c) => {
  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const { code } = rawBody as { code: string };

  if (!code) {
    return c.json({ error: 'Missing code' }, 400);
  }

  // Validate and consume the code (single use)
  const stored = getState(CODE_NAMESPACE, code);
  if (!stored) {
    return c.json({ error: 'Invalid or expired code' }, 400);
  }
  deleteState(CODE_NAMESPACE, code);
  const { userId: storedUserId, orgId: storedOrgId } = JSON.parse(stored) as {
    userId: string;
    orgId: string;
  };

  const db = getDb();

  // Look up user + org
  const user = db.select().from(users)
    .where(eq(users.id, storedUserId))
    .get();
  const org = db.select().from(organizations)
    .where(eq(organizations.id, storedOrgId))
    .get();

  if (!user || !org) {
    return c.json({ error: 'User or organization not found' }, 404);
  }
  // The code was issued to an active user of this org without a temporary
  // password; re-check, since either may have changed within the code's TTL.
  if (!user.isActive || user.orgId !== org.id) {
    return c.json({ error: 'User not found' }, 401);
  }
  if (user.mustChangePassword) {
    return passwordChangeRequiredResponse(c);
  }

  // Re-authenticating replaces only THIS user's extension key. Keys are bound
  // to their user, so a teammate signing in no longer signs anyone else out.
  // (v1.1.0 revoked any active "VS Code Extension" key in the whole org.)
  const revoked = db.update(apiKeys)
    .set({ isActive: false })
    .where(and(
      eq(apiKeys.orgId, org.id),
      eq(apiKeys.userId, user.id),
      eq(apiKeys.label, 'VS Code Extension'),
      eq(apiKeys.isActive, true),
    ))
    .run();

  // Generate new API key (same logic as tenants.ts)
  const rawKey = `${API_KEY_PREFIX_LIVE}${randomBytes(24).toString('base64url')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const now = new Date().toISOString();
  db.insert(apiKeys).values({
    id: randomUUID(),
    orgId: org.id,
    keyHash,
    keyPrefix: rawKey.slice(0, 12),
    label: 'VS Code Extension',
    scopes: JSON.stringify(['read:policies', 'evaluate', 'stream']),
    rateLimitRpm: env().NOMUS_RATE_LIMIT_RPM,
    isActive: true,
    createdAt: now,
    userId: user.id,
  }).run();

  logger.info({ userId: user.id, orgId: org.id, replacedKeys: revoked.changes }, 'Device auth: user-bound API key generated for VS Code');

  return c.json({
    apiKey: rawKey,
    orgName: org.name,
    userEmail: user.email,
  });
});
