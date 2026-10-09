// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import type { CiEvaluateResponse } from '@nomus/scanner/corporate';
import { policyKeyOf } from './cpg-check-run.js';
import { upsertMarkedComment } from './pr-comments.js';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

export const CORPORATE_COMMENT_MARKER = '<!-- nomus-cpg -->';
const MAX_ROWS = 50;

/**
 * The corporate gate's PR comment (design spec §11.6), edited in place on
 * every run: the case link, the counts and one row per blocking finding.
 * Never code, snippets or justifications (§12): those stay on the server.
 */
export function corporateCommentBody(v: CiEvaluateResponse): string {
  const c = v.counts;
  const blocking = v.findings.filter((f) => f.blocking);
  const lines = [
    CORPORATE_COMMENT_MARKER,
    `## Nomus Corporate Policy Gate: ${v.verdict === 'pass' ? 'passed' : 'failed'}`,
    '',
    v.caseUrl ? `**Review case:** [${v.caseId}](${v.caseUrl})` : 'No review case for this branch.',
    '',
    '| Blocking | Pending | Rejected | Approved | Excepted | Advisory |',
    '|---|---|---|---|---|---|',
    `| ${c.blocking} | ${c.pending} | ${c.rejected} | ${c.approved} | ${c.excepted} | ${c.advisory} |`,
  ];
  if (blocking.length > 0) {
    lines.push('', '### Blocking findings', '', '| Policy | Location | Status |', '|---|---|---|');
    for (const f of blocking.slice(0, MAX_ROWS)) {
      lines.push(`| \`${policyKeyOf(f.fingerprint)}\` | \`${f.filePath}:${f.startLine}\` | ${f.status.replace(/_/g, ' ')} |`);
    }
    if (blocking.length > MAX_ROWS) lines.push('', `_…and ${blocking.length - MAX_ROWS} more in the review case._`);
    lines.push('', 'Each blocking finding needs an approval, a standing exception or a code change. Request a review from VS Code or open the case.');
  }
  return `${lines.join('\n')}\n`;
}

export async function postCorporateComment(octokit: Octokit, repo: { owner: string; repo: string }, prNumber: number, v: CiEvaluateResponse): Promise<void> {
  await upsertMarkedComment(octokit, repo, prNumber, CORPORATE_COMMENT_MARKER, () => corporateCommentBody(v), 'corporate policy comment');
}
