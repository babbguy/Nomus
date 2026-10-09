import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Offline verification of an evidence bundle (design spec §13.6), exactly as
 * the bundle's own instructions describe it: nothing here reads the database
 * or the instance key. bundleVersion 1 bundles (v1.1.0) are checked by step 1
 * alone; bundleVersion 2 adds the corporate governance steps 2 to 4. Fails
 * closed: anything missing or unreadable is a reason.
 */

type Json = Record<string, any>;
const ITEM_KINDS = { decision: ['nomus.cpg-decision.v1', 'id'], case_closure: ['nomus.cpg-case-closure.v1', 'caseId'], ci_run: ['nomus.cpg-ci-run.v1', 'runId'] } as const;
const RECEIPT_KEYS = ['id', 'orgId', 'result', 'jurisdiction', 'policyStateHash', 'evaluatedAt'] as const;

function spki(b64: unknown): KeyObject | null {
  try {
    return createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The parsed payload when the signature verifies under `key`, else null. */
function signed(key: KeyObject, record: Json | null | undefined): Json | null {
  try {
    const text = String(record?.signedPayloadCanonicalJson);
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(String(record?.signature), 'base64')) ? JSON.parse(text) as Json : null;
  } catch {
    return null;
  }
}

export function verifyEvidenceBundle(bundle: Json, publishedSpki: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const key = spki(publishedSpki);
  const v = bundle?.verification ?? {};
  const a = bundle?.attestation ?? {};

  // 1. The receipt, unchanged since v1.1.0.
  const embedded = spki(v.publicKey);
  if (!key || !embedded || !embedded.equals(key)) reasons.push('the embedded key is not the published key');
  const receipt = key ? signed(key, v) : null;
  if (!receipt) reasons.push('the receipt signature does not verify');
  else {
    for (const k of RECEIPT_KEYS) if (receipt[k] !== a[k]) reasons.push(`attestation ${k} differs from the signed payload`);
    if (JSON.stringify(receipt.actionContext) !== JSON.stringify(a.actionContext)) reasons.push('attestation actionContext differs from the signed payload');
  }
  if (a.signature !== v.signature) reasons.push('the attestation and verification signatures differ');

  const g = bundle?.corporateGovernance;
  if (bundle?.bundleVersion === 1 && g === undefined) return { ok: reasons.length === 0, reasons };
  if (bundle?.bundleVersion !== 2 || !g || !key) return { ok: false, reasons: [...reasons, 'bundleVersion 2 needs a corporateGovernance section'] };

  // 2. The manifest: same key, bound to this attestation.
  const m = signed(key, g.manifest);
  if (!m || m.kind !== 'nomus.cpg-attestation-manifest.v1') return { ok: false, reasons: [...reasons, 'the manifest signature does not verify'] };
  for (const [mk, ak] of [['attestationId', 'id'], ['evaluatedAt', 'evaluatedAt'], ['orgId', 'orgId']] as const) {
    if (m[mk] !== a[ak]) reasons.push(`manifest ${mk} differs from the attestation`);
  }

  // 3 and 4. Each item, its hash in the manifest, and any revocation.
  const listed: Json[] = Array.isArray(m.items) ? m.items : [];
  const items: Json[] = Array.isArray(g.items) ? g.items : [];
  if (items.length !== listed.length) reasons.push('the bundle items differ from the manifest items');
  const closures = items.filter((i) => i.type === 'case_closure').map((i) => signed(key, i));
  for (const ref of listed) {
    const name = `${ref.type} ${ref.id}`;
    const item = items.find((i) => i.type === ref.type && i.id === ref.id);
    const kind = ITEM_KINDS[ref.type as keyof typeof ITEM_KINDS];
    const p = item && kind ? signed(key, item) : null;
    if (!p) { reasons.push(`${name}: missing or its signature does not verify`); continue; }
    if (createHash('sha256').update(String(item!.signature), 'utf8').digest('hex') !== ref.signatureSha256) reasons.push(`${name}: signature hash differs from the manifest`);
    if (p.kind !== kind[0] || p[kind[1]] !== ref.id || p.orgId !== m.orgId) reasons.push(`${name}: not this record`);
    if (ref.type === 'decision' && (p.outcome !== 'approve' || !(p.expiresAt > m.evaluatedAt))) reasons.push(`${name}: not an approval valid at the attestation instant`);
    if (ref.type === 'ci_run' && !closures.some((c) => c?.ciRunIds?.includes(ref.id))) reasons.push(`${name}: not listed by a closure record`);
    if (item!.revocation) {
      const r = signed(key, item!.revocation);
      if (!r || r.kind !== 'nomus.cpg-revocation.v1' || r.decisionId !== ref.id || r.orgId !== m.orgId) reasons.push(`${name}: the revocation does not verify`);
      else if (!(r.revokedAt > m.evaluatedAt)) reasons.push(`${name}: revoked before the attestation instant`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
