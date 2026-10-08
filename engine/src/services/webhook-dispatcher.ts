import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { captureError } from '../observability/error-tracking.js';
import { getDb } from '../db/client.js';
import { platformSettings } from '../db/schema.js';

// ─── Types ──────────────────────────────────────────────────────

export type NomusWebhookEvent =
  | 'rules.updated'
  | 'rules.error'
  | 'rules.approved'
  | 'scout.signal_promoted'
  // Attestation lifecycle notifications (reliance subscriptions)
  | 'attestation.revoked'
  | 'attestation.superseded'
  | 'attestation.expired';

interface WebhookPayload {
  event: NomusWebhookEvent;
  timestamp: string;
  data: Record<string, unknown>;
}

interface WebhookSubscriber {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: NomusWebhookEvent[];
  enabled: boolean;
}

// ─── Subscriber Resolution ──────────────────────────────────────

function getSubscribers(): WebhookSubscriber[] {
  const config = env();
  const subscribers: WebhookSubscriber[] = [];

  // Modus as built-in subscriber
  if (config.NOMUS_MODUS_API_URL) {
    subscribers.push({
      id: 'modus',
      name: 'Modus',
      url: `${config.NOMUS_MODUS_API_URL.replace(/\/$/, '')}/api/v1/webhooks/nomus`,
      secret: config.NOMUS_MODUS_API_KEY ?? '',
      events: ['rules.updated', 'rules.error', 'scout.signal_promoted'],
      enabled: true,
    });
  }

  // Load additional subscribers from platform_settings
  try {
    const db = getDb();
    const row = db.select().from(platformSettings)
      .where(eq(platformSettings.key, 'webhook.subscribers'))
      .get();
    if (row) {
      const custom: WebhookSubscriber[] = JSON.parse(row.value);
      subscribers.push(...custom.filter((s) => s.enabled));
    }
  } catch {
    // DB not ready or invalid JSON — proceed with built-in subscribers only
  }

  return subscribers;
}

// ─── Signing ────────────────────────────────────────────────────
//
// Outbound webhook signing (replay protection; webhook replay protection).
//
// DELIBERATE ADAPTATION from the spec's rollout plan (§7.3/§8), approved by
// the orchestrator: instead of a flag-day lockstep merge with Modus,
// Nomus emits BOTH signatures during a migration window:
//
//   X-Nomus-Signature     legacy v1 — HMAC-SHA256(secret, body), lowercase
//                            hex, no prefix. Unchanged wire format, so current
//                            Modus verifiers keep working. Emission is
//                            controlled by NOMUS_WEBHOOK_LEGACY_SIGNATURE
//                            (default true).
//   X-Nomus-Signature-V2  new — "sha256=" + HMAC-SHA256(secret,
//                            `${timestamp}.${body}`) lowercase hex. Signing
//                            scheme: the timestamp
//                            string first, a literal "." (0x2E), then the raw
//                            body bytes.
//   X-Nomus-Timestamp     unchanged value (UTC ISO-8601, captured ONCE in
//                            dispatchWebhook as payload.timestamp), now
//                            cryptographically bound via the V2 signature.
//   X-Nomus-Delivery-Id   UUID per delivery (spec §6.1), stable across
//                            retry attempts so receivers can dedupe replays
//                            inside the freshness window.
//
// The spec's X-Nomus-Signature-Version header is intentionally NOT sent:
// during dual emission both v1 and v2 signatures are present simultaneously,
// so versioning is carried by the header names themselves.
//
// CUTOVER PROCEDURE:
//   1. Deploy this build. Existing consumers keep verifying the legacy
//      X-Nomus-Signature — nothing breaks.
//   2. Each consumer (Modus first) migrates its verifier to
//      X-Nomus-Signature-V2: recompute
//      "sha256=" + HMAC-SHA256(secret, `${X-Nomus-Timestamp}.${raw_body}`)
//      hex, compare in constant time, and enforce a 5-minute freshness window
//      on X-Nomus-Timestamp.
//   3. Once ALL consumers verify V2, set NOMUS_WEBHOOK_LEGACY_SIGNATURE=false
//      and restart. The legacy body-only header disappears and the
//      replay-with-rewritten-timestamp gap (spec §2) is fully closed.
//
// RETRY TIMESTAMP POLICY (spec §6.3): timestamp and signatures are computed
// ONCE per delivery and reused verbatim across all retry attempts. The spec
// explicitly rejects re-signing on retry — the full 8-attempt backoff
// schedule (~183 s) fits inside the receiver's 5-minute freshness window,
// and a delivery genuinely older than the window SHOULD fail at the receiver
// and surface in dispatcher logs rather than being made artificially fresh.

/** Legacy v1 signature: HMAC-SHA256 over the raw body only (no prefix). */
function signPayloadLegacy(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * V2 signature: HMAC-SHA256 over `${timestamp}.${body}` (spec §6.2).
 * The timestamp MUST be the exact string sent in X-Nomus-Timestamp.
 */
function signPayloadV2(timestamp: string, body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// ─── Delivery (with retry) ──────────────────────────────────────

const MAX_WEBHOOK_RETRIES = 8;
// Exponential backoff delays in ms: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];

async function deliverWebhook(subscriber: WebhookSubscriber, payload: WebhookPayload): Promise<boolean> {
  const body = JSON.stringify(payload);
  const deliveryId = randomUUID();

  // Compute all signatures up front, before any network I/O. The timestamp
  // bound into the V2 signature is payload.timestamp — the SAME string sent
  // in the X-Nomus-Timestamp header and embedded in the JSON body. It was
  // captured once in dispatchWebhook; never re-read the clock here
  // (time-of-check-vs-time-of-use guard, spec §9 note).
  //
  // If signing throws for any reason, the delivery fails LOUDLY and is
  // counted as a failed delivery — we never fall through to sending an
  // unsigned or partially signed webhook.
  let headers: Record<string, string>;
  try {
    headers = {
      'Content-Type': 'application/json',
      'X-Nomus-Signature-V2': `sha256=${signPayloadV2(payload.timestamp, body, subscriber.secret)}`,
      'X-Nomus-Event': payload.event,
      'X-Nomus-Timestamp': payload.timestamp,
      'X-Nomus-Delivery-Id': deliveryId,
      'User-Agent': 'Nomus/1.0',
    };
    if (env().NOMUS_WEBHOOK_LEGACY_SIGNATURE === 'true') {
      headers['X-Nomus-Signature'] = signPayloadLegacy(body, subscriber.secret);
    }
  } catch (err) {
    logger.error(
      { subscriber: subscriber.name, event: payload.event, error: (err as Error).message },
      'Nomus webhook signing failed — delivery aborted, nothing sent',
    );
    return false;
  }

  for (let attempt = 1; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
    try {
      const res = await fetch(subscriber.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        logger.info({ subscriber: subscriber.name, event: payload.event, attempt }, 'Nomus webhook delivered');
        // The last-webhook tracker feeds the Modus integration status page —
        // only the Modus subscriber should update it (attestation
        // subscription deliveries must not masquerade as Modus traffic).
        if (subscriber.id === 'modus') recordLastWebhook(payload.event);
        return true;
      }
      logger.warn({ subscriber: subscriber.name, status: res.status, attempt }, 'Nomus webhook delivery failed');
    } catch (err) {
      logger.warn({ subscriber: subscriber.name, attempt, error: (err as Error).message }, 'Nomus webhook request error');
    }

    if (attempt < MAX_WEBHOOK_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
    }
  }

  logger.error({ subscriber: subscriber.name, event: payload.event }, 'Nomus webhook delivery exhausted retries');
  captureError(new Error(`Webhook delivery exhausted retries: ${payload.event}`), {
    subsystem: 'webhooks',
    context: { subscriber: subscriber.name, event: payload.event },
  });
  return false;
}

// ─── Webhook Tracking ────────────────────────────────────────────

function recordLastWebhook(event: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(platformSettings)
      .values({ key: 'modus.last_webhook_at', value: now, updatedAt: now })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: now, updatedAt: now } })
      .run();
    db.insert(platformSettings)
      .values({ key: 'modus.last_webhook_event', value: event, updatedAt: now })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: event, updatedAt: now } })
      .run();
  } catch {
    // Best-effort tracking
  }
}

// ─── Public API ─────────────────────────────────────────────────

export async function dispatchWebhook(event: NomusWebhookEvent, data: Record<string, unknown>): Promise<void> {
  const subscribers = getSubscribers().filter((s) => s.events.includes(event));
  if (subscribers.length === 0) return;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  // Fire all in parallel, non-blocking
  Promise.allSettled(
    subscribers.map((s) => deliverWebhook(s, payload)),
  ).catch(() => {});
}

/**
 * An ad-hoc delivery target (attestation reliance subscription).
 * Unlike platform subscribers, these are per-subscription endpoints with a
 * per-subscription HMAC secret generated at subscribe time.
 */
export interface WebhookTarget {
  id: string;
  name: string;
  url: string;
  secret: string;
}

/**
 * Deliver one event to explicit targets, reusing the exact same signed
 * delivery path (V1+V2 HMAC headers, retry schedule, fail-loud signing) as
 * dispatchWebhook. The payload timestamp is captured ONCE and shared across
 * all targets and retries (spec §6.3).
 *
 * Fire-and-forget like dispatchWebhook: failures are logged by
 * deliverWebhook after retries are exhausted, never silently dropped.
 */
export async function dispatchWebhookToTargets(
  targets: WebhookTarget[],
  event: NomusWebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  if (targets.length === 0) return;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  Promise.allSettled(
    targets.map((t) => deliverWebhook(
      { id: t.id, name: t.name, url: t.url, secret: t.secret, events: [event], enabled: true },
      payload,
    )),
  ).catch(() => {});
}

// ─── Convenience Helpers ────────────────────────────────────────

/** Called after pipeline successfully generates/updates rules */
export async function notifyRulesUpdated(data: {
  sourceId: string;
  sourceName: string;
  jurisdiction: string;
  rulesCreated: number;
  rulesUpdated: number;
  stateHash: string;
  generatedAt: string;
}): Promise<void> {
  await dispatchWebhook('rules.updated', data);
}

/** Called when the pipeline encounters an error */
export async function notifyRulesError(data: {
  sourceId: string;
  sourceName: string;
  error: string;
  stepReached: number;
}): Promise<void> {
  await dispatchWebhook('rules.error', data);
}

/** Called when a Scout signal gets promoted to an active rule */
export async function notifyScoutSignalPromoted(data: {
  signalId: string;
  title: string;
  jurisdiction: string;
  ruleKey: string;
}): Promise<void> {
  await dispatchWebhook('scout.signal_promoted', data);
}
