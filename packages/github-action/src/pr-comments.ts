import * as core from '@actions/core';
import type { Finding, ScanResult } from '@nomus/scanner';
import type { ComplianceScoreResult } from './types.js';
import { bySeverity, commentableLines, toRepoPath } from './findings.js';

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
const DISCLAIMER = '*Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.*';

/** GitHub accepts a limited number of comments per review. */
const MAX_INLINE_COMMENTS = 25;

function findingBlock(f: Finding): string {
  const icon = SEVERITY_ICONS[f.rule.severity] ?? '⚪';
  const effect = EFFECT_LABELS[f.rule.effect] ?? f.rule.effect.toUpperCase();
  let body = `${icon} **Nomus: ${f.rule.severity.toUpperCase()}** — ${effect}\n\n`;
  body += `**${f.rule.ruleKey}**\n`;
  body += `${f.rule.humanSummary}\n\n`;
  body += `📜 ${f.rule.legalReference}\n`;
  body += `🔧 SDK: \`${f.sdk}\`\n`;
  if (f.suggestion) {
    body += `\n<details><summary>💡 Suggested fix</summary>\n\n\`\`\`\n${f.suggestion}\n\`\`\`\n</details>\n`;
  }
  return body;
}

/**
 * Post inline review comments on lines with applicable regulatory obligations.
 *
 * Only lines inside the PR's diff hunks are commented (GitHub rejects the
 * whole review otherwise), all obligations on one line share one comment, and
 * the most severe lines are commented first.
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
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      ...repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const diffLines = new Map<string, Set<number> | null>();
    for (const f of files) diffLines.set(f.filename, commentableLines(f.patch));

    // Group by (path, line), keeping severity order.
    const byLocation = new Map<string, { path: string; line: number; findings: Finding[] }>();
    for (const f of bySeverity(result.findings)) {
      const path = toRepoPath(f.file);
      if (!diffLines.has(path)) continue;
      const lines = diffLines.get(path);
      if (!lines || !lines.has(f.line)) continue;
      const key = `${path}:${f.line}`;
      const entry = byLocation.get(key) ?? { path, line: f.line, findings: [] };
      entry.findings.push(f);
      byLocation.set(key, entry);
    }

    const comments = [...byLocation.values()]
      .slice(0, MAX_INLINE_COMMENTS)
      .map(({ path, line, findings }) => ({
        path,
        line,
        side: 'RIGHT' as const,
        body: `${findings.map(findingBlock).join('\n---\n\n')}\n---\n${DISCLAIMER}`,
      }));

    if (comments.length === 0) {
      core.info('   No obligations on lines changed in this pull request — no inline comments');
      return;
    }

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
 *
 * `badgeOrgSlug` is the Nomus organization whose public badge to embed, or
 * null to embed none (the caller checks that the badge is actually served).
 */
export async function postSummaryComment(
  result: ScanResult,
  octokit: Octokit,
  repo: { owner: string; repo: string },
  apiUrl: string,
  prNumber: number,
  badgeOrgSlug: string | null,
  complianceScore?: ComplianceScoreResult,
): Promise<void> {
  try {
    const body = buildSummaryBody(result, apiUrl, badgeOrgSlug, complianceScore);

    // Find existing Nomus comment
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
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
  apiUrl: string,
  badgeOrgSlug: string | null,
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

  // Top findings (max 10), most severe first
  if (findings.length > 0) {
    body += `### Applicable Obligations\n\n`;
    const top = bySeverity(findings).slice(0, 10);
    for (const f of top) {
      const icon = SEVERITY_ICONS[f.rule.severity] ?? '⚪';
      body += `${icon} **${f.rule.ruleKey}** — \`${toRepoPath(f.file)}:${f.line}\`\n`;
      body += `   ${f.rule.humanSummary}\n\n`;
    }
    if (findings.length > 10) {
      body += `_...and ${findings.length - 10} more obligations identified._\n\n`;
    }
  }

  // Badge
  if (badgeOrgSlug) {
    const slug = encodeURIComponent(badgeOrgSlug);
    body += `---\n`;
    body += `[![Nomus Regulatory](${apiUrl}/api/v1/badge/${slug}/svg)](${apiUrl}/api/v1/badge/${slug})\n\n`;
  }

  body += `---\n`;
  body += `${DISCLAIMER}\n`;

  return body;
}
