import * as core from '@actions/core';
import { relative } from 'node:path';
import type { ScanResult } from '@nomus/scanner';
import type { ComplianceScoreResult } from './types.js';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

/**
 * Create a GitHub Check Run with annotations for each finding.
 */
export async function createCheckRun(
  result: ScanResult,
  octokit: Octokit,
  repo: { owner: string; repo: string },
  sha: string,
  complianceScore?: ComplianceScoreResult,
): Promise<void> {
  try {
    const { counts, status, findings } = result;

    const conclusion = status === 'fail' ? 'failure' : counts.total > 0 ? 'neutral' : 'success';

    const title = status === 'fail'
      ? `${counts.critical} critical, ${counts.high} high — regulatory check failed`
      : counts.total > 0
        ? `${counts.total} obligations identified — review recommended`
        : 'No applicable regulatory obligations identified';

    const scoreRow = complianceScore
      ? `| **Regulatory Score** | **${complianceScore.score}% (${complianceScore.label})** |`
      : '';

    const summary = [
      `## Nomus Regulatory Scan Results`,
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      ...(scoreRow ? [scoreRow] : []),
      `| Files scanned | ${result.fileCount} |`,
      `| AI SDK imports | ${result.importCount} |`,
      `| Critical findings | ${counts.critical} |`,
      `| High findings | ${counts.high} |`,
      `| Medium findings | ${counts.medium} |`,
      `| Low findings | ${counts.low} |`,
      `| **Total findings** | **${counts.total}** |`,
      '',
      '*Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.*',
    ].join('\n');

    // GitHub limits annotations to 50 per API call
    const annotations = findings.slice(0, 50).map((f) => {
      const relPath = relative(process.cwd(), f.file).replace(/\\/g, '/');
      return {
        path: relPath,
        start_line: f.line,
        end_line: f.line,
        annotation_level: mapSeverityToAnnotation(f.rule.severity),
        title: `${f.rule.severity.toUpperCase()}: ${f.rule.ruleKey}`,
        message: `${f.rule.humanSummary}\n\n${f.rule.legalReference}`,
        raw_details: f.suggestion ?? undefined,
      };
    });

    await octokit.rest.checks.create({
      ...repo,
      head_sha: sha,
      name: 'Nomus Regulatory Scan',
      status: 'completed',
      conclusion,
      output: {
        title,
        summary,
        annotations,
      },
    });

    core.info(`   Check run created: ${conclusion}`);
  } catch (err) {
    core.warning(`Failed to create check run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function mapSeverityToAnnotation(severity: string): 'failure' | 'warning' | 'notice' {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'failure';
    case 'medium':
      return 'warning';
    default:
      return 'notice';
  }
}
