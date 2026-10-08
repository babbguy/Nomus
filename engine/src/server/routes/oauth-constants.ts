/**
 * Shared constants for OAuth and device-auth flows.
 *
 * The TTL and pending-state cap were previously redeclared in each of
 * github-oauth.ts, oauth.ts, and device-auth.ts with the same numeric
 * literals — invitation to drift. Single source of truth here.
 */

/** How long an OAuth state token (CSRF + device handoff) is valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Cap on concurrent pending OAuth flows per namespace. */
export const OAUTH_MAX_PENDING_STATES = 10_000;

/** How long a device-auth pending request is valid (browser → VS Code handoff). */
export const DEVICE_AUTH_PENDING_TTL_MS = 10 * 60 * 1000;

/** How long a device-auth single-use exchange code is valid. Short — code is hot. */
export const DEVICE_AUTH_CODE_TTL_MS = 60 * 1000;
