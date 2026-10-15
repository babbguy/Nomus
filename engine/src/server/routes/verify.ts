/**
 * Public attestation verification API (no auth).
 *
 * GET  /api/v1/verify/:attestationId            — lifecycle status + signature validity
 * POST /api/v1/verify/:attestationId/subscribe  — reliance subscription (email | webhook)
 *
 * FROZEN CONTRACT (the dashboard builds against this exact shape):
 * {
 *   attestationId, status: 'valid'|'expired'|'revoked'|'superseded',
 *   signatureValid: boolean, schemaVersion, attestedAt, expiresAt,
 *   revokedAt, revocationReason, supersededBy,
 *   orgDisplayName: string|null,
 *   subject: { result, jurisdiction, rulesEvaluated: [{ruleKey, version, effect, matched}] },
 *   ruleContext: { stateHash, computedAt } | null,
 *   verification: { algorithm: 'ed25519', publicKey, signedPayloadDescription, instructions },
 *   corporateGovernance?: { manifestSignatureValid, exceptions, revokedSince, caseClosures, ciRuns },
 *   _disclaimer
 * }
 * corporateGovernance is present only for an attestation with a corporate
 * policy manifest (design spec §13): counts and validity only, never policy
 * keys, repositories or code.
 *
 * PUBLIC-EXPOSURE POLICY (what `subject` contains and why):
 *   EXPOSED  — result, jurisdiction, and the rulesEvaluated entries
 *              ({ ruleKey, version, effect, matched }): these are the
 *              regulatory basis of the attestation (
 *              transparent reasoning) and reference the public rule corpus.
 *   EXCLUDED — actionContext (the org's private action/business context),
 *              orgId, and the org name unless the org opted in via the
 *              showOrgOnPublicVerify setting (private by default).
 *
 * Unknown ids return a bare 404 { error } — no existence oracle beyond the
 * fact that a random UUID is not an attestation.
 */
import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { attestationReceipts, attestationSubscriptions, organizations } from '../../db/schema.js';
import {
  deriveAttestationStatus,
  verifyReceiptSignature,
  verificationInstructions,
  SIGNED_PAYLOAD_DESCRIPTION,
} from '../../core/attestation-lifecycle.js';
import { getPublicKey } from '../../core/signing.js';
import { isEmailConfigured } from '../../services/notifications.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';
import { logger } from '../../logger.js';
import { publicGovernanceSummary } from '../../cpg/attestations/governance-bundle.js';

export const verifyPublicRoutes = new Hono();

// ─── Per-IP rate limiter (subscribe route ONLY) ─────────────────
//
// The org-keyed rateLimit() middleware cannot protect public routes (no
// orgId), and no public route had a limiter before this one. This is a
// deliberately minimal in-memory fixed-window limiter, scoped to the
// subscribe endpoint only: max SUBSCRIBE_MAX_REQUESTS per IP per
// SUBSCRIBE_WINDOW_MS. IP comes from X-Forwarded-For (first hop) — the
// deployment fronts the engine with a proxy that sets it; without the
// header all callers share the 'unknown' bucket, which fails safe (stricter,
// not looser). State is per-process; a restart resets it, which is
// acceptable for abuse throttling (not billing).

const SUBSCRIBE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const SUBSCRIBE_MAX_REQUESTS = 10;
const subscribeWindows = new Map<string, { count: number; resetAt: number }>();

function subscribeRateLimited(ip: string): boolean {
  const now = Date.now();
  // Opportunistic cleanup so the map cannot grow unbounded
  if (subscribeWindows.size > 10_000) {
    for (const [key, val] of subscribeWindows) {
      if (val.resetAt < now) subscribeWindows.delete(key);
    }
  }
  let window = subscribeWindows.get(ip);
  if (!window || window.resetAt < now) {
    window = { count: 0, resetAt: now + SUBSCRIBE_WINDOW_MS };
    subscribeWindows.set(ip, window);
  }
  window.count++;
  return window.count > SUBSCRIBE_MAX_REQUESTS;
}

/** Test hook — clears limiter state between tests. */
export function resetSubscribeRateLimiter(): void {
  subscribeWindows.clear();
}

function clientIp(headers: { header: (name: string) => string | undefined }): string {
  const fwd = headers.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return headers.header('x-real-ip') ?? 'unknown';
}

// ─── SSRF guard for webhook targets ─────────────────────────────
//
// The subscribe endpoint is public and the webhook target is delivered to
// by this server — reject obviously-internal destinations. (Hostname-literal
// checks only; DNS-rebinding-grade protection is out of scope for v1 and
// documented as such.)

function isDisallowedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv4 private / loopback / link-local ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

// ─── GET /api/v1/verify/:attestationId ──────────────────────────

verifyPublicRoutes.get('/:attestationId', (c) => {
  const db = getDb();
  const receipt = db.select().from(attestationReceipts)
    .where(eq(attestationReceipts.id, c.req.param('attestationId')))
    .get();

  if (!receipt) return c.json({ error: 'Attestation not found' }, 404);

  let publicKey: string;
  try {
    publicKey = getPublicKey();
  } catch {
    logger.error({ attestationId: receipt.id }, 'Public verify requested but signing keys not initialized');
    return c.json({ error: 'Verification service unavailable' }, 503);
  }

  // the determination instant is explicit and reported back
  const checkedAt = new Date().toISOString();
  const status = deriveAttestationStatus(receipt, checkedAt);
  const signatureValid = verifyReceiptSignature(receipt);

  // Org display name — strictly opt-in (private by default)
  const org = db.select({
    name: organizations.name,
    showOrgOnPublicVerify: organizations.showOrgOnPublicVerify,
  }).from(organizations)
    .where(eq(organizations.id, receipt.orgId))
    .get();
  const orgDisplayName = org?.showOrgOnPublicVerify ? org.name : null;

  // Subject: the attested content summary. actionContext is org-private and
  // deliberately NOT parsed or exposed here.
  let rulesEvaluated: Array<{ ruleKey: string; version: number; effect: string; matched: boolean }>;
  try {
    const parsed = JSON.parse(receipt.rulesEvaluated) as Array<Record<string, unknown>>;
    rulesEvaluated = (Array.isArray(parsed) ? parsed : []).map((r) => ({
      ruleKey: String(r.ruleKey),
      version: Number(r.version),
      effect: String(r.effect),
      matched: Boolean(r.matched),
    }));
  } catch {
    rulesEvaluated = [];
  }
  const corporateGovernance = publicGovernanceSummary(db, receipt.id);

  return c.json({
    attestationId: receipt.id,
    status,
    signatureValid,
    schemaVersion: receipt.schemaVersion,
    attestedAt: receipt.evaluatedAt,
    expiresAt: receipt.expiresAt,
    revokedAt: receipt.revokedAt,
    revocationReason: receipt.revocationReason,
    supersededBy: receipt.supersededBy,
    orgDisplayName,
    subject: {
      result: receipt.result,
      jurisdiction: receipt.jurisdiction,
      rulesEvaluated,
    },
    // The policy state hash was computed inside the evaluation itself, so
    // its computedAt is the attestation instant (traceable + reproducible).
    ruleContext: receipt.policyStateHash
      ? { stateHash: receipt.policyStateHash, computedAt: receipt.evaluatedAt }
      : null,
    verification: {
      algorithm: 'ed25519',
      publicKey,
      signedPayloadDescription: SIGNED_PAYLOAD_DESCRIPTION,
      instructions: verificationInstructions(),
    },
    checkedAt,
    ...(corporateGovernance ? { corporateGovernance } : {}),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// ─── POST /api/v1/verify/:attestationId/subscribe ───────────────

const subscribeSchema = z.object({
  channel: z.enum(['email', 'webhook']),
  target: z.string().min(3).max(2048),
});

const emailTargetSchema = z.string().email().max(320);

/** Max active subscriptions per attestation — public-endpoint growth cap. */
const MAX_SUBSCRIPTIONS_PER_ATTESTATION = 50;

verifyPublicRoutes.post('/:attestationId/subscribe', async (c) => {
  if (subscribeRateLimited(clientIp(c.req))) {
    return c.json({ error: 'Rate limit exceeded. Try again later.' }, 429);
  }

  const db = getDb();
  const receipt = db.select({ id: attestationReceipts.id }).from(attestationReceipts)
    .where(eq(attestationReceipts.id, c.req.param('attestationId')))
    .get();
  if (!receipt) return c.json({ error: 'Attestation not found' }, 404);

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }
  const { channel, target } = parsed.data;

  if (channel === 'email') {
    if (!emailTargetSchema.safeParse(target).success) {
      return c.json({ error: 'Invalid email address' }, 400);
    }
    // NEVER silently accept a subscription this instance cannot deliver
    if (!isEmailConfigured()) {
      return c.json({
        error: 'Email notifications are not configured on this Nomus instance. Use the webhook channel or contact the instance operator.',
      }, 503);
    }
  } else {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return c.json({ error: 'Invalid webhook URL' }, 400);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return c.json({ error: 'Webhook URL must use http or https' }, 400);
    }
    if (isDisallowedWebhookHost(url.hostname)) {
      return c.json({ error: 'Webhook URL host is not allowed' }, 400);
    }
  }

  // Idempotent on (attestation, channel, target): re-subscribing returns the
  // existing subscription instead of creating duplicates. The webhook secret
  // is NOT re-revealed (it is returned exactly once at creation).
  const existing = db.select().from(attestationSubscriptions)
    .where(and(
      eq(attestationSubscriptions.attestationId, receipt.id),
      eq(attestationSubscriptions.channel, channel),
      eq(attestationSubscriptions.target, target),
      eq(attestationSubscriptions.active, true),
    ))
    .get();
  if (existing) {
    return c.json({
      subscriptionId: existing.id,
      attestationId: receipt.id,
      channel,
      alreadySubscribed: true,
    });
  }

  const activeCount = db.select({ count: sql<number>`count(*)` })
    .from(attestationSubscriptions)
    .where(and(
      eq(attestationSubscriptions.attestationId, receipt.id),
      eq(attestationSubscriptions.active, true),
    ))
    .get()?.count ?? 0;
  if (activeCount >= MAX_SUBSCRIPTIONS_PER_ATTESTATION) {
    return c.json({ error: 'Subscription limit reached for this attestation' }, 409);
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const secret = channel === 'webhook' ? randomBytes(32).toString('hex') : null;

  db.insert(attestationSubscriptions).values({
    id,
    attestationId: receipt.id,
    channel,
    target,
    secret,
    active: true,
    createdAt: now,
  }).run();

  logger.info({ subscriptionId: id, attestationId: receipt.id, channel }, 'Attestation reliance subscription created');

  return c.json({
    subscriptionId: id,
    attestationId: receipt.id,
    channel,
    createdAt: now,
    ...(secret ? {
      secret,
      secretUsage: 'Notifications are HMAC-SHA256 signed: X-Nomus-Signature-V2 = "sha256=" + hex(HMAC(secret, `${X-Nomus-Timestamp}.${rawBody}`)). Store this secret — it cannot be retrieved again.',
    } : {}),
    events: ['attestation.revoked', 'attestation.superseded', 'attestation.expired'],
  }, 201);
});
