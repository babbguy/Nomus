// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import type { CiEvaluateResponse } from '@nomus/scanner/corporate';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

/** The check run of the corporate policy gate (design spec §11.5), next to the regulatory one. */
export const CORPORATE_CHECK_NAME = 'Nomus Corporate Policy Gate';

/** The policy key a fingerprint names (`sha256:corp.key:version`). */
export const policyKeyOf = (fingerprint: string): string => fingerprint.split(':')[1] ?? fingerprint;

/**
 * The verdict as a check run: counts, the case link and the bundle hash, and
 * up to 50 annotations, blocking first. Locations and statuses only, never
 * the code (§12).
 */
export async function createCorporateCheckRun(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  sha: string,
  v: CiEvaluateResponse,
  bundleHash: string,
  titles: ReadonlyMap<string, string>,
): Promise<void> {
  const { counts } = v;
  const summary = [
    `## ${CORPORATE_CHECK_NAME}: ${v.verdict === 'pass' ? 'passed' : 'failed'}`,
    '',
    '| Blocking | Pending | Rejected | Approved | Excepted | Advisory |',
    '|---|---|---|---|---|---|',
    `| ${counts.blocking} | ${counts.pending} | ${counts.rejected} | ${counts.approved} | ${counts.excepted} | ${counts.advisory} |`,
    '',
    v.caseUrl ? `Review case: [${v.caseRef ?? v.caseId}](${v.caseUrl})` : 'No review case for this branch.',
    '',
    `Policy bundle: \`${bundleHash}\``,
  ].join('\n');
  const annotations = [...v.findings]
    .sort((a, b) => Number(b.blocking) - Number(a.blocking))
    .slice(0, 50)
    .map((f) => {
      const key = policyKeyOf(f.fingerprint);
      return {
        path: f.filePath,
        start_line: f.startLine,
        end_line: f.endLine,
        annotation_level: f.blocking ? 'failure' as const : 'notice' as const,
        title: `${key}: ${f.status.replace(/_/g, ' ')}`,
        message: `${titles.get(key) ?? key} (${f.tier})${f.blocking ? ' blocks this pull request until a reviewer decides it.' : ''}`,
      };
    });
  await create(octokit, repo, sha, v.verdict === 'pass' ? 'success' : 'failure', `${counts.blocking} blocking, ${counts.approved} approved, ${counts.excepted} excepted`, summary, annotations);
}

/** Best effort when the gate fails closed; the failed job is the authority. */
export async function createFailClosedCheckRun(octokit: Octokit, repo: { owner: string; repo: string }, sha: string, title: string): Promise<void> {
  await create(octokit, repo, sha, 'failure', title, `## ${CORPORATE_CHECK_NAME}: ${title}\n\nThe corporate policy status is unknown, so the gate fails closed. See the job log for the cause.`, []);
}

async function create(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  sha: string,
  conclusion: 'success' | 'failure',
  title: string,
  summary: string,
  annotations: Array<{ path: string; start_line: number; end_line: number; annotation_level: 'failure' | 'notice'; title: string; message: string }>,
): Promise<void> {
  try {
    await octokit.rest.checks.create({
      ...repo, head_sha: sha, name: CORPORATE_CHECK_NAME, status: 'completed', conclusion, output: { title, summary, annotations },
    });
    core.info(`   Corporate check run created: ${conclusion}`);
  } catch (err) {
    core.warning(`Failed to create the corporate check run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
