import { canonicalJson, policyActivationPayload, sha256Hex, type BundlePolicy } from '@nomus/scanner/corporate';
import { signData, verifySignature } from '../../core/signing.js';
import { CpgError } from '../errors.js';

/**
 * Ed25519 signatures for CPG records (design spec §1.4, §4.4, §8.5, §8.6).
 *
 * Every payload is domain-separated by a `kind` field, so a CPG signature can
 * never be replayed as a regulatory rule or attestation signature, nor one
 * kind of CPG record as another. The instance key is reused through
 * signData; signRule is not (its payload shape is regulatory).
 */

const QUORUM_KIND = 'nomus.cpg-quorum.v1';
export const POLICY_EXPORT_KIND = 'nomus.cpg-policy-export.v1';
export const GOVERNANCE_EXPORT_KIND = 'nomus.cpg-governance-export.v1';

/** signData, with "keys not initialized" turned into 503 signing_unavailable. */
export function cpgSign(text: string): string {
  try {
    return signData(text);
  } catch (err) {
    if (err instanceof Error && /not initialized/i.test(err.message)) {
      throw new CpgError(503, 'signing_unavailable', 'Signing keys are not initialized');
    }
    throw err;
  }
}

export function cpgVerify(text: string, signature: string): boolean {
  return verifySignature(text, signature);
}

export function quorumSignedText(v: { orgId: string; version: number; configHash: string; createdAt: string }): string {
  return canonicalJson({ kind: QUORUM_KIND, orgId: v.orgId, version: v.version, configHash: v.configHash, createdAt: v.createdAt });
}

/** The activation payload of a policy version, as the bundle client reconstructs it. */
export function activationSignedText(orgId: string, p: Omit<BundlePolicy, 'activationSignature' | 'rule'>): string {
  return canonicalJson(policyActivationPayload(orgId, p));
}

/** What a signed export's signature covers (the policy log E39, the governance audit E73). */
export function exportSignedText(e: { kind: typeof POLICY_EXPORT_KIND | typeof GOVERNANCE_EXPORT_KIND; orgId: string; exportedAt: string; contentHash: string }): string {
  return canonicalJson({ kind: e.kind, orgId: e.orgId, exportedAt: e.exportedAt, contentHash: e.contentHash });
}

export function contentHashOf(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

const POLICY_RETIRE_KIND = 'nomus.cpg-policy-retire.v1';

/** The signed record of a retirement taking effect (the policy leaves the bundle). */
export function retirementSignedText(r: { orgId: string; policyId: string; policyKey: string; version: number; retiredAt: string }): string {
  return canonicalJson({ kind: POLICY_RETIRE_KIND, orgId: r.orgId, policyId: r.policyId, policyKey: r.policyKey, version: r.version, retiredAt: r.retiredAt });
}
