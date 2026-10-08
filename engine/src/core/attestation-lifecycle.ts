/**
 * Attestation lifecycle: status derivation + signature verification.
 *
 * Two SEPARATE questions are answered about every attestation, and both are
 * always reported together (fail closed: a revoked attestation must never
 * verify as clean):
 *
 *   1. STATUS   — lifecycle state derived from mutable operational fields
 *                 (revokedAt / supersededBy / expiresAt). Precedence:
 *                 revoked > superseded > expired > valid.
 *   2. SIGNATURE — cryptographic integrity of the immutable attested facts.
 *                 The Ed25519 signature covers canonicalJSON of
 *                 { actionContext, evaluatedAt, id, jurisdiction, orgId,
 *                 policyStateHash, result } — EXACTLY the payload signed at
 *                 creation in core/attestation.ts. Lifecycle fields are NOT
 *                 part of the signed payload (they are operational state that
 *                 changes after signing; schemaVersion 1 keeps every
 *                 historical receipt verifiable).
 */
import { canonicalJSON } from './policy-compiler.js';
import { verifySignature } from './signing.js';

/** Receipt format version written by the current engine. */
export const ATTESTATION_SCHEMA_VERSION = 1;

export type AttestationStatus = 'valid' | 'expired' | 'revoked' | 'superseded';

export interface AttestationLifecycleFields {
  revokedAt: string | null;
  supersededBy: string | null;
  expiresAt: string | null;
}

/**
 * Derive the lifecycle status of an attestation at a given instant.
 *
 * Pure and deterministic: the evaluation instant `atIso` (UTC ISO-8601) is an
 * explicit input so every determination is timestamped and reproducible
 *.
 *
 * Precedence: revoked > superseded > expired > valid.
 *
 * Fail-closed rules (never report clean on bad data):
 * - an unparseable `expiresAt` counts as expired
 * - an unparseable `atIso` (caller bug) counts as expired
 */
export function deriveAttestationStatus(
  fields: AttestationLifecycleFields,
  atIso: string,
): AttestationStatus {
  if (fields.revokedAt) return 'revoked';
  if (fields.supersededBy) return 'superseded';
  if (fields.expiresAt) {
    const expires = Date.parse(fields.expiresAt);
    const at = Date.parse(atIso);
    if (Number.isNaN(expires) || Number.isNaN(at) || expires < at) return 'expired';
  }
  return 'valid';
}

/** The immutable columns covered by the receipt signature. */
export interface SignedReceiptFields {
  id: string;
  orgId: string;
  /** JSON string as stored in attestation_receipts.action_context */
  actionContext: string;
  result: string;
  jurisdiction: string;
  policyStateHash: string;
  evaluatedAt: string;
}

/**
 * Rebuild the exact canonical payload that was signed at creation.
 * Returns null when the stored actionContext is not valid JSON (a tampered
 * or corrupted record) — callers must treat that as signature-invalid.
 */
export function buildSignedReceiptPayload(receipt: SignedReceiptFields): string | null {
  let actionContext: unknown;
  try {
    actionContext = JSON.parse(receipt.actionContext);
  } catch {
    return null;
  }
  return canonicalJSON({
    id: receipt.id,
    orgId: receipt.orgId,
    actionContext,
    result: receipt.result,
    jurisdiction: receipt.jurisdiction,
    policyStateHash: receipt.policyStateHash,
    evaluatedAt: receipt.evaluatedAt,
  });
}

/**
 * Verify a stored receipt's Ed25519 signature against the engine public key.
 * Never throws — any failure (corrupted actionContext, malformed signature,
 * uninitialized keys) returns false. Zero silent failures: false IS the
 * loud answer here; it is surfaced verbatim as signatureValid.
 */
export function verifyReceiptSignature(
  receipt: SignedReceiptFields & { signature: string },
): boolean {
  const payload = buildSignedReceiptPayload(receipt);
  if (payload === null) return false;
  try {
    return verifySignature(payload, receipt.signature);
  } catch {
    return false;
  }
}

/**
 * Human-readable description of what the signature covers — shipped on the
 * public verify endpoint so third parties know exactly what they can and
 * cannot check without the owner's evidence bundle.
 */
export const SIGNED_PAYLOAD_DESCRIPTION =
  'Ed25519 signature over the UTF-8 bytes of canonical JSON (object keys sorted ' +
  'alphabetically at every depth, no whitespace) of ' +
  '{ actionContext, evaluatedAt, id, jurisdiction, orgId, policyStateHash, result }. ' +
  'actionContext and orgId are org-private and are not exposed by the public verify ' +
  'endpoint; the attestation owner can share the exact signed payload via the ' +
  'evidence export (GET /api/v1/attestations/:id/export?format=json).';

/**
 * Step-by-step independent verification instructions ("how your auditor
 * checks this without trusting us").
 */
export function verificationInstructions(): string[] {
  return [
    'Obtain the evidence bundle from the attestation owner (GET /api/v1/attestations/:id/export?format=json, authenticated). It contains the exact signed payload string (verification.signedPayloadCanonicalJson).',
    `Fetch GET /.well-known/nomus-keys on this Nomus instance and confirm the Ed25519 key matches verification.publicKey (base64-encoded SPKI DER): either compare it with the "spki" member of the key (a Nomus extension to the JWK, identical encoding), or import the standard RFC 8037 JWK ("x" is the base64url raw 32-byte key, e.g. Node.js crypto.createPublicKey({ key: jwk, format: 'jwk' })) and export it as SPKI DER to compare.`,
    'Verify the Ed25519 signature (base64) over the UTF-8 bytes of the signed payload string with any standard cryptography library (e.g. Node.js crypto.verify with key format der, type spki).',
    'Re-check the lifecycle status at GET /api/v1/verify/:attestationId. A valid signature does NOT mean the attestation is currently valid: revoked, superseded, and expired attestations keep verifiable signatures but must not be relied upon.',
  ];
}
