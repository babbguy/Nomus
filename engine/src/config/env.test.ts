// Copyright 2026 babbguy
// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, describe, expect, it, vi } from 'vitest';

/** Load a fresh env module with the given overrides; returns the config or the exit error. */
async function load(overrides: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('NOMUS_ENV', 'development');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { loadEnv } = await import('./env.js');
  try {
    return { config: loadEnv(), logged: '' };
  } catch (e) {
    return { failure: (e as Error).message, logged: error.mock.calls.flat().join('\n') };
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}

describe('cron settings', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts valid expressions and strips surrounding quotes', async () => {
    const { config } = await load({ NOMUS_SCRAPE_CRON: '"0 3 * * *"', NOMUS_SCOUT_CRON: '*/30 * * * *' });
    expect(config?.NOMUS_SCRAPE_CRON).toBe('0 3 * * *');
    expect(config?.NOMUS_SCOUT_CRON).toBe('*/30 * * * *');
  });

  it.each([
    ['NOMUS_SCRAPE_CRON', '0 0 30 2 *'], // impossible date: 30 February
    ['NOMUS_SCRAPE_CRON', 'every night'],
    ['NOMUS_SCOUT_CRON', '61 * * * *'],
  ])('refuses %s=%s as a configuration error', async (key, value) => {
    const { failure, logged } = await load({ [key]: value });
    expect(failure).toBe('exit 1');
    expect(logged).toContain(`${key}: must be a valid, possible cron expression`);
  });
});
