import * as core from '@actions/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ScanResult } from '@nomus/scanner';
import { formatSarifReport } from '@nomus/scanner/sarif';
import { repoRoot } from './findings.js';

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
  rootDir: string = repoRoot(),
  ref?: string,
): Promise<string | null> {
  // Code Scanning resolves artifact URIs against the repository root, so
  // paths must be repo-relative even when working-directory is a subfolder.
  return uploadSarifDocument(octokit, repo, sha, ref, {
    sarif: () => formatSarifReport(result.findings, rootDir),
    file: 'nomus-results.sarif',
    toolName: 'Nomus',
  });
}

export interface SarifDocument {
  /** Built inside the upload's error handling. */
  sarif: object | (() => object);
  /** The Code Scanning category the runs declare (`automationDetails.id`); logged with the upload. */
  category?: string;
  /** Written to the working directory for downstream steps. */
  file: string;
  toolName: string;
}

/**
 * Upload one SARIF log as its own Code Scanning analysis. The regulatory
 * scan and the corporate gate (category `nomus-corporate/`) each upload
 * their own. Returns the path to the SARIF file, or null if upload failed.
 */
export async function uploadSarifDocument(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  sha: string,
  ref: string | undefined,
  doc: SarifDocument,
): Promise<string | null> {
  try {
    const sarif = typeof doc.sarif === 'function' ? doc.sarif() : doc.sarif;
    const sarifJson = JSON.stringify(sarif, null, 2);

    // Write to file for downstream use
    const sarifPath = resolve(doc.file);
    writeFileSync(sarifPath, sarifJson, 'utf-8');

    // Compress and encode for API upload
    const compressed = gzipSync(Buffer.from(sarifJson, 'utf-8'));
    const encoded = compressed.toString('base64');

    await octokit.rest.codeScanning.uploadSarif({
      ...repo,
      commit_sha: sha,
      ref: ref ?? process.env.GITHUB_REF ?? `refs/heads/main`,
      sarif: encoded,
      tool_name: doc.toolName,
    });

    core.info(`   SARIF uploaded to Code Scanning tab${doc.category ? ` (category ${doc.category})` : ''}`);
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
