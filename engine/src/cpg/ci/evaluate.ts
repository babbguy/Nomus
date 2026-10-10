import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  canonicalJson, ciRunPayloadSchema, CI_RUN_KIND, normalizeSnippet, parseFingerprint, sha256Hex,
  type CiEvaluateRequest, type CiEvaluateResponse, type FindingResolution,
} from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgCiRuns } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { getCorporateBundle } from '../bundle/build.js';
import { addCaseEvent, addRevision, attachPullRequest, findingsDigest, findOpenCase, findOrCreateCase, getCase, type CaseRow } from '../cases/service.js';
import { caseUrl, findingsStatus } from '../cases/serialize.js';
import { CpgError } from '../errors.js';
import { cpgSign } from '../policies/signing.js';

/**
 * CI evaluate (design spec §11.2, E61): the server, never the client, decides
 * whether a CI scan passes. Each uploaded finding must name a policy version
 * of the org's current bundle, and a blocking-tier finding must carry the
 * snippet its fingerprint hashes. Every finding is then resolved (§7.4) with
 * the server's tier and enforcement date; the verdict fails iff any finding
 * blocks.
 *
 * In one transaction: a failing scan finds or creates the branch's case (a
 * passing one uses the open case, if any), attaches the PR and adds a revision
 * when the findings changed, so a branch whose blocking findings were fixed
 * moves its case on. The run is stored with its signed verdict and recorded
 * on the case and in the audit chain. A refused request writes nothing.
 */

type ResolvedFinding = CiEvaluateResponse['findings'][number];
type Counts = CiEvaluateResponse['counts'];

export interface CiCaller {
  orgId: string;
  apiKeyId: string;
}

export function evaluateCi(db: Db, caller: CiCaller, req: CiEvaluateRequest, origin: string): CiEvaluateResponse {
  const { orgId } = caller;
  const { bundle } = getCorporateBundle(db, orgId);
  if (req.bundleHash !== bundle.bundleHash) {
    throw new CpgError(409, 'bundle_stale', 'The scan used an older policy bundle; fetch the bundle and rescan', { bundleHash: bundle.bundleHash });
  }
  if (req.scannedFileCount === 0 && db.select({ id: cpgCiRuns.id }).from(cpgCiRuns)
    .where(and(eq(cpgCiRuns.orgId, orgId), eq(cpgCiRuns.repo, req.repo), gt(cpgCiRuns.scannedFileCount, 0))).get()) {
    throw new CpgError(422, 'suspicious_empty_scan', 'The scan checked no files, but earlier scans of this repository did (§11.7)');
  }
  const tiers = new Map(bundle.policies.map((p) => [`${p.policyKey}:${p.version}`, p.tier]));
  const located = req.findings.map((f) => {
    const parsed = parseFingerprint(f.fingerprint);
    const refuse = (code: string, message: string) => new CpgError(422, code, message, { fingerprint: f.fingerprint });
    if (parsed?.policyKey !== f.policyKey || parsed.policyVersion !== f.policyVersion) throw refuse('fingerprint_mismatch', 'A fingerprint does not name its policy key and version');
    const tier = tiers.get(`${f.policyKey}:${f.policyVersion}`);
    if (!tier) throw refuse('unknown_fingerprint', 'A fingerprint names a policy version that is not in the current bundle');
    if (tier !== 'advisory' && f.snippet === undefined) throw refuse('snippet_required', 'A finding of a blocking tier must carry its snippet');
    if (f.snippet !== undefined && sha256Hex(normalizeSnippet(f.snippet)) !== parsed.snippetHash) throw refuse('fingerprint_mismatch', 'The snippet does not hash to its fingerprint');
    return { ...f, repo: req.repo, branch: req.branch, snippetHash: parsed.snippetHash };
  });

  const actor = `api_key:${caller.apiKeyId}`;
  return rawSqlite(db).transaction((): CiEvaluateResponse => {
    const now = new Date().toISOString();
    const resolve = () => (located.length === 0 ? [] : locate(findingsStatus(db, orgId, req, located.map((f) => f.fingerprint), now, located), located));
    let findings = resolve();
    const failing = findings.some((f) => f.blocking);
    let kase: CaseRow | undefined = failing
      ? findOrCreateCase(db, { orgId, repo: req.repo, branch: req.branch }, actor).case
      : findOpenCase(db, { orgId, repo: req.repo, branch: req.branch });
    let revision: number | null = null;
    if (kase) {
      if (req.prNumber !== null) attachPullRequest(db, orgId, kase.id, req.prNumber, actor);
      revision = addRevision(db, orgId, kase.id, { source: 'ci', headSha: req.headSha, bundleHash: req.bundleHash, findings: req.findings }, actor).revision.revision;
      kase = getCase(db, orgId, kase.id);
      // The revision stored the snippets, which a standing exception's snippet condition may need.
      findings = resolve();
    }

    const counts = countsOf(findings);
    const verdict = counts.blocking > 0 ? 'fail' : 'pass';
    const runId = randomUUID();
    const signedPayload = canonicalJson(ciRunPayloadSchema.parse({
      kind: CI_RUN_KIND, runId, orgId, repo: req.repo, branch: req.branch, prNumber: req.prNumber, headSha: req.headSha,
      bundleHash: req.bundleHash, verdict, counts, findingsDigest: findingsDigest(located.map((f) => f.fingerprint)), evaluatedAt: now,
    }));
    const signature = cpgSign(signedPayload);
    db.insert(cpgCiRuns).values({
      id: runId, orgId, apiKeyId: caller.apiKeyId, repo: req.repo, branch: req.branch, prNumber: req.prNumber, headSha: req.headSha,
      eventName: req.eventName, bundleHash: req.bundleHash, scannedFileCount: req.scannedFileCount, verdict,
      blockingCount: counts.blocking, pendingCount: counts.pending, rejectedCount: counts.rejected,
      approvedCount: counts.approved, exceptedCount: counts.excepted, advisoryCount: counts.advisory,
      caseId: kase?.id ?? null,
      findings: JSON.stringify(findings.map((f) => ({
        fingerprint: f.fingerprint, filePath: f.filePath, startLine: f.startLine, endLine: f.endLine, status: f.status,
        decisionId: f.decisionId, exceptionDecisionId: f.exceptionDecisionId,
      }))),
      evaluatedAt: now, signedPayload, signature,
    }).run();
    if (kase) addCaseEvent(db, kase, 'ci_result', actor, { runId, verdict, headSha: req.headSha, revision }, now);
    appendAuditEvent(db, {
      orgId, actor, action: 'ci.evaluated', targetType: 'ci_run', targetId: runId,
      payload: { repo: req.repo, branch: req.branch, prNumber: req.prNumber, headSha: req.headSha, verdict, counts, caseId: kase?.id ?? null },
    });
    return {
      runId, verdict, reasons: findings.flatMap((f, i) => (f.blocking ? [`${located[i].policyKey} @ ${f.filePath}:${f.startLine}: ${f.status}`] : [])),
      caseId: kase?.id ?? null, caseRef: kase?.ref ?? null, caseUrl: kase ? caseUrl(origin, kase.id) : null,
      findings, counts, evaluatedAt: now, signedPayload, signature,
    };
  }).immediate();
}

/** One resolved finding per uploaded occurrence, in upload order. */
function locate(resolutions: FindingResolution[], located: ReadonlyArray<{ fingerprint: string; filePath: string; startLine: number; endLine: number }>): ResolvedFinding[] {
  const byFingerprint = new Map(resolutions.map((r) => [r.fingerprint, r]));
  return located.map((f) => ({ ...byFingerprint.get(f.fingerprint)!, filePath: f.filePath, startLine: f.startLine, endLine: f.endLine }));
}

function countsOf(findings: readonly ResolvedFinding[]): Counts {
  const is = (...statuses: FindingResolution['status'][]) => findings.filter((f) => statuses.includes(f.status)).length;
  return {
    blocking: findings.filter((f) => f.blocking).length, pending: is('pending'), rejected: is('rejected'),
    approved: is('approved'), excepted: is('excepted'), advisory: is('advisory', 'grace'),
  };
}
