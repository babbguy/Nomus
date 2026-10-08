import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCheckRun } from '../src/check-run.js';
import { makeScanResult, makeFinding, mockOctokit } from './helpers.js';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

import * as core from '@actions/core';

describe('createCheckRun', () => {
  const repo = { owner: 'testorg', repo: 'testrepo' };
  const sha = 'abc123def456';
  let octokit: ReturnType<typeof mockOctokit>;

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = mockOctokit();
  });

  it('creates a successful check run when no findings', async () => {
    const result = makeScanResult();
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0][0] as any;
    expect(call.conclusion).toBe('success');
    expect(call.name).toBe('Nomus Regulatory Scan');
    expect(call.head_sha).toBe(sha);
    expect(call.output.title).toContain('No applicable regulatory obligations');
  });

  it('creates a failure check run when status is fail', async () => {
    const result = makeScanResult({
      status: 'fail',
      findings: [makeFinding({ severity: 'critical' })],
      counts: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
    });
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    const call = spy.mock.calls[0][0] as any;
    expect(call.conclusion).toBe('failure');
    expect(call.output.title).toContain('regulatory check failed');
  });

  it('creates a neutral check run when findings exist but status is pass', async () => {
    const result = makeScanResult({
      status: 'pass',
      findings: [makeFinding({ severity: 'low' })],
      counts: { critical: 0, high: 0, medium: 0, low: 1, total: 1 },
    });
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    const call = spy.mock.calls[0][0] as any;
    expect(call.conclusion).toBe('neutral');
    expect(call.output.title).toContain('review recommended');
  });

  it('includes annotations for findings', async () => {
    const result = makeScanResult({
      findings: [
        makeFinding({ severity: 'critical', ruleKey: 'eu.rule1', line: 10 }),
        makeFinding({ severity: 'medium', ruleKey: 'eu.rule2', line: 20 }),
      ],
      counts: { critical: 1, high: 0, medium: 1, low: 0, total: 2 },
    });
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    const call = spy.mock.calls[0][0] as any;
    const annotations = call.output.annotations;
    expect(annotations).toHaveLength(2);
    expect(annotations[0].start_line).toBe(10);
    expect(annotations[0].annotation_level).toBe('failure'); // critical → failure
    expect(annotations[1].annotation_level).toBe('warning'); // medium → warning
  });

  it('limits annotations to 50', async () => {
    const findings = Array.from({ length: 60 }, (_, i) =>
      makeFinding({ ruleKey: `rule.${i}`, line: i + 1 }),
    );
    const result = makeScanResult({ findings, counts: { critical: 0, high: 60, medium: 0, low: 0, total: 60 } });
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    const call = spy.mock.calls[0][0] as any;
    expect(call.output.annotations).toHaveLength(50);
  });

  it('includes summary table with metrics', async () => {
    const result = makeScanResult({
      fileCount: 42,
      importCount: 7,
      counts: { critical: 1, high: 2, medium: 3, low: 4, total: 10 },
    });
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    const summary = spy.mock.calls[0][0].output.summary;
    expect(summary).toContain('42');
    expect(summary).toContain('7');
    expect(summary).toContain('Nomus Regulatory Scan Results');
  });

  it('handles API errors gracefully', async () => {
    octokit.rest.checks.create = async () => { throw new Error('API rate limited'); };
    const result = makeScanResult();

    await createCheckRun(result, octokit as any, repo, sha);

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('API rate limited'));
  });

  it('maps severity to correct annotation levels', async () => {
    const findings = [
      makeFinding({ severity: 'critical', ruleKey: 'r1' }),
      makeFinding({ severity: 'high', ruleKey: 'r2' }),
      makeFinding({ severity: 'medium', ruleKey: 'r3' }),
      makeFinding({ severity: 'low', ruleKey: 'r4' }),
    ];
    const result = makeScanResult({
      findings,
      counts: { critical: 1, high: 1, medium: 1, low: 1, total: 4 },
    });
    const spy = vi.spyOn(octokit.rest.checks, 'create');

    await createCheckRun(result, octokit as any, repo, sha);

    const annotations = spy.mock.calls[0][0].output.annotations;
    expect(annotations[0].annotation_level).toBe('failure');
    expect(annotations[1].annotation_level).toBe('failure');
    expect(annotations[2].annotation_level).toBe('warning');
    expect(annotations[3].annotation_level).toBe('notice');
  });
});
