import { logger } from '../logger.js';
import { getInstallationToken } from './token-manager.js';

interface FindingSummary {
  file: string;
  line: number;
  sdk: string;
  ruleKey: string;
  severity: string;
  effect: string;
  humanSummary: string;
  legalReference: string;
  detectorSource?: string;
  suggestion?: string;
}

interface ScanCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

/**
 * Create a GitHub Check Run with annotations for each finding.
 */
export async function createCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  sha: string,
  findings: FindingSummary[],
  counts: ScanCounts,
  fileCount: number,
  importCount: number,
): Promise<void> {
  const token = await getInstallationToken(installationId);
  const status = counts.critical > 0 || counts.high > 0 ? 'failure' : counts.total > 0 ? 'neutral' : 'success';

  const title = status === 'failure'
    ? `${counts.critical} critical, ${counts.high} high — compliance check failed`
    : counts.total > 0
      ? `${counts.total} findings — review recommended`
      : 'No compliance issues found';

  const summary = [
    `## Nomus Compliance Scan Results`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Files scanned | ${fileCount} |`,
    `| AI SDK imports | ${importCount} |`,
    `| Critical | ${counts.critical} |`,
    `| High | ${counts.high} |`,
    `| Medium | ${counts.medium} |`,
    `| Low | ${counts.low} |`,
    `| **Total** | **${counts.total}** |`,
  ].join('\n');

  const annotations = findings.slice(0, 50).map((f) => ({
    path: f.file,
    start_line: f.line,
    end_line: f.line,
    annotation_level: f.severity === 'critical' || f.severity === 'high' ? 'failure' : f.severity === 'medium' ? 'warning' : 'notice',
    title: `${f.severity.toUpperCase()}: ${f.ruleKey}`,
    message: `${f.humanSummary}\n\n${f.legalReference}`,
  }));

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      name: 'Nomus Compliance Scan',
      head_sha: sha,
      status: 'completed',
      conclusion: status,
      output: { title, summary, annotations },
    }),
  });

  if (!response.ok) {
    logger.error({ status: response.status }, 'Failed to create check run');
  }
}

/**
 * Post a summary comment on a PR.
 */
export async function postPrSummary(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  findings: FindingSummary[],
  counts: ScanCounts,
  fileCount: number,
  importCount: number,
): Promise<void> {
  const token = await getInstallationToken(installationId);
  const marker = '<!-- nomus-scan -->';
  const status = counts.critical > 0 || counts.high > 0 ? 'FAILED' : 'PASSED';
  const statusIcon = status === 'FAILED' ? '❌' : '✅';

  let body = `${marker}\n## 🛡️ Nomus Compliance Scan — ${statusIcon} ${status}\n\n`;
  body += `| Severity | Count |\n|----------|-------|\n`;
  body += `| 🔴 Critical | ${counts.critical} |\n`;
  body += `| 🟠 High | ${counts.high} |\n`;
  body += `| 🟡 Medium | ${counts.medium} |\n`;
  body += `| 🔵 Low | ${counts.low} |\n`;
  body += `| **Total** | **${counts.total}** |\n\n`;
  body += `📁 ${fileCount} files scanned · ${importCount} AI SDK imports\n\n`;

  if (findings.length > 0) {
    body += `### Top Findings\n\n`;
    for (const f of findings.slice(0, 10)) {
      const icon = SEVERITY_ICONS[f.severity] ?? '⚪';
      body += `${icon} **${f.ruleKey}** — \`${f.file}:${f.line}\`\n`;
      body += `   ${f.humanSummary}\n\n`;
    }
    if (findings.length > 10) body += `_...and ${findings.length - 10} more._\n\n`;
  }

  body += `---\n*Nomus is a regulatory monitoring tool. It does not provide legal advice.*\n`;

  // Find existing comment to update
  const commentsResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (commentsResponse.ok) {
    const comments = await commentsResponse.json() as { id: number; body: string }[];
    const existing = comments.find((c) => c.body?.includes(marker));

    if (existing) {
      await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body }),
      });
      return;
    }
  }

  // Create new comment
  await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body }),
  });
}
