import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postSummaryComment, postInlineComments } from '../src/pr-comments.js';
import { makeScanResult, makeFinding, mockOctokit } from './helpers.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

import * as core from '@actions/core';

describe('postSummaryComment', () => {
  const repo = { owner: 'testorg', repo: 'testrepo' };
  let octokit: ReturnType<typeof mockOctokit>;

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = mockOctokit();
  });

  it('creates a new summary comment when none exists', async () => {
    const result = makeScanResult({
      status: 'pass',
      counts: { critical: 0, high: 0, medium: 1, low: 0, total: 1 },
      findings: [makeFinding({ severity: 'medium' })],
    });
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(result, octokit as any, repo, 'http://localhost:3100', 42, null);

    expect(spy).toHaveBeenCalledOnce();
    const body = spy.mock.calls[0][0].body;
    expect(body).toContain('nomus-scan'); // marker
    expect(body).toContain('PASSED');
    expect(body).toContain('Nomus Regulatory Scan');
  });

  it('updates existing comment when marker found', async () => {
    octokit.rest.issues.listComments = async () => ({
      data: [
        { id: 99, body: '<!-- nomus-scan -->\nold content' },
      ],
    });
    const updateSpy = vi.spyOn(octokit.rest.issues, 'updateComment');
    const createSpy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(makeScanResult(), octokit as any, repo, 'http://localhost:3100', 42, null);

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0][0].comment_id).toBe(99);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('includes FAILED status when scan fails', async () => {
    const result = makeScanResult({
      status: 'fail',
      counts: { critical: 2, high: 1, medium: 0, low: 0, total: 3 },
    });
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(result, octokit as any, repo, 'http://localhost:3100', 42, null);

    expect(spy.mock.calls[0][0].body).toContain('FAILED');
  });

  it('includes severity count table', async () => {
    const result = makeScanResult({
      counts: { critical: 1, high: 2, medium: 3, low: 4, total: 10 },
    });
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(result, octokit as any, repo, 'http://localhost:3100', 42, null);

    const body = spy.mock.calls[0][0].body;
    expect(body).toContain('Critical');
    expect(body).toContain('**10**');
  });

  it('embeds the badge for the given organization slug', async () => {
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(makeScanResult(), octokit as any, repo, 'http://localhost:3100', 42, 'testorg');

    const body = spy.mock.calls[0][0].body;
    expect(body).toContain('localhost:3100/api/v1/badge/testorg/svg');
  });

  it('does not embed a badge without an organization slug', async () => {
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(makeScanResult(), octokit as any, repo, 'http://localhost:3100', 42, null);

    const body = spy.mock.calls[0][0].body;
    expect(body).not.toContain('badge');
  });

  it('shows top 10 findings and truncation message', async () => {
    const findings = Array.from({ length: 15 }, (_, i) =>
      makeFinding({ ruleKey: `rule.${i}` }),
    );
    const result = makeScanResult({ findings, counts: { critical: 0, high: 15, medium: 0, low: 0, total: 15 } });
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');

    await postSummaryComment(result, octokit as any, repo, 'http://localhost:3100', 42, null);

    const body = spy.mock.calls[0][0].body;
    expect(body).toContain('rule.0');
    expect(body).toContain('rule.9');
    expect(body).not.toContain('rule.10');
    expect(body).toContain('5 more obligations');
  });

  it('includes legal disclaimer', async () => {
    const spy = vi.spyOn(octokit.rest.issues, 'createComment');
    await postSummaryComment(makeScanResult(), octokit as any, repo, 'http://localhost:3100', 42, null);

    expect(spy.mock.calls[0][0].body).toContain('does not provide legal advice');
  });

  it('handles API errors gracefully', async () => {
    octokit.rest.issues.listComments = async () => { throw new Error('forbidden'); };

    await postSummaryComment(makeScanResult(), octokit as any, repo, 'http://localhost:3100', 42, null);

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('forbidden'));
  });
});

describe('postInlineComments', () => {
  const repo = { owner: 'testorg', repo: 'testrepo' };
  const sha = 'abc123';
  let octokit: ReturnType<typeof mockOctokit>;

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = mockOctokit();
  });

  it('does nothing when no findings', async () => {
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');
    await postInlineComments(makeScanResult(), octokit as any, repo, 42, sha);
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts inline comments for findings in PR diff', async () => {
    const result = makeScanResult({
      findings: [makeFinding({ file: `${process.cwd()}/src/app.ts`, line: 5 })],
      counts: { critical: 0, high: 1, medium: 0, low: 0, total: 1 },
    });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');

    await postInlineComments(result, octokit as any, repo, 42, sha);

    expect(spy).toHaveBeenCalledOnce();
    const comments = spy.mock.calls[0][0].comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].line).toBe(5);
    expect(comments[0].body).toContain('Nomus');
  });

  it('skips findings not in the PR diff', async () => {
    const result = makeScanResult({
      findings: [makeFinding({ file: `${process.cwd()}/src/not-in-diff.ts` })],
      counts: { critical: 0, high: 1, medium: 0, low: 0, total: 1 },
    });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');

    await postInlineComments(result, octokit as any, repo, 42, sha);

    // Should not post because file isn't in diff
    expect(spy).not.toHaveBeenCalled();
  });

  it('limits inline comments to 25', async () => {
    const findings = Array.from({ length: 30 }, (_, i) =>
      makeFinding({ file: `${process.cwd()}/src/app.ts`, line: i + 1 }),
    );
    const result = makeScanResult({ findings });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');

    await postInlineComments(result, octokit as any, repo, 42, sha);

    const comments = spy.mock.calls[0][0].comments;
    expect(comments.length).toBeLessThanOrEqual(25);
  });

  it('includes severity icon and effect label', async () => {
    const result = makeScanResult({
      findings: [makeFinding({ severity: 'critical', effect: 'deny', file: `${process.cwd()}/src/app.ts` })],
    });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');

    await postInlineComments(result, octokit as any, repo, 42, sha);

    const body = spy.mock.calls[0][0].comments[0].body;
    expect(body).toContain('CRITICAL');
    expect(body).toContain('BLOCKED');
  });

  it('includes suggestion in collapsible details', async () => {
    const result = makeScanResult({
      findings: [makeFinding({
        file: `${process.cwd()}/src/app.ts`,
        suggestion: 'Add transparency disclosure middleware',
      })],
    });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');

    await postInlineComments(result, octokit as any, repo, 42, sha);

    const body = spy.mock.calls[0][0].comments[0].body;
    expect(body).toContain('Suggested fix');
    expect(body).toContain('Add transparency disclosure middleware');
  });

  it('handles API errors gracefully', async () => {
    octokit.rest.pulls.listFiles = async () => { throw new Error('rate limit'); };
    const result = makeScanResult({ findings: [makeFinding()] });

    await postInlineComments(result, octokit as any, repo, 42, sha);

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('rate limit'));
  });
});
