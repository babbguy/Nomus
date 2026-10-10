// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import * as github from '@actions/github';
import { runCorporateScanOnDisk, type CorporateFinding, type CorporateScanOutcome } from '@nomus/scanner';
import {
  bundleFailureOf, canonicalRepo, ciEvaluateRequestSchema, CorporateBundleError, fetchCorporateBundle, prClosedRequestSchema,
  prClosedResponseSchema, verifyCiVerdict, type CiEvaluateResponse, type CorporateBundle,
} from '@nomus/scanner/corporate';
import { formatCorporateSarif, CORPORATE_SARIF_CATEGORY } from '@nomus/scanner/sarif';
import { createCorporateCheckRun, createFailClosedCheckRun } from './cpg-check-run.js';
import { postCorporateComment } from './cpg-comment.js';
import { repoRoot } from './findings.js';
import { uploadSarifDocument } from './sarif-upload.js';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * The corporate policy gate (design spec §11). VS Code advises, CI enforces:
 * the job fails unless the Nomus server's signed verdict is `pass`.
 *
 * Fail closed: no answer, an unexpected status, a response that does not
 * verify, a scan error or a refused bypass all fail the job with
 * `corporate-status=unknown`. No path turns an error into `pass`.
 */

export type CorporateStatus = 'pass' | 'fail' | 'unknown' | 'disabled' | 'unavailable' | 'closed';

export interface CorporateGateOptions {
  apiUrl: string;
  apiKey: string;
  /** The raw `corporate-gate` input: '' or 'true' runs the gate; 'false' is refused while the org enforces it. */
  gateInput: string;
  uploadSarif: boolean;
  postPrComment: boolean;
  octokit: Octokit | null;
  /** Files this run wrote into the checkout (the regulatory SARIF): never scanned as code. */
  generated?: readonly string[];
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: Date;
}

/** The scan identity the verdict must be signed for (§11.1 step 4). */
export interface GateIdentity {
  repo: string;
  branch: string;
  prNumber: number | null;
  headSha: string;
}

const EVALUATE_TIMEOUT_MS = 30_000;
const FAILED_CLOSED = 'corporate policy status UNKNOWN; failing closed.';

class GateRefused extends Error {}

function setStatus(status: CorporateStatus, blocking = 0, caseUrl = ''): void {
  core.setOutput('corporate-status', status);
  core.setOutput('corporate-blocking', blocking);
  core.setOutput('corporate-case-url', caseUrl);
}

/** The scan identity from the workflow context: the PR head, and `owner/repo:ref` for a fork. */
export function gateIdentity(): GateIdentity {
  const { context } = github;
  const pr = context.payload.pull_request;
  const repo = canonicalRepo(`${context.repo.owner}/${context.repo.repo}`);
  const headFull = String(pr?.head?.repo?.full_name ?? '').toLowerCase();
  const baseFull = String(pr?.base?.repo?.full_name ?? '').toLowerCase();
  const branch = pr ? (headFull && baseFull && headFull !== baseFull ? `${headFull}:${pr.head.ref}` : pr.head?.ref) : process.env.GITHUB_REF_NAME;
  if (!repo || typeof branch !== 'string' || !branch) throw new Error('the repository or branch of this workflow run could not be determined');
  return { repo, branch, prNumber: pr?.number ?? null, headSha: pr?.head?.sha ?? context.sha };
}

/** POST JSON to the engine; no answer is `unreachable`, a body that is not JSON is `invalid`. */
async function post(o: CorporateGateOptions, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(`${o.apiUrl.replace(/\/+$/, '')}/api/v1/cpg${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EVALUATE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CorporateBundleError({ kind: 'unreachable' }, `Could not reach POST /cpg${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new CorporateBundleError({ kind: 'invalid' }, `POST /cpg${path} answered ${res.status} without JSON`, err);
  }
  return { status: res.status, json };
}

function httpError(path: string, status: number, json: unknown): CorporateBundleError {
  const code = (json as { code?: unknown } | null)?.code;
  return new CorporateBundleError({ kind: 'http', status }, `POST /cpg${path} answered ${status}${typeof code === 'string' ? ` ${code}` : ''}`, json);
}

async function fetchEnabledBundle(o: CorporateGateOptions) {
  return fetchCorporateBundle({ apiUrl: o.apiUrl, apiKey: o.apiKey, fetchImpl: o.fetchImpl });
}

/** Every finding with its snippet: blocking tiers require it, and a case revision stores them all. */
function evaluateRequest(id: GateIdentity, bundle: CorporateBundle, scan: CorporateScanOutcome) {
  return ciEvaluateRequestSchema.parse({
    ...id,
    eventName: github.context.eventName.slice(0, 50),
    bundleHash: bundle.bundleHash,
    scannedFileCount: scan.summary.scannedFileCount,
    findings: scan.findings.map((f) => ({
      fingerprint: f.fingerprint, policyKey: f.policyKey, policyVersion: f.policyVersion, filePath: f.filePath,
      startLine: f.startLine, endLine: f.endLine, language: f.language, snippet: f.snippet,
    })),
  });
}

/** Scan the whole checkout (D15: `working-directory` never narrows it) and get the signed verdict. */
async function evaluate(o: CorporateGateOptions, id: GateIdentity, first: { bundle: CorporateBundle; publicKeySpki: string }) {
  let { bundle, publicKeySpki } = first;
  for (let attempt = 1; ; attempt++) {
    const scan = await runCorporateScanOnDisk(repoRoot(), bundle, { now: o.now, generated: o.generated });
    core.info(`   Corporate policies: ${bundle.policies.length}, files checked: ${scan.summary.scannedFileCount}, findings: ${scan.findings.length}`);
    const res = await post(o, '/ci/evaluate', evaluateRequest(id, bundle, scan));
    if (res.status === 200) {
      const verdict = verifyCiVerdict(res.json, publicKeySpki, { orgId: bundle.orgId, ...id, bundleHash: bundle.bundleHash });
      return { bundle, scan, verdict };
    }
    // The policies changed since the bundle was fetched: refetch, rescan and retry once.
    if (res.status === 409 && (res.json as { code?: unknown } | null)?.code === 'bundle_stale' && attempt === 1) {
      core.info('   The corporate policy bundle changed during the run; fetching it again and rescanning');
      const again = await fetchEnabledBundle(o);
      if (!again.available || !again.bundle.enabled) throw new CorporateBundleError({ kind: 'invalid' }, 'The corporate policy bundle disappeared during the run');
      ({ bundle, publicKeySpki } = again);
      continue;
    }
    throw httpError('/ci/evaluate', res.status, res.json);
  }
}

async function closePullRequest(o: CorporateGateOptions, id: GateIdentity): Promise<void> {
  const pr = github.context.payload.pull_request!;
  const merged = pr.merged === true;
  const mergeSha = merged && typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : undefined;
  const res = await post(o, '/ci/pr-closed', prClosedRequestSchema.parse({ repo: id.repo, branch: id.branch, prNumber: id.prNumber, merged, ...(mergeSha ? { mergeSha } : {}) }));
  if (res.status !== 200) throw httpError('/ci/pr-closed', res.status, res.json);
  const closed = prClosedResponseSchema.safeParse(res.json);
  if (!closed.success) throw new CorporateBundleError({ kind: 'invalid' }, 'The pr-closed response does not match the contract', closed.error.issues);
  core.info(`   Pull request ${merged ? 'merged' : 'closed'}: ${closed.data.closed ? `review case ${closed.data.caseId} closed` : 'no open review case to close'}`);
  setStatus('closed');
}

/** Code Scanning, the check run and the PR comment. Best effort: the job status is the gate. */
async function report(o: CorporateGateOptions, id: GateIdentity, findings: readonly CorporateFinding[], bundle: CorporateBundle, v: CiEvaluateResponse) {
  if (!o.octokit) {
    core.warning('No github-token provided: skipping the corporate SARIF upload, check run and PR comment.');
    return;
  }
  const { context } = github;
  if (o.uploadSarif) {
    const located = new Map(v.findings.map((r) => [`${r.fingerprint}@${r.filePath}:${r.startLine}`, r]));
    await uploadSarifDocument(o.octokit, context.repo, context.sha, context.ref, {
      sarif: () => formatCorporateSarif(findings, { resolutionOf: (f) => located.get(`${f.fingerprint}@${f.filePath}:${f.startLine}`), caseUrl: v.caseUrl }),
      category: CORPORATE_SARIF_CATEGORY, file: 'nomus-corporate.sarif', toolName: 'Nomus Corporate Policy',
    });
  }
  const titles = new Map(bundle.policies.map((p) => [p.policyKey, p.title]));
  await createCorporateCheckRun(o.octokit, context.repo, id.headSha, v, bundle.bundleHash, titles);
  if (o.postPrComment && id.prNumber && (v.findings.length > 0 || v.caseId)) {
    await postCorporateComment(o.octokit, context.repo, id.prNumber, v);
  }
}

/** Why the gate failed closed, as the check run title and the job error. */
function failClosedReason(err: unknown): string {
  if (err instanceof GateRefused) return 'Corporate policy gate cannot be disabled';
  if (!(err instanceof CorporateBundleError)) return 'Corporate policy scan failed';
  return bundleFailureOf(err).kind === 'invalid' ? 'Nomus response could not be verified' : 'Nomus unreachable';
}

/** Run the gate after the regulatory flow. Never throws: every failure fails the job closed. */
export async function runCorporateGate(o: CorporateGateOptions): Promise<void> {
  core.info('🛡️  Nomus Corporate Policy Gate');
  let id: GateIdentity | null = null;
  try {
    const gateInput = o.gateInput.trim().toLowerCase() || 'true';
    if (gateInput !== 'true' && gateInput !== 'false') throw new GateRefused(`corporate-gate must be true or false (got "${o.gateInput}")`);
    if (gateInput === 'false') core.info('Corporate policy gate: disabled by workflow input');

    const fetched = await fetchEnabledBundle(o);
    if (!fetched.available) {
      core.info('   This Nomus server does not support corporate policies; the corporate policy gate did not run');
      setStatus('unavailable');
      return;
    }
    if (!fetched.bundle.enabled) {
      core.info('   Corporate policies are not enabled for this organization; the corporate policy gate did not run');
      setStatus('disabled');
      return;
    }
    if (gateInput === 'false') {
      throw new GateRefused('the organization enforces corporate policies; the gate cannot be disabled from the workflow');
    }

    id = gateIdentity();
    if (github.context.payload.action === 'closed' && github.context.payload.pull_request) {
      await closePullRequest(o, id);
      return;
    }

    const { bundle, scan, verdict: v } = await evaluate(o, id, fetched);
    setStatus(v.verdict, v.counts.blocking, v.caseUrl ?? '');
    core.info(`   Corporate verdict: ${v.verdict} (${v.counts.blocking} blocking, ${v.counts.approved} approved, ${v.counts.excepted} excepted)`);
    await report(o, id, scan.findings, bundle, v);
    if (v.verdict === 'fail') {
      for (const reason of v.reasons) core.info(`   Blocking: ${reason}`);
      core.setFailed(
        `Corporate policy gate failed: ${v.counts.blocking} blocking finding(s) without a valid decision (${v.counts.rejected} rejected, ${v.counts.blocking - v.counts.rejected} need review).`
        + (v.caseUrl ? ` Review case: ${v.caseUrl}` : ''),
      );
    }
  } catch (err) {
    const reason = failClosedReason(err);
    setStatus('unknown');
    if (o.octokit) {
      const sha = id?.headSha ?? github.context.payload.pull_request?.head?.sha ?? github.context.sha;
      await createFailClosedCheckRun(o.octokit, github.context.repo, sha, `${reason}: failing closed`);
    }
    core.setFailed(`${reason}: ${FAILED_CLOSED} ${err instanceof Error ? err.message : String(err)}`);
  }
}
