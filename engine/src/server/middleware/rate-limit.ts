import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../app.js';
import { env } from '../../config/env.js';

/**
 * Simple in-memory sliding window rate limiter.
 * Keyed by orgId; the per-minute cap comes from the API key (or NOMUS_RATE_LIMIT_RPM for sessions).
 */
const windows = new Map<string, { count: number; resetAt: number }>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of windows) {
    if (val.resetAt < now) windows.delete(key);
  }
}, 300_000);

export function rateLimit() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const orgId = c.get('orgId');
    if (!orgId) {
      await next();
      return;
    }

    // Read RPM from context — auth middleware already resolved the tenant
    const rpm = c.get('rateLimitRpm') ?? env().NOMUS_RATE_LIMIT_RPM;

    const now = Date.now();
    const windowKey = `rl:${orgId}`;
    let window = windows.get(windowKey);

    if (!window || window.resetAt < now) {
      window = { count: 0, resetAt: now + 60_000 };
      windows.set(windowKey, window);
    }

    window.count++;

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(rpm));
    c.header('X-RateLimit-Remaining', String(Math.max(0, rpm - window.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(window.resetAt / 1000)));

    if (window.count > rpm) {
      throw new HTTPException(429, {
        message: `Rate limit exceeded. ${rpm} requests per minute allowed.`,
      });
    }

    await next();
  });
}
