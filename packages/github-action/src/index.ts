import * as core from '@actions/core';
import * as github from '@actions/github';
import { runScan, isNomusApiError, type ScanResult } from '@nomus/scanner';
import { uploadSarif } from './sarif-upload.js';
import { postSummaryComment, postInlineComments } from './pr-comments.js';
import { createCheckRun } from './check-run.js';
import { repoRoot, toRepoPath } from './findings.js';
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
    const badgeOrg = core.getInput('badge-org');

    // GitHub context
    const { context } = github;
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const octokit = token ? github.getOctokit(token) : null;
    const repo = context.repo;
    const sha = context.sha;
    const prNumber = context.payload.pull_request?.number;
    // On pull_request events context.sha is the synthetic merge commit. Check
    // runs and review comments must target the PR head commit to show up on
    // the PR (GitHub rejects review comments on a commit outside the PR).
    const headSha: string = context.payload.pull_request?.head?.sha ?? sha;

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
    const uploaded = result.findings.length > 0
      ? await uploadFindings(result, apiKey, apiUrl, repo, prNumber, headSha)
      : true;

    // Fetch compliance score (reflects uploaded findings + existing org findings)
    const complianceScore = await fetchComplianceScore(apiKey, apiUrl, result, uploaded);
    core.setOutput('compliance-score', complianceScore.score);
    core.setOutput('compliance-label', complianceScore.label);
    core.info(`   Regulatory exposure score: ${complianceScore.score}% (${complianceScore.label})`);

    // GitHub integrations (require token)
    if (octokit) {
      // SARIF upload for Code Scanning tab
      if (uploadSarifEnabled && result.findings.length > 0) {
        const sarifPath = await uploadSarif(result, octokit, repo, sha, repoRoot(), context.ref);
        if (sarifPath) core.setOutput('sarif-file', sarifPath);
      }

      // PR comments (only on pull requests)
      if (postPrComment && prNumber) {
        await postInlineComments(result, octokit, repo, prNumber, headSha);
        const badgeSlug = badgeEmbed ? await resolveBadgeSlug(apiUrl, badgeOrg || repo.owner) : null;
        await postSummaryComment(result, octokit, repo, apiUrl, prNumber, badgeSlug, complianceScore);
      }

      // Check Run
      await createCheckRun(result, octokit, repo, headSha, complianceScore);
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
 * Fetch the compliance score from the Nomus API.
 *
 * When this run's findings were uploaded, the engine's score already counts
 * them (it deducts every open finding), so it is used as is. Only when the
 * upload failed are this scan's findings deducted locally — deducting them on
 * top of an engine score that includes them counted every finding twice.
 *
 * Severity weights: critical = -5, high = -3, medium = -1, low = 0.
 */
async function fetchComplianceScore(
  apiKey: string,
  apiUrl: string,
  result: ScanResult,
  findingsUploaded: boolean,
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
  const deductions = findingsUploaded ? 0 :
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

/**
 * Store this scan's findings in Nomus (dashboard Scans page). Paths are sent
 * repository-relative, optional fields are omitted rather than sent as null,
 * and a failure is reported with its cause. Returns whether the upload stored
 * the findings.
 */
async function uploadFindings(
  result: ScanResult,
  apiKey: string,
  apiUrl: string,
  repo: { owner: string; repo: string },
  prNumber: number | undefined,
  sha: string,
): Promise<boolean> {
  try {
    const resp = await axios.post(`${apiUrl}/api/v1/scan/findings`, {
      repo: `${repo.owner}/${repo.repo}`,
      commitSha: sha,
      ...(prNumber ? { prNumber } : {}),
      findings: result.findings.map((f) => ({
        file: toRepoPath(f.file),
        line: f.line,
        ruleKey: f.rule.ruleKey,
        severity: f.rule.severity,
        effect: f.rule.effect,
        sdk: f.sdk,
        summary: f.rule.humanSummary,
        ...(f.suggestion ? { suggestion: f.suggestion } : {}),
        ...(f.detectorSource ? { detectorSource: f.detectorSource } : {}),
        ...(f.rule.legalReference ? { legalReference: f.rule.legalReference } : {}),
      })),
    }, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
    const created = resp.data?.created ?? 0;
    const updated = resp.data?.updated ?? 0;
    core.info(`   Obligations stored in Nomus: ${created} new, ${updated} updated`);
    return true;
  } catch (err) {
    const status = (err as { response?: { status?: number; data?: unknown } }).response?.status;
    const detail = status
      ? `HTTP ${status} ${JSON.stringify((err as { response?: { data?: unknown } }).response?.data ?? '').slice(0, 300)}`
      : (err instanceof Error ? err.message : String(err));
    core.warning(`Failed to upload findings to Nomus API (non-fatal): ${detail}`);
    return false;
  }
}

/**
 * The Nomus organization slug whose public badge can be embedded, or null.
 * The badge is served only for an existing organization with a public badge;
 * embedding anything else renders a broken image in the PR comment.
 */
async function resolveBadgeSlug(apiUrl: string, slug: string): Promise<string | null> {
  try {
    await axios.get(`${apiUrl}/api/v1/badge/${encodeURIComponent(slug)}`, { timeout: 10000 });
    return slug;
  } catch {
    core.info(`   No public Nomus badge for organization "${slug}" — badge not embedded (set badge-org to your Nomus organization slug and enable its public badge)`);
    return null;
  }
}

run();
