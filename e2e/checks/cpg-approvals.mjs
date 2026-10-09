// CPG Phase 5a: approvals, standing exceptions and revocation, design spec
// §16.5 release-gate checks 1 to 10, over HTTP against the built engine, and
// check 11 (the decision pages in a browser, via cpg-browser.mjs). Then the
// Phase 6 engine: CI evaluate on the same branch, then pr-closed (the
// action's own rows come with the action).
//
// dev@ requests review on a new branch for the corporate findings the real
// CLI reports on the policy-repo fixture. ai-reviewer@ (AI Review Board) and
// legal-reviewer@ (Legal Board) then propose and vote; exceptions@ proposes
// and revokes a standing exception. Decision signatures are verified offline
// against the published instance key. Runs after every other cpg-* area,
// because decisions bind (repo, fingerprint) across branches. Governance is
// switched on for this area and off again at the end, and the grants given to
// dev@ (self-approval check) and legal-reviewer@ (exception.approve) are revoked.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/procs.mjs';
import { preparePolicyRepo } from './cpg-scanner.mjs';
import { uploads } from './cpg-cases.mjs';
import { approvalPageChecks } from './cpg-browser.mjs';

const REPO = 'github.com/gate-org/policy-repo';
const BRANCH = 'feat/policy-approvals';
const RATIONALE = 'Reviewed for the support chat; the gateway client replaces it before expiry.';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ── offline verification (independent of the engine code) ──
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
function verifyOffline(spki, signedPayload, signature, isThisRecord) {
  const payload = parse(signedPayload ?? '');
  if (!payload || JSON.stringify(sortDeep(payload)) !== signedPayload) return 'signedPayload is not canonical JSON';
  if (!isThisRecord(payload)) return 'not this record';
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(signedPayload, 'utf8'), key, Buffer.from(signature, 'base64')) ? null : 'signature does not verify';
  } catch (err) {
    return String(err);
  }
}
const verifyDecisionOffline = (spki, d) => verifyOffline(spki, d?.signedPayload, d?.signature, (p) => p.kind === 'nomus.cpg-decision.v1' && p.id === d.id);

export async function cpgApprovalsChecks(ctx) {
  const { gate, repoRoot, outDir, data } = ctx;
  const { owner, users } = data.cpg;
  if (!data.cpg.scanner || !data.cpg.policy) {
    gate.blocked('cpg-approvals checks', 'the cpg-scanner and cpg-policy areas did not record the fixture findings and boards');
    return;
  }
  const dev = users.dev.client;
  const ai = users['ai-reviewer'].client;
  const legal = users['legal-reviewer'].client;
  const work = path.join(outDir, 'work', 'cpg-approvals');
  fs.mkdirSync(work, { recursive: true });

  const before = await owner.client.get('/api/v1/cpg/settings');
  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg approvals gate', scopes: ['read:policies', 'evaluate'] });
  const reviewerRole = (await owner.client.get('/api/v1/cpg/roles')).json?.items?.find((r) => r.key === 'case_reviewer')?.id;
  const devGrant = await owner.client.post(`/api/v1/cpg/users/${users.dev.id}/grants`, { roleId: reviewerRole, scopeType: 'org' });
  if (!gate.check('governance on, an org key for the CLI, and dev@ granted Case Reviewer (so the self-approval refusal is not a missing permission)',
    enable.status === 200 && typeof keyRes.json?.key === 'string' && devGrant.status === 201, '200, key, 201', `${enable.status} ${keyRes.status} ${devGrant.status}`)) return;

  let legalGrant = null;
  try {
    const repo = preparePolicyRepo(ctx, path.join(work, 'policy-repo'));
    const cli = path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js');
    const scan = parse((await run(process.execPath, [cli, '.', '--json'], { cwd: repo, env: { NOMUS_API_KEY: keyRes.json.key }, timeout: 120_000 })).stdout);
    const findings = scan?.corporateFindings ?? [];
    const blocking = findings.filter((f) => f.blocking);
    const fp = (key, file) => blocking.find((f) => f.policyKey === key && f.file === file)?.fingerprint;
    const chat = fp('corp.no-direct-openai', 'src/chat.ts');
    const legacy = fp('corp.no-direct-openai', 'src/legacy/old_chat.ts');
    const legacyVersion = blocking.find((f) => f.fingerprint === legacy)?.policyVersion;
    const pii = fp('corp.no-pii-to-ai', 'app/summarize.py');
    const opened = await dev.post('/api/v1/cpg/cases/request-review', {
      repo: REPO, branch: BRANCH, headSha: null, bundleHash: data.cpg.scanner.bundleHash, findings: uploads(repo, findings),
      justifications: blocking.map((f) => ({ fingerprint: f.fingerprint, body: 'Needed for the support chat until the gateway client supports streaming.' })),
    });
    const caseId = opened.json?.case?.id;
    if (!gate.check(`dev@ requests review on ${BRANCH}: a new case holding the three blocking fixture findings`,
      opened.status === 201 && !!chat && !!legacy && !!pii, '201 and the chat, legacy and PII findings', `${opened.status} ${[chat, legacy, pii].map(Boolean)}`)) return;
    const status = async (fingerprint) => (await dev.post('/api/v1/cpg/findings/status', { repo: REPO, branch: BRANCH, fingerprints: [fingerprint] })).json?.items?.[0];

    // ── 1. prohibited snippet: the AI reviewer proposes a 30-day approval → pending, 1 of 2 ──
    const proposed = await ai.post('/api/v1/cpg/proposals', { caseId, scope: 'snippet', outcome: 'approve', fingerprints: [chat], expiresAt: inDays(30), rationale: RATIONALE });
    const p = proposed.json;
    gate.check('ai-reviewer@ proposes a 30-day approval of the prohibited chat.ts finding: 201 pending, 1 vote of 2 required, covering both owning boards',
      proposed.status === 201 && p?.status === 'pending' && p.votes?.length === 1 && p.required?.approvals === 2 && p.required?.boardCoverage === 'all_owning'
        && JSON.stringify(p.required?.boardIds) === JSON.stringify([data.cpg.policy.aiBoardId, data.cpg.policy.legalBoardId].sort()),
      '201 pending 1/2 all_owning [AI, Legal]', `${proposed.status} ${p?.status} ${p?.votes?.length}/${p?.required?.approvals} ${p?.required?.boardCoverage}`);

    // ── 2. a case.review holder who justified findings in the case cannot vote ──
    const self = await dev.post(`/api/v1/cpg/proposals/${p?.id}/votes`, { vote: 'approve' });
    gate.check('dev@ (holds case.review, opened the case and wrote its justifications) votes: 403 self_approval_forbidden',
      self.status === 403 && self.json?.code === 'self_approval_forbidden', '403 self_approval_forbidden', `${self.status} ${self.json?.code}`);

    // ── 7 (first half). the Org Admin writes a new quorum version while the proposal is pending ──
    const quorum = (await owner.client.get('/api/v1/cpg/quorum')).json;
    const next = await owner.client.put('/api/v1/cpg/quorum', { config: quorum?.config, changeNote: 'Gate: a new version while a proposal is pending' });
    gate.check('Org Admin writes a new quorum version during the proposal (201, version + 1)',
      next.status === 201 && next.json?.version === quorum?.version + 1 && p?.quorumConfigVersionAtCreation === quorum?.version,
      `201 v${quorum?.version + 1}`, `${next.status} v${next.json?.version} (created under v${p?.quorumConfigVersionAtCreation})`);

    // ── 3. the Legal reviewer approves → finalized; the signature verifies offline; status approved ──
    const voted = await legal.post(`/api/v1/cpg/proposals/${p?.id}/votes`, { vote: 'approve' });
    const decision = (await dev.get(`/api/v1/cpg/decisions/${voted.json?.decisionIds?.[0]}`)).json;
    const spki = (await ctx.data.api.get('/.well-known/nomus-keys')).json?.keys?.[0]?.spki;
    const offline = verifyDecisionOffline(spki, decision);
    const approved = await status(chat);
    gate.check('legal-reviewer@ approves: finalized with one decision whose signature verifies offline, and findings/status says approved (non-blocking)',
      voted.status === 201 && voted.json?.proposalStatus === 'finalized' && offline === null && decision?.outcome === 'approve'
        && approved?.status === 'approved' && approved.blocking === false && approved.decisionId === decision?.id,
      'finalized, verifies, approved', `${voted.status} ${voted.json?.proposalStatus} ${offline} ${approved?.status}`);

    // ── 7. the decision records the config at finalization; the proposal keeps the one at creation ──
    const payload = parse(decision?.signedPayload ?? '');
    gate.check('the decision records the quorum version in force at finalization, the proposal the version at creation',
      decision?.quorumConfigVersion === next.json?.version && payload?.quorumConfigVersion === next.json?.version
        && payload?.quorumConfigHash === next.json?.configHash && p?.quorumConfigVersionAtCreation === quorum?.version,
      `decision v${next.json?.version}, proposal v${quorum?.version}`, `decision v${decision?.quorumConfigVersion}, proposal v${p?.quorumConfigVersionAtCreation}`);

    // ── 4. bulk on a prohibited policy → 422 scope_not_allowed ──
    const bulk = await legal.post('/api/v1/cpg/proposals', { caseId, scope: 'bulk', outcome: 'approve', fingerprints: [chat, legacy], expiresAt: inDays(30), rationale: RATIONALE });
    gate.check('a bulk proposal over the two prohibited corp.no-direct-openai findings: 422 scope_not_allowed',
      bulk.status === 422 && bulk.json?.code === 'scope_not_allowed', '422 scope_not_allowed', `${bulk.status} ${bulk.json?.code}`);

    // ── 5. review-required PII: the Legal reviewer proposes rejection → a reject decision, status rejected ──
    const reject = await legal.post('/api/v1/cpg/proposals', { caseId, scope: 'snippet', outcome: 'reject', fingerprints: [pii], rationale: 'Personal data must not reach the model; redact it first.' });
    const rejected = await status(pii);
    gate.check('legal-reviewer@ proposes rejecting the PII finding: finalized at once with a reject decision, and findings/status says rejected (blocking)',
      reject.status === 201 && reject.json?.status === 'finalized' && reject.json?.decisionIds?.length === 1
        && rejected?.status === 'rejected' && rejected.blocking === true && rejected.decisionId === reject.json.decisionIds[0] && rejected.expiresAt === null,
      'finalized, rejected, blocking, no expiry', `${reject.status} ${reject.json?.status} ${rejected?.status} ${rejected?.blocking}`);

    // ── 8. veto: an approval proposal and one eligible reject vote → vetoed, no decision ──
    const toVeto = await ai.post('/api/v1/cpg/proposals', { caseId, scope: 'snippet', outcome: 'approve', fingerprints: [legacy], expiresAt: inDays(30), rationale: RATIONALE });
    const veto = await legal.post(`/api/v1/cpg/proposals/${toVeto.json?.id}/votes`, { vote: 'reject' });
    const afterVeto = await status(legacy);
    gate.check('ai-reviewer@ proposes approving the legacy finding and legal-reviewer@ votes reject: vetoed, no decision, the finding still needs review',
      toVeto.status === 201 && veto.status === 201 && veto.json?.proposalStatus === 'vetoed' && veto.json?.decisionIds?.length === 0 && afterVeto?.status === 'needs_review',
      'vetoed, 0 decisions, needs_review', `${toVeto.status} ${veto.status} ${veto.json?.proposalStatus} ${veto.json?.decisionIds?.length} ${afterVeto?.status}`);

    // ── 6. standing exception for src/legacy/**: the expiry bound, the quorum, then excepted ──
    const exceptionRole = (await owner.client.get('/api/v1/cpg/roles')).json?.items?.find((r) => r.key === 'exception_approver')?.id;
    legalGrant = await owner.client.post(`/api/v1/cpg/users/${users['legal-reviewer'].id}/grants`, { roleId: exceptionRole, scopeType: 'org' });
    gate.equal('legal-reviewer@ granted Exception Approver, so the Legal vote can carry exception.approve', legalGrant.status, 201);
    const exceptions = users.exceptions.client;
    const standing = (days) => exceptions.post('/api/v1/cpg/proposals', {
      scope: 'standing', caseId, expiresAt: inDays(days), rationale: RATIONALE,
      pattern: { repos: [REPO], paths: ['src/legacy/**'], policyKey: 'corp.no-direct-openai', policyVersion: legacyVersion },
    });
    const tooLong = await standing(120);
    const se = await standing(30);
    const sp = se.json;
    const firstVote = await ai.post(`/api/v1/cpg/proposals/${sp?.id}/votes`, { vote: 'approve' });
    const lastVote = await legal.post(`/api/v1/cpg/proposals/${sp?.id}/votes`, { vote: 'approve' });
    const excepted = await status(legacy);
    gate.check('exceptions@ proposes a standing exception for src/legacy/**: 120 days is 422 expiry_out_of_range; 30 days needs 2 approvals covering both boards plus exception.approve, and after the AI and Legal votes the legacy finding is excepted',
      tooLong.status === 422 && tooLong.json?.code === 'expiry_out_of_range' && se.status === 201 && sp?.status === 'pending' && sp.votes?.length === 0
        && sp.required?.approvals === 2 && sp.required?.boardCoverage === 'all_owning' && sp.required?.requiredPermission === 'exception.approve'
        && firstVote.json?.proposalStatus === 'pending' && lastVote.json?.proposalStatus === 'finalized'
        && excepted?.status === 'excepted' && excepted.blocking === false && excepted.exceptionDecisionId === lastVote.json?.decisionIds?.[0],
      '422; pending 0/2 all_owning exception.approve; pending; finalized; excepted',
      `${tooLong.status} ${tooLong.json?.code}; ${sp?.status} ${sp?.votes?.length}/${sp?.required?.approvals} ${sp?.required?.requiredPermission}; ${firstVote.json?.proposalStatus}; ${lastVote.json?.proposalStatus}; ${excepted?.status}`);

    // ── 10. every blocking finding is resolved (approved, rejected, excepted) → the case is decided ──
    const caseState = async () => (await dev.get(`/api/v1/cpg/cases/${caseId}`)).json?.case?.state;
    const decided = await caseState();
    gate.equal('with every blocking finding approved, rejected or excepted, the case state is decided', decided, 'decided');

    // ── 9. revocation: the finding returns to needs_review, and a second revocation is 409 ──
    const exceptionId = lastVote.json?.decisionIds?.[0];
    const revoked = await exceptions.post(`/api/v1/cpg/decisions/${exceptionId}/revoke`, { reason: 'Gate: the legacy client is being removed.' });
    const afterRevoke = await status(legacy);
    const reopened = await caseState();
    const again = await exceptions.post(`/api/v1/cpg/decisions/${exceptionId}/revoke`, { reason: 'Gate: the legacy client is being removed.' });
    gate.check('exceptions@ revokes the standing exception: 201 signed, the legacy finding returns to needs_review and the case leaves decided; a second revocation is 409 already_revoked',
      revoked.status === 201 && revoked.json?.decisionId === exceptionId && afterRevoke?.status === 'needs_review' && reopened === 'in_review'
        && again.status === 409 && again.json?.code === 'already_revoked',
      '201, needs_review, in_review, 409 already_revoked', `${revoked.status} ${afterRevoke?.status} ${reopened} ${again.status} ${again.json?.code}`);

    // ── 11 (5b). the decision pages in a browser, with a pending proposal to vote on ──
    const pending = await ai.post('/api/v1/cpg/proposals', { caseId, scope: 'snippet', outcome: 'approve', fingerprints: [legacy], expiresAt: inDays(30), rationale: RATIONALE });
    if (gate.check('ai-reviewer@ proposes approving the legacy finding again after the revocation: pending, 1 of 2',
      pending.status === 201 && pending.json?.status === 'pending', '201 pending', `${pending.status} ${pending.json?.status}`)) {
      await approvalPageChecks(ctx, { caseId, pendingId: pending.json.id, status: () => status(legacy) });
    }

    // ── Phase 6 (engine): the CI verdict on this branch, then the merged PR closes the case ──
    const ci = ctx.data.api.withKey(keyRes.json.key);
    const scanned = { repo: REPO, branch: BRANCH, prNumber: 1, headSha: 'e'.repeat(40), eventName: 'pull_request', bundleHash: scan.corporate.bundleHash };
    const evaluated = await ci.post('/api/v1/cpg/ci/evaluate', { ...scanned, scannedFileCount: scan.corporate.scannedFileCount, findings: uploads(repo, findings) });
    const v = evaluated.json;
    const verdictOffline = verifyOffline(spki, v?.signedPayload, v?.signature, (p) => p.kind === 'nomus.cpg-ci-run.v1' && p.runId === v.runId && p.verdict === v.verdict && p.headSha === scanned.headSha);
    gate.check('CI evaluate on the branch (org key): 200 fail on the review case, the rejected PII finding among the reasons, and the signed verdict verifies offline',
      evaluated.status === 200 && v?.verdict === 'fail' && v.caseId === caseId && v.reasons.includes(`corp.no-pii-to-ai @ app/summarize.py:${blocking.find((f) => f.fingerprint === pii).startLine}: rejected`) && verdictOffline === null,
      '200 fail, same case, rejected PII, verifies', `${evaluated.status} ${v?.verdict} ${v?.caseId === caseId} ${JSON.stringify(v?.reasons ?? v)} ${verdictOffline}`);
    const merged = await ci.post('/api/v1/cpg/ci/pr-closed', { repo: REPO, branch: BRANCH, prNumber: 1, merged: true });
    const closure = (await dev.get(`/api/v1/cpg/cases/${caseId}`)).json?.closure;
    gate.check('the merged PR closes the case as merged, and its signed closure record lists the CI run',
      merged.json?.closed === true && closure?.reason === 'merged' && closure.signatureValid === true && closure.record?.ciRunIds?.includes(v?.runId),
      'closed, merged, valid, run listed', `${merged.status} ${JSON.stringify(merged.json)} ${closure?.reason} ${closure?.signatureValid} ${JSON.stringify(closure?.record?.ciRunIds)}`);
  } finally {
    const revoke = await owner.client.post(`/api/v1/cpg/grants/${devGrant.json?.id}/revoke`, { reason: 'Gate: self-approval check done' });
    if (legalGrant) {
      const revokeLegal = await owner.client.post(`/api/v1/cpg/grants/${legalGrant.json?.id}/revoke`, { reason: 'Gate: standing exception check done' });
      gate.equal("legal-reviewer@'s Exception Approver grant revoked", revokeLegal.status, 200);
    }
    const restore = await owner.client.patch('/api/v1/cpg/settings', { enabled: false, reviewerContextLlm: before.json?.reviewerContextLlm ?? false });
    gate.check('dev@\'s Case Reviewer grant revoked and governance switched off again', revoke.status === 200 && restore.status === 200 && restore.json?.enabled === false,
      '200, 200 enabled false', `${revoke.status} ${restore.status} ${restore.json?.enabled}`);
    if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
  }
}
