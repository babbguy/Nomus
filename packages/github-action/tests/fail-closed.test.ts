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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  return { ...actual, runScan: vi.fn(), runCorporateScanOnDisk: vi.fn(actual.runCorporateScanOnDisk) };
});

import * as core from '@actions/core';
import * as github from '@actions/github';
import { runScan, runCorporateScanOnDisk, NomusApiError } from '@nomus/scanner';
import { runCorporateGate } from '../src/cpg.js';
import { makeCheckout, startFakeEngine, statefulOctokit, type FakeEngine } from './fake-engine.js';

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
    // The corporate policy gate never ran: its status is unknown, not pass.
    expect(vi.mocked(core.setOutput).mock.calls.filter(([k]) => k === 'corporate-status')).toEqual([['corporate-status', 'unknown']]);
  });
});

/**
 * The corporate policy gate fails closed (design spec §11.3): one test per
 * row. Each asserts the job failed, corporate-status=unknown, and that no
 * success check run was created.
 */
describe('runCorporateGate fails closed (§11.3)', () => {
  let engine: FakeEngine;
  let gh: ReturnType<typeof statefulOctokit>;
  const gate = (apiUrl = engine.url) => runCorporateGate({ apiUrl, apiKey: 'nk_live_test', gateInput: 'true', uploadSarif: true, postPrComment: true, octokit: gh.octokit as any });

  beforeAll(async () => {
    engine = await startFakeEngine();
    process.env.GITHUB_WORKSPACE = makeCheckout();
    Object.assign(github.context, {
      sha: 'b'.repeat(40), eventName: 'pull_request',
      payload: { action: 'synchronize', pull_request: { number: 7, head: { sha: 'a'.repeat(40), ref: 'feat/x' } } },
    });
  });
  afterAll(async () => { await engine.close(); process.env.GITHUB_WORKSPACE = process.cwd(); });
  beforeEach(() => { vi.clearAllMocks(); engine.fault = null; gh = statefulOctokit(); });

  function expectFailedClosed(message: RegExp) {
    expect(core.setFailed).toHaveBeenCalledTimes(1);
    const text = vi.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(text).toMatch(/corporate policy status UNKNOWN; failing closed/);
    expect(text).toMatch(message);
    const status = vi.mocked(core.setOutput).mock.calls.filter(([k]) => k === 'corporate-status');
    expect(status).toEqual([['corporate-status', 'unknown']]);
    expect(gh.state.checkRuns.map((c) => c.conclusion)).toEqual(['failure']);
    expect(gh.state.checkRuns[0].output.title).toMatch(/failing closed$/);
  }

  it('network error: nothing listens at api-url', async () => {
    const closed = await startFakeEngine();
    await closed.close();
    await gate(closed.url);
    expectFailedClosed(/^Nomus unreachable: .*Could not reach/);
  });

  it('timeout or dropped connection on evaluate', async () => {
    engine.fault = { path: '/api/v1/cpg/ci/evaluate', kind: 'drop' };
    await gate();
    expectFailedClosed(/^Nomus unreachable: .*Could not reach POST \/cpg\/ci\/evaluate/);
  });

  it('non-2xx: the bundle endpoint answers 500', async () => {
    engine.fault = { path: '/api/v1/cpg/bundle', kind: 500 };
    await gate();
    expectFailedClosed(/^Nomus unreachable: .*answered 500/);
  });

  it('non-2xx: evaluate answers 500', async () => {
    engine.fault = { path: '/api/v1/cpg/ci/evaluate', kind: 500 };
    await gate();
    expectFailedClosed(/^Nomus unreachable: .*POST \/cpg\/ci\/evaluate answered 500 internal/);
  });

  it('non-2xx: a second 409 bundle_stale after the one retry', async () => {
    engine.fault = { path: '/api/v1/cpg/ci/evaluate', kind: 'stale' };
    await gate();
    expectFailedClosed(/answered 409 bundle_stale/);
    expect(engine.requests.filter((r) => r.path === '/api/v1/cpg/ci/evaluate').length).toBeGreaterThanOrEqual(2);
  });

  it('the verdict fails the contract (zod)', async () => {
    engine.fault = { path: '/api/v1/cpg/ci/evaluate', kind: 'schema' };
    await gate();
    expectFailedClosed(/^Nomus response could not be verified: .*does not match the contract/);
  });

  it('the verdict signature does not verify', async () => {
    engine.fault = { path: '/api/v1/cpg/ci/evaluate', kind: 'corrupt' };
    await gate();
    expectFailedClosed(/^Nomus response could not be verified: .*signature does not verify/);
  });

  it('/.well-known/nomus-keys is unavailable', async () => {
    engine.fault = { path: '/.well-known/nomus-keys', kind: 500 };
    await gate();
    expectFailedClosed(/^Nomus unreachable: .*signing-key endpoint answered 500/);
  });

  it('the corporate scan throws (unreadable checkout)', async () => {
    vi.mocked(runCorporateScanOnDisk).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await gate();
    expectFailedClosed(/^Corporate policy scan failed: .*EACCES/);
  });

  it('any other exception in the gate (an unusable repository identity)', async () => {
    const repo = github.context.repo;
    Object.defineProperty(github.context, 'repo', { value: { owner: 'not a repo', repo: '' }, configurable: true });
    try {
      await gate();
    } finally {
      Object.defineProperty(github.context, 'repo', { value: repo, configurable: true });
    }
    expectFailedClosed(/could not be determined/);
  });
});
