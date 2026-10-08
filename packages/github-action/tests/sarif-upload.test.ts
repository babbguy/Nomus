import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadSarif } from '../src/sarif-upload.js';
import { makeScanResult, makeFinding, mockOctokit } from './helpers.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

// Mock @nomus/scanner/sarif
vi.mock('@nomus/scanner/sarif', () => ({
  formatSarifReport: vi.fn((_findings: any[], _rootDir: string) => ({
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Nomus', version: '0.1.0', rules: [] } },
      results: [],
    }],
  })),
}));

// Mock fs.writeFileSync
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
}));

import * as core from '@actions/core';
import { writeFileSync } from 'node:fs';

describe('uploadSarif', () => {
  const repo = { owner: 'testorg', repo: 'testrepo' };
  const sha = 'abc123';
  let octokit: ReturnType<typeof mockOctokit>;

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = mockOctokit();
  });

  it('generates SARIF and uploads to GitHub', async () => {
    const result = makeScanResult({
      findings: [makeFinding()],
    });
    const spy = vi.spyOn(octokit.rest.codeScanning, 'uploadSarif');

    const sarifPath = await uploadSarif(result, octokit as any, repo, sha, '.');

    expect(sarifPath).toBeTruthy();
    expect(sarifPath).toContain('nomus-results.sarif');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].commit_sha).toBe(sha);
    expect(spy.mock.calls[0][0].tool_name).toBe('Nomus');
  });

  it('writes SARIF file to disk', async () => {
    const result = makeScanResult({ findings: [makeFinding()] });

    await uploadSarif(result, octokit as any, repo, sha, '.');

    expect(writeFileSync).toHaveBeenCalledOnce();
    const [path, content] = (writeFileSync as any).mock.calls[0];
    expect(path).toContain('nomus-results.sarif');
    expect(content).toContain('sarif-schema');
  });

  it('base64-encodes gzipped SARIF for upload', async () => {
    const result = makeScanResult({ findings: [makeFinding()] });
    const spy = vi.spyOn(octokit.rest.codeScanning, 'uploadSarif');

    await uploadSarif(result, octokit as any, repo, sha, '.');

    const sarif = spy.mock.calls[0][0].sarif;
    // Should be a base64 string (no whitespace, alphanumeric + /+=)
    expect(sarif).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Should decode to gzipped content
    const buf = Buffer.from(sarif, 'base64');
    expect(buf.length).toBeGreaterThan(0);
  });

  it('returns null when Advanced Security not enabled', async () => {
    octokit.rest.codeScanning.uploadSarif = async () => {
      throw new Error('Advanced Security must be enabled');
    };
    const result = makeScanResult({ findings: [makeFinding()] });

    const path = await uploadSarif(result, octokit as any, repo, sha, '.');

    expect(path).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Advanced Security not enabled'),
    );
  });

  it('returns null and warns on generic API error', async () => {
    octokit.rest.codeScanning.uploadSarif = async () => {
      throw new Error('Internal server error');
    };
    const result = makeScanResult({ findings: [makeFinding()] });

    const path = await uploadSarif(result, octokit as any, repo, sha, '.');

    expect(path).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Internal server error'),
    );
  });

  it('uses GITHUB_REF env var for ref parameter', async () => {
    const origRef = process.env.GITHUB_REF;
    process.env.GITHUB_REF = 'refs/heads/feature-branch';
    const spy = vi.spyOn(octokit.rest.codeScanning, 'uploadSarif');

    const result = makeScanResult({ findings: [makeFinding()] });
    await uploadSarif(result, octokit as any, repo, sha, '.');

    expect(spy.mock.calls[0][0].ref).toBe('refs/heads/feature-branch');

    // Restore
    if (origRef) process.env.GITHUB_REF = origRef;
    else delete process.env.GITHUB_REF;
  });
});
