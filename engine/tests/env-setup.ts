/**
 * Global test environment setup.
 *
 * Loaded by vitest via `setupFiles` in vitest.config.ts.
 * Runs BEFORE any test file imports, ensuring env vars are available
 * when modules call env() at import time.
 *
 * Values come from engine/.env.test — a committed file with safe test-only values.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envTestPath = resolve(import.meta.dirname, '../.env.test');
const envContent = readFileSync(envTestPath, 'utf-8');

for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  const value = trimmed.slice(eqIdx + 1);
  // Only set if not already defined (allow overrides from CLI)
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
