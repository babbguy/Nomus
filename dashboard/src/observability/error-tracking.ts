/**
 * Client-side error tracking.
 *
 * Initialized ONLY when VITE_NOMUS_SENTRY_DSN is set at build time.
 * Unset (the default) = a true no-op: the SDK is never initialized and every
 * helper returns immediately. Self-hosted builds ship with no DSN and send
 * nothing. When enabled, only error + minimal navigation context is sent;
 * we do not attach user identity or app state.
 */
import * as Sentry from '@sentry/react';

let initialized = false;

export function isErrorTrackingEnabled(): boolean {
  return initialized;
}

export function initErrorTracking(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_NOMUS_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      defaultIntegrations: false,
      // Strip anything that could carry regulatory/customer data before send.
      beforeSend(event) {
        if (event.request) {
          const q = event.request.url?.indexOf('?') ?? -1;
          event.request = { url: q >= 0 ? event.request.url!.slice(0, q) : event.request.url };
        }
        delete event.user;
        return event;
      },
    });
    initialized = true;
  } catch {
    // Reporting must never break the app.
  }
}

export function captureError(err: unknown, context?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (context) for (const [k, v] of Object.entries(context)) scope.setTag(k, v);
      Sentry.captureException(err);
    });
  } catch {
    /* swallow — reporting must never throw */
  }
}
