/**
 * Configuration for the Nomus MCP server.
 *
 * All config comes from environment variables (the standard way MCP clients
 * pass configuration to spawned stdio servers):
 *
 *   NOMUS_API_URL  (required) — base URL of the Nomus engine,
 *                     e.g. http://localhost:3100 or https://nomus.example.com
 *   NOMUS_API_KEY  (required) — a Nomus API key (nk_live_…)
 *                     with the `read:policies` and `evaluate` scopes.
 *
 * Validation is strict and fails at startup with actionable messages —
 * a misconfigured compliance tool must never start silently.
 */

import { API_KEY_PREFIX_LIVE, API_KEY_PREFIX_TEST } from '@nomus/shared';

export interface NomusMcpConfig {
  apiUrl: string;
  apiKey: string;
}

/** Thrown when required environment configuration is missing or invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate config from an environment map.
 * Collects ALL problems before throwing, so users fix everything in one pass.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): NomusMcpConfig {
  const problems: string[] = [];

  const rawUrl = env.NOMUS_API_URL?.trim();
  let apiUrl = '';
  if (!rawUrl) {
    problems.push(
      'NOMUS_API_URL is not set. Set it to your Nomus engine base URL, e.g. http://localhost:3100',
    );
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`NOMUS_API_URL must be an http(s) URL, got "${rawUrl}"`);
      } else {
        // Strip any trailing slash so path joining is deterministic.
        apiUrl = rawUrl.replace(/\/+$/, '');
      }
    } catch {
      problems.push(`NOMUS_API_URL is not a valid URL: "${rawUrl}"`);
    }
  }

  const apiKey = env.NOMUS_API_KEY?.trim() ?? '';
  if (!apiKey) {
    problems.push(
      'NOMUS_API_KEY is not set. Set it to a Nomus API key ' +
      "with the 'read:policies' and 'evaluate' scopes.",
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(
      'Nomus MCP server cannot start — configuration errors:\n' +
      problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  return { apiUrl, apiKey };
}

/**
 * Non-fatal advisory warnings about the loaded config, for stderr.
 * (stdout belongs to the MCP protocol — never write there.)
 */
export function configWarnings(config: NomusMcpConfig): string[] {
  const warnings: string[] = [];
  if (
    !config.apiKey.startsWith(API_KEY_PREFIX_LIVE) &&
    !config.apiKey.startsWith(API_KEY_PREFIX_TEST)
  ) {
    warnings.push(
      `NOMUS_API_KEY does not look like a Nomus key (expected a ${API_KEY_PREFIX_LIVE}… or ${API_KEY_PREFIX_TEST}… prefix). ` +
      'The server will start, but API calls may fail with 401.',
    );
  }
  if (config.apiKey.startsWith(API_KEY_PREFIX_LIVE)) {
    warnings.push(
      'MCP client config files are often committed or synced. Use a dedicated key with only the ' +
      "'read:policies' and 'evaluate' scopes, and revoke it if the file leaks.",
    );
  }
  return warnings;
}
