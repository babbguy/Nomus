/**
 * Decides whether a 401 from the API should send the browser to /login.
 *
 * Kept free of DOM and axios so it can be unit-tested on its own.
 */

/**
 * Routes that must stay reachable without a session. The public pages
 * (attestation verification, transparency, ledger) are opened by people who
 * have no account; the rest are the sign-in flow itself.
 */
const PUBLIC_ROUTES = [
  '/verify',
  '/transparency',
  '/ledger',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/change-password',
];

/** The session probe: "who am I?" has a normal answer of 401 when signed out. */
const SESSION_PROBE_PATH = '/auth/me';

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

function isSessionProbe(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false;
  const path = requestUrl.split(/[?#]/)[0].replace(/\/+$/, '');
  return path === SESSION_PROBE_PATH || path.endsWith(`/api/v1${SESSION_PROBE_PATH}`);
}

/**
 * True when a 401 for `requestUrl`, received while viewing `pathname`, means
 * the session expired on a protected page. An unauthenticated session probe is
 * a normal answer (ProtectedRoute sends signed-out users of protected pages to
 * /login itself), and public routes never redirect.
 */
export function shouldRedirectToLogin(pathname: string, requestUrl: string | undefined): boolean {
  if (isPublicRoute(pathname)) return false;
  if (isSessionProbe(requestUrl)) return false;
  return true;
}
