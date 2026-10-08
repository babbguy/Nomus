import { createSign } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { setState, getState, deleteState, ensureEphemeralTable } from '../core/state-store.js';

const TOKEN_NAMESPACE = 'github_token';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

/**
 * Generate a JWT for the GitHub App.
 * Used to authenticate as the app itself (not an installation).
 */
export function generateAppJwt(): string {
  const config = env();
  const appId = config.NOMUS_GITHUB_APP_ID;
  const privateKey = config.NOMUS_GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error('NOMUS_GITHUB_APP_ID and NOMUS_GITHUB_APP_PRIVATE_KEY must be set');
  }

  // Decode base64 PEM if needed
  const pem = privateKey.includes('BEGIN') ? privateKey : Buffer.from(privateKey, 'base64').toString('utf-8');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 1 minute in the past (clock skew)
    exp: now + (10 * 60), // 10 minute TTL (GitHub maximum)
    iss: appId,
  };

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signable = `${header}.${body}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = signer.sign(pem, 'base64url');

  return `${signable}.${signature}`;
}

/**
 * Get an installation access token for a specific GitHub App installation.
 *
 * Tokens are persisted to SQLite (encrypted at rest with AES-256-GCM)
 * and refreshed 5 minutes before expiry. This survives process restarts
 * and avoids redundant token requests.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  ensureEphemeralTable();

  const key = String(installationId);

  // Check for cached token (stored as JSON: { token, expiresAt })
  const cached = getState(TOKEN_NAMESPACE, key, true);
  if (cached) {
    const parsed = JSON.parse(cached) as { token: string; expiresAt: number };
    if (parsed.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return parsed.token;
    }
    // Token is about to expire — fall through to refresh
  }

  // Fetch a new installation token from GitHub
  const jwt = generateAppJwt();

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${body}`);
  }

  const data = await response.json() as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();
  const ttlMs = expiresAt - Date.now();

  // Persist encrypted — tokens are sensitive and MUST be encrypted at rest
  setState(
    TOKEN_NAMESPACE,
    key,
    JSON.stringify({ token: data.token, expiresAt }),
    ttlMs,
    true, // encrypt with AES-256-GCM
  );

  logger.debug({ installationId }, 'GitHub installation token refreshed and persisted');
  return data.token;
}

/**
 * Clear cached token for an installation (e.g., on uninstall).
 */
export function clearInstallationToken(installationId: number): void {
  deleteState(TOKEN_NAMESPACE, String(installationId));
}
