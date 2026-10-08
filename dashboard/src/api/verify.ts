// ─── Attestation Reliance Network — public verification API ──
//
// These are PUBLIC, unauthenticated endpoints. They use plain fetch
// (matching PublicTransparency.tsx conventions) instead of the shared
// axios client, because the client attaches credentials and its 401
// interceptor redirects to /login — behavior that must never apply to
// a shareable public verification page.

export type AttestationLifecycleStatus = 'valid' | 'expired' | 'revoked' | 'superseded';

export interface VerifyRuleContext {
  /** SHA-256 hash of the compiled policy state the attestation was evaluated against. */
  stateHash: string;
  /** UTC ISO-8601 — when that policy state was computed. */
  computedAt: string;
}

export interface VerificationInfo {
  algorithm: string;
  /** Public key to verify the signature independently. */
  publicKey: string;
  signedPayloadDescription: string;
  /** Step-by-step independent verification instructions. */
  instructions: string | string[];
}

export interface AttestationVerification {
  attestationId: string;
  status: AttestationLifecycleStatus;
  signatureValid: boolean;
  schemaVersion: string | number;
  /** UTC ISO-8601. */
  attestedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  /** Attestation ID that replaces this one, when status === 'superseded'. */
  supersededBy: string | null;
  orgDisplayName: string | null;
  /** What was attested — arbitrary key/value summary. */
  subject: Record<string, unknown>;
  ruleContext: VerifyRuleContext | null;
  verification: VerificationInfo;
  _disclaimer: string;
}

/**
 * Discriminated fetch result so the page can render 404 ("no attestation
 * with this ID") visibly distinct from a load failure:
 * error states must never masquerade as data states.
 */
export type VerifyFetchResult =
  | { kind: 'ok'; data: AttestationVerification }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

function extractServerError(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string' && err.length > 0) return err;
  }
  return null;
}

export async function fetchAttestationVerification(attestationId: string): Promise<VerifyFetchResult> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/verify/${encodeURIComponent(attestationId)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Network request failed' };
  }

  if (res.status === 404) return { kind: 'not_found' };

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const serverMsg = extractServerError(await res.json());
      if (serverMsg) message = `${serverMsg} (HTTP ${res.status})`;
    } catch {
      // non-JSON error body — keep the HTTP status message
    }
    return { kind: 'error', message };
  }

  try {
    const data = (await res.json()) as AttestationVerification;
    return { kind: 'ok', data };
  } catch {
    return { kind: 'error', message: 'Response was not valid JSON' };
  }
}

// ─── Status-change subscriptions ────────────────────────────────

export type SubscribeChannel = 'email' | 'webhook';

export interface SubscribeResponse {
  subscriptionId: string;
  /**
   * Per-subscription HMAC secret, returned EXACTLY ONCE at creation for
   * webhook subscriptions — the subscriber needs it to verify the
   * X-Nomus-Signature-V2 header on status-change deliveries. Never
   * retrievable again; the UI must display it with a save-it-now warning.
   */
  secret?: string;
}

/**
 * Subscribe to status-change notifications for an attestation.
 * Throws an Error carrying the server's own message where one is provided —
 * including the 503 "email delivery not configured" case, which must be
 * surfaced to the user honestly, not swallowed.
 */
export async function subscribeToAttestation(
  attestationId: string,
  channel: SubscribeChannel,
  target: string,
): Promise<SubscribeResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/verify/${encodeURIComponent(attestationId)}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ channel, target }),
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Network request failed');
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through — handled below
  }

  if (!res.ok) {
    const serverMsg = extractServerError(body);
    throw new Error(serverMsg ? `${serverMsg} (HTTP ${res.status})` : `Subscription failed (HTTP ${res.status})`);
  }

  if (
    body &&
    typeof body === 'object' &&
    'subscriptionId' in body &&
    typeof (body as { subscriptionId: unknown }).subscriptionId === 'string'
  ) {
    const b = body as { subscriptionId: string; secret?: unknown };
    return {
      subscriptionId: b.subscriptionId,
      ...(typeof b.secret === 'string' ? { secret: b.secret } : {}),
    };
  }
  throw new Error('Server accepted the subscription but returned no subscription ID');
}
