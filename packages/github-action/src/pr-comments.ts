import * as core from '@actions/core';
import { relative } from 'node:path';
import type { ScanResult } from '@nomus/scanner';
import type { ComplianceScoreResult } from './types.js';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

const EFFECT_LABELS: Record<string, string> = {
  deny: 'BLOCKED',
  require_disclosure: 'DISCLOSURE REQUIRED',
  allow_with_audit: 'AUDIT REQUIRED',
  flag: 'FLAGGED',
};

const COMMENT_MARKER = '<!-- nomus-scan -->';

/**
 * Post inline review comments on lines with applicable regulatory obligations.
 */
export async function postInlineComments(
  result: ScanResult,
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
  sha: string,
): Promise<void> {
  if (result.findings.length === 0) return;

  try {
    // Get the PR diff to know which files/lines are in the diff
    const { data: files } = await octokit.rest.pulls.listFiles({
      ...repo,
      pull_number: prNumber,
    });
    const diffFiles = new Set(files.map((f) => f.filename));

    // Only comment on files that are in the PR diff
    const comments = result.findings
      .filter((f) => {
        // Normalize path — strip leading ./ or absolute path prefix
        const relPath = relative(process.cwd(), f.file).replace(/\\/g, '/');
        return diffFiles.has(relPath);
      })
      .slice(0, 25) // GitHub limits to ~30 comments per review
      .map((f) => {
        const icon = SEVERITY_ICONS[f.rule.severity] ?? '⚪';
        const effect = EFFECT_LABELS[f.rule.effect] ?? f.rule.effect.toUpperCase();
        const relPath = relative(process.cwd(), f.file).replace(/\\/g, '/');

        let body = `${icon} **Nomus: ${f.rule.severity.toUpperCase()}** — ${effect}\n\n`;
        body += `**${f.rule.ruleKey}**\n`;
        body += `${f.rule.humanSummary}\n\n`;
        body += `📜 ${f.rule.legalReference}\n`;
        body += `🔧 SDK: \`${f.sdk}\`\n`;

        if (f.suggestion) {
          body += `\n<details><summary>💡 Suggested fix</summary>\n\n\`\`\`\n${f.suggestion}\n\`\`\`\n</details>\n`;
        }

        body += `\n---\n*Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.*`;

        return { path: relPath, line: f.line, body };
      });

    if (comments.length === 0) return;

    await octokit.rest.pulls.createReview({
      ...repo,
      pull_number: prNumber,
      commit_id: sha,
      event: 'COMMENT',
      comments,
    });

    core.info(`   Posted ${comments.length} inline review comment(s)`);
  } catch (err) {
    core.warning(`Failed to post inline comments: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Post or update a single summary comment on the PR.
 * Uses a hidden marker to find and update existing comments.
 */
export async function postSummaryComment(
  result: ScanResult,
  octokit: Octokit,
  repo: { owner: string; repo: string },
  apiUrl: string,
  prNumber: number,
  badgeEmbed: boolean,
  complianceScore?: ComplianceScoreResult,
): Promise<void> {
  try {
    const body = buildSummaryBody(result, repo, apiUrl, badgeEmbed, complianceScore);

    // Find existing Nomus comment
    const { data: comments } = await octokit.rest.issues.listComments({
      ...repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));

    if (existing) {
      await octokit.rest.issues.updateComment({
        ...repo,
        comment_id: existing.id,
        body,
      });
      core.info('   Updated existing PR summary comment');
    } else {
      await octokit.rest.issues.createComment({
        ...repo,
        issue_number: prNumber,
        body,
      });
      core.info('   Posted PR summary comment');
    }
  } catch (err) {
    core.warning(`Failed to post summary comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildSummaryBody(
  result: ScanResult,
  repo: { owner: string; repo: string },
  apiUrl: string,
  badgeEmbed: boolean,
  complianceScore?: ComplianceScoreResult,
): string {
  const { counts, status, findings } = result;
  const statusIcon = status === 'pass' ? '✅' : '❌';
  const statusText = status === 'pass' ? 'PASSED' : 'FAILED';

  let body = `${COMMENT_MARKER}\n`;
  body += `## 🛡️ Nomus Regulatory Scan — ${statusIcon} ${statusText}\n\n`;

  // Compliance score
  if (complianceScore) {
    const scoreIcon = complianceScore.score >= 80 ? '🟢'
      : complianceScore.score >= 60 ? '🟡'
      : '🔴';
    body += `**Regulatory Exposure Score:** ${scoreIcon} ${complianceScore.score}% (${complianceScore.label})\n\n`;
  }

  // Summary table
  body += `| Severity | Count |\n`;
  body += `|----------|-------|\n`;
  body += `| 🔴 Critical | ${counts.critical} |\n`;
  body += `| 🟠 High | ${counts.high} |\n`;
  body += `| 🟡 Medium | ${counts.medium} |\n`;
  body += `| 🔵 Low | ${counts.low} |\n`;
  body += `| **Total** | **${counts.total}** |\n\n`;

  // Files scanned
  body += `📁 ${result.fileCount} files scanned · ${result.importCount} AI SDK imports detected\n\n`;

  // Top findings (max 10)
  if (findings.length > 0) {
    body += `### Applicable Obligations\n\n`;
    const top = findings.slice(0, 10);
    for (const f of top) {
      const icon = SEVERITY_ICONS[f.rule.severity] ?? '⚪';
      const relPath = relative(process.cwd(), f.file).replace(/\\/g, '/');
      body += `${icon} **${f.rule.ruleKey}** — \`${relPath}:${f.line}\`\n`;
      body += `   ${f.rule.humanSummary}\n\n`;
    }
    if (findings.length > 10) {
      body += `_...and ${findings.length - 10} more obligations identified._\n\n`;
    }
  }

  // Badge
  if (badgeEmbed) {
    body += `---\n`;
    body += `[![Nomus Regulatory](${apiUrl}/api/v1/badge/${repo.owner}/svg)](${apiUrl}/api/v1/badge/${repo.owner})\n\n`;
  }

  body += `---\n`;
  body += `*Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.*\n`;

  return body;
}
