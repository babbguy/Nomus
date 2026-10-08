import * as core from '@actions/core';
import * as github from '@actions/github';
import { runScan, isNomusApiError, type ScanResult } from '@nomus/scanner';
import { uploadSarif } from './sarif-upload.js';
import { postSummaryComment, postInlineComments } from './pr-comments.js';
import { createCheckRun } from './check-run.js';
import axios from 'axios';

async function run(): Promise<void> {
  try {
    // Read inputs
    const apiKey = core.getInput('api-key', { required: true });
    const apiUrl = core.getInput('api-url') || 'http://localhost:3100';
    const failOn = core.getInput('fail-on') || 'critical';
    const workingDir = core.getInput('working-directory') || '.';
    const uploadSarifEnabled = core.getBooleanInput('upload-sarif');
    const postPrComment = core.getBooleanInput('post-pr-comment');
    const badgeEmbed = core.getBooleanInput('badge-embed');

    // GitHub context
    const { context } = github;
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const octokit = token ? github.getOctokit(token) : null;
    const repo = context.repo;
    const sha = context.sha;
    const prNumber = context.payload.pull_request?.number;

    core.info('🛡️  Nomus Regulatory Scan');
    core.info(`   Repository: ${repo.owner}/${repo.repo}`);
    core.info(`   Commit: ${sha.slice(0, 8)}`);
    if (prNumber) core.info(`   Pull Request: #${prNumber}`);

    // Run the scan
    const result = await runScan({
      rootDir: workingDir,
      apiKey,
      apiUrl,
      failOn,
    });

    core.info(`   Files scanned: ${result.fileCount}`);
    core.info(`   AI imports found: ${result.importCount}`);
    core.info(`   Findings: ${result.counts.total} (${result.counts.critical} critical, ${result.counts.high} high)`);

    // Set outputs
    core.setOutput('total-findings', result.counts.total);
    core.setOutput('critical-count', result.counts.critical);
    core.setOutput('high-count', result.counts.high);
    core.setOutput('medium-count', result.counts.medium);
    core.setOutput('low-count', result.counts.low);
    core.setOutput('status', result.status);

    // Upload findings to Nomus API
    if (result.findings.length > 0) {
      await uploadFindings(result, apiKey, apiUrl, repo, prNumber, sha);
    }

    // Fetch compliance score (reflects uploaded findings + existing org findings)
    const complianceScore = await fetchComplianceScore(apiKey, apiUrl, result);
    core.setOutput('compliance-score', complianceScore.score);
    core.setOutput('compliance-label', complianceScore.label);
    core.info(`   Regulatory exposure score: ${complianceScore.score}% (${complianceScore.label})`);

    // GitHub integrations (require token)
    if (octokit) {
      // SARIF upload for Code Scanning tab
      if (uploadSarifEnabled && result.findings.length > 0) {
        const sarifPath = await uploadSarif(result, octokit, repo, sha, workingDir, context.ref);
        if (sarifPath) core.setOutput('sarif-file', sarifPath);
      }

      // PR comments (only on pull requests)
      if (postPrComment && prNumber) {
        await postInlineComments(result, octokit, repo, prNumber, sha);
        await postSummaryComment(result, octokit, repo, apiUrl, prNumber, badgeEmbed, complianceScore);
      }

      // Check Run
      await createCheckRun(result, octokit, repo, sha, complianceScore);
    } else {
      core.warning('No github-token provided — skipping PR comments, SARIF upload, and check run.');
    }

    // Fail if threshold exceeded
    if (result.status === 'fail') {
      core.setFailed(
        `Nomus found ${result.counts.critical} critical and ${result.counts.high} high severity findings. ` +
        `Threshold: --fail-on=${failOn}`,
      );
    }
  } catch (error) {
    // Fail CLOSED on Nomus API failure: the scan could not determine
    // compliance, so the check must fail — never report green on an outage.
    if (isNomusApiError(error)) {
      core.setOutput('status', 'unknown');
      core.setFailed(
        `Nomus API unreachable — compliance status UNKNOWN; failing closed. ${error.message}`,
      );
      return;
    }
    core.setFailed(`Nomus scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type { ComplianceScoreResult } from './types.js';
import type { ComplianceScoreResult } from './types.js';

/**
 * Fetch the compliance score from the Nomus API, then apply local scan
 * finding deductions to ensure the reported score reflects ALL known issues
 * (same logic as the VS Code extension).
 *
 * Severity weights: critical = -5, high = -3, medium = -1, low = 0.
 */
async function fetchComplianceScore(
  apiKey: string,
  apiUrl: string,
  result: ScanResult,
): Promise<ComplianceScoreResult> {
  let backendScore = 100;

  try {
    const resp = await axios.get(`${apiUrl}/api/v1/compliance/score`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    backendScore = resp.data?.overallScore ?? 100;
  } catch {
    core.warning('Could not fetch compliance score from Nomus API — computing from scan findings only');
  }

  // Apply local finding deductions (same weights as engine + VS Code extension)
  const deductions =
    result.counts.critical * 5 +
    result.counts.high * 3 +
    result.counts.medium * 1;

  const score = Math.max(0, Math.min(100, backendScore - deductions));
  const label = score >= 90 ? 'Excellent'
    : score >= 80 ? 'Good'
    : score >= 60 ? 'Fair'
    : score >= 40 ? 'Needs Work'
    : 'Critical';

  return { score, label };
}

async function uploadFindings(
  result: ScanResult,
  apiKey: string,
  apiUrl: string,
  repo: { owner: string; repo: string },
  prNumber: number | undefined,
  sha: string,
): Promise<void> {
  try {
    await axios.post(`${apiUrl}/api/v1/scan/findings`, {
      findings: result.findings.map((f) => ({
        repo: `${repo.owner}/${repo.repo}`,
        prNumber: prNumber ?? null,
        commitSha: sha,
        file: f.file,
        line: f.line,
        ruleKey: f.rule.ruleKey,
        severity: f.rule.severity,
        effect: f.rule.effect,
        sdk: f.sdk,
        summary: f.rule.humanSummary,
        suggestion: f.suggestion ?? null,
        detectorSource: f.detectorSource ?? null,
        legalReference: f.rule.legalReference ?? null,
      })),
    }, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
    core.info('   Obligations uploaded to Nomus dashboard');
  } catch {
    core.warning('Failed to upload findings to Nomus API (non-fatal)');
  }
}

run();
