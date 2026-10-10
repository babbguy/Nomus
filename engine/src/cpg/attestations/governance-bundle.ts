import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { cpgAttestationLinks, cpgAttestationManifests, cpgCases, cpgCiRuns, cpgDecisions, cpgRevocations } from '../../db/schema-cpg.js';
import { closureSignedText } from '../cases/close.js';
import { cpgVerify } from '../policies/signing.js';
import { manifestCounts, type ItemType } from './manifest.js';

/**
 * The `corporateGovernance` section of an evidence bundle (design spec §13.5)
 * and the public summary of a manifest. Every record travels as its exact
 * signed text and signature, so an auditor verifies it offline with the
 * instance's published key, as the receipt itself.
 */

export interface SignedRecord { signedPayloadCanonicalJson: string; signature: string }
export interface GovernanceItem extends SignedRecord {
  type: ItemType;
  id: string;
  /** Decisions: active, expired or revoked when the bundle was generated. Closures and CI runs never change: final. */
  statusAtGeneration: 'active' | 'expired' | 'revoked' | 'final';
  revocation: SignedRecord | null;
}
export interface CorporateGovernanceSection {
  manifest: SignedRecord;
  items: GovernanceItem[];
  instructions: string[];
}

export const GOVERNANCE_INSTRUCTIONS = [
  'Verify the attestation exactly as for bundleVersion 1 (verification.*). This step is unchanged.',
  'Verify corporateGovernance.manifest.signature (Ed25519, base64) over the UTF-8 bytes of manifest.signedPayloadCanonicalJson with the SAME published key. Check that its kind is "nomus.cpg-attestation-manifest.v1" and that its attestationId, orgId and evaluatedAt equal the attestation\'s.',
  'For each manifest item, take the bundle item with the same type and id; verify its signature over its signedPayloadCanonicalJson with the same key; check that sha256 (hex) of the UTF-8 bytes of its base64 signature string equals the item\'s signatureSha256, and that its orgId equals the manifest\'s. Every bundle item must be listed in the manifest, and every manifest item must be present.',
  'Kinds: a decision is "nomus.cpg-decision.v1" (its id is the item id; it must have outcome "approve" and expiresAt later than the manifest evaluatedAt); a case closure is "nomus.cpg-case-closure.v1" (caseId); a CI run is "nomus.cpg-ci-run.v1" (runId), listed in the closure\'s ciRunIds. The kind field keeps the domains apart, so no CPG signature can stand in for a receipt signature.',
  'If an item has a revocation, verify it the same way ("nomus.cpg-revocation.v1", decisionId equal to the item id). A revocation dated after the manifest evaluatedAt means the exception was valid at attestation time and has been revoked since.',
];

function decisionItem(db: Db, id: string, generatedAt: string): Omit<GovernanceItem, 'type' | 'id'> {
  const d = db.select({ signedPayload: cpgDecisions.signedPayload, signature: cpgDecisions.signature, expiresAt: cpgDecisions.expiresAt })
    .from(cpgDecisions).where(eq(cpgDecisions.id, id)).get()!;
  const r = db.select({ signedPayload: cpgRevocations.signedPayload, signature: cpgRevocations.signature })
    .from(cpgRevocations).where(eq(cpgRevocations.decisionId, id)).get();
  return {
    signedPayloadCanonicalJson: d.signedPayload, signature: d.signature,
    statusAtGeneration: r ? 'revoked' : d.expiresAt! <= generatedAt ? 'expired' : 'active',
    revocation: r ? { signedPayloadCanonicalJson: r.signedPayload, signature: r.signature } : null,
  };
}

function finalItem(db: Db, type: ItemType, id: string): SignedRecord {
  if (type === 'ci_run') {
    const run = db.select({ signedPayload: cpgCiRuns.signedPayload, signature: cpgCiRuns.signature }).from(cpgCiRuns).where(eq(cpgCiRuns.id, id)).get()!;
    return { signedPayloadCanonicalJson: run.signedPayload, signature: run.signature };
  }
  const c = db.select().from(cpgCases).where(eq(cpgCases.id, id)).get()!;
  return { signedPayloadCanonicalJson: closureSignedText(db, c), signature: c.closureSignature! };
}

/** The section for an attestation with a manifest, or null (the bundle then stays bundleVersion 1, byte for byte). */
export function corporateGovernanceSection(db: Db, attestationId: string, generatedAt: string): CorporateGovernanceSection | null {
  const m = db.select().from(cpgAttestationManifests).where(eq(cpgAttestationManifests.attestationId, attestationId)).get();
  if (!m) return null;
  const links = db.select().from(cpgAttestationLinks).where(eq(cpgAttestationLinks.attestationId, attestationId))
    .orderBy(asc(cpgAttestationLinks.itemType), asc(cpgAttestationLinks.itemId)).all();
  return {
    manifest: { signedPayloadCanonicalJson: m.signedPayload, signature: m.signature },
    items: links.map((l) => ({
      type: l.itemType, id: l.itemId,
      ...(l.itemType === 'decision' ? decisionItem(db, l.itemId, generatedAt) : { ...finalItem(db, l.itemType, l.itemId), statusAtGeneration: 'final' as const, revocation: null }),
    })),
    instructions: GOVERNANCE_INSTRUCTIONS,
  };
}

/** What the public verify page shows: counts and validity only, never policy keys, repositories or code. */
export function publicGovernanceSummary(db: Db, attestationId: string) {
  const m = db.select().from(cpgAttestationManifests).where(eq(cpgAttestationManifests.attestationId, attestationId)).get();
  if (!m) return null;
  const counts = manifestCounts(db, [attestationId]).get(attestationId)!;
  const revokedSince = db.select({ id: cpgRevocations.id }).from(cpgAttestationLinks)
    .innerJoin(cpgRevocations, eq(cpgRevocations.decisionId, cpgAttestationLinks.itemId))
    .where(and(eq(cpgAttestationLinks.attestationId, attestationId), eq(cpgAttestationLinks.itemType, 'decision'))).all().length;
  return {
    manifestSignatureValid: safeVerify(m.signedPayload, m.signature),
    exceptions: counts.decision, revokedSince, caseClosures: counts.case_closure, ciRuns: counts.ci_run,
  };
}

function safeVerify(text: string, signature: string): boolean {
  try {
    return cpgVerify(text, signature);
  } catch {
    return false;
  }
}
