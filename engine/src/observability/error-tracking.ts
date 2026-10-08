/**
 * External error tracking.
 *
 * Sentry is initialized ONLY when NOMUS_SENTRY_DSN is set. When it is
 * unset the module is a true no-op: `Sentry.init` is never called, no
 * network egress occurs, and every exported helper returns immediately.
 * This keeps self-hosted, telemetry-sensitive deployments zero-overhead by
 * default while giving hosted deployments crash + job-failure visibility.
 *
 * Privacy (bank-grade): `beforeSend` strips anything that could carry
 * regulatory content or customer data — request bodies, query strings,
 * cookies, and headers are removed, leaving only the HTTP method, route
 * template, status, and the error itself. Capture is ADDITIVE to the pino
 * logs; it never replaces or suppresses them, and never changes control
 * flow (a capture failure is swallowed so reporting can never crash the
 * thing it is reporting on).
 */
import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export type Subsystem =
  | 'api'
  | 'hunter'
  | 'scout'
  | 'forge'
  | 'webhooks'
  | 'scheduler'
  | 'process';

let initialized = false;

/** True only when a DSN was configured and init succeeded. Test/inspection use. */
export function isErrorTrackingEnabled(): boolean {
  return initialized;
}

/**
 * Initialize error tracking. Idempotent. Safe to call unconditionally at
 * boot — returns immediately (no SDK init) when no DSN is configured.
 */
export function initErrorTracking(): void {
  if (initialized) return;

  const config = env();
  const dsn = config.NOMUS_SENTRY_DSN;
  if (!dsn) return; // no-op: never touch the SDK, never open a socket

  try {
    Sentry.init({
      dsn,
      environment: config.NOMUS_ENV,
      tracesSampleRate: config.NOMUS_SENTRY_TRACES_SAMPLE_RATE,
      // Do not auto-instrument HTTP/Express/etc — we report explicitly so we
      // control exactly what leaves the process.
      defaultIntegrations: false,
      beforeSend: scrubEvent,
    });
    initialized = true;
    logger.info('Error tracking enabled (Sentry)');
  } catch (err) {
    // Reporting must never break boot.
    logger.error({ err }, 'Error tracking init failed — continuing without it');
  }
}

/**
 * Remove any field that could carry regulatory content or customer data.
 * Whitelist-by-destruction: keep method/route/status, drop the rest.
 */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    const method = event.request.method;
    const url = stripQuery(event.request.url);
    event.request = { method, url };
  }
  // User identity and extra context can carry org data — drop wholesale.
  delete event.user;
  delete event.contexts?.trace?.data;
  if (event.extra) delete event.extra;
  return event;
}

function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Report an error, tagged by subsystem. No-op when tracking is disabled.
 * Never throws — a reporting failure is logged and swallowed.
 */
export function captureError(
  err: unknown,
  opts: { subsystem: Subsystem; context?: Record<string, string | number | boolean> } = {
    subsystem: 'process',
  },
): void {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag('subsystem', opts.subsystem);
      if (opts.context) {
        for (const [k, v] of Object.entries(opts.context)) scope.setTag(k, String(v));
      }
      Sentry.captureException(err);
    });
  } catch (captureErr) {
    logger.error({ captureErr }, 'Error tracking capture failed');
  }
}

/** Flush pending events on shutdown. No-op when disabled. Bounded wait. */
export async function flushErrorTracking(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* shutdown path — nothing further to do */
  }
}
