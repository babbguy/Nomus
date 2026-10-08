/**
 * Fail-closed test for the action entrypoint.
 *
 * When the scanner throws NomusApiError (Nomus API down / unusable),
 * run() must call core.setFailed with a message stating that compliance
 * status is UNKNOWN — the check must FAIL, never silently pass.
 *
 * Uses the REAL NomusApiError / isNomusApiError from @nomus/scanner
 * (only runScan is mocked) so the error-identification wiring is exercised
 * end to end. src/index.ts invokes run() at import time, so the module is
 * imported inside the test after the mocks are armed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => (name === 'api-key' ? 'ul_nomus_testkey' : '')),
  getBooleanInput: vi.fn(() => false),
  info: vi.fn(),
  warning: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'testorg', repo: 'testrepo' },
    sha: 'abc123def4567890',
    payload: {},
    ref: 'refs/heads/main',
  },
  getOctokit: vi.fn(),
}));

vi.mock('@nomus/scanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nomus/scanner')>();
  return { ...actual, runScan: vi.fn() };
});

import * as core from '@actions/core';
import { runScan, NomusApiError } from '@nomus/scanner';

describe('run() fail-closed on Nomus API failure', () => {
  it('calls setFailed with a compliance-status-UNKNOWN message when runScan throws NomusApiError', async () => {
    vi.mocked(runScan).mockRejectedValue(
      new NomusApiError('Nomus API request failed: connect ECONNREFUSED'),
    );

    await import('../src/index.js'); // triggers run()
    // run() is fire-and-forget; flush pending microtasks/macrotasks
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));

    expect(core.setFailed).toHaveBeenCalledTimes(1);
    const message = vi.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(message).toMatch(/compliance status UNKNOWN/);
    expect(message).toMatch(/failing closed/i);

    // The status output must not report a pass
    const statusCalls = vi.mocked(core.setOutput).mock.calls.filter(([k]) => k === 'status');
    expect(statusCalls).toEqual([['status', 'unknown']]);
  });
});
