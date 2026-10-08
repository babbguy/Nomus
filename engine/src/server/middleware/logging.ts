import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'node:crypto';
import type { AppEnv } from '../app.js';
import { logger } from '../../logger.js';

export function loggingMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);

    const start = performance.now();
    const method = c.req.method;
    const path = c.req.path;

    await next();

    const duration = Math.round(performance.now() - start);
    const status = c.res.status;

    logger.info({
      requestId,
      method,
      path,
      status,
      durationMs: duration,
      orgId: c.get('orgId'),
    }, `${method} ${path} ${status} ${duration}ms`);
  });
}
