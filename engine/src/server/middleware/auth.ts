import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { resolveApiKey } from '../../tenant/resolver.js';
import { recordUsage } from '../../tenant/usage.js';
import { getDb } from '../../db/client.js';
import { sessions, users } from '../../db/schema.js';
import { env } from '../../config/env.js';

/**
 * API key authentication middleware.
 * Extracts Bearer token from Authorization header, resolves to tenant context.
 */
export function requireAuth(...requiredScopes: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    const tenant = resolveApiKey(token);

    if (!tenant) {
      throw new HTTPException(401, { message: 'Invalid or expired API key' });
    }

    if (requiredScopes.length > 0) {
      const hasAllScopes = requiredScopes.every((s) => tenant.scopes.includes(s));
      if (!hasAllScopes) {
        throw new HTTPException(403, {
          message: `Insufficient permissions. Required: ${requiredScopes.join(', ')}`,
        });
      }
    }

    c.set('orgId', tenant.orgId);
    c.set('apiKeyId', tenant.apiKeyId);
    c.set('scopes', tenant.scopes);
    c.set('rateLimitRpm', tenant.rateLimitRpm);
    c.set('maxSseConnections', tenant.maxSseConnections);

    const start = performance.now();
    await next();
    const duration = Math.round(performance.now() - start);

    recordUsage(tenant.orgId, tenant.apiKeyId, c.req.path, c.req.method, c.res.status, duration);
  });
}

/**
 * Session-based authentication middleware for the browser portal.
 * Reads the nomus_session cookie, resolves to user + org context.
 */
export function requireSession(requiredRole?: 'platform_admin' | 'member') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = getCookie(c, 'nomus_session');
    if (!token) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    const db = getDb();
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const session = db.select().from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .get();

    if (!session || new Date(session.expiresAt) < new Date()) {
      throw new HTTPException(401, { message: 'Session expired' });
    }

    const user = db.select().from(users)
      .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
      .get();

    if (!user) {
      throw new HTTPException(401, { message: 'User not found' });
    }

    if (requiredRole && user.role !== requiredRole && user.role !== 'platform_admin') {
      throw new HTTPException(403, { message: 'Insufficient permissions' });
    }

    // Sessions have no per-key rateLimitRpm (that column lives on API keys),
    // so apply the configured default request limit.
    c.set('orgId', user.orgId);
    c.set('userId', user.id);
    c.set('rateLimitRpm', env().NOMUS_RATE_LIMIT_RPM);
    c.set('maxSseConnections', env().NOMUS_MAX_SSE_CONNECTIONS_PER_ORG);
    c.set('scopes', ['read:policies', 'stream', 'evaluate', ...(user.role === 'platform_admin' ? ['admin'] : [])]);

    await next();
  });
}

/**
 * Accepts either session cookie OR API key Bearer token.
 * Used for endpoints that serve both browser portal and programmatic API access.
 */
export function requireSessionOrApiKey(...requiredScopes: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const sessionToken = getCookie(c, 'nomus_session');
    const authHeader = c.req.header('Authorization');

    if (sessionToken) {
      // Try session auth
      const db = getDb();
      const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
      const session = db.select().from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .get();

      if (session && new Date(session.expiresAt) >= new Date()) {
        const user = db.select().from(users)
          .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
          .get();

        if (user) {
          const sessionScopes = [
            'read:policies',
            'stream',
            'evaluate',
            ...(user.role === 'platform_admin' ? ['admin'] : []),
          ];

          // Enforce required scopes on the session path too. Without this any
          // authenticated session walks straight through admin-gated routes,
          // because the session branch returns before the API-key scope check
          // below ever runs.
          if (requiredScopes.length > 0) {
            const hasAllScopes = requiredScopes.every((s) => sessionScopes.includes(s));
            if (!hasAllScopes) {
              throw new HTTPException(403, {
                message: `Insufficient permissions. Required: ${requiredScopes.join(', ')}`,
              });
            }
          }

          c.set('orgId', user.orgId);
          c.set('userId', user.id);
          c.set('rateLimitRpm', env().NOMUS_RATE_LIMIT_RPM);
          c.set('maxSseConnections', env().NOMUS_MAX_SSE_CONNECTIONS_PER_ORG);
          c.set('scopes', sessionScopes);
          await next();
          return;
        }
      }
    }

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const tenant = resolveApiKey(token);

      if (tenant) {
        if (requiredScopes.length > 0) {
          const hasAllScopes = requiredScopes.every((s) => tenant.scopes.includes(s));
          if (!hasAllScopes) {
            throw new HTTPException(403, { message: `Insufficient permissions` });
          }
        }

        c.set('orgId', tenant.orgId);
        c.set('apiKeyId', tenant.apiKeyId);
        c.set('scopes', tenant.scopes);
        c.set('rateLimitRpm', tenant.rateLimitRpm);
        c.set('maxSseConnections', tenant.maxSseConnections);
        await next();
        return;
      }
    }

    throw new HTTPException(401, { message: 'Authentication required' });
  });
}
