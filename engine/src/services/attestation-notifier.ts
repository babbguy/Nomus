/**
 * Attestation reliance notifications.
 *
 * When an attestation's lifecycle status changes (revoked / superseded /
 * expired), every ACTIVE subscription on that attestation is notified:
 *
 *   - webhook subscriptions: dispatched through the signed  webhook
 *     path (dispatchWebhookToTargets — V2 timestamp-bound HMAC signature
 *     with the per-subscription secret, full retry schedule).
 *   - email subscriptions: sent via the existing Resend email service.
 *
 * Delivery is fire-and-forget from the caller's perspective (route handlers
 * must not block on retry schedules), but every failure is logged — zero
 * silent failures.
 */
import { and, eq, isNull, isNotNull, lt } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { attestationReceipts, attestationSubscriptions } from '../db/schema.js';
import { deriveAttestationStatus, type AttestationStatus } from '../core/attestation-lifecycle.js';
import { dispatchWebhookToTargets, type NomusWebhookEvent, type WebhookTarget } from './webhook-dispatcher.js';
import { sendEmail } from './notifications.js';
import { logger } from '../logger.js';

export type AttestationLifecycleEvent =
  | 'attestation.revoked'
  | 'attestation.superseded'
  | 'attestation.expired';

/** The attestation columns the notifier needs (a full receipt row satisfies this). */
export interface AttestationNotificationRecord {
  id: string;
  schemaVersion: number;
  evaluatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  supersededBy: string | null;
}

/**
 * Notify all active subscriptions of `attestation` about `event`.
 *
 * The webhook payload data is identical for every subscriber of one change
 * (one traceable, timestamped fact) and contains no org-private
 * fields (no actionContext, no orgId): subscribers are third parties.
 */
export function notifyAttestationStatusChange(
  attestation: AttestationNotificationRecord,
  event: AttestationLifecycleEvent,
): void {
  try {
    const db = getDb();
    const subs = db.select().from(attestationSubscriptions)
      .where(and(
        eq(attestationSubscriptions.attestationId, attestation.id),
        eq(attestationSubscriptions.active, true),
      ))
      .all();
    if (subs.length === 0) return;

    const notifiedAt = new Date().toISOString();
    const status: AttestationStatus = deriveAttestationStatus(attestation, notifiedAt);
    const data: Record<string, unknown> = {
      attestationId: attestation.id,
      status,
      schemaVersion: attestation.schemaVersion,
      attestedAt: attestation.evaluatedAt,
      expiresAt: attestation.expiresAt,
      revokedAt: attestation.revokedAt,
      revocationReason: attestation.revocationReason,
      supersededBy: attestation.supersededBy,
      notifiedAt,
    };

    // Webhook channel — signed, retried, per-subscription secret
    const targets: WebhookTarget[] = [];
    for (const sub of subs.filter((s) => s.channel === 'webhook')) {
      if (!sub.secret) {
        // Should be impossible (secret generated at subscribe time) — log loudly
        logger.error({ subscriptionId: sub.id, attestationId: attestation.id },
          'Webhook subscription has no secret — notification skipped');
        continue;
      }
      targets.push({
        id: sub.id,
        name: `attestation-subscription:${sub.id}`,
        url: sub.target,
        secret: sub.secret,
      });
    }
    if (targets.length > 0) {
      void dispatchWebhookToTargets(targets, event as NomusWebhookEvent, data);
    }

    // Email channel
    for (const sub of subs.filter((s) => s.channel === 'email')) {
      void sendEmail(
        [sub.target],
        `Nomus attestation ${attestation.id} is now ${status.toUpperCase()}`,
        buildStatusChangeEmailHtml(attestation, status, notifiedAt),
      ).then((ok) => {
        if (!ok) {
          logger.error({ subscriptionId: sub.id, attestationId: attestation.id, event },
            'Attestation status email delivery failed');
        }
      }).catch((err: Error) => {
        logger.error({ subscriptionId: sub.id, attestationId: attestation.id, error: err.message },
          'Attestation status email delivery error');
      });
    }

    logger.info({
      attestationId: attestation.id,
      event,
      status,
      webhookTargets: targets.length,
      emailTargets: subs.filter((s) => s.channel === 'email').length,
    }, 'Attestation status change notifications dispatched');
  } catch (err) {
    logger.error({ attestationId: attestation.id, event, error: (err as Error).message },
      'Attestation status notification failed');
  }
}

/**
 * Nightly expiry sweep (scheduler, 04:45 UTC): find attestations whose
 * expiresAt crossed since the last sweep and notify their subscriptions.
 *
 * Exactly-once semantics: expiry_notified_at is a one-shot marker set with a
 * guarded UPDATE (WHERE expiry_notified_at IS NULL) BEFORE dispatch, so a
 * partially-failed sweep can never re-spam subscribers on the next run —
 * the dispatcher's own retry schedule handles transient delivery failures.
 *
 * Attestations already revoked or superseded are skipped: their subscribers
 * were notified of the higher-precedence status when it happened, and the
 * derived status would not be 'expired' (revoked > superseded > expired).
 */
export function sweepExpiredAttestations(
  nowIso: string = new Date().toISOString(),
): { newlyExpired: number; notified: number } {
  const db = getDb();

  // expiresAt is validated at the boundary to be UTC ISO-8601 (Z), so
  // lexicographic comparison is a correct time comparison.
  const rows = db.select().from(attestationReceipts)
    .where(and(
      isNotNull(attestationReceipts.expiresAt),
      lt(attestationReceipts.expiresAt, nowIso),
      isNull(attestationReceipts.expiryNotifiedAt),
      isNull(attestationReceipts.revokedAt),
      isNull(attestationReceipts.supersededBy),
    ))
    .all();

  let newlyExpired = 0;
  let notified = 0;

  for (const row of rows) {
    const marked = db.update(attestationReceipts)
      .set({ expiryNotifiedAt: nowIso })
      .where(and(
        eq(attestationReceipts.id, row.id),
        isNull(attestationReceipts.expiryNotifiedAt),
      ))
      .run();
    if (marked.changes === 0) continue; // raced with a concurrent sweep

    newlyExpired++;

    const hasActiveSubs = db.select({ id: attestationSubscriptions.id })
      .from(attestationSubscriptions)
      .where(and(
        eq(attestationSubscriptions.attestationId, row.id),
        eq(attestationSubscriptions.active, true),
      ))
      .all().length > 0;

    if (hasActiveSubs) {
      notifyAttestationStatusChange(row, 'attestation.expired');
      notified++;
    }
  }

  if (newlyExpired > 0) {
    logger.info({ newlyExpired, notified, sweepAt: nowIso }, 'Attestation expiry sweep complete');
  }
  return { newlyExpired, notified };
}

// ─── Email rendering ─────────────────────────────────────────────

function buildStatusChangeEmailHtml(
  attestation: AttestationNotificationRecord,
  status: AttestationStatus,
  notifiedAt: string,
): string {
  const rows: Array<[string, string]> = [
    ['Attestation', attestation.id],
    ['New status', status.toUpperCase()],
    ['Attested at', attestation.evaluatedAt],
  ];
  if (attestation.revokedAt) rows.push(['Revoked at', attestation.revokedAt]);
  if (attestation.revocationReason) rows.push(['Revocation reason', attestation.revocationReason]);
  if (attestation.supersededBy) rows.push(['Superseded by', attestation.supersededBy]);
  if (attestation.expiresAt) rows.push(['Expires at', attestation.expiresAt]);
  rows.push(['Status changed detected at', notifiedAt]);

  const table = rows.map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">${escapeHtml(k)}</td><td style="font-weight:600;">${escapeHtml(v)}</td></tr>`,
  ).join('');

  return `<p>The status of a Nomus attestation you subscribed to has changed.</p>
    <table style="border-collapse:collapse;margin:12px 0;">${table}</table>
    <p>Verify the current status any time at <code>/api/v1/verify/${escapeHtml(attestation.id)}</code> on this Nomus instance.</p>
    <p style="color:#9ca3af;font-size:12px;">Do not rely on a revoked, superseded, or expired attestation.</p>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
