import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../../logger.js';
import { captureError } from '../../observability/error-tracking.js';

/**
 * Turn any thrown error into a structured JSON response. Client errors
 * (HTTPException) keep their status; anything else is logged at error level,
 * reported to error tracking, and returned as a generic 500 that never
 * exposes internal details.
 */
export function handleAppError(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) {
    return c.json({
      error: err.message,
      status: err.status,
    }, err.status);
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error({ err, path: c.req.path }, `Unhandled error: ${message}`);
  // 5xx only — HTTPException (4xx client errors) returned above, never reported.
  captureError(err, { subsystem: 'api', context: { method: c.req.method, route: c.req.routePath } });

  return c.json({
    error: 'Internal server error',
    status: 500,
  }, 500);
}

/**
 * Global error middleware. Hono hands errors thrown by route handlers to
 * `app.onError` rather than rethrowing them through middleware, so
 * createApp() also registers handleAppError there; this middleware covers
 * errors raised by other middleware.
 */
export function errorHandler() {
  return createMiddleware(async (c, next) => {
    try {
      await next();
    } catch (err) {
      return handleAppError(err, c);
    }
  });
}
