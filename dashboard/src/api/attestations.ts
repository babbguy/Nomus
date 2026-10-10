import api from './client';
import type { AttestationLifecycleStatus } from './verify';

export interface Attestation {
  id: string;
  orgId: string;
  actionContext: Record<string, string>;
  rulesEvaluated: Array<{
    ruleKey: string;
    version: number;
    effect: string;
    matched: boolean;
  }>;
  result: string;
  jurisdiction: string;
  policyStateHash: string;
  signature: string;
  evaluatedAt: string;
  // ── Attestation lifecycle fields ──
  // Optional: the list endpoint spreads the full DB row, so these flow
  // through once the engine adds the columns. Older rows / older engine
  // builds omit them entirely — callers must treat "absent" as UNKNOWN,
  // never as valid.
  status?: AttestationLifecycleStatus;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  supersededBy?: string | null;
  /** Present only when the attestation has a corporate-policy manifest (counts of the signed records it lists). */
  corporateGovernance?: { exceptions: number; caseClosures: number; ciRuns: number };
}

/**
 * Derive the display lifecycle from whatever fields the record carries.
 * Returns null when the record has no lifecycle data at all — the caller
 * must render an explicit "unknown", NEVER assume valid.
 */
export function deriveLifecycle(a: Attestation): AttestationLifecycleStatus | null {
  if (a.revokedAt) return 'revoked';
  if (a.supersededBy) return 'superseded';
  const expired = typeof a.expiresAt === 'string' && Date.parse(a.expiresAt) < Date.now();
  if (a.status) {
    // A 'valid' status past its expiry must not render green.
    if (a.status === 'valid' && expired) return 'expired';
    return a.status;
  }
  if (expired) return 'expired';
  return null;
}

export async function getAttestations(params?: {
  since?: string;
  result?: string;
  limit?: number;
}): Promise<{ count: number; attestations: Attestation[] }> {
  const { data } = await api.get<{ count: number; attestations: Attestation[] }>('/attestations', { params });
  return data;
}

export async function verifyAttestation(id: string): Promise<{
  attestationId: string;
  signatureValid: boolean;
  result: string;
  evaluatedAt: string;
}> {
  const { data } = await api.get(`/attestations/${id}/verify`);
  return data;
}

/** Revoke an attestation. A reason is mandatory — the engine records it and exposes it on the public verify page. */
export async function revokeAttestation(id: string, reason: string): Promise<void> {
  await api.post(`/attestations/${id}/revoke`, { reason });
}

/** Download an attestation bundle in the given format. Returns the raw blob for a client-side download link. */
export async function exportAttestation(id: string, format: 'json' | 'html'): Promise<Blob> {
  const { data } = await api.get<Blob>(`/attestations/${id}/export`, {
    params: { format },
    responseType: 'blob',
  });
  return data;
}
