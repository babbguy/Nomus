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
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { runScan } from '@nomus/scanner';
import { postInlineComments } from '../src/pr-comments.js';
import { createCheckRun } from '../src/check-run.js';
import { runCorporateGate } from '../src/cpg.js';
import { bySeverity, commentableLines, toRepoPath } from '../src/findings.js';
import { makeScanResult, makeFinding, mockOctokit } from './helpers.js';
import { CASE, makeCheckout, startFakeEngine, statefulOctokit, type FakeEngine } from './fake-engine.js';

const inputs = vi.hoisted(() => ({} as Record<string, string>));
const outputs = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  getInput: vi.fn((name: string) => inputs[name] ?? ''),
  getBooleanInput: vi.fn((name: string) => inputs[name] === 'true'),
  setOutput: vi.fn((name: string, value: unknown) => { outputs[name] = value; }),
  setFailed: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: { repo: { owner: 'Gate-Org', repo: 'Sample-Repo' }, sha: 'b'.repeat(40), ref: 'refs/pull/7/merge', eventName: 'pull_request', payload: {} },
  getOctokit: vi.fn(),
}));

vi.mock('@nomus/scanner', async (importOriginal) => ({ ...await importOriginal<typeof import('@nomus/scanner')>(), runScan: vi.fn() }));

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

describe('the corporate policy gate against a fake engine', () => {
  let engine: FakeEngine;
  let gh: ReturnType<typeof statefulOctokit>;
  const HEAD = 'a'.repeat(40);
  const pr = (extra: Record<string, unknown> = {}) => ({
    action: 'synchronize',
    pull_request: { number: 7, head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'Gate-Org/Sample-Repo' } }, base: { repo: { full_name: 'gate-org/sample-repo' } }, ...extra },
  });
  const gate = (gateInput = 'true') => runCorporateGate({ apiUrl: engine.url, apiKey: 'nk_live_test', gateInput, uploadSarif: true, postPrComment: true, octokit: gh.octokit as any });
  const evaluations = () => engine.requests.filter((r) => r.path === '/api/v1/cpg/ci/evaluate');
  const sarifOf = (upload: any) => JSON.parse(gunzipSync(Buffer.from(upload.sarif, 'base64')).toString('utf8'));

  const cwd = process.cwd();

  // The checkout is the working directory, as on a runner (the SARIF files are written there).
  beforeAll(async () => {
    engine = await startFakeEngine();
    process.env.GITHUB_WORKSPACE = makeCheckout();
    process.chdir(process.env.GITHUB_WORKSPACE);
  });
  afterAll(async () => { await engine.close(); process.chdir(cwd); process.env.GITHUB_WORKSPACE = cwd; });
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(outputs)) delete outputs[k];
    Object.assign(engine, { requests: [], fault: null, enabled: true, statusOf: () => 'needs_review' });
    (github.context as any).payload = pr();
    gh = statefulOctokit();
  });

  it('fails on blocking findings, then passes after the decisions with the comment edited in place', async () => {
    await gate();
    // The request: the whole checkout, every finding with its snippet, for the PR head.
    const sent = evaluations()[0].body;
    expect(sent).toMatchObject({ repo: 'gate-org/sample-repo', branch: 'feat/x', prNumber: 7, headSha: HEAD, eventName: 'pull_request', scannedFileCount: 2 });
    expect(sent.findings.map((f: any) => f.filePath).sort()).toEqual(['app/helper.ts', 'src/chat.ts']);
    expect(sent.findings.every((f: any) => f.snippet.includes('openai.chat.completions.create'))).toBe(true);
    // Outputs and the failed job.
    expect(outputs).toEqual({ 'corporate-status': 'fail', 'corporate-blocking': 2, 'corporate-case-url': `https://gate.example.org/governance/cases/${CASE}` });
    expect(vi.mocked(core.setFailed).mock.calls[0][0]).toMatch(/^Corporate policy gate failed: 2 blocking finding\(s\) without a valid decision \(0 rejected, 2 need review\)\. Review case: https/);
    // The check run: failure, annotated.
    expect(gh.state.checkRuns).toHaveLength(1);
    expect(gh.state.checkRuns[0]).toMatchObject({ name: 'Nomus Corporate Policy Gate', head_sha: HEAD, conclusion: 'failure', output: { title: '2 blocking, 0 approved, 0 excepted' } });
    expect(gh.state.checkRuns[0].output.annotations.map((a: any) => [a.path, a.annotation_level])).toEqual([['app/helper.ts', 'failure'], ['src/chat.ts', 'failure']]);
    // The corporate SARIF: its own upload and category, errors.
    expect(gh.state.sarifs).toHaveLength(1);
    const sarif = sarifOf(gh.state.sarifs[0]);
    expect(sarif.runs[0].automationDetails.id).toBe('nomus-corporate/');
    expect(sarif.runs[0].results.map((r: any) => r.level)).toEqual(['error', 'error']);
    // One marked comment with the case link and the blocking rows.
    expect(gh.state.comments).toHaveLength(1);
    const comment = gh.state.comments[0].body;
    expect(comment).toContain('<!-- nomus-cpg -->');
    expect(comment).toContain(`[${CASE}](https://gate.example.org/governance/cases/${CASE})`);
    expect(comment).toContain('| `corp.no-direct-openai` | `src/chat.ts:3` | needs review |');
    // Never the code (§12).
    for (const text of [comment, JSON.stringify(gh.state.checkRuns), JSON.stringify(sarif)]) expect(text).not.toContain('chat.completions.create');

    // The reviewers approve: the rerun passes, edits the comment and suppresses the alerts.
    engine.statusOf = () => 'approved';
    vi.clearAllMocks();
    await gate();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(outputs['corporate-status']).toBe('pass');
    expect(gh.state.checkRuns.map((c) => c.conclusion)).toEqual(['failure', 'success']);
    expect(gh.state.comments).toHaveLength(1);
    expect(gh.state.comments[0].body).toMatch(/Gate: passed/);
    const passed = sarifOf(gh.state.sarifs[1]).runs[0].results;
    expect(passed.map((r: any) => [r.level, r.suppressions?.[0]?.status])).toEqual([['note', 'accepted'], ['note', 'accepted']]);
    expect(passed[0].suppressions[0].justification).toMatch(/^Approved by Nomus decision [0-9a-f-]{36} until 2026-11-08/);
  });

  it('never scans a report this run wrote into the checkout as code', async () => {
    const report = join(process.cwd(), 'report.ts');
    writeFileSync(report, 'const fix = client.openai.chat.completions.create;\n');
    try {
      await runCorporateGate({ apiUrl: engine.url, apiKey: 'nk_live_test', gateInput: 'true', uploadSarif: false, postPrComment: false, octokit: gh.octokit as any, generated: [report] });
    } finally {
      rmSync(report);
    }
    expect(evaluations()[0].body.findings.map((f: any) => f.filePath).sort()).toEqual(['app/helper.ts', 'src/chat.ts']);
  });

  it('refetches the bundle and retries once on 409 bundle_stale', async () => {
    engine.fault = { path: '/api/v1/cpg/ci/evaluate', kind: 'stale-once' };
    await gate();
    expect(evaluations()).toHaveLength(2);
    expect(engine.requests.filter((r) => r.path === '/api/v1/cpg/bundle')).toHaveLength(2);
    expect(outputs['corporate-status']).toBe('fail');
  });

  it('a closed pull request closes the case instead of evaluating', async () => {
    (github.context as any).payload = { ...pr({ merged: true, merge_commit_sha: 'c'.repeat(40) }), action: 'closed' };
    await gate();
    expect(engine.requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body])).toEqual([
      ['/api/v1/cpg/ci/pr-closed', { repo: 'gate-org/sample-repo', branch: 'feat/x', prNumber: 7, merged: true, mergeSha: 'c'.repeat(40) }],
    ]);
    expect(outputs['corporate-status']).toBe('closed');
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(gh.state.checkRuns).toEqual([]);
  });

  it('refuses corporate-gate: false while the organization enforces corporate policies', async () => {
    await gate('false');
    expect(vi.mocked(core.setFailed).mock.calls[0][0]).toMatch(/^Corporate policy gate cannot be disabled: .*the gate cannot be disabled from the workflow/);
    expect(outputs['corporate-status']).toBe('unknown');
    expect(evaluations()).toEqual([]);
  });

  it('does nothing visible for an organization without corporate policies, even with corporate-gate: false', async () => {
    engine.enabled = false;
    await gate();
    await gate('false');
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
    expect(outputs['corporate-status']).toBe('disabled');
    expect(evaluations()).toEqual([]);
    expect(gh.state).toEqual({ comments: [], checkRuns: [], sarifs: [] });
  });

  it('the Action scans the whole checkout for corporate policies, whatever working-directory says', async () => {
    Object.assign(inputs, { 'api-key': 'nk_live_test', 'api-url': engine.url, 'working-directory': 'app', 'github-token': 'ghs_test', 'upload-sarif': 'true', 'post-pr-comment': 'false', 'badge-embed': 'false' });
    vi.mocked(github.getOctokit).mockReturnValue(gh.octokit as any);
    vi.mocked(runScan).mockResolvedValue(makeScanResult());
    vi.resetModules();
    await import('../src/index.js');
    await vi.waitFor(() => expect(outputs['corporate-status']).toBe('fail'), { timeout: 10_000 });
    expect(vi.mocked(runScan).mock.calls[0][0].rootDir).toBe('app');
    expect(evaluations()[0].body.findings.map((f: any) => f.filePath).sort()).toEqual(['app/helper.ts', 'src/chat.ts']);
    expect(outputs.status).toBe('pass'); // the regulatory result is its own
  });
});
