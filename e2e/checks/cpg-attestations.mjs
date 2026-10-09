// CPG Phase 8: corporate policy records in attestations, design spec §16.8
// release-gate checks 1 to 7, against the built engine and dashboard.
// Check 6 also verifies the signed governance audit export (E73) offline.
//
// Uses what cpg-approvals left in "Gate Policy Org": the active 30-day
// approval of the chat.ts finding and the case it closed (with its CI run).
// exceptions@ proposes a new standing exception for src/legacy/**, the AI and
// Legal reviewers approve it, and the Org Admin attests with the governance
// extra. The evidence export is verified offline twice: with the unchanged
// v1 verifier from attestations.mjs and with verifyGovernance() below, which
// follows the bundle's own instructions using only node:crypto. Governance is
// switched on for this area and off again at the end, and legal-reviewer@'s
// Exception Approver grant is revoked.

import crypto from 'node:crypto';
import { verifyBundle } from './attestations.mjs';
import { attestationPageChecks } from './cpg-browser.mjs';

const REPO = 'gate-org/policy-repo';
const V1_KEYS = ['bundleType', 'bundleVersion', 'generatedAt', 'attestation', 'verification', 'citedRules', 'corpus', '_disclaimer'];
const KINDS = { decision: ['nomus.cpg-decision.v1', 'id'], case_closure: ['nomus.cpg-case-closure.v1', 'caseId'], ci_run: ['nomus.cpg-ci-run.v1', 'runId'] };
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

/** The parsed payload of a signed record when its Ed25519 signature verifies under `key`, else null. */
function signedBy(key, record) {
  try {
    const text = String(record?.signedPayloadCanonicalJson);
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(String(record?.signature), 'base64')) ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** §13.6 steps 2 to 4 (step 1 is verifyBundle). Independent of the engine code. */
export function verifyGovernance(b, key) {
  const reasons = [];
  const g = b?.corporateGovernance;
  const a = b?.attestation ?? {};
  const m = signedBy(key, g?.manifest);
  if (b?.bundleVersion !== 2 || !m || m.kind !== 'nomus.cpg-attestation-manifest.v1') return { ok: false, reasons: ['manifest missing or its signature does not verify'] };
  if (m.attestationId !== a.id || m.evaluatedAt !== a.evaluatedAt || m.orgId !== a.orgId) reasons.push('manifest is not bound to this attestation');
  if ((g.items ?? []).length !== m.items.length) reasons.push('bundle items differ from the manifest');
  const closures = g.items.filter((i) => i.type === 'case_closure').map((i) => signedBy(key, i));
  for (const ref of m.items) {
    const item = g.items.find((i) => i.type === ref.type && i.id === ref.id);
    const p = item ? signedBy(key, item) : null;
    const [kind, idKey] = KINDS[ref.type] ?? [];
    if (!p) { reasons.push(`${ref.type} ${ref.id}: missing or signature invalid`); continue; }
    if (crypto.createHash('sha256').update(item.signature, 'utf8').digest('hex') !== ref.signatureSha256) reasons.push(`${ref.type}: signature hash differs from the manifest`);
    if (p.kind !== kind || p[idKey] !== ref.id || p.orgId !== m.orgId) reasons.push(`${ref.type}: not this record`);
    if (ref.type === 'decision' && (p.outcome !== 'approve' || !(p.expiresAt > m.evaluatedAt))) reasons.push('decision: not an approval valid at the attestation instant');
    if (ref.type === 'ci_run' && !closures.some((c) => c?.ciRunIds?.includes(ref.id))) reasons.push('ci_run: not in a closure record');
    if (item.revocation) {
      const r = signedBy(key, item.revocation);
      if (!r || r.kind !== 'nomus.cpg-revocation.v1' || r.decisionId !== ref.id || !(r.revokedAt > m.evaluatedAt)) reasons.push('revocation does not verify');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const canonical = (v) => JSON.stringify(sortDeep(v));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** The signed governance audit export (E73), offline: export signature, content hash, the chain from genesis, each record. */
export function verifyAuditExport(e, key) {
  const reasons = [];
  const c = e?.content ?? {};
  if (e?.kind !== 'nomus.cpg-governance-export.v1' || sha256(canonical(c)) !== e.contentHash) reasons.push('content hash differs');
  if (!signedBy(key, { signedPayloadCanonicalJson: canonical({ kind: e?.kind, orgId: e?.orgId, exportedAt: e?.exportedAt, contentHash: e?.contentHash }), signature: e?.signature })) reasons.push('export signature');
  let prev = '0'.repeat(64);
  for (const [i, ev] of (c.auditEvents ?? []).entries()) {
    const body = canonical({ id: ev.id, org_id: e.orgId, seq: ev.seq, actor: ev.actor, action: ev.action, target_type: ev.targetType, target_id: ev.targetId, payload: ev.payload, created_at: ev.createdAt });
    if (ev.seq !== i + 1 || ev.prevHash !== prev || sha256(prev + body) !== ev.hash) { reasons.push(`audit chain breaks at ${ev.seq}`); break; }
    prev = ev.hash;
  }
  for (const r of ['decisions', 'revocations', 'caseClosures', 'ciRuns'].flatMap((k) => c[k] ?? [])) if (!signedBy(key, r)) reasons.push(`record ${r.id} does not verify`);
  return { ok: reasons.length === 0, reasons };
}

export async function cpgAttestationsChecks(ctx) {
  const { gate, data } = ctx;
  const { owner, users } = data.cpg;
  const caseId = data.cpg.closedCaseId;
  if (!caseId) {
    gate.blocked('cpg-attestations checks', 'the cpg-approvals area did not close its review case');
    return;
  }
  const anon = data.api.anonymous();
  const jwk = (await anon.get('/.well-known/nomus-keys')).json?.keys?.[0];
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  const [ai, legal, exceptions] = [users['ai-reviewer'].client, users['legal-reviewer'].client, users.exceptions.client];

  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const roleId = (await owner.client.get('/api/v1/cpg/roles')).json?.items?.find((r) => r.key === 'exception_approver')?.id;
  const legalGrant = await owner.client.post(`/api/v1/cpg/users/${users['legal-reviewer'].id}/grants`, { roleId, scopeType: 'org' });
  try {
    const previous = (await exceptions.get('/api/v1/cpg/exceptions')).json?.items?.find((x) => x.status === 'revoked');
    const proposed = await exceptions.post('/api/v1/cpg/proposals', {
      scope: 'standing', expiresAt: inDays(30), rationale: 'Gate: the legacy client stays until the gateway release.',
      pattern: { repos: [REPO], paths: ['src/legacy/**'], policyKey: previous?.policyKey, policyVersion: previous?.policyVersion },
    });
    await ai.post(`/api/v1/cpg/proposals/${proposed.json?.id}/votes`, { vote: 'approve' });
    const finalized = await legal.post(`/api/v1/cpg/proposals/${proposed.json?.id}/votes`, { vote: 'approve' });
    const exceptionId = finalized.json?.decisionIds?.[0];
    if (!gate.check('governance on, and a new standing exception for src/legacy/** approved by the AI and Legal reviewers',
      enable.status === 200 && legalGrant.status === 201 && finalized.json?.proposalStatus === 'finalized' && !!exceptionId,
      '200, 201, finalized', `${enable.status} ${legalGrant.status} ${proposed.status} ${finalized.json?.proposalStatus}`)) return;

    // ── 1. evaluate with governance ──
    const evalBody = { action: 'ai_user_interaction', jurisdiction: 'EU', context: { region: 'EU' } };
    const attested = await owner.client.post('/api/v1/evaluate', { ...evalBody, governance: { repo: REPO, branch: 'main', caseId } });
    const id = attested.json?.id;
    gate.check('POST /evaluate with governance {repo, branch main, the closed case}: a signed receipt and a manifest of at least 3 items (the snippet approval, the standing exception, the case closure)',
      attested.status === 200 && attested.json?.governance?.manifest === true && attested.json.governance.itemCount >= 3,
      '200, manifest, itemCount >= 3', `${attested.status} ${JSON.stringify(attested.json?.governance ?? attested.json)?.slice(0, 160)}`);

    // ── 2. the export is bundleVersion 2 and verifies offline both ways ──
    const bundle = (await owner.client.get(`/api/v1/attestations/${id}/export?format=json`)).json;
    const record = (await anon.get(`/api/v1/verify/${id}`)).json;
    const v1 = verifyBundle(bundle, key, record);
    const gv = verifyGovernance(bundle, key);
    const types = (bundle?.corporateGovernance?.items ?? []).map((i) => i.type);
    gate.check('the export is bundleVersion 2; the unchanged v1 verifyBundle passes and verifyGovernance passes (decisions, the closure and its CI run, all with the published key)',
      bundle?.bundleVersion === 2 && v1.ok && gv.ok && types.includes('decision') && types.includes('case_closure') && types.includes('ci_run')
        && JSON.stringify(Object.keys(bundle).filter((k) => k !== 'corporateGovernance')) === JSON.stringify(V1_KEYS),
      'v2, both verify, decision + case_closure + ci_run', `v${bundle?.bundleVersion} ${v1.reasons} ${gv.reasons} [${types}]`);
    gate.check('public verify shows the corporate governance counts and a valid manifest signature, nothing org-private',
      record?.corporateGovernance?.manifestSignatureValid === true && record.corporateGovernance.exceptions >= 2 && record.corporateGovernance.caseClosures === 1
        && !JSON.stringify(record).includes(REPO),
      'valid, >= 2 exceptions, 1 closure, no repo', JSON.stringify(record?.corporateGovernance));

    // ── 3. tampering ──
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    const decision = (b) => b.corporateGovernance.items.find((i) => i.type === 'decision');
    const tampered = {
      "a decision's expiresAt edited": (b) => { decision(b).signedPayloadCanonicalJson = decision(b).signedPayloadCanonicalJson.replace(/"expiresAt":"[^"]+"/, '"expiresAt":"2099-12-31T00:00:00.000Z"'); },
      'an item dropped': (b) => { b.corporateGovernance.items.shift(); },
      "the manifest's attestationId swapped": (b) => { b.corporateGovernance.manifest.signedPayloadCanonicalJson = b.corporateGovernance.manifest.signedPayloadCanonicalJson.replace(id, crypto.randomUUID()); },
      'a decision re-signed with another key': (b) => { decision(b).signature = crypto.sign(null, Buffer.from(decision(b).signedPayloadCanonicalJson), other).toString('base64'); },
    };
    for (const [name, mutate] of Object.entries(tampered)) {
      const b = structuredClone(bundle);
      mutate(b);
      const v = verifyGovernance(b, key);
      gate.check(`a tampered governance bundle is rejected: ${name}`, !v.ok, 'rejected', v.ok ? 'accepted' : v.reasons[0]);
    }

    // ── 4. without governance: exactly the v1.1.0 bundle ──
    const plain = await owner.client.post('/api/v1/evaluate', evalBody);
    const plainBundle = (await owner.client.get(`/api/v1/attestations/${plain.json?.id}/export?format=json`)).json;
    gate.check('an attestation without governance: no governance in the response, bundleVersion 1 with exactly the v1.1.0 top-level keys',
      plain.status === 200 && !('governance' in plain.json) && plainBundle?.bundleVersion === 1 && JSON.stringify(Object.keys(plainBundle)) === JSON.stringify(V1_KEYS),
      `v1 [${V1_KEYS}]`, `v${plainBundle?.bundleVersion} [${Object.keys(plainBundle ?? {})}]`);

    // ── 5. revoked after the attestation ──
    const revoked = await exceptions.post(`/api/v1/cpg/decisions/${exceptionId}/revoke`, { reason: 'Gate: revoked after the attestation was issued.' });
    const after = (await owner.client.get(`/api/v1/attestations/${id}/export?format=json`)).json;
    const item = after?.corporateGovernance?.items?.find((i) => i.id === exceptionId);
    const afterCheck = verifyGovernance(after, key);
    gate.check('revoking the exception after the attestation: the export marks it revoked, its signed revocation verifies, and the bundle still verifies',
      revoked.status === 201 && item?.statusAtGeneration === 'revoked' && signedBy(key, item.revocation)?.decisionId === exceptionId && afterCheck.ok,
      'revoked, revocation verifies, bundle verifies', `${revoked.status} ${item?.statusAtGeneration} ${afterCheck.reasons}`);

    // ── 6. the audit chain: the Auditor reads it valid and exports it signed; the Developer is refused ──
    const audit = await users.auditor.client.get('/api/v1/cpg/audit?limit=5');
    const devAudit = await users.dev.client.get('/api/v1/cpg/audit?limit=5');
    gate.check('Auditor reads the governance audit log with chainValid true; Developer is 403',
      audit.status === 200 && audit.json?.chainValid === true && devAudit.status === 403, '200 chainValid, 403', `${audit.status} ${audit.json?.chainValid} ${devAudit.status}`);
    const exp = await users.auditor.client.get('/api/v1/cpg/audit/export');
    const e = exp.json;
    const ev = verifyAuditExport(e, key);
    const closure = e?.content?.caseClosures?.find((r) => r.id === caseId);
    const ciRunIds = signedBy(key, closure)?.ciRunIds ?? [];
    const holds = e?.content?.chainValid === true && e.content.auditEvents.length >= 5 && e.content.auditEvents.some((x) => x.hash === audit.json?.items?.[0]?.hash)
      && e.content.revocations.some((r) => signedBy(key, r)?.decisionId === exceptionId) && ciRunIds.length > 0
      && ciRunIds.every((id) => e.content.ciRuns.some((r) => r.id === id && signedBy(key, r)?.runId === id));
    gate.check('Auditor GET /cpg/audit/export: the export signature, content hash, whole audit chain and every signed record verify offline; it holds the revocation, the closure and its CI runs',
      exp.status === 200 && ev.ok && holds, '200, verifies, revocation + closure + CI runs', `${exp.status} ${ev.reasons.slice(0, 3)} holds=${holds}`);
    const forged = structuredClone(e ?? {});
    if (forged.content?.auditEvents?.[0]) forged.content.auditEvents[0].actor = 'system:forged';
    forged.contentHash = sha256(canonical(forged.content ?? {}));
    const exportRefused = [users.dev, owner].map((u) => u.client.get('/api/v1/cpg/audit/export'));
    const refused = (await Promise.all(exportRefused)).map((r) => r.status);
    gate.check('the audit export: an edited audit event is rejected offline; a Developer and an Org Admin (no audit.export) are 403',
      !verifyAuditExport(forged, key).ok && refused.every((s) => s === 403), 'rejected, 403 403', `${verifyAuditExport(forged, key).ok ? 'accepted' : 'rejected'} ${refused}`);

    // ── 7. in the browser ──
    await attestationPageChecks(ctx, { id });
  } finally {
    if (legalGrant.status === 201) {
      const revokeGrant = await owner.client.post(`/api/v1/cpg/grants/${legalGrant.json.id}/revoke`, { reason: 'Gate: attestation checks done' });
      gate.equal("legal-reviewer@'s Exception Approver grant revoked", revokeGrant.status, 200);
    }
    const restore = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    gate.check('governance switched off again', restore.status === 200 && restore.json?.enabled === false, '200 enabled false', `${restore.status} ${restore.json?.enabled}`);
  }
}
