import * as core from '@actions/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ScanResult } from '@nomus/scanner';
import { formatSarifReport } from '@nomus/scanner/sarif';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

/**
 * Generate SARIF report and upload to GitHub Code Scanning.
 * Returns the path to the SARIF file, or null if upload failed.
 */
export async function uploadSarif(
  result: ScanResult,
  octokit: Octokit,
  repo: { owner: string; repo: string },
  sha: string,
  rootDir: string,
  ref?: string,
): Promise<string | null> {
  try {
    const sarif = formatSarifReport(result.findings, rootDir);
    const sarifJson = JSON.stringify(sarif, null, 2);

    // Write to file for downstream use
    const sarifPath = resolve('nomus-results.sarif');
    writeFileSync(sarifPath, sarifJson, 'utf-8');

    // Compress and encode for API upload
    const compressed = gzipSync(Buffer.from(sarifJson, 'utf-8'));
    const encoded = compressed.toString('base64');

    await octokit.rest.codeScanning.uploadSarif({
      ...repo,
      commit_sha: sha,
      ref: ref ?? process.env.GITHUB_REF ?? `refs/heads/main`,
      sarif: encoded,
      tool_name: 'Nomus',
    });

    core.info('   SARIF uploaded to Code Scanning tab');
    return sarifPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Advanced Security') || msg.includes('not enabled')) {
      core.warning('SARIF upload skipped — GitHub Advanced Security not enabled for this repo.');
    } else {
      core.warning(`SARIF upload failed: ${msg}`);
    }
    return null;
  }
}
