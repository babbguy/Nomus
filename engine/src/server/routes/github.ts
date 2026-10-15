import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runScanFromContents, type Finding } from '@nomus/scanner';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { githubAppInstallations, webhookEvents, scanFindings } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { invalidateComplianceScore } from '../../core/compliance-score-cache.js';
import { clearInstallationToken } from '../../github/token-manager.js';
import { fetchRepoSourceFiles } from '../../github/scanner-runner.js';
import { createCheckRun, postPrSummary } from '../../github/result-poster.js';
import { applyCpgPullRequest } from '../../cpg/cases/github-hook.js';

/** Minimal shape of a GitHub webhook payload (only fields we access). */
interface GitHubWebhookPayload {
  installation?: { id: number };
  action?: string;
  repository?: { full_name: string; default_branch?: string };
  check_suite?: { head_sha: string; pull_requests?: Array<{ number: number }> };
  sender?: { login: string };
  [key: string]: unknown;
}

export const githubRoutes = new Hono<AppEnv>();

/**
 * GitHub App webhook receiver.
 * Validates X-Hub-Signature-256, routes to handlers, returns 200 immediately.
 */
githubRoutes.post('/webhook', async (c) => {
  const config = env();
  const secret = config.NOMUS_GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    return c.json({ error: 'GitHub webhook not configured' }, 503);
  }

  // Validate signature
  const signature = c.req.header('x-hub-signature-256');
  const rawBody = await c.req.text();

  if (!signature || !verifySignature(rawBody, signature, secret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const event = c.req.header('x-github-event') ?? 'unknown';
  const deliveryId = c.req.header('x-github-delivery') ?? randomUUID();
  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  const installationId = payload.installation?.id;

  const db = getDb();

  // Idempotency: GitHub redelivers webhooks on retries — bail if we've already
  // seen this delivery ID. Otherwise we'd run a duplicate scan and double-write
  // findings.
  const existing = db.select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(eq(webhookEvents.deliveryId, deliveryId))
    .get();
  if (existing) {
    logger.info({ deliveryId, event }, 'GitHub webhook already processed — skipping (idempotent)');
    return c.json({ received: true, deliveryId, deduplicated: true });
  }

  // Store webhook event
  const eventId = randomUUID();
  const now = new Date().toISOString();

  db.insert(webhookEvents).values({
    id: eventId,
    installationId: installationId ?? 0,
    event,
    action: payload.action ?? null,
    deliveryId,
    repo: payload.repository?.full_name ?? null,
    payload: rawBody,
    status: 'received',
    receivedAt: now,
  }).run();

  // Return 200 immediately, process async
  // (In production, use a proper job queue — for now, fire-and-forget)
  processWebhook(eventId, event, payload, installationId).catch((err) => {
    logger.error({ eventId, event, error: (err as Error).message }, 'Webhook processing failed');
    db.update(webhookEvents)
      .set({ status: 'failed', errorMessage: (err as Error).message, processedAt: new Date().toISOString() })
      .where(eq(webhookEvents.id, eventId))
      .run();
  });

  return c.json({ received: true, deliveryId });
});

function verifySignature(payload: string, signature: string, secret: string): boolean {
  // Explicit length check before timingSafeEqual (which throws on length
  // mismatch), and explicit utf-8 encoding so the hex-string comparison is
  // unambiguous.
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const expBuf = Buffer.from(expected, 'utf-8');
  const sigBuf = Buffer.from(signature, 'utf-8');
  if (expBuf.length !== sigBuf.length) return false;
  try {
    return timingSafeEqual(expBuf, sigBuf);
  } catch {
    return false;
  }
}

async function processWebhook(
  eventId: string,
  event: string,
  payload: GitHubWebhookPayload,
  installationId: number | undefined,
): Promise<void> {
  const db = getDb();
  db.update(webhookEvents)
    .set({ status: 'processing' })
    .where(eq(webhookEvents.id, eventId))
    .run();

  switch (event) {
    case 'installation':
      await handleInstallation(payload);
      break;
    case 'pull_request': {
      // Review cases (CPG) first: attaching or closing a case must not wait for, or depend on, the scan.
      let cpgFailure: unknown = null;
      if (installationId) {
        try {
          const outcome = applyCpgPullRequest(db, installationId, payload);
          if (outcome !== 'ignored') logger.info({ eventId, action: payload.action, outcome }, 'Review case updated from pull request');
        } catch (err) {
          logger.error({ eventId, action: payload.action, error: (err as Error).message }, 'Review case update from pull request failed');
          cpgFailure = err;
        }
      }
      if (installationId && (payload.action === 'opened' || payload.action === 'synchronize')) {
        await handlePullRequest(installationId, payload);
      }
      if (cpgFailure) throw cpgFailure;
      break;
    }
    case 'push':
      if (installationId) {
        await handlePush(installationId, payload);
      }
      break;
    default:
      logger.debug({ event, action: payload.action }, 'Unhandled webhook event');
  }

  db.update(webhookEvents)
    .set({ status: 'completed', processedAt: new Date().toISOString() })
    .where(eq(webhookEvents.id, eventId))
    .run();
}

async function handleInstallation(payload: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const installation = payload.installation as Record<string, unknown>;
  const account = installation.account as Record<string, unknown>;
  const now = new Date().toISOString();

  if (payload.action === 'created') {
    db.insert(githubAppInstallations).values({
      id: randomUUID(),
      installationId: installation.id as number,
      accountLogin: account.login as string,
      accountType: account.type as 'Organization' | 'User',
      repositorySelection: (installation.repository_selection as 'all' | 'selected') ?? 'all',
      selectedRepos: JSON.stringify(payload.repositories ?? []),
      permissions: JSON.stringify(installation.permissions ?? {}),
      isActive: true,
      installedAt: now,
      updatedAt: now,
    }).run();
    logger.info({ account: account.login, installationId: installation.id }, 'GitHub App installed');
  } else if (payload.action === 'deleted') {
    const instId = installation.id as number;
    db.update(githubAppInstallations)
      .set({ isActive: false, updatedAt: now })
      .where(eq(githubAppInstallations.installationId, instId))
      .run();
    clearInstallationToken(instId);
    logger.info({ account: account.login, installationId: instId }, 'GitHub App uninstalled');
  }
}

/**
 * Map scanner Finding[] to the FindingSummary shape expected by result-poster.
 * Carries detectorSource through so the dashboard can render the right badge.
 */
function mapFindingsToSummaries(findings: Finding[]) {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    sdk: f.sdk,
    ruleKey: f.rule.ruleKey,
    severity: f.rule.severity,
    effect: f.rule.effect,
    humanSummary: f.rule.humanSummary,
    legalReference: f.rule.legalReference,
    detectorSource: f.detectorSource,
    suggestion: f.suggestion,
  }));
}

/**
 * Persist scanner findings to the scan_findings table so the dashboard, audit
 * exports, and history queries can see GitHub App scan results. Without this
 * the entire detector → badge chain breaks for every webhook scan.
 *
 * Org resolution: looks up the orgId via the GitHub App installation. If no
 * org is linked yet, findings are dropped (logged) — a future installation
 * association job can backfill.
 */
export async function persistScanFindings(
  installationId: number,
  repoFullName: string,
  prNumber: number | null,
  commitSha: string,
  findings: Finding[],
): Promise<void> {
  if (findings.length === 0) return;

  const db = getDb();
  const installation = db.select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .get();

  if (!installation?.orgId) {
    logger.warn(
      { installationId, repoFullName, count: findings.length },
      'Cannot persist scan findings — installation has no orgId',
    );
    return;
  }

  const now = new Date().toISOString();
  // Rows are inserted one at a time (not in a transaction), so a failure part
  // way through still leaves committed findings: invalidate whatever happens.
  try {
  for (const f of findings) {
    db.insert(scanFindings).values({
      id: randomUUID(),
      orgId: installation.orgId,
      repo: repoFullName,
      prNumber,
      commitSha,
      filePath: f.file,
      lineNumber: f.line,
      ruleId: null,
      ruleKey: f.rule.ruleKey,
      severity: f.rule.severity as 'critical' | 'high' | 'medium' | 'low',
      effect: f.rule.effect,
      capabilityDetected: f.sdk,
      humanSummary: f.rule.humanSummary,
      suggestion: f.suggestion ?? null,
      detectorSource: f.detectorSource ?? null,
      legalReference: f.rule.legalReference ?? null,
      status: 'open',
      scannedAt: now,
    }).run();
  }
  } finally {
    invalidateComplianceScore(installation.orgId);
  }

  logger.info(
    { installationId, repoFullName, prNumber, count: findings.length },
    'Persisted GitHub App scan findings to dashboard',
  );
}

async function scanFiles(files: Map<string, string>) {
  const config = env();
  // Prefer an explicit internal URL (deployment-controlled); fall back to
  // the loopback IP rather than 'localhost' for deterministic resolution
  // on dual-stack hosts.
  const apiUrl = config.NOMUS_INTERNAL_API_URL ?? `http://127.0.0.1:${config.NOMUS_PORT}`;
  const apiKey = config.NOMUS_ADMIN_BOOTSTRAP_KEY;

  return runScanFromContents(files, {
    rootDir: '.',
    apiKey,
    apiUrl,
    config: { jurisdictions: ['EU', 'US-FED', 'UK'] },
  });
}

async function handlePullRequest(installationId: number, payload: Record<string, unknown>): Promise<void> {
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const owner = (repo.owner as Record<string, unknown>).login as string;
  const repoName = repo.name as string;
  const sha = pr.head ? (pr.head as Record<string, unknown>).sha as string : '';
  const prNumber = pr.number as number;

  logger.info({ owner, repo: repoName, pr: prNumber, sha: sha.slice(0, 8) }, 'Processing PR scan');

  // Fetch source files
  const files = await fetchRepoSourceFiles(installationId, owner, repoName, sha);

  if (files.size === 0) {
    logger.info({ owner, repo: repoName }, 'No source files found — skipping scan');
    return;
  }

  // Run scan using @nomus/scanner
  const result = await scanFiles(files);
  const findings = mapFindingsToSummaries(result.findings);

  // Persist to scan_findings so the dashboard can render history + badges
  await persistScanFindings(installationId, `${owner}/${repoName}`, prNumber, sha, result.findings);

  // Post results
  await createCheckRun(installationId, owner, repoName, sha, findings, result.counts, result.fileCount, result.importCount);

  if (prNumber) {
    await postPrSummary(installationId, owner, repoName, prNumber, findings, result.counts, result.fileCount, result.importCount);
  }

  logger.info({ owner, repo: repoName, pr: prNumber, findings: findings.length }, 'PR scan complete');
}

async function handlePush(installationId: number, payload: Record<string, unknown>): Promise<void> {
  const repo = payload.repository as Record<string, unknown>;
  const owner = (repo.owner as Record<string, unknown>).login as string;
  const repoName = repo.name as string;
  const sha = payload.after as string;
  const ref = payload.ref as string;
  const defaultBranch = repo.default_branch as string;

  // Only scan pushes to default branch
  if (ref !== `refs/heads/${defaultBranch}`) return;

  logger.info({ owner, repo: repoName, sha: sha.slice(0, 8) }, 'Processing push scan on default branch');

  const files = await fetchRepoSourceFiles(installationId, owner, repoName, sha);

  if (files.size === 0) {
    logger.info({ owner, repo: repoName }, 'No source files found — skipping scan');
    return;
  }

  // Run scan using @nomus/scanner
  const result = await scanFiles(files);
  const findings = mapFindingsToSummaries(result.findings);

  // Persist to scan_findings so the dashboard can render history + badges
  await persistScanFindings(installationId, `${owner}/${repoName}`, null, sha, result.findings);

  await createCheckRun(installationId, owner, repoName, sha, findings, result.counts, result.fileCount, result.importCount);

  logger.info({ owner, repo: repoName, findings: findings.length }, 'Push scan complete');
}
