// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions found by running the action end to end (dist/index.js against a
 * real engine and a recording GitHub API):
 *   - the bundle crashed on load ("__filename is not defined in ES module scope")
 *   - review comments pointed at lines outside the diff (GitHub 422s the review)
 *   - one comment per rule on the same line, in rule order instead of severity
 *   - absolute runner paths in annotations, uploads and comments
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { postInlineComments } from '../src/pr-comments.js';
import { createCheckRun } from '../src/check-run.js';
import { bySeverity, commentableLines, toRepoPath } from '../src/findings.js';
import { makeScanResult, makeFinding, mockOctokit } from './helpers.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

const repo = { owner: 'testorg', repo: 'testrepo' };

describe('dist/index.js (the file GitHub runs)', () => {
  const dist = resolve(import.meta.dirname, '..', 'dist', 'index.js');

  it.skipIf(!existsSync(dist))('loads and reports a missing input instead of crashing', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('INPUT_') && !k.startsWith('GITHUB_')) env[k] = v;
    }
    const run = spawnSync(process.execPath, [dist], { env, encoding: 'utf8', timeout: 60_000 });
    expect(run.stderr).not.toMatch(/ReferenceError|is not defined in ES module scope/);
    expect(run.stdout).toMatch(/::error::.*Input required and not supplied: api-key/);
    expect(run.status).toBe(1);
  });
});

describe('findings helpers', () => {
  it('commentableLines returns the right-side lines of each hunk', () => {
    const patch = [
      '@@ -10,4 +10,5 @@ function a() {',
      ' context10',
      '-removed',
      '+added11',
      '+added12',
      ' context13',
      '\\ No newline at end of file',
      '@@ -40,2 +41,2 @@',
      ' context41',
      '+added42',
    ].join('\n');
    expect([...commentableLines(patch)!]).toEqual([10, 11, 12, 13, 41, 42]);
    expect(commentableLines(undefined)).toBeNull();
  });

  it('toRepoPath makes runner paths repository-relative', () => {
    expect(toRepoPath(join(process.cwd(), 'src', 'api', 'chat.ts'))).toBe('src/api/chat.ts');
    // On a runner the checkout root is GITHUB_WORKSPACE, not the scan directory.
    const saved = process.env.GITHUB_WORKSPACE;
    try {
      process.env.GITHUB_WORKSPACE = resolve(process.cwd(), '..');
      expect(toRepoPath(join(process.cwd(), 'src', 'api', 'chat.ts'))).toBe(`${basename(process.cwd())}/src/api/chat.ts`);
    } finally {
      process.env.GITHUB_WORKSPACE = saved;
    }
    expect(toRepoPath('src/x.ts')).toBe('src/x.ts');
  });

  it('bySeverity orders critical first and keeps order within a severity', () => {
    const fs = [
      makeFinding({ severity: 'low', ruleKey: 'l' }),
      makeFinding({ severity: 'critical', ruleKey: 'c1' }),
      makeFinding({ severity: 'high', ruleKey: 'h' }),
      makeFinding({ severity: 'critical', ruleKey: 'c2' }),
    ];
    expect(bySeverity(fs).map((f) => f.rule.ruleKey)).toEqual(['c1', 'c2', 'h', 'l']);
  });
});

describe('postInlineComments against a real diff', () => {
  let octokit: ReturnType<typeof mockOctokit>;
  beforeEach(() => { octokit = mockOctokit(); });

  it('only comments on lines inside the diff hunks', async () => {
    octokit.rest.pulls.listFiles = async () => ({
      data: [{ filename: 'src/app.ts', patch: '@@ -1,3 +1,3 @@\n line1\n+line2\n line3' }],
    }) as any;
    const result = makeScanResult({
      findings: [
        makeFinding({ file: `${process.cwd()}/src/app.ts`, line: 2 }),
        makeFinding({ file: `${process.cwd()}/src/app.ts`, line: 19 }), // outside the hunk
      ],
    });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');
    await postInlineComments(result, octokit as any, repo, 42, 'headsha');
    const comments = spy.mock.calls[0][0].comments;
    expect(comments.map((c: any) => c.line)).toEqual([2]);
    expect(spy.mock.calls[0][0].commit_id).toBe('headsha');
  });

  it('puts every obligation on one line into one comment, most severe first', async () => {
    const result = makeScanResult({
      findings: [
        makeFinding({ file: `${process.cwd()}/src/app.ts`, line: 5, severity: 'medium', ruleKey: 'rule.medium' }),
        makeFinding({ file: `${process.cwd()}/src/app.ts`, line: 5, severity: 'critical', ruleKey: 'rule.critical' }),
        makeFinding({ file: `${process.cwd()}/src/app.ts`, line: 9, severity: 'high', ruleKey: 'rule.high' }),
      ],
    });
    const spy = vi.spyOn(octokit.rest.pulls, 'createReview');
    await postInlineComments(result, octokit as any, repo, 42, 'headsha');
    const comments = spy.mock.calls[0][0].comments;
    expect(comments).toHaveLength(2);
    expect(comments[0].line).toBe(5);
    expect(comments[0].body.indexOf('rule.critical')).toBeLessThan(comments[0].body.indexOf('rule.medium'));
  });
});

describe('createCheckRun annotations', () => {
  it('annotates the most severe findings with repository-relative paths', async () => {
    const octokit = mockOctokit();
    const spy = vi.spyOn(octokit.rest.checks, 'create');
    const findings = [
      ...Array.from({ length: 60 }, (_, i) => makeFinding({ severity: 'low', ruleKey: `low.${i}` })),
      makeFinding({ severity: 'critical', ruleKey: 'crit', file: `${process.cwd()}/src/deep/x.ts` }),
    ];
    await createCheckRun(makeScanResult({ findings, status: 'fail' }), octokit as any, repo, 'sha');
    const annotations = (spy.mock.calls[0][0] as any).output.annotations;
    expect(annotations).toHaveLength(50);
    expect(annotations[0].title).toContain('crit');
    expect(annotations[0].path).toBe('src/deep/x.ts');
  });
});
